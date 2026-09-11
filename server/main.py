from __future__ import annotations

from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .retrieval import (
    ENGINE_NAME,
    MAX_CHUNKS,
    MAX_CORPUS_CHARACTERS,
    MAX_QUERY_CHARACTERS,
    RetrievalChunk,
    search_chunks,
)
from .semantic import (
    VECTOR_ENGINE_NAME,
    IndexNotReadyError,
    ModelUnavailableError,
    semantic_index,
)
from .hybrid import RERANK_ENGINE_NAME, RRF_ENGINE_NAME, hybrid_search, reranker_provider
from .generation import (
    ProviderResponseError,
    ProviderUnavailableError,
    build_context,
    generation_provider,
)


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ChunkInput(ApiModel):
    id: str = Field(min_length=1, max_length=200)
    source_id: str = Field(min_length=1, max_length=200)
    source_title: str = Field(min_length=1, max_length=500)
    heading: str = Field(default="", max_length=1_000)
    content: str = Field(min_length=1, max_length=100_000)
    start_line: int = Field(default=1, ge=1)
    end_line: int = Field(default=1, ge=1)
    start_offset: int = Field(default=0, ge=0)
    end_offset: int = Field(default=0, ge=0)
    content_hash: Optional[str] = Field(default=None, max_length=128)
    source_content_hash: Optional[str] = Field(default=None, max_length=128)


class SearchRequest(ApiModel):
    query: str = Field(min_length=1, max_length=MAX_QUERY_CHARACTERS)
    chunks: list[ChunkInput] = Field(default_factory=list, max_length=MAX_CHUNKS)
    top_k: int = Field(default=5, ge=1, le=10)
    mode: Literal["keyword", "vector", "hybrid", "hybrid_rerank"] = "keyword"
    corpus_fingerprint: Optional[str] = Field(default=None, max_length=128)


class IndexSyncRequest(ApiModel):
    chunks: list[ChunkInput] = Field(max_length=MAX_CHUNKS)


class ScoreBreakdownResponse(ApiModel):
    bm25: float
    title_boost: float
    heading_boost: float
    phrase_boost: float
    coverage_boost: float
    vector: float = 0.0
    rrf: float = 0.0
    reranker: Optional[float] = None
    keyword_rank: Optional[int] = None
    vector_rank: Optional[int] = None
    rank_delta: Optional[int] = None


class SearchResultResponse(ApiModel):
    chunk_id: str
    source_id: str
    source_title: str
    heading: str
    content: str
    excerpt: str
    score: float
    score_breakdown: ScoreBreakdownResponse
    matched_terms: list[str]
    query_coverage: float
    start_line: int
    end_line: int
    start_offset: int
    end_offset: int


class CorpusStatsResponse(ApiModel):
    chunk_count: int
    source_count: int
    average_chunk_length: float


class SearchResponse(ApiModel):
    engine: str
    mode: str
    query: str
    normalized_query: str
    query_terms: list[str]
    results: list[SearchResultResponse]
    duration_ms: float
    confidence: Literal["strong", "possible", "none"]
    no_answer_reason: Optional[str]
    corpus_stats: CorpusStatsResponse
    warnings: list[str] = Field(default_factory=list)


class IndexStatusResponse(ApiModel):
    ready: bool
    chunk_count: int
    fingerprint: Optional[str]
    model: str
    dimensions: int
    model_available: bool
    model_checksum: Optional[str]
    built_at: Optional[str]
    storage: str


class IndexSyncResponse(ApiModel):
    fingerprint: str
    added: int
    updated: int
    removed: int
    unchanged: int
    chunk_count: int
    duration_ms: float
    built_at: str
    model: str
    dimensions: int


class RagAnswerRequest(ApiModel):
    query: str = Field(min_length=1, max_length=MAX_QUERY_CHARACTERS)
    corpus_fingerprint: str = Field(min_length=64, max_length=64)
    retrieval_mode: Literal["hybrid", "hybrid_rerank"] = "hybrid_rerank"
    top_k: int = Field(default=6, ge=1, le=8)
    preview_only: bool = False


class RagEvidenceResponse(ApiModel):
    reference_id: str
    chunk_id: str
    source_id: str
    source_title: str
    heading: str
    content: str
    start_line: int
    end_line: int
    start_offset: int
    end_offset: int
    retrieval_score: float
    truncated: bool
    instruction_flagged: bool


class RagRetrievalResponse(ApiModel):
    engine: str
    mode: str
    confidence: Literal["strong", "possible", "none"]
    duration_ms: float


class RagContextStatsResponse(ApiModel):
    evidence_count: int
    used_characters: int
    omitted_count: int
    flagged_reference_ids: list[str]


class RagGenerationResponse(ApiModel):
    duration_ms: float
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None


class RagAnswerResponse(ApiModel):
    status: Literal["context_only", "answered", "refused"]
    query: str
    answer: Optional[str]
    citation_ids: list[str]
    uncertainties: list[str]
    evidence: list[RagEvidenceResponse]
    provider: Optional[str]
    model: Optional[str]
    retrieval: RagRetrievalResponse
    context: RagContextStatsResponse
    generation: Optional[RagGenerationResponse] = None
    warnings: list[str] = Field(default_factory=list)


app = FastAPI(
    title="Xirang Retrieval Service",
    description="Local keyword and semantic retrieval service for the Xirang knowledge base.",
    version=__version__,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "null"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health")
def health() -> dict:
    try:
        index = semantic_index.status()
    except Exception:
        index = {
            "ready": False,
            "chunkCount": 0,
            "model": semantic_index.provider.name,
            "dimensions": semantic_index.provider.dimensions,
            "modelAvailable": semantic_index.provider.available,
        }
    return {
        "status": "ok",
        "version": __version__,
        "retrievalEngine": ENGINE_NAME,
        "storesData": bool(index.get("ready")),
        "semanticEngine": VECTOR_ENGINE_NAME,
        "reranker": {
            "model": reranker_provider.name,
            "available": reranker_provider.available,
            "checksum": reranker_provider.checksum,
        },
        "generation": generation_provider.status(),
        "index": index,
    }


def request_chunks(items: list[ChunkInput]) -> list[RetrievalChunk]:
    total_characters = sum(len(chunk.content) + len(chunk.source_title) + len(chunk.heading) for chunk in items)
    if total_characters > MAX_CORPUS_CHARACTERS:
        raise HTTPException(status_code=413, detail="本次检索语料超过 800 万字符，请缩小知识库范围。")
    return [RetrievalChunk(
        id=item.id,
        source_id=item.source_id,
        source_title=item.source_title,
        heading=item.heading,
        content=item.content,
        start_line=item.start_line,
        end_line=item.end_line,
        start_offset=item.start_offset,
        end_offset=item.end_offset,
    ) for item in items]


@app.get("/api/index/status", response_model=IndexStatusResponse)
def index_status() -> IndexStatusResponse:
    return IndexStatusResponse(**semantic_index.status())


@app.post("/api/index/sync", response_model=IndexSyncResponse)
def sync_index(request: IndexSyncRequest) -> IndexSyncResponse:
    chunks = request_chunks(request.chunks)
    if not chunks:
        raise HTTPException(status_code=422, detail="知识库中还没有可构建索引的文本块。")
    try:
        result = semantic_index.sync(chunks)
    except ModelUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return IndexSyncResponse(
        **result.__dict__,
        model=semantic_index.provider.name,
        dimensions=semantic_index.provider.dimensions,
    )


@app.delete("/api/index", response_model=IndexStatusResponse)
def clear_index() -> IndexStatusResponse:
    semantic_index.clear()
    return IndexStatusResponse(**semantic_index.status())


@app.post("/api/retrieval/search", response_model=SearchResponse)
def search(request: SearchRequest) -> SearchResponse:
    chunks = request_chunks(request.chunks)
    warnings: list[str] = []
    if request.mode in ("vector", "hybrid", "hybrid_rerank"):
        status = semantic_index.status()
        if request.corpus_fingerprint and status.get("fingerprint") != request.corpus_fingerprint:
            raise HTTPException(status_code=409, detail="知识库已变化，请先同步本地向量索引。")
        try:
            if request.mode == "vector":
                output = semantic_index.search(request.query, request.top_k)
                engine = VECTOR_ENGINE_NAME
            else:
                indexed_chunks = semantic_index.chunks()
                active_reranker = None
                if request.mode == "hybrid_rerank":
                    if reranker_provider.available:
                        active_reranker = reranker_provider
                    else:
                        warnings.append("多语言 Cross-Encoder 尚未准备好，已降级为 RRF 混合检索。")
                output = hybrid_search(
                    request.query,
                    indexed_chunks,
                    semantic_index,
                    request.top_k,
                    reranker=active_reranker,
                )
                engine = RERANK_ENGINE_NAME if active_reranker else RRF_ENGINE_NAME
        except IndexNotReadyError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ModelUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
    else:
        if not chunks:
            try:
                chunks = semantic_index.chunks()
            except Exception:
                chunks = []
        output = search_chunks(request.query, chunks, request.top_k)
        engine = ENGINE_NAME
    return SearchResponse(
        engine=engine,
        mode=request.mode,
        query=output.query,
        normalized_query=output.normalized_query,
        query_terms=output.query_terms,
        results=[SearchResultResponse(
            chunk_id=result.chunk.id,
            source_id=result.chunk.source_id,
            source_title=result.chunk.source_title,
            heading=result.chunk.heading,
            content=result.chunk.content,
            excerpt=result.excerpt,
            score=round(result.score, 6),
            score_breakdown=ScoreBreakdownResponse(
                bm25=round(result.breakdown.bm25, 6),
                title_boost=round(result.breakdown.title_boost, 6),
                heading_boost=round(result.breakdown.heading_boost, 6),
                phrase_boost=round(result.breakdown.phrase_boost, 6),
                coverage_boost=round(result.breakdown.coverage_boost, 6),
                vector=round(result.breakdown.vector, 6),
                rrf=round(result.breakdown.rrf, 6),
                reranker=round(result.breakdown.reranker, 6) if result.breakdown.reranker is not None else None,
                keyword_rank=result.breakdown.keyword_rank,
                vector_rank=result.breakdown.vector_rank,
                rank_delta=result.breakdown.rank_delta,
            ),
            matched_terms=result.matched_terms,
            query_coverage=round(result.query_coverage, 6),
            start_line=result.chunk.start_line,
            end_line=result.chunk.end_line,
            start_offset=result.chunk.start_offset,
            end_offset=result.chunk.end_offset,
        ) for result in output.results],
        duration_ms=output.duration_ms,
        confidence=output.confidence,
        no_answer_reason=output.no_answer_reason,
        corpus_stats=CorpusStatsResponse(
            chunk_count=output.chunk_count,
            source_count=output.source_count,
            average_chunk_length=output.average_chunk_length,
        ),
        warnings=warnings,
    )


@app.post("/api/rag/answer", response_model=RagAnswerResponse)
def answer_with_rag(request: RagAnswerRequest) -> RagAnswerResponse:
    warnings: list[str] = []
    status = semantic_index.status()
    if status.get("fingerprint") != request.corpus_fingerprint:
        raise HTTPException(status_code=409, detail="知识库已变化，请先同步本地向量索引。")
    try:
        chunks = semantic_index.chunks()
        active_reranker = None
        if request.retrieval_mode == "hybrid_rerank":
            if reranker_provider.available:
                active_reranker = reranker_provider
            else:
                warnings.append("多语言 Cross-Encoder 尚未准备好，上下文检索已降级为 RRF。")
        retrieval = hybrid_search(
            request.query,
            chunks,
            semantic_index,
            request.top_k,
            reranker=active_reranker,
        )
        engine = RERANK_ENGINE_NAME if active_reranker else RRF_ENGINE_NAME
    except IndexNotReadyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ModelUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    context = build_context(retrieval.results)
    if context.flagged_reference_ids:
        warnings.append(
            "部分资料包含疑似指令文本，已标记为不可信证据且不会作为系统指令执行："
            + "、".join(context.flagged_reference_ids)
        )
    evidence = [RagEvidenceResponse(
        reference_id=item.reference_id,
        chunk_id=item.chunk_id,
        source_id=item.source_id,
        source_title=item.source_title,
        heading=item.heading,
        content=item.content,
        start_line=item.start_line,
        end_line=item.end_line,
        start_offset=item.start_offset,
        end_offset=item.end_offset,
        retrieval_score=round(item.retrieval_score, 6),
        truncated=item.truncated,
        instruction_flagged=item.instruction_flagged,
    ) for item in context.evidence]
    retrieval_response = RagRetrievalResponse(
        engine=engine,
        mode=request.retrieval_mode,
        confidence=retrieval.confidence,
        duration_ms=retrieval.duration_ms,
    )
    context_response = RagContextStatsResponse(
        evidence_count=len(context.evidence),
        used_characters=context.used_characters,
        omitted_count=context.omitted_count,
        flagged_reference_ids=context.flagged_reference_ids,
    )

    if not context.evidence:
        return RagAnswerResponse(
            status="refused",
            query=request.query,
            answer="知识库中没有找到足够依据，未调用 AI 生成平台。",
            citation_ids=[],
            uncertainties=[retrieval.no_answer_reason or "当前资料不足以回答。"],
            evidence=[],
            provider=None,
            model=None,
            retrieval=retrieval_response,
            context=context_response,
            warnings=warnings,
        )
    if request.preview_only:
        return RagAnswerResponse(
            status="context_only",
            query=request.query,
            answer=None,
            citation_ids=[],
            uncertainties=[],
            evidence=evidence,
            provider=None,
            model=None,
            retrieval=retrieval_response,
            context=context_response,
            warnings=warnings,
        )
    try:
        generated = generation_provider.generate_answer(request.query, context.evidence)
    except ProviderUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ProviderResponseError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    return RagAnswerResponse(
        status="refused" if generated.payload.refused else "answered",
        query=request.query,
        answer=generated.payload.answer,
        citation_ids=generated.payload.citation_ids,
        uncertainties=generated.payload.uncertainties,
        evidence=evidence,
        provider=generated.provider,
        model=generated.model,
        retrieval=retrieval_response,
        context=context_response,
        generation=RagGenerationResponse(
            duration_ms=generated.duration_ms,
            input_tokens=generated.input_tokens,
            output_tokens=generated.output_tokens,
        ),
        warnings=warnings,
    )
