from __future__ import annotations

from pathlib import Path

from server.runtime_paths import (
    default_checkpoint_path,
    default_credential_path,
    default_embedding_model_path,
    default_vector_index_path,
)


def test_runtime_paths_share_explicit_data_root(monkeypatch, tmp_path: Path) -> None:
    data_root = tmp_path / "runtime"
    model_root = tmp_path / "models"
    monkeypatch.setenv("XIRANG_DATA_DIR", str(data_root))
    monkeypatch.setenv("XIRANG_MODEL_DIR", str(model_root))
    monkeypatch.delenv("XIRANG_AGENT_CHECKPOINT_PATH", raising=False)
    monkeypatch.delenv("XIRANG_CREDENTIAL_DIR", raising=False)
    monkeypatch.delenv("XIRANG_VECTOR_INDEX_DIR", raising=False)
    monkeypatch.delenv("XIRANG_EMBEDDING_MODEL_PATH", raising=False)

    assert default_checkpoint_path() == data_root / "agent" / "checkpoints.sqlite3"
    assert default_credential_path() == data_root / "credentials" / "deepseek.json"
    assert default_vector_index_path() == data_root / "retrieval" / "qdrant"
    assert default_embedding_model_path() == model_root / "bge-small-zh-v1.5"


def test_specific_path_override_wins(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "custom" / "state.sqlite3"
    monkeypatch.setenv("XIRANG_DATA_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("XIRANG_AGENT_CHECKPOINT_PATH", str(checkpoint))

    assert default_checkpoint_path() == checkpoint
