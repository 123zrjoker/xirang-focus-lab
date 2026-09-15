from __future__ import annotations

import hashlib
import json
import time
import uuid
from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock, RLock
from typing import Callable, Optional, Protocol, Sequence

import numpy as np

from .retrieval import RankedChunk, RetrievalChunk, ScoreBreakdown, SearchOutput, normalize_text, tokenize
from .runtime_paths import (
    default_embedding_model_path,
    default_vector_index_path,
    default_vector_meta_path,
)


COLLECTION_NAME = "xirang_knowledge_chunks"
VECTOR_ENGINE_NAME = "bge-small-zh-v1.5+qdrant-local"
BGE_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："
QUERY_VECTOR_CACHE_CAPACITY = 128
QUERY_RESULT_CACHE_CAPACITY = 64


class ModelUnavailableError(RuntimeError):
    pass


class IndexNotReadyError(RuntimeError):
    pass


class IndexBusyError(RuntimeError):
    pass


class IndexSyncCancelled(RuntimeError):
    pass


class EmbeddingProvider(Protocol):
    name: str
    dimensions: int

    @property
    def available(self) -> bool: ...

    def encode_documents(self, texts: Sequence[str]) -> np.ndarray: ...

    def encode_query(self, text: str) -> np.ndarray: ...


class BgeEmbeddingProvider:
    name = "BAAI/bge-small-zh-v1.5"
    dimensions = 512

    def __init__(
        self,
        model_path: Optional[Path] = None,
        *,
        query_cache_capacity: int = QUERY_VECTOR_CACHE_CAPACITY,
    ) -> None:
        self.model_path = model_path or default_embedding_model_path()
        self._model = None
        self._checksum: Optional[str] = None
        self._model_lock = RLock()
        self._cache_lock = RLock()
        self._query_cache_capacity = max(0, query_cache_capacity)
        self._query_cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self._query_cache_hits = 0
        self._query_cache_misses = 0
        self._query_cache_evictions = 0

    @property
    def available(self) -> bool:
        return (self.model_path / "model.safetensors").is_file() and (self.model_path / "config.json").is_file()

    @property
    def checksum(self) -> Optional[str]:
        if not self.available:
            return None
        if self._checksum is None:
            digest = hashlib.sha256()
            with (self.model_path / "model.safetensors").open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
            self._checksum = digest.hexdigest()
        return self._checksum

    def _load(self):
        if not self.available:
            raise ModelUnavailableError(
                "本地 BGE 模型不完整。请先运行 scripts/download_retrieval_models.ps1，再重新构建索引。"
            )
        if self._model is None:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(str(self.model_path), local_files_only=True, device="cpu")
        return self._model

    def encode_documents(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.empty((0, self.dimensions), dtype=np.float32)
        with self._model_lock:
            values = self._load().encode(
                list(texts),
                batch_size=16,
                show_progress_bar=False,
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
        return np.asarray(values, dtype=np.float32)

    def encode_query(self, text: str) -> np.ndarray:
        cache_key = hashlib.sha256(text.encode("utf-8")).hexdigest()
        with self._cache_lock:
            cached = self._query_cache.pop(cache_key, None)
            if cached is not None:
                self._query_cache[cache_key] = cached
                self._query_cache_hits += 1
                return cached.copy()
            self._query_cache_misses += 1
        with self._model_lock:
            value = self._load().encode(
                [f"{BGE_QUERY_INSTRUCTION}{text}"],
                show_progress_bar=False,
                normalize_embeddings=True,
                convert_to_numpy=True,
            )[0]
        result = np.asarray(value, dtype=np.float32)
        with self._cache_lock:
            if self._query_cache_capacity > 0:
                self._query_cache[cache_key] = result.copy()
                while len(self._query_cache) > self._query_cache_capacity:
                    self._query_cache.popitem(last=False)
                    self._query_cache_evictions += 1
            return result

    def query_cache_status(self) -> dict[str, int]:
        with self._cache_lock:
            return {
                "capacity": self._query_cache_capacity,
                "size": len(self._query_cache),
                "hits": self._query_cache_hits,
                "misses": self._query_cache_misses,
                "evictions": self._query_cache_evictions,
            }

    def clear_query_cache(self) -> None:
        with self._cache_lock:
            self._query_cache.clear()


@dataclass(frozen=True)
class IndexSyncResult:
    fingerprint: str
    added: int
    updated: int
    removed: int
    unchanged: int
    chunk_count: int
    duration_ms: float
    built_at: str


def chunk_sha256(chunk: RetrievalChunk) -> str:
    value = "\n".join([
        chunk.id,
        chunk.source_id,
        chunk.source_title,
        chunk.heading,
        chunk.content,
        str(chunk.start_line),
        str(chunk.end_line),
        str(chunk.start_offset),
        str(chunk.end_offset),
    ])
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def corpus_sha256(chunks: Sequence[RetrievalChunk]) -> str:
    digest = hashlib.sha256()
    for chunk in sorted(chunks, key=lambda item: item.id):
        digest.update(f"{chunk.id}:{chunk_sha256(chunk)}\n".encode("utf-8"))
    return digest.hexdigest()


def chunk_embedding_text(chunk: RetrievalChunk) -> str:
    return "\n".join(part for part in (chunk.source_title, chunk.heading, chunk.content) if part).strip()


def _point_id(chunk_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"xirang://knowledge-chunk/{chunk_id}"))


def _payload(chunk: RetrievalChunk) -> dict:
    return {
        "chunkId": chunk.id,
        "chunkHash": chunk_sha256(chunk),
        "sourceId": chunk.source_id,
        "sourceTitle": chunk.source_title,
        "heading": chunk.heading,
        "content": chunk.content,
        "startLine": chunk.start_line,
        "endLine": chunk.end_line,
        "startOffset": chunk.start_offset,
        "endOffset": chunk.end_offset,
    }


def _chunk_from_payload(payload: dict) -> RetrievalChunk:
    return RetrievalChunk(
        id=str(payload["chunkId"]),
        source_id=str(payload["sourceId"]),
        source_title=str(payload["sourceTitle"]),
        heading=str(payload.get("heading", "")),
        content=str(payload["content"]),
        start_line=int(payload.get("startLine", 1)),
        end_line=int(payload.get("endLine", 1)),
        start_offset=int(payload.get("startOffset", 0)),
        end_offset=int(payload.get("endOffset", 0)),
    )


class LocalVectorIndex:
    def __init__(
        self,
        provider: Optional[EmbeddingProvider] = None,
        *,
        path: Optional[Path] = None,
        meta_path: Optional[Path] = None,
        memory: bool = False,
        query_cache_capacity: int = QUERY_RESULT_CACHE_CAPACITY,
    ) -> None:
        self.provider = provider or BgeEmbeddingProvider()
        self.path = path or default_vector_index_path()
        self.meta_path = None if memory else (meta_path or default_vector_meta_path())
        self.memory = memory
        self._client = None
        self._memory_meta: dict = {}
        self._operation_lock = RLock()
        self._sync_lock = Lock()
        self._cache_lock = RLock()
        self._mutation_generation = 0
        self._query_cache_capacity = max(0, query_cache_capacity)
        self._query_cache: OrderedDict[tuple[object, ...], SearchOutput] = OrderedDict()
        self._query_cache_hits = 0
        self._query_cache_misses = 0
        self._query_cache_evictions = 0
        self._query_cache_invalidations = 0

    def _query_cache_key(
        self,
        *,
        fingerprint: str,
        query: str,
        top_k: int,
        apply_threshold: bool,
        source_ids: Optional[Sequence[str]],
    ) -> tuple[object, ...]:
        return (
            str(self.path.resolve()) if not self.memory else "memory",
            fingerprint,
            getattr(self.provider, "checksum", None),
            normalize_text(query),
            top_k,
            apply_threshold,
            tuple(sorted(set(source_ids))) if source_ids is not None else None,
        )

    def _cached_search(self, key: tuple[object, ...], started: float) -> Optional[SearchOutput]:
        with self._cache_lock:
            cached = self._query_cache.pop(key, None)
            if cached is None:
                self._query_cache_misses += 1
                return None
            self._query_cache[key] = cached
            self._query_cache_hits += 1
            return replace(
                deepcopy(cached),
                duration_ms=round((time.perf_counter() - started) * 1_000, 3),
            )

    def _store_cached_search(self, key: tuple[object, ...], output: SearchOutput) -> None:
        if self._query_cache_capacity <= 0:
            return
        with self._cache_lock:
            self._query_cache[key] = deepcopy(output)
            self._query_cache.move_to_end(key)
            while len(self._query_cache) > self._query_cache_capacity:
                self._query_cache.popitem(last=False)
                self._query_cache_evictions += 1

    def _invalidate_query_cache(self) -> None:
        with self._cache_lock:
            self._query_cache.clear()
            self._query_cache_invalidations += 1

    def cache_status(self) -> dict[str, object]:
        with self._cache_lock:
            result_cache = {
                "capacity": self._query_cache_capacity,
                "size": len(self._query_cache),
                "hits": self._query_cache_hits,
                "misses": self._query_cache_misses,
                "evictions": self._query_cache_evictions,
                "invalidations": self._query_cache_invalidations,
            }
        provider_status = getattr(self.provider, "query_cache_status", None)
        return {
            "scope": "index-instance",
            "resultCache": result_cache,
            "vectorCache": provider_status() if callable(provider_status) else None,
        }

    def _qdrant(self):
        if self._client is None:
            try:
                from qdrant_client import QdrantClient
            except ImportError as error:
                raise ModelUnavailableError("缺少 qdrant-client，请安装 server/requirements.txt。") from error
            if self.memory:
                self._client = QdrantClient(":memory:")
            else:
                self.path.mkdir(parents=True, exist_ok=True)
                self._client = QdrantClient(path=str(self.path))
        return self._client

    def _read_meta(self) -> dict:
        if self.memory:
            return dict(self._memory_meta)
        if not self.meta_path or not self.meta_path.exists():
            return {}
        try:
            return json.loads(self.meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _write_meta(self, value: dict) -> None:
        if self.memory:
            self._memory_meta = dict(value)
            return
        assert self.meta_path is not None
        self.meta_path.parent.mkdir(parents=True, exist_ok=True)
        self.meta_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

    def _ensure_collection(self) -> None:
        from qdrant_client import models

        client = self._qdrant()
        if client.collection_exists(COLLECTION_NAME):
            info = client.get_collection(COLLECTION_NAME)
            vectors = info.config.params.vectors
            size = getattr(vectors, "size", None)
            if size == self.provider.dimensions:
                return
            client.delete_collection(COLLECTION_NAME)
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=models.VectorParams(size=self.provider.dimensions, distance=models.Distance.COSINE),
        )

    def _all_points(self) -> list:
        client = self._qdrant()
        if not client.collection_exists(COLLECTION_NAME):
            return []
        points: list = []
        offset = None
        while True:
            page, offset = client.scroll(
                collection_name=COLLECTION_NAME,
                limit=256,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            points.extend(page)
            if offset is None:
                return points

    def sync(
        self,
        chunks: Sequence[RetrievalChunk],
        *,
        on_progress: Optional[Callable[[str, int, int], None]] = None,
        should_cancel: Optional[Callable[[], bool]] = None,
    ) -> IndexSyncResult:
        from qdrant_client import models

        if not self._sync_lock.acquire(blocking=False):
            raise IndexBusyError("本地向量索引已有同步任务正在运行。")

        started = time.perf_counter()
        commit_started = False

        def report(stage: str, completed: int, total: int) -> None:
            if on_progress is not None:
                on_progress(stage, completed, total)

        def cancel_requested() -> bool:
            return should_cancel is not None and should_cancel()

        try:
            report("preparing", 0, len(chunks))
            if cancel_requested():
                raise IndexSyncCancelled("本地向量索引同步已取消。")

            with self._operation_lock:
                start_generation = self._mutation_generation
                previous_meta = self._read_meta()
                client = self._qdrant()
                incompatible_collection = False
                if client.collection_exists(COLLECTION_NAME):
                    info = client.get_collection(COLLECTION_NAME)
                    vectors = info.config.params.vectors
                    incompatible_collection = getattr(vectors, "size", None) != self.provider.dimensions
                current = {} if incompatible_collection else {
                    str(point.payload.get("chunkId")): point
                    for point in self._all_points()
                    if point.payload and point.payload.get("chunkId")
                }

            incoming = {chunk.id: chunk for chunk in chunks}
            model_checksum = getattr(self.provider, "checksum", None)
            force_reencode = (
                incompatible_collection
                or previous_meta.get("syncState") in {"committing", "failed"}
                or (
                    bool(previous_meta.get("fingerprint"))
                    and (
                    previous_meta.get("model") != self.provider.name
                    or previous_meta.get("dimensions") != self.provider.dimensions
                    or previous_meta.get("modelChecksum") != model_checksum
                    )
                )
            )
            added_ids = [identifier for identifier in incoming if identifier not in current]
            updated_ids = [
                identifier for identifier, chunk in incoming.items()
                if identifier in current and (
                    force_reencode
                    or current[identifier].payload.get("chunkHash") != chunk_sha256(chunk)
                )
            ]
            removed_ids = [identifier for identifier in current if identifier not in incoming]
            changed_ids = added_ids + updated_ids
            report("preparing", len(chunks), len(chunks))

            encoded_batches: list[np.ndarray] = []
            report("embedding", 0, len(changed_ids))
            for offset in range(0, len(changed_ids), 16):
                if cancel_requested():
                    raise IndexSyncCancelled("本地向量索引同步已取消。")
                batch_ids = changed_ids[offset:offset + 16]
                encoded_batches.append(self.provider.encode_documents([
                    chunk_embedding_text(incoming[identifier]) for identifier in batch_ids
                ]))
                report("embedding", min(offset + len(batch_ids), len(changed_ids)), len(changed_ids))

            if cancel_requested():
                raise IndexSyncCancelled("本地向量索引同步已取消。")
            encoded = np.concatenate(encoded_batches, axis=0) if encoded_batches else np.empty(
                (0, self.provider.dimensions),
                dtype=np.float32,
            )
            fingerprint = corpus_sha256(chunks)
            built_at = datetime.now(timezone.utc).isoformat()
            changed_index = bool(changed_ids or removed_ids or force_reencode)
            commit_total = max(1, len(changed_ids) + len(removed_ids))
            report("committing", 0, commit_total)

            with self._operation_lock:
                if self._mutation_generation != start_generation:
                    raise IndexBusyError("索引在同步准备期间已被其他操作修改，请重试。")
                if changed_index:
                    self._write_meta({
                        "syncState": "committing",
                        "startedAt": built_at,
                        "previousFingerprint": previous_meta.get("fingerprint"),
                        "model": self.provider.name,
                        "dimensions": self.provider.dimensions,
                        "modelChecksum": model_checksum,
                    })
                    commit_started = True
                    self._invalidate_query_cache()
                    self._ensure_collection()
                    committed = 0
                    for offset in range(0, len(changed_ids), 128):
                        batch_ids = changed_ids[offset:offset + 128]
                        points = [
                            models.PointStruct(
                                id=_point_id(identifier),
                                vector=vector.tolist(),
                                payload=_payload(incoming[identifier]),
                            )
                            for identifier, vector in zip(batch_ids, encoded[offset:offset + len(batch_ids)])
                        ]
                        client.upsert(collection_name=COLLECTION_NAME, points=points, wait=True)
                        committed += len(batch_ids)
                        report("committing", committed, commit_total)
                    if removed_ids:
                        client.delete(
                            collection_name=COLLECTION_NAME,
                            points_selector=models.PointIdsList(points=[_point_id(identifier) for identifier in removed_ids]),
                            wait=True,
                        )
                        committed += len(removed_ids)
                        report("committing", committed, commit_total)

                meta = {
                    "syncState": "ready",
                    "fingerprint": fingerprint,
                    "chunkCount": len(chunks),
                    "model": self.provider.name,
                    "dimensions": self.provider.dimensions,
                    "builtAt": built_at,
                    "modelChecksum": model_checksum,
                }
                self._write_meta(meta)
                self._mutation_generation += 1
                if not changed_index and previous_meta.get("fingerprint") != fingerprint:
                    self._invalidate_query_cache()

            report("completed", commit_total, commit_total)
            return IndexSyncResult(
                fingerprint=fingerprint,
                added=len(added_ids),
                updated=len(updated_ids),
                removed=len(removed_ids),
                unchanged=len(chunks) - len(changed_ids),
                chunk_count=len(chunks),
                duration_ms=round((time.perf_counter() - started) * 1_000, 3),
                built_at=built_at,
            )
        except (IndexSyncCancelled, IndexBusyError):
            raise
        except Exception:
            if commit_started:
                with self._operation_lock:
                    try:
                        self._write_meta({
                            "syncState": "failed",
                            "failedAt": datetime.now(timezone.utc).isoformat(),
                            "model": self.provider.name,
                            "dimensions": self.provider.dimensions,
                            "modelChecksum": getattr(self.provider, "checksum", None),
                        })
                    finally:
                        self._mutation_generation += 1
                        self._invalidate_query_cache()
            raise
        finally:
            self._sync_lock.release()

    def status(self) -> dict:
        with self._operation_lock:
            meta = self._read_meta()
            client = self._qdrant()
            count = 0
            if client.collection_exists(COLLECTION_NAME):
                count = int(client.count(COLLECTION_NAME, exact=True).count)
            sync_state = str(meta.get("syncState") or ("ready" if meta.get("fingerprint") else "idle"))
            recovery_required = sync_state in {"committing", "failed"}
            return {
                "ready": not recovery_required and bool(meta.get("fingerprint")) and count > 0,
                "chunkCount": count,
                "fingerprint": meta.get("fingerprint"),
                "model": self.provider.name,
                "dimensions": self.provider.dimensions,
                "modelAvailable": self.provider.available,
                "modelChecksum": getattr(self.provider, "checksum", None),
                "builtAt": meta.get("builtAt"),
                "storage": "memory" if self.memory else str(self.path),
                "syncState": sync_state,
                "recoveryRequired": recovery_required,
            }

    def chunks(self) -> list[RetrievalChunk]:
        with self._operation_lock:
            return [_chunk_from_payload(point.payload) for point in self._all_points() if point.payload]

    def search(
        self,
        query: str,
        top_k: int = 5,
        *,
        apply_threshold: bool = True,
        source_ids: Optional[Sequence[str]] = None,
    ) -> SearchOutput:
        started = time.perf_counter()
        with self._operation_lock:
            meta = self._read_meta()
            if not meta.get("fingerprint") or meta.get("syncState") in {"committing", "failed"}:
                raise IndexNotReadyError("本地向量索引尚未构建或需要重新同步。")
            cache_key = self._query_cache_key(
                fingerprint=str(meta["fingerprint"]),
                query=query,
                top_k=top_k,
                apply_threshold=apply_threshold,
                source_ids=source_ids,
            )
            cached = self._cached_search(cache_key, started)
            if cached is not None:
                return cached
            output = self._search_uncached(
                query,
                top_k,
                apply_threshold=apply_threshold,
                source_ids=source_ids,
                started=started,
            )
            self._store_cached_search(cache_key, output)
            return output

    def _search_uncached(
        self,
        query: str,
        top_k: int,
        *,
        apply_threshold: bool,
        source_ids: Optional[Sequence[str]],
        started: float,
    ) -> SearchOutput:
        allowed_source_ids = set(source_ids) if source_ids is not None else None
        corpus = self.chunks()
        if allowed_source_ids is not None:
            corpus = [chunk for chunk in corpus if chunk.source_id in allowed_source_ids]
        if not corpus:
            return SearchOutput(
                query=query,
                normalized_query=normalize_text(query),
                query_terms=tokenize(query),
                results=[],
                duration_ms=round((time.perf_counter() - started) * 1_000, 3),
                chunk_count=0,
                source_count=0,
                average_chunk_length=0.0,
                confidence="none",
                no_answer_reason="本次授权范围内没有可检索的知识片段。",
            )
        query_vector = self.provider.encode_query(query)
        query_filter = None
        if allowed_source_ids is not None:
            from qdrant_client import models

            query_filter = models.Filter(must=[models.FieldCondition(
                key="sourceId",
                match=models.MatchAny(any=sorted(allowed_source_ids)),
            )])
        response = self._qdrant().query_points(
            collection_name=COLLECTION_NAME,
            query=query_vector.tolist(),
            query_filter=query_filter,
            limit=top_k,
            with_payload=True,
            with_vectors=False,
        )
        query_terms = tokenize(query)
        ranked: list[RankedChunk] = []
        for point in response.points:
            if not point.payload:
                continue
            chunk = _chunk_from_payload(point.payload)
            haystack_terms = set(tokenize(chunk_embedding_text(chunk)))
            matched = [term for term in query_terms if term in haystack_terms]
            score = float(point.score)
            ranked.append(RankedChunk(
                chunk=chunk,
                score=score,
                breakdown=ScoreBreakdown(
                    bm25=0.0,
                    title_boost=0.0,
                    heading_boost=0.0,
                    phrase_boost=0.0,
                    coverage_boost=0.0,
                    vector=score,
                ),
                matched_terms=matched,
                query_coverage=len(matched) / len(query_terms) if query_terms else 0.0,
                excerpt=chunk.content if len(chunk.content) <= 210 else f"{chunk.content[:207].strip()}…",
            ))

        confidence = "none"
        no_answer_reason = "向量相似度低于拒答阈值，暂不返回可能误导的结果。"
        if ranked and (not apply_threshold or ranked[0].score >= 0.48):
            confidence = "strong" if ranked[0].score >= 0.72 else "possible"
            no_answer_reason = None
        elif apply_threshold:
            ranked = []
        average_length = sum(len(tokenize(chunk.content)) for chunk in corpus) / len(corpus) if corpus else 0.0
        return SearchOutput(
            query=query,
            normalized_query=normalize_text(query),
            query_terms=query_terms,
            results=ranked,
            duration_ms=round((time.perf_counter() - started) * 1_000, 3),
            chunk_count=len(corpus),
            source_count=len({chunk.source_id for chunk in corpus}),
            average_chunk_length=round(average_length, 2),
            confidence=confidence,
            no_answer_reason=no_answer_reason,
        )

    def clear(self) -> None:
        if not self._sync_lock.acquire(blocking=False):
            raise IndexBusyError("索引同步期间不能清除向量索引，请先取消任务。")
        try:
            with self._operation_lock:
                client = self._qdrant()
                if client.collection_exists(COLLECTION_NAME):
                    client.delete_collection(COLLECTION_NAME)
                self._write_meta({})
                self._mutation_generation += 1
                self._invalidate_query_cache()
        finally:
            self._sync_lock.release()

    def close(self) -> None:
        with self._sync_lock:
            with self._operation_lock:
                client = self._client
                self._client = None
                self._invalidate_query_cache()
                if client is not None and hasattr(client, "close"):
                    client.close()


semantic_index = LocalVectorIndex()
