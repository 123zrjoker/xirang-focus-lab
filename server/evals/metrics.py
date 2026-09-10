from __future__ import annotations

import math
from collections import defaultdict
from typing import Callable, Sequence

from server.retrieval import RetrievalChunk, SearchOutput

from .project_dataset import EvaluationQuery


SearchFunction = Callable[[str, Sequence[RetrievalChunk], int], SearchOutput]


def _dcg(grades: list[int]) -> float:
    return sum((2 ** grade - 1) / math.log2(rank + 1) for rank, grade in enumerate(grades, 1))


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * fraction) - 1)
    return round(ordered[index], 3)


def evaluate_queries(
    dataset_name: str,
    chunks: Sequence[RetrievalChunk],
    queries: Sequence[EvaluationQuery],
    search: SearchFunction,
    *,
    top_k: int = 5,
    engine: str,
) -> tuple[dict, list[dict]]:
    answerable = [item for item in queries if item.relevance]
    unanswerable = [item for item in queries if not item.relevance]
    recall_at_one: list[float] = []
    recall_at_five: list[float] = []
    reciprocal_ranks: list[float] = []
    ndcgs: list[float] = []
    no_answer_hits = 0
    durations: list[float] = []
    failures: list[dict] = []
    by_kind: dict[str, list[float]] = defaultdict(list)

    for item in queries:
        output = search(item.query, chunks, top_k)
        durations.append(output.duration_ms)
        returned = [result.chunk.id for result in output.results]
        if not item.relevance:
            correct = output.confidence == "none"
            no_answer_hits += int(correct)
            by_kind[item.kind].append(float(correct))
            if not correct:
                failures.append({
                    "id": item.id,
                    "kind": item.kind,
                    "query": item.query,
                    "expected": "no-answer",
                    "returned": returned,
                    "topHeading": output.results[0].chunk.heading if output.results else None,
                })
            continue

        relevant = set(item.relevance)
        recall_one = float(bool(returned) and returned[0] in relevant)
        recall_five = len(relevant.intersection(returned[:5])) / len(relevant)
        first_rank = next((rank for rank, identifier in enumerate(returned[:5], 1) if identifier in relevant), None)
        reciprocal_rank = 1 / first_rank if first_rank else 0.0
        returned_grades = [item.relevance.get(identifier, 0) for identifier in returned[:5]]
        ideal_grades = sorted(item.relevance.values(), reverse=True)[:5]
        ideal_dcg = _dcg(ideal_grades)
        ndcg = _dcg(returned_grades) / ideal_dcg if ideal_dcg else 0.0
        recall_at_one.append(recall_one)
        recall_at_five.append(recall_five)
        reciprocal_ranks.append(reciprocal_rank)
        ndcgs.append(ndcg)
        by_kind[item.kind].append(reciprocal_rank)
        if not first_rank:
            failures.append({
                "id": item.id,
                "kind": item.kind,
                "query": item.query,
                "expectedChunkIds": sorted(relevant),
                "returned": returned,
                "topHeading": output.results[0].chunk.heading if output.results else None,
            })

    mean = lambda values: round(sum(values) / len(values), 4) if values else 0.0
    metrics = {
        "dataset": dataset_name,
        "engine": engine,
        "documentCount": len({chunk.source_id for chunk in chunks}),
        "chunkCount": len(chunks),
        "queryCount": len(queries),
        "answerableCount": len(answerable),
        "noAnswerCount": len(unanswerable),
        "recallAt1": mean(recall_at_one),
        "recallAt5": mean(recall_at_five),
        "mrrAt5": mean(reciprocal_ranks),
        "ndcgAt5": mean(ndcgs),
        "noAnswerAccuracy": round(no_answer_hits / len(unanswerable), 4) if unanswerable else 0.0,
        "latencyP50Ms": percentile(durations, 0.5),
        "latencyP95Ms": percentile(durations, 0.95),
        "failureCount": len(failures),
        "byKind": {kind: mean(scores) for kind, scores in sorted(by_kind.items())},
    }
    return metrics, failures


def markdown_report(metrics: dict, failures: list[dict]) -> str:
    rows = [
        "# 息壤真实场景检索评测报告",
        "",
        f"> 数据集：{metrics['dataset']}；引擎：{metrics['engine']}。本报告由固定语料和人工相关性标注离线生成。",
        "",
        "## 数据规模",
        "",
        f"- 文档：{metrics['documentCount']} 份",
        f"- 文本块：{metrics['chunkCount']} 个",
        (
            f"- 查询：共 {metrics['totalQueryCount']} 条（开发校准 {metrics['developmentQueryCount']}，独立评测 {metrics['queryCount']}）"
            if metrics.get("totalQueryCount") else
            f"- 查询：{metrics['queryCount']} 条（可回答 {metrics['answerableCount']}，不可回答 {metrics['noAnswerCount']}）"
        ),
        f"- 评测子集：可回答 {metrics['answerableCount']}，不可回答 {metrics['noAnswerCount']}",
        "",
        "## 核心指标",
        "",
        "| Recall@1 | Recall@5 | MRR@5 | nDCG@5 | No-answer | P50 | P95 |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| {metrics['recallAt1']:.4f} | {metrics['recallAt5']:.4f} | {metrics['mrrAt5']:.4f} | {metrics['ndcgAt5']:.4f} | {metrics['noAnswerAccuracy']:.4f} | {metrics['latencyP50Ms']:.3f} ms | {metrics['latencyP95Ms']:.3f} ms |",
        "",
        "## 分类型 MRR / 正确率",
        "",
    ]
    rows.extend(f"- {kind}: {score:.4f}" for kind, score in metrics["byKind"].items())
    rows.extend(["", f"## 失败样例（{len(failures)} 条）", ""])
    if not failures:
        rows.append("本次没有失败样例。")
    else:
        for item in failures[:30]:
            rows.append(f"- `{item['id']}` [{item['kind']}] {item['query']} → {item.get('topHeading') or '无结果'}")
    rows.extend([
        "",
        "## 解释边界",
        "",
        "这套语料来自项目真实文档，但查询由人工脱敏编写，不代表线上用户流量。指标只用于相同数据集、相同切块和相同 Top-K 下的版本对比。",
        "",
    ])
    return "\n".join(rows)
