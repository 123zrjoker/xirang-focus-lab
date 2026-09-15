from __future__ import annotations

import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _configured_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    return Path(value).expanduser().resolve() if value else None


def default_data_root() -> Path:
    configured = _configured_path("XIRANG_DATA_DIR")
    if configured:
        return configured
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        return (Path(local_app_data) / "Xirang").resolve()
    return (Path.home() / ".xirang").resolve()


def default_model_root() -> Path:
    configured = _configured_path("XIRANG_MODEL_DIR")
    if configured:
        return configured
    return (PROJECT_ROOT / ".model-cache").resolve()


def default_embedding_model_path() -> Path:
    configured = _configured_path("XIRANG_EMBEDDING_MODEL_PATH")
    return configured or default_model_root() / "bge-small-zh-v1.5"


def default_reranker_model_path() -> Path:
    configured = _configured_path("XIRANG_RERANKER_MODEL_PATH")
    return configured or default_model_root() / "mmarco-mMiniLMv2-L12-H384-v1"


def default_vector_index_path() -> Path:
    configured = _configured_path("XIRANG_VECTOR_INDEX_DIR")
    return configured or default_data_root() / "retrieval" / "qdrant"


def default_vector_meta_path() -> Path:
    configured = _configured_path("XIRANG_VECTOR_META_PATH")
    return configured or default_data_root() / "retrieval" / "index-meta.json"


def default_credential_path() -> Path:
    configured = _configured_path("XIRANG_CREDENTIAL_DIR")
    return (configured / "deepseek.json") if configured else default_data_root() / "credentials" / "deepseek.json"


def default_checkpoint_path() -> Path:
    configured = _configured_path("XIRANG_AGENT_CHECKPOINT_PATH")
    return configured or default_data_root() / "agent" / "checkpoints.sqlite3"


def runtime_path_summary() -> dict[str, str]:
    """Return non-secret local paths for diagnostics shown only by the loopback API."""

    return {
        "dataRoot": str(default_data_root()),
        "modelRoot": str(default_model_root()),
        "vectorIndex": str(default_vector_index_path()),
        "checkpoint": str(default_checkpoint_path()),
        "credentialDirectory": str(default_credential_path().parent),
    }
