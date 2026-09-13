from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from .contracts import TraceEvent, TraceKind


_SENSITIVE_KEYS = {
    "api_key",
    "authorization",
    "credential",
    "password",
    "secret",
    "access_token",
    "refresh_token",
}
_MAX_TRACE_TEXT = 1_000


def _redact(value: Any, key: str = "") -> Any:
    lowered = key.lower()
    if lowered in _SENSITIVE_KEYS or lowered.endswith("_api_key") or lowered.endswith("_credential"):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(item_key): _redact(item_value, str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value[:50]]
    if isinstance(value, str) and len(value) > _MAX_TRACE_TEXT:
        return f"{value[:_MAX_TRACE_TEXT]}…"
    return value


class TraceRecorder:
    """Thread-safe local trace recorder with mandatory field redaction."""

    def __init__(self, path: Path | None = None) -> None:
        self._events: dict[str, list[TraceEvent]] = {}
        self._lock = Lock()
        self._connection: sqlite3.Connection | None = None
        if path is not None:
            resolved = path.expanduser().resolve()
            resolved.parent.mkdir(parents=True, exist_ok=True)
            self._connection = sqlite3.connect(resolved, check_same_thread=False)
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_trace_events (
                    run_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    PRIMARY KEY (run_id, sequence)
                )
                """
            )
            self._connection.commit()

    def record(
        self,
        run_id: str,
        kind: TraceKind,
        *,
        node: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> TraceEvent:
        with self._lock:
            if self._connection is None:
                sequence = len(self._events.setdefault(run_id, [])) + 1
            else:
                row = self._connection.execute(
                    "SELECT COALESCE(MAX(sequence), 0) FROM agent_trace_events WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
                sequence = int(row[0]) + 1
            event = TraceEvent(
                event_id=str(uuid4()),
                run_id=run_id,
                sequence=sequence,
                created_at=datetime.now(timezone.utc),
                kind=kind,
                node=node,
                details=_redact(details or {}),
            )
            if self._connection is None:
                self._events[run_id].append(event)
            else:
                self._connection.execute(
                    "INSERT INTO agent_trace_events (run_id, sequence, payload_json) VALUES (?, ?, ?)",
                    (run_id, sequence, json.dumps(event.model_dump(mode="json"), ensure_ascii=False)),
                )
                self._connection.commit()
            return event

    def get(self, run_id: str) -> list[TraceEvent]:
        with self._lock:
            if self._connection is None:
                return list(self._events.get(run_id, []))
            rows = self._connection.execute(
                "SELECT payload_json FROM agent_trace_events WHERE run_id = ? ORDER BY sequence",
                (run_id,),
            ).fetchall()
            return [TraceEvent.model_validate(json.loads(row[0])) for row in rows]

    def clear(self, run_id: str) -> None:
        with self._lock:
            if self._connection is None:
                self._events.pop(run_id, None)
            else:
                self._connection.execute("DELETE FROM agent_trace_events WHERE run_id = ?", (run_id,))
                self._connection.commit()

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
