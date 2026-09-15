import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import numpy as np
import pytest
from fastapi.testclient import TestClient

import server.main as main_module
from server.retrieval import RetrievalChunk
from server.semantic import BgeEmbeddingProvider, IndexSyncCancelled, LocalVectorIndex, corpus_sha256


class FakeEmbeddingProvider:
    name = "fake-semantic-v1"
    dimensions = 64
    available = True
    checksum = "test-checksum"

    def __init__(self) -> None:
        self.document_calls = 0
        self.query_calls = 0

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
        self.document_calls += 1
        return np.stack([self._encode(text) for text in texts])

    def encode_query(self, text):
        self.query_calls += 1
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


def test_vector_search_enforces_authorized_source_filter() -> None:
    index = LocalVectorIndex(provider=FakeEmbeddingProvider(), memory=True)
    index.sync([
        chunk("focus", "专注时减少手机分心，把设备放远。"),
        chunk("pdf", "文字型 PDF 可以读取文字层和页码。"),
    ])

    output = index.search(
        "专注时减少手机分心，把设备放远。",
        top_k=2,
        apply_threshold=False,
        source_ids=["source-pdf"],
    )

    assert [item.chunk.source_id for item in output.results] == ["source-pdf"]
    assert output.source_count == 1
    assert output.chunk_count == 1


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


def test_query_result_cache_is_bounded_thread_safe_and_invalidated() -> None:
    provider = FakeEmbeddingProvider()
    index = LocalVectorIndex(provider=provider, memory=True, query_cache_capacity=2)
    original = [chunk("focus", "专注时减少手机分心，把设备放远。")]
    index.sync(original)

    with ThreadPoolExecutor(max_workers=4) as executor:
        outputs = list(executor.map(
            lambda _item: index.search("减少手机分心", top_k=1, apply_threshold=False),
            range(4),
        ))

    assert all(output.results for output in outputs)
    assert provider.query_calls == 1
    assert index.cache_status()["resultCache"]["hits"] == 3

    index.search("开始困难任务", top_k=1, apply_threshold=False)
    index.search("处理文字 PDF", top_k=1, apply_threshold=False)
    index.search("减少手机分心", top_k=1, apply_threshold=False)
    assert provider.query_calls == 4
    assert index.cache_status()["resultCache"]["size"] == 2
    assert index.cache_status()["resultCache"]["evictions"] >= 2

    index.sync([chunk("focus", "专注前将手机静音并放到另一个房间。")])
    index.search("减少手机分心", top_k=1, apply_threshold=False)
    assert provider.query_calls == 5
    assert index.cache_status()["resultCache"]["invalidations"] >= 2


def test_embedding_cache_is_bounded_and_does_not_retain_plaintext_keys(monkeypatch, tmp_path) -> None:
    class FakeSentenceModel:
        def encode(self, texts, **_kwargs):
            return np.stack([np.full(512, index + 1, dtype=np.float32) for index, _text in enumerate(texts)])

    provider = BgeEmbeddingProvider(tmp_path, query_cache_capacity=2)
    monkeypatch.setattr(provider, "_load", lambda: FakeSentenceModel())

    provider.encode_query("私人查询一")
    provider.encode_query("私人查询一")
    provider.encode_query("私人查询二")
    provider.encode_query("私人查询三")

    status = provider.query_cache_status()
    assert status == {"capacity": 2, "size": 2, "hits": 1, "misses": 3, "evictions": 1}
    assert all(len(key) == 64 for key in provider._query_cache)
    assert "私人查询" not in repr(provider._query_cache)


def test_cancelled_sync_preserves_previous_ready_index() -> None:
    index = LocalVectorIndex(provider=FakeEmbeddingProvider(), memory=True)
    original = [chunk("original", "原有索引应在取消后继续可用。")]
    previous = index.sync(original)
    cancel_event = Event()
    changed = [chunk(f"changed-{item}", f"需要重新编码的文本 {item}") for item in range(20)]

    def progress(stage: str, completed: int, _total: int) -> None:
        if stage == "embedding" and completed >= 16:
            cancel_event.set()

    with pytest.raises(IndexSyncCancelled):
        index.sync(changed, on_progress=progress, should_cancel=cancel_event.is_set)

    status = index.status()
    assert status["ready"] is True
    assert status["fingerprint"] == previous.fingerprint
    assert [item.id for item in index.chunks()] == ["original"]


def test_failed_commit_fails_closed_and_next_sync_recovers(monkeypatch) -> None:
    index = LocalVectorIndex(provider=FakeEmbeddingProvider(), memory=True)
    original = [chunk("focus", "旧索引内容。")]
    updated = [chunk("focus", "修订后的索引内容。")]
    index.sync(original)
    ensure_collection = index._ensure_collection

    def fail_commit() -> None:
        raise RuntimeError("injected commit failure")

    monkeypatch.setattr(index, "_ensure_collection", fail_commit)
    with pytest.raises(RuntimeError, match="injected commit failure"):
        index.sync(updated)

    failed = index.status()
    assert failed["ready"] is False
    assert failed["syncState"] == "failed"
    assert failed["recoveryRequired"] is True

    monkeypatch.setattr(index, "_ensure_collection", ensure_collection)
    recovered = index.sync(updated)
    assert recovered.updated == 1
    assert index.status()["ready"] is True
    assert index.status()["syncState"] == "ready"
