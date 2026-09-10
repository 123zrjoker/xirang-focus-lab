import hashlib

import numpy as np
from fastapi.testclient import TestClient

import server.main as main_module
from server.retrieval import RetrievalChunk
from server.semantic import LocalVectorIndex, corpus_sha256


class FakeEmbeddingProvider:
    name = "fake-semantic-v1"
    dimensions = 64
    available = True
    checksum = "test-checksum"

    def _encode(self, text: str) -> np.ndarray:
        vector = np.zeros(self.dimensions, dtype=np.float32)
        normalized = "".join(text.lower().split())
        features = [normalized[index:index + 2] for index in range(max(1, len(normalized) - 1))]
        for feature in features:
            bucket = int(hashlib.sha256(feature.encode("utf-8")).hexdigest()[:8], 16) % self.dimensions
            vector[bucket] += 1
        norm = np.linalg.norm(vector)
        return vector / norm if norm else vector

    def encode_documents(self, texts):
        return np.stack([self._encode(text) for text in texts])

    def encode_query(self, text):
        return self._encode(text)


def chunk(identifier: str, content: str) -> RetrievalChunk:
    return RetrievalChunk(
        id=identifier,
        source_id=f"source-{identifier}",
        source_title=f"资料 {identifier}",
        heading="操作建议",
        content=content,
        start_line=1,
        end_line=2,
        start_offset=0,
        end_offset=len(content),
    )


def test_qdrant_local_index_sync_is_sha256_incremental() -> None:
    index = LocalVectorIndex(provider=FakeEmbeddingProvider(), memory=True)
    original = [
        chunk("focus", "专注前把手机调成静音并放到看不见的位置。"),
        chunk("start", "把困难任务缩小成一个可以立刻执行的动作。"),
    ]

    first = index.sync(original)
    second = index.sync(original)
    changed = [original[0], chunk("start", "先打开文档，只写下标题。"), chunk("pdf", "文字型 PDF 可以提取文字层。")]
    third = index.sync(changed)

    assert first.added == 2
    assert first.fingerprint == corpus_sha256(original)
    assert second.unchanged == 2
    assert second.added == second.updated == second.removed == 0
    assert third.added == 1
    assert third.updated == 1
    assert third.removed == 0
    assert index.status()["chunkCount"] == 3


def test_vector_search_returns_traceable_qdrant_payload() -> None:
    index = LocalVectorIndex(provider=FakeEmbeddingProvider(), memory=True)
    index.sync([
        chunk("focus", "专注时减少手机分心，把设备放远。"),
        chunk("pdf", "文字型 PDF 可以读取文字层和页码。"),
    ])

    output = index.search("专注时减少手机分心，把设备放远。", top_k=2)

    assert output.results[0].chunk.id == "focus"
    assert output.results[0].breakdown.vector > 0
    assert output.chunk_count == 2


def test_vector_api_exposes_index_metadata_and_clear(monkeypatch) -> None:
    index = LocalVectorIndex(provider=FakeEmbeddingProvider(), memory=True)
    monkeypatch.setattr(main_module, "semantic_index", index)
    client = TestClient(main_module.app)
    payload = [{
        "id": "focus",
        "sourceId": "note-1",
        "sourceTitle": "专注笔记",
        "heading": "减少干扰",
        "content": "专注时减少手机分心，把设备放远。",
        "startLine": 1,
        "endLine": 1,
        "startOffset": 0,
        "endOffset": 18,
    }]

    synced = client.post("/api/index/sync", json={"chunks": payload})
    searched = client.post("/api/retrieval/search", json={
        "query": "如何减少手机分心",
        "mode": "vector",
        "topK": 3,
        "corpusFingerprint": synced.json()["fingerprint"],
    })
    cleared = client.delete("/api/index")

    assert synced.status_code == 200
    assert synced.json()["dimensions"] == 64
    assert searched.status_code == 200
    assert searched.json()["mode"] == "vector"
    assert searched.json()["results"][0]["chunkId"] == "focus"
    assert cleared.json()["ready"] is False
