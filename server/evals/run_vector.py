from __future__ import annotations

import json
from pathlib import Path

from server.semantic import BgeEmbeddingProvider, LocalVectorIndex, VECTOR_ENGINE_NAME

from .metrics import evaluate_queries, markdown_report
from .project_dataset import load_project_dataset, split_queries


REPORT_PATH = Path(__file__).resolve().parents[2] / "artifacts" / "evals" / "0.4.2-vector-evaluation-report.md"
JSON_PATH = REPORT_PATH.with_suffix(".json")


def evaluate_vector() -> dict:
    definition, chunks, queries = load_project_dataset()
    development, evaluation = split_queries(definition, queries)
    index = LocalVectorIndex(provider=BgeEmbeddingProvider(), memory=True)
    sync = index.sync(chunks)
    metrics, failures = evaluate_queries(
        definition["name"],
        chunks,
        evaluation,
        lambda query, _chunks, top_k: index.search(query, top_k),
        top_k=5,
        engine=VECTOR_ENGINE_NAME,
    )
    metrics["indexBuildMs"] = sync.duration_ms
    metrics["totalQueryCount"] = len(queries)
    metrics["developmentQueryCount"] = len(development)
    metrics["indexFingerprint"] = sync.fingerprint
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    report = markdown_report(metrics, failures)
    report += f"\n\n## 索引构建\n\n- 构建耗时：{sync.duration_ms:.3f} ms\n- 语料指纹：`{sync.fingerprint}`\n"
    REPORT_PATH.write_text(report, encoding="utf-8")
    JSON_PATH.write_text(json.dumps({"metrics": metrics, "failures": failures}, ensure_ascii=False, indent=2), encoding="utf-8")
    return metrics


if __name__ == "__main__":
    print(json.dumps(evaluate_vector(), ensure_ascii=False, indent=2))
