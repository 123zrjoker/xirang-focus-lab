from __future__ import annotations

import json
from pathlib import Path

from server.hybrid import (
    HYBRID_KEYWORD_COVERAGE_THRESHOLD,
    HYBRID_KEYWORD_SCORE_THRESHOLD,
    HYBRID_VECTOR_THRESHOLD,
    RERANK_ENGINE_NAME,
    RERANK_K,
    RRF_ENGINE_NAME,
    RRF_K,
    RRF_KEYWORD_WEIGHT,
    RRF_VECTOR_WEIGHT,
    hybrid_search,
    reranker_provider,
)
from server.retrieval import ENGINE_NAME, search_chunks
from server.semantic import BgeEmbeddingProvider, LocalVectorIndex, VECTOR_ENGINE_NAME

from .metrics import evaluate_queries
from .project_dataset import load_project_dataset, split_queries


REPORT_PATH = Path(__file__).resolve().parents[2] / "artifacts" / "evals" / "0.4.3-ablation-report.md"
JSON_PATH = REPORT_PATH.with_suffix(".json")


def _report(results: dict[str, dict], failures: dict[str, list[dict]], sync_ms: float) -> str:
    rows = [
        "# 0.4.3 混合检索消融评测",
        "",
        "> 同一份 15 文档 / 100 查询人工标注集，对比 BM25、BGE 向量、RRF 融合与 Cross-Encoder 重排。",
        "",
        "| 模式 | Recall@1 | Recall@5 | MRR@5 | nDCG@5 | No-answer | P50 | P95 | 失败数 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for mode, metrics in results.items():
        if metrics.get("available") is False:
            rows.append(f"| {mode} | 未安装模型 | — | — | — | — | — | — | — |")
            continue
        rows.append(
            f"| {mode} | {metrics['recallAt1']:.4f} | {metrics['recallAt5']:.4f} | "
            f"{metrics['mrrAt5']:.4f} | {metrics['ndcgAt5']:.4f} | {metrics['noAnswerAccuracy']:.4f} | "
            f"{metrics['latencyP50Ms']:.3f} ms | {metrics['latencyP95Ms']:.3f} ms | {metrics['failureCount']} |"
        )
    rows.extend([
        "",
        "## 运行信息",
        "",
        f"- BGE + Qdrant 索引构建耗时：{sync_ms:.3f} ms",
        f"- 数据划分：20 条开发查询用于参数校准，80 条查询仅用于本报告的独立评测",
        f"- RRF 参数：k={RRF_K}，BM25 权重 {RRF_KEYWORD_WEIGHT}，向量权重 {RRF_VECTOR_WEIGHT}，双路各取前 20 条",
        f"- 拒答门控：向量分数 ≥ {HYBRID_VECTOR_THRESHOLD}，或 BM25 分数 ≥ {HYBRID_KEYWORD_SCORE_THRESHOLD} 且查询覆盖率 ≥ {HYBRID_KEYWORD_COVERAGE_THRESHOLD}",
        f"- Cross-Encoder：{reranker_provider.name}，重排前 {RERANK_K} 条",
        f"- Cross-Encoder SHA-256：{reranker_provider.checksum or '模型未安装'}",
        "",
        "## 各模式失败样例",
        "",
    ])
    for mode, items in failures.items():
        rows.append(f"### {mode}（{len(items)} 条）")
        rows.append("")
        if not items:
            rows.append("无。")
        else:
            rows.extend(
                f"- `{item['id']}` [{item['kind']}] {item['query']} → {item.get('topHeading') or '无结果'}"
                for item in items[:12]
            )
        rows.append("")
    rows.extend([
        "## 说明",
        "",
        "延迟为本机 CPU 单查询服务端耗时，不包含首次模型加载和索引构建。真实应用的首个请求会受到磁盘与模型预热影响。",
    ])
    return "\n".join(rows)


def evaluate_ablation() -> dict:
    definition, chunks, queries = load_project_dataset()
    development, evaluation = split_queries(definition, queries)
    provider = BgeEmbeddingProvider()
    index = LocalVectorIndex(provider=provider, memory=True)
    sync = index.sync(chunks)
    specifications = {
        "BM25": (ENGINE_NAME, lambda query, corpus, top_k: search_chunks(query, corpus, top_k)),
        "BGE vector": (VECTOR_ENGINE_NAME, lambda query, _corpus, top_k: index.search(query, top_k)),
        "RRF hybrid": (RRF_ENGINE_NAME, lambda query, corpus, top_k: hybrid_search(query, corpus, index, top_k)),
    }
    if reranker_provider.available:
        specifications["RRF + Cross-Encoder"] = (
            RERANK_ENGINE_NAME,
            lambda query, corpus, top_k: hybrid_search(query, corpus, index, top_k, reranker=reranker_provider),
        )

    results: dict[str, dict] = {}
    failures: dict[str, list[dict]] = {}
    for mode, (engine, search) in specifications.items():
        metrics, mode_failures = evaluate_queries(
            definition["name"], chunks, evaluation, search, top_k=5, engine=engine,
        )
        results[mode] = metrics
        failures[mode] = mode_failures
    if not reranker_provider.available:
        results["RRF + Cross-Encoder"] = {"available": False, "model": reranker_provider.name}
        failures["RRF + Cross-Encoder"] = []

    output = {
        "dataset": definition["name"],
        "totalQueryCount": len(queries),
        "developmentQueryCount": len(development),
        "evaluationQueryCount": len(evaluation),
        "indexBuildMs": sync.duration_ms,
        "indexFingerprint": sync.fingerprint,
        "rerankerChecksum": reranker_provider.checksum,
        "parameters": {
            "rrfK": RRF_K,
            "keywordWeight": RRF_KEYWORD_WEIGHT,
            "vectorWeight": RRF_VECTOR_WEIGHT,
            "vectorThreshold": HYBRID_VECTOR_THRESHOLD,
            "keywordScoreThreshold": HYBRID_KEYWORD_SCORE_THRESHOLD,
            "keywordCoverageThreshold": HYBRID_KEYWORD_COVERAGE_THRESHOLD,
            "candidateK": 20,
            "rerankK": RERANK_K,
        },
        "results": results,
        "failures": failures,
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(_report(results, failures, sync.duration_ms), encoding="utf-8")
    JSON_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


if __name__ == "__main__":
    print(json.dumps(evaluate_ablation(), ensure_ascii=False, indent=2))
