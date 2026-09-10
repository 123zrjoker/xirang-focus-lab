from __future__ import annotations

import argparse
import json
from pathlib import Path

from server.retrieval import ENGINE_NAME, search_chunks

from .metrics import evaluate_queries, markdown_report
from .project_dataset import load_project_dataset, split_queries


DEFAULT_REPORT = Path(__file__).resolve().parents[2] / "artifacts" / "evals" / "0.4.1-bm25-real-eval.md"
DEFAULT_JSON = DEFAULT_REPORT.with_suffix(".json")


def run(report_path: Path = DEFAULT_REPORT, json_path: Path = DEFAULT_JSON) -> dict:
    definition, chunks, queries = load_project_dataset()
    development, evaluation = split_queries(definition, queries)
    metrics, failures = evaluate_queries(
        definition["name"],
        chunks,
        evaluation,
        lambda query, corpus, top_k: search_chunks(query, corpus, top_k),
        engine=ENGINE_NAME,
    )
    metrics["totalQueryCount"] = len(queries)
    metrics["developmentQueryCount"] = len(development)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(markdown_report(metrics, failures), encoding="utf-8")
    json_path.write_text(json.dumps({"metrics": metrics, "failures": failures}, ensure_ascii=False, indent=2), encoding="utf-8")
    return metrics


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the project-grounded retrieval evaluation.")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON)
    args = parser.parse_args()
    print(json.dumps(run(args.report, args.json), ensure_ascii=False, indent=2))
