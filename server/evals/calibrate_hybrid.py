from __future__ import annotations

import json
from pathlib import Path

from server.evals.metrics import evaluate_queries
from server.evals.project_dataset import load_project_dataset, split_queries
from server.hybrid import hybrid_search
from server.semantic import BgeEmbeddingProvider, LocalVectorIndex


OUTPUT_PATH = Path(__file__).resolve().parents[2] / "artifacts" / "evals" / "0.4.3-hybrid-dev-calibration.json"
MARKDOWN_PATH = OUTPUT_PATH.with_suffix(".md")


def _report(output: dict) -> str:
    selected = output["selected"]
    metrics = selected["metrics"]
    rows = [
        "# 0.4.3 混合检索开发集校准",
        "",
        "> 参数只由固定的 20 条开发查询选择；80 条保留测试查询未参与本步骤。",
        "",
        "## 选择规则",
        "",
        f"- 网格候选：{len(output['candidates'])} 组",
        f"- 目标函数：{output['objective']}",
        f"- 使用保留测试数据：{'是' if output['evaluationDataUsed'] else '否'}",
        "",
        "## 选定参数",
        "",
        f"- BM25 / 向量权重：{selected['keywordWeight']} / {selected['vectorWeight']}",
        f"- 向量拒答阈值：{selected['vectorThreshold']}",
        f"- BM25 证据门槛：分数 ≥ {selected['keywordScoreThreshold']} 且覆盖率 ≥ {selected['keywordCoverageThreshold']}",
        "",
        "| Recall@1 | Recall@5 | MRR@5 | nDCG@5 | No-answer | 失败数 |",
        "| ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| {metrics['recallAt1']:.4f} | {metrics['recallAt5']:.4f} | {metrics['mrrAt5']:.4f} | {metrics['ndcgAt5']:.4f} | {metrics['noAnswerAccuracy']:.4f} | {metrics['failureCount']} |",
        "",
        "完整 48 组候选指标保存在同名 JSON 产物中。若重新校准，应在查看保留集结果之前运行本脚本。",
    ]
    return "\n".join(rows)


def calibrate() -> dict:
    definition, chunks, queries = load_project_dataset()
    development, _evaluation = split_queries(definition, queries)
    index = LocalVectorIndex(provider=BgeEmbeddingProvider(), memory=True)
    sync = index.sync(chunks)
    candidates: list[dict] = []

    for keyword_weight in (0.75, 1.0, 1.25, 1.5):
        for vector_threshold in (0.46, 0.48, 0.50):
            for keyword_score_threshold, keyword_coverage_threshold in (
                (2.0, 0.67),
                (3.0, 0.67),
                (4.0, 0.67),
                (999.0, 1.0),
            ):
                engine = (
                    f"dev-w{keyword_weight}-v{vector_threshold}-"
                    f"ks{keyword_score_threshold}-kc{keyword_coverage_threshold}"
                )
                metrics, _failures = evaluate_queries(
                    definition["name"],
                    chunks,
                    development,
                    lambda query, corpus, top_k, kw=keyword_weight, vt=vector_threshold,
                    ks=keyword_score_threshold, kc=keyword_coverage_threshold: hybrid_search(
                        query,
                        corpus,
                        index,
                        top_k,
                        keyword_weight=kw,
                        vector_threshold=vt,
                        keyword_score_threshold=ks,
                        keyword_coverage_threshold=kc,
                    ),
                    top_k=5,
                    engine=engine,
                )
                objective = round(
                    metrics["recallAt5"] + metrics["mrrAt5"] + metrics["noAnswerAccuracy"],
                    4,
                )
                candidates.append({
                    "keywordWeight": keyword_weight,
                    "vectorWeight": 1.0,
                    "vectorThreshold": vector_threshold,
                    "keywordScoreThreshold": keyword_score_threshold,
                    "keywordCoverageThreshold": keyword_coverage_threshold,
                    "objective": objective,
                    "metrics": metrics,
                })

    candidates.sort(key=lambda item: (
        -item["objective"],
        -item["metrics"]["noAnswerAccuracy"],
        -item["metrics"]["mrrAt5"],
        item["keywordWeight"],
    ))
    output = {
        "dataset": definition["name"],
        "developmentQueryCount": len(development),
        "evaluationDataUsed": False,
        "indexBuildMs": sync.duration_ms,
        "objective": "Recall@5 + MRR@5 + no-answer accuracy",
        "selected": candidates[0],
        "candidates": candidates,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    MARKDOWN_PATH.write_text(_report(output), encoding="utf-8")
    return output


if __name__ == "__main__":
    result = calibrate()
    print(json.dumps({"selected": result["selected"]}, ensure_ascii=False, indent=2))
