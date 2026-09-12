from __future__ import annotations

import hashlib
import math
import os
import time
from dataclasses import replace
from pathlib import Path
from typing import Optional, Protocol, Sequence

import numpy as np

from .retrieval import RankedChunk, RetrievalChunk, ScoreBreakdown, SearchOutput, normalize_text, search_chunks, tokenize
from .semantic import LocalVectorIndex, ModelUnavailableError, chunk_embedding_text


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RERANKER_PATH = PROJECT_ROOT / ".model-cache" / "mmarco-mMiniLMv2-L12-H384-v1"
RRF_ENGINE_NAME = "bm25+bge-weighted-rrf-v1"
RERANK_ENGINE_NAME = "bm25+bge-weighted-rrf+mmarco-cross-encoder-v1"
RRF_K = 60
RRF_KEYWORD_WEIGHT = 1.0
RRF_VECTOR_WEIGHT = 1.0
CANDIDATE_K = 20
RERANK_K = 12
HYBRID_VECTOR_THRESHOLD = 0.48
HYBRID_KEYWORD_SCORE_THRESHOLD = 2.0
HYBRID_KEYWORD_COVERAGE_THRESHOLD = 0.67


class RerankerProvider(Protocol):
    name: str

    @property
    def available(self) -> bool: ...

    def score(self, query: str, passages: Sequence[str]) -> list[float]: ...


class MMarcoCrossEncoderReranker:
    name = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1-int8"

    def __init__(self, model_path: Optional[Path] = None) -> None:
        configured = os.environ.get("XIRANG_RERANKER_MODEL_PATH")
        self.model_path = Path(configured) if configured else (model_path or DEFAULT_RERANKER_PATH)
        self.onnx_path = self.model_path / "onnx" / "model_quint8_avx2.onnx"
        self._tokenizer = None
        self._session = None
        self._checksum: Optional[str] = None

    @property
    def available(self) -> bool:
        return self.onnx_path.is_file() and (self.model_path / "config.json").is_file()

    @property
    def checksum(self) -> Optional[str]:
        if not self.available:
            return None
        if self._checksum is None:
            digest = hashlib.sha256()
            with self.onnx_path.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
            self._checksum = digest.hexdigest()
        return self._checksum

    def _load(self):
        if not self.available:
            raise ModelUnavailableError(
                "本地多语言 Cross-Encoder 不完整。请运行 scripts/download_retrieval_models.ps1。"
            )
        if self._session is None or self._tokenizer is None:
            try:
                import onnxruntime as ort
                from transformers import AutoTokenizer
            except ImportError as error:
                raise ModelUnavailableError("缺少 onnxruntime，无法加载本地重排模型。") from error
            self._tokenizer = AutoTokenizer.from_pretrained(str(self.model_path), local_files_only=True)
            self._session = ort.InferenceSession(
                str(self.onnx_path),
                providers=["CPUExecutionProvider"],
            )
        return self._tokenizer, self._session

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        if not passages:
            return []
        tokenizer, session = self._load()
        pairs = [(query, passage) for passage in passages]
        encoded = tokenizer(
            pairs,
            padding=True,
            truncation=True,
            max_length=384,
            return_tensors="np",
        )
        expected_inputs = {item.name for item in session.get_inputs()}
        inputs = {
            key: np.asarray(value, dtype=np.int64)
            for key, value in encoded.items()
            if key in expected_inputs
        }
        logits = np.asarray(session.run(None, inputs)[0]).reshape(-1)
        return [float(1 / (1 + math.exp(-max(-30.0, min(30.0, float(value)))))) for value in logits]


def _empty_breakdown() -> ScoreBreakdown:
    return ScoreBreakdown(0.0, 0.0, 0.0, 0.0, 0.0)


def hybrid_search(
    query: str,
    chunks: Sequence[RetrievalChunk],
    vector_index: LocalVectorIndex,
    top_k: int = 5,
    *,
    reranker: Optional[RerankerProvider] = None,
    keyword_weight: float = RRF_KEYWORD_WEIGHT,
    vector_weight: float = RRF_VECTOR_WEIGHT,
    vector_threshold: float = HYBRID_VECTOR_THRESHOLD,
    keyword_score_threshold: float = HYBRID_KEYWORD_SCORE_THRESHOLD,
    keyword_coverage_threshold: float = HYBRID_KEYWORD_COVERAGE_THRESHOLD,
    source_ids: Optional[Sequence[str]] = None,
) -> SearchOutput:
    started = time.perf_counter()
    if source_ids is not None:
        allowed_source_ids = set(source_ids)
        chunks = [chunk for chunk in chunks if chunk.source_id in allowed_source_ids]
    candidate_k = min(CANDIDATE_K, max(top_k, len(chunks)))
    keyword_output = search_chunks(query, chunks, candidate_k)
    vector_output = vector_index.search(
        query,
        candidate_k,
        apply_threshold=False,
        source_ids=source_ids,
    )
    keyword_by_id = {item.chunk.id: (rank, item) for rank, item in enumerate(keyword_output.results, 1)}
    vector_by_id = {item.chunk.id: (rank, item) for rank, item in enumerate(vector_output.results, 1)}
    identifiers = set(keyword_by_id) | set(vector_by_id)
    fused: list[RankedChunk] = []

    for identifier in identifiers:
        keyword_entry = keyword_by_id.get(identifier)
        vector_entry = vector_by_id.get(identifier)
        keyword_rank = keyword_entry[0] if keyword_entry else None
        vector_rank = vector_entry[0] if vector_entry else None
        keyword_result = keyword_entry[1] if keyword_entry else None
        vector_result = vector_entry[1] if vector_entry else None
        base = keyword_result or vector_result
        assert base is not None
        rrf = (keyword_weight / (RRF_K + keyword_rank) if keyword_rank else 0.0) + (
            vector_weight / (RRF_K + vector_rank) if vector_rank else 0.0
        )
        lexical = keyword_result.breakdown if keyword_result else _empty_breakdown()
        vector_score = vector_result.breakdown.vector if vector_result else 0.0
        matched_terms = keyword_result.matched_terms if keyword_result else vector_result.matched_terms
        coverage = keyword_result.query_coverage if keyword_result else vector_result.query_coverage
        fused.append(RankedChunk(
            chunk=base.chunk,
            score=rrf,
            breakdown=ScoreBreakdown(
                bm25=lexical.bm25,
                title_boost=lexical.title_boost,
                heading_boost=lexical.heading_boost,
                phrase_boost=lexical.phrase_boost,
                coverage_boost=lexical.coverage_boost,
                vector=vector_score,
                rrf=rrf,
                keyword_rank=keyword_rank,
                vector_rank=vector_rank,
            ),
            matched_terms=matched_terms,
            query_coverage=coverage,
            excerpt=base.excerpt,
        ))

    fused.sort(key=lambda item: (-item.score, item.chunk.id))
    pre_rerank = fused[:RERANK_K]
    if reranker is not None:
        scores = reranker.score(query, [chunk_embedding_text(item.chunk) for item in pre_rerank])
        original_ranks = {item.chunk.id: rank for rank, item in enumerate(pre_rerank, 1)}
        rescored = [
            replace(
                item,
                score=score,
                breakdown=replace(item.breakdown, reranker=score),
            )
            for item, score in zip(pre_rerank, scores)
        ]
        rescored.sort(key=lambda item: (-item.score, -item.breakdown.rrf, item.chunk.id))
        fused = [
            replace(item, breakdown=replace(
                item.breakdown,
                rank_delta=original_ranks[item.chunk.id] - new_rank,
            ))
            for new_rank, item in enumerate(rescored, 1)
        ]

    results = fused[:top_k]
    top_vector = vector_output.results[0].score if vector_output.results else 0.0
    top_keyword_score = keyword_output.results[0].score if keyword_output.results else 0.0
    top_keyword_coverage = keyword_output.results[0].query_coverage if keyword_output.results else 0.0
    vector_support = top_vector >= vector_threshold
    keyword_support = (
        top_keyword_score >= keyword_score_threshold
        and top_keyword_coverage >= keyword_coverage_threshold
    )
    confidence = "none"
    no_answer_reason = "关键词与向量通道都没有形成足够一致的依据。"
    if results and (vector_support or keyword_support):
        confidence = "strong" if vector_support and keyword_support else "possible"
        no_answer_reason = None
    else:
        results = []

    average_length = sum(len(tokenize(chunk.content)) for chunk in chunks) / len(chunks) if chunks else 0.0
    return SearchOutput(
        query=query,
        normalized_query=normalize_text(query),
        query_terms=tokenize(query),
        results=results,
        duration_ms=round((time.perf_counter() - started) * 1_000, 3),
        chunk_count=len(chunks),
        source_count=len({chunk.source_id for chunk in chunks}),
        average_chunk_length=round(average_length, 2),
        confidence=confidence,
        no_answer_reason=no_answer_reason,
    )


reranker_provider = MMarcoCrossEncoderReranker()
