from __future__ import annotations

from threading import Event

import pytest
from fastapi.testclient import TestClient

import server.main as main_module
from server.index_tasks import IndexSyncTaskManager, IndexTaskConflictError
from server.semantic import IndexSyncCancelled, IndexSyncResult


class FakeProvider:
    name = "fake-task-provider"
    dimensions = 32


class ControlledIndex:
    provider = FakeProvider()

    def __init__(self, *, fail: bool = False) -> None:
        self.entered = Event()
        self.release = Event()
        self.fail = fail

    def sync(self, chunks, *, on_progress, should_cancel):
        on_progress("preparing", len(chunks), len(chunks))
        self.entered.set()
        assert self.release.wait(2)
        on_progress("embedding", 1, max(1, len(chunks)))
        if should_cancel():
            raise IndexSyncCancelled("cancelled")
        on_progress("committing", len(chunks), max(1, len(chunks)))
        if self.fail:
            raise RuntimeError("injected task failure")
        on_progress("completed", len(chunks), max(1, len(chunks)))
        return IndexSyncResult(
            fingerprint="f" * 64,
            added=len(chunks),
            updated=0,
            removed=0,
            unchanged=0,
            chunk_count=len(chunks),
            duration_ms=12.5,
            built_at="2026-09-15T00:00:00+00:00",
        )


def payload() -> list[dict[str, object]]:
    return [{
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


def test_manager_enforces_single_task_and_cancels_before_commit() -> None:
    index = ControlledIndex()
    manager = IndexSyncTaskManager(index)
    first = manager.start([object()])
    assert index.entered.wait(1)

    with pytest.raises(IndexTaskConflictError):
        manager.start([object()])

    cancelling = manager.cancel(str(first["taskId"]))
    assert cancelling["cancelRequested"] is True
    index.release.set()
    terminal = manager.wait_for_terminal()

    assert terminal["state"] == "cancelled"
    assert terminal["result"] is None
    manager.shutdown()


def test_manager_records_success_and_failure_without_source_content() -> None:
    success_index = ControlledIndex()
    success_manager = IndexSyncTaskManager(success_index)
    success = success_manager.start([object(), object()])
    success_index.release.set()
    succeeded = success_manager.wait_for_terminal()

    assert succeeded["taskId"] == success["taskId"]
    assert succeeded["state"] == "succeeded"
    assert succeeded["progress"] == 100.0
    assert succeeded["result"]["chunk_count"] == 2
    assert "source" not in repr(succeeded).lower()
    success_manager.shutdown()

    failed_index = ControlledIndex(fail=True)
    failed_manager = IndexSyncTaskManager(failed_index)
    failed_manager.start([object()])
    failed_index.release.set()
    failed = failed_manager.wait_for_terminal()

    assert failed["state"] == "failed"
    assert failed["error"] == "injected task failure"
    assert failed["result"] is None
    failed_manager.shutdown()


def test_index_task_api_starts_reports_and_rejects_parallel_work(monkeypatch) -> None:
    index = ControlledIndex()
    manager = IndexSyncTaskManager(index)
    monkeypatch.setattr(main_module, "index_task_manager", manager)
    client = TestClient(main_module.app)

    started = client.post("/api/index/tasks", json={"chunks": payload()})
    assert started.status_code == 202
    assert index.entered.wait(1)

    conflict = client.post("/api/index/tasks", json={"chunks": payload()})
    assert conflict.status_code == 409
    assert "正在运行" in conflict.json()["detail"]

    index.release.set()
    manager.wait_for_terminal()
    current = client.get("/api/index/tasks/current")

    assert current.status_code == 200
    assert current.json()["state"] == "succeeded"
    assert current.json()["result"]["model"] == "fake-task-provider"
    manager.shutdown()
