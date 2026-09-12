from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock
from typing import Any
from uuid import uuid4

from .contracts import TraceEvent, TraceKind


_SENSITIVE_KEYS = ("api_key", "authorization", "credential", "password", "secret", "token")
_MAX_TRACE_TEXT = 1_000


def _redact(value: Any, key: str = "") -> Any:
    lowered = key.lower()
    if any(marker in lowered for marker in _SENSITIVE_KEYS):
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

    def __init__(self) -> None:
        self._events: dict[str, list[TraceEvent]] = {}
        self._lock = Lock()

    def record(
        self,
        run_id: str,
        kind: TraceKind,
        *,
        node: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> TraceEvent:
        with self._lock:
            run_events = self._events.setdefault(run_id, [])
            event = TraceEvent(
                event_id=str(uuid4()),
                run_id=run_id,
                sequence=len(run_events) + 1,
                created_at=datetime.now(timezone.utc),
                kind=kind,
                node=node,
                details=_redact(details or {}),
            )
            run_events.append(event)
            return event

    def get(self, run_id: str) -> list[TraceEvent]:
        with self._lock:
            return list(self._events.get(run_id, []))

    def clear(self, run_id: str) -> None:
        with self._lock:
            self._events.pop(run_id, None)
