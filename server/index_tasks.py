from __future__ import annotations

from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from copy import deepcopy
from dataclasses import asdict
from datetime import datetime, timezone
from threading import Event, RLock
from typing import Sequence
from uuid import uuid4

from .retrieval import RetrievalChunk
from .semantic import IndexSyncCancelled, LocalVectorIndex


ACTIVE_STATES = {"queued", "running", "cancel_requested"}
TERMINAL_STATES = {"succeeded", "failed", "cancelled"}
CANCELLABLE_STAGES = {"queued", "preparing", "embedding"}


class IndexTaskConflictError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class IndexSyncTaskManager:
    """Run one cancellable index sync at a time without exposing source content in status."""

    def __init__(self, index: LocalVectorIndex) -> None:
        self.index = index
        self._lock = RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="xirang-index")
        self._task: dict[str, object] | None = None
        self._future: Future | None = None
        self._cancel_event: Event | None = None
        self._closed = False

    @staticmethod
    def idle_status() -> dict[str, object]:
        return {
            "taskId": None,
            "state": "idle",
            "stage": "idle",
            "progress": 0.0,
            "completedItems": 0,
            "totalItems": 0,
            "cancelRequested": False,
            "cancellable": False,
            "createdAt": None,
            "startedAt": None,
            "finishedAt": None,
            "result": None,
            "error": None,
        }

    def status(self) -> dict[str, object]:
        with self._lock:
            return deepcopy(self._task) if self._task is not None else self.idle_status()

    def start(self, chunks: Sequence[RetrievalChunk]) -> dict[str, object]:
        with self._lock:
            if self._closed:
                raise RuntimeError("索引后台任务管理器已关闭。")
            if self._task is not None and self._task["state"] in ACTIVE_STATES:
                raise IndexTaskConflictError("已有本地向量索引任务正在运行。")
            task_id = str(uuid4())
            cancel_event = Event()
            self._task = {
                "taskId": task_id,
                "state": "queued",
                "stage": "queued",
                "progress": 0.0,
                "completedItems": 0,
                "totalItems": len(chunks),
                "cancelRequested": False,
                "cancellable": True,
                "createdAt": _now(),
                "startedAt": None,
                "finishedAt": None,
                "result": None,
                "error": None,
            }
            self._cancel_event = cancel_event
            self._future = self._executor.submit(self._run, task_id, tuple(chunks), cancel_event)
            return deepcopy(self._task)

    def cancel(self, task_id: str) -> dict[str, object]:
        with self._lock:
            if self._task is None or self._task["taskId"] != task_id:
                raise KeyError("找不到指定的索引任务。")
            if self._task["state"] in TERMINAL_STATES:
                return deepcopy(self._task)
            assert self._cancel_event is not None
            self._cancel_event.set()
            self._task["cancelRequested"] = True
            self._task["state"] = "cancel_requested"
            self._task["cancellable"] = self._task["stage"] in CANCELLABLE_STAGES
            if self._task["stage"] == "queued" and self._future is not None and self._future.cancel():
                self._task.update({
                    "state": "cancelled",
                    "stage": "cancelled",
                    "progress": 0.0,
                    "cancellable": False,
                    "finishedAt": _now(),
                })
            return deepcopy(self._task)

    def _progress(self, task_id: str, stage: str, completed: int, total: int) -> None:
        ranges = {
            "preparing": (2.0, 10.0),
            "embedding": (10.0, 80.0),
            "committing": (80.0, 99.0),
            "completed": (100.0, 100.0),
        }
        start, end = ranges.get(stage, (0.0, 99.0))
        fraction = 1.0 if total <= 0 else min(1.0, max(0.0, completed / total))
        progress = round(start + ((end - start) * fraction), 1)
        with self._lock:
            if self._task is None or self._task["taskId"] != task_id:
                return
            cancel_requested = bool(self._task["cancelRequested"])
            self._task.update({
                "state": "cancel_requested" if cancel_requested else "running",
                "stage": stage,
                "progress": progress,
                "completedItems": completed,
                "totalItems": total,
                "cancellable": stage in CANCELLABLE_STAGES,
            })

    def _run(self, task_id: str, chunks: tuple[RetrievalChunk, ...], cancel_event: Event) -> None:
        with self._lock:
            if self._task is None or self._task["taskId"] != task_id:
                return
            self._task.update({
                "state": "cancel_requested" if cancel_event.is_set() else "running",
                "stage": "preparing",
                "progress": 2.0,
                "startedAt": _now(),
            })
        try:
            result = self.index.sync(
                chunks,
                on_progress=lambda stage, completed, total: self._progress(task_id, stage, completed, total),
                should_cancel=cancel_event.is_set,
            )
        except IndexSyncCancelled:
            with self._lock:
                if self._task is not None and self._task["taskId"] == task_id:
                    self._task.update({
                        "state": "cancelled",
                        "stage": "cancelled",
                        "cancellable": False,
                        "finishedAt": _now(),
                        "error": None,
                    })
            return
        except Exception as error:
            with self._lock:
                if self._task is not None and self._task["taskId"] == task_id:
                    self._task.update({
                        "state": "failed",
                        "stage": "failed",
                        "cancellable": False,
                        "finishedAt": _now(),
                        "error": str(error)[:1_000] or error.__class__.__name__,
                    })
            return

        payload = asdict(result)
        payload.update({
            "model": self.index.provider.name,
            "dimensions": self.index.provider.dimensions,
        })
        with self._lock:
            if self._task is not None and self._task["taskId"] == task_id:
                self._task.update({
                    "state": "succeeded",
                    "stage": "completed",
                    "progress": 100.0,
                    "cancellable": False,
                    "finishedAt": _now(),
                    "result": payload,
                    "error": None,
                })

    def wait_for_terminal(self, timeout: float = 10.0) -> dict[str, object]:
        future = self._future
        if future is not None:
            try:
                future.result(timeout=timeout)
            except (CancelledError, IndexSyncCancelled):
                pass
        return self.status()

    def shutdown(self, *, wait: bool = True) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._cancel_event is not None and self._task is not None and self._task["state"] in ACTIVE_STATES:
                self._cancel_event.set()
        self._executor.shutdown(wait=wait, cancel_futures=True)
