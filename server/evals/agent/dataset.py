from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from .contracts import AgentEvaluationDataset


PACKAGE_DIR = Path(__file__).resolve().parent
DEFAULT_FAKE_DATASET = PACKAGE_DIR / "dataset.json"
DEFAULT_REAL_DATASET = PACKAGE_DIR / "real_holdout_dataset.json"


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = deepcopy(value)
    return merged


def _canonical_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_dataset(source: Path | str | dict[str, Any] | AgentEvaluationDataset) -> AgentEvaluationDataset:
    if isinstance(source, AgentEvaluationDataset):
        return source
    if isinstance(source, (str, Path)):
        path = Path(source).expanduser().resolve()
        raw = json.loads(path.read_text(encoding="utf-8"))
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    elif isinstance(source, dict):
        raw = deepcopy(source)
        digest = hashlib.sha256(_canonical_bytes(raw)).hexdigest()
    else:
        raise TypeError("Agent 评测数据集必须是路径、字典或 AgentEvaluationDataset。")

    base_snapshot = raw.pop("baseSnapshot", None)
    if base_snapshot is not None:
        for case in raw.get("cases", []):
            patch = case.pop("snapshotPatch", {})
            case["snapshot"] = _deep_merge(base_snapshot, patch)
    raw["datasetSha256"] = digest
    return AgentEvaluationDataset.model_validate(raw)
