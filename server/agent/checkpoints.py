from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite import SqliteSaver


def _safe_serializer() -> JsonPlusSerializer:
    return JsonPlusSerializer(allowed_msgpack_modules=())


def build_in_memory_checkpointer() -> InMemorySaver:
    return InMemorySaver(serde=_safe_serializer())


def default_checkpoint_path() -> Path:
    override = os.environ.get("XIRANG_AGENT_CHECKPOINT_PATH", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        return Path(local_app_data) / "Xirang" / "agent" / "checkpoints.sqlite3"
    return Path.home() / ".xirang" / "agent" / "checkpoints.sqlite3"


def resolve_checkpoint_path() -> Path:
    configured = default_checkpoint_path().expanduser().resolve()
    try:
        configured.parent.mkdir(parents=True, exist_ok=True)
        return configured
    except OSError:
        if os.environ.get("XIRANG_AGENT_CHECKPOINT_PATH", "").strip():
            raise
        development_fallback = (Path.cwd() / "server" / "data" / "agent" / "checkpoints.sqlite3").resolve()
        development_fallback.parent.mkdir(parents=True, exist_ok=True)
        return development_fallback


def build_sqlite_checkpointer(path: Path | None = None) -> SqliteSaver:
    checkpoint_path = (path or resolve_checkpoint_path()).expanduser().resolve()
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(checkpoint_path, check_same_thread=False)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    saver = SqliteSaver(connection, serde=_safe_serializer())
    saver.setup()
    return saver
