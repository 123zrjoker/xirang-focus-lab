import hashlib

import numpy as np

from server.hybrid import hybrid_search
from server.retrieval import RetrievalChunk
from server.semantic import LocalVectorIndex


class FakeEmbeddingProvider:
    name = "fake-vector"
    dimensions = 48
    available = True
    checksum = "vector-checksum"

    def encode(self, text: str) -> np.ndarray:
        vector = np.zeros(self.dimensions, dtype=np.float32)
        compact = "".join(text.lower().split())
        for index in range(max(1, len(compact) - 1)):
            feature = compact[index:index + 2]
            bucket = int(hashlib.sha256(feature.encode()).hexdigest()[:8], 16) % self.dimensions
            vector[bucket] += 1
        norm = np.linalg.norm(vector)
        return vector / norm if norm else vector

    def encode_documents(self, texts):
        return np.stack([self.encode(text) for text in texts])

    def encode_query(self, text):
        return self.encode(text)


class PreferPdfReranker:
    name = "fake-cross-encoder"
    available = True

    def score(self, query, passages):
        return [0.95 if "PDF" in passage else 0.1 for passage in passages]


def make_chunk(identifier: str, heading: str, content: str) -> RetrievalChunk:
    return RetrievalChunk(
        id=identifier,
        source_id=identifier,
        source_title=f"资料 {identifier}",
        heading=heading,
        content=content,
        start_line=1,
        end_line=1,
        start_offset=0,
        end_offset=len(content),
    )


def test_rrf_fuses_keyword_and_vector_ranks_with_trace() -> None:
    chunks = [
        make_chunk("focus", "减少干扰", "专注时减少手机分心，把设备放远。"),
        make_chunk("pdf", "文档导入", "文字型 PDF 可以读取文字层和页码。"),
    ]
    index = LocalVectorIndex(provider=FakeEmbeddingProvider(), memory=True)
    index.sync(chunks)

    output = hybrid_search("如何减少手机分心", chunks, index, top_k=2)

    assert output.results[0].chunk.id == "focus"
    assert output.results[0].breakdown.rrf > 0
    assert output.results[0].breakdown.keyword_rank is not None
    assert output.results[0].breakdown.vector_rank is not None


def test_cross_encoder_reranking_exposes_rank_delta() -> None:
    chunks = [
        make_chunk("focus", "操作建议", "专注时把手机放远。"),
        make_chunk("pdf", "操作建议", "PDF 文档导入后检查页码。"),
        make_chunk("note", "操作建议", "笔记保存后可以搜索。"),
    ]
    index = LocalVectorIndex(provider=FakeEmbeddingProvider(), memory=True)
    index.sync(chunks)

    output = hybrid_search("操作建议", chunks, index, top_k=3, reranker=PreferPdfReranker())

    assert output.results[0].chunk.id == "pdf"
    assert output.results[0].breakdown.reranker == 0.95
    assert output.results[0].breakdown.rank_delta is not None
