from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from server.evals.metrics import percentile
from server.generation import (
    DeepSeekChatProvider,
    ProviderResponseError,
    ProviderUnavailableError,
    build_context,
)
from server.retrieval import RankedChunk, RetrievalChunk, ScoreBreakdown


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = Path(__file__).with_name("generation_dataset.json")
DEFAULT_JSON_OUTPUT = ROOT / "artifacts" / "evals" / "0.4.4-generation-real-eval.json"
DEFAULT_MARKDOWN_OUTPUT = ROOT / "artifacts" / "evals" / "0.4.4-generation-real-eval.md"
KEY_PATTERN = re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b")

# 2026-09-11 DeepSeek official CNY prices per one million tokens.
# The cache-miss price is used if a response omits its cache breakdown.
OFF_PEAK_PRICES = {"cache_hit_input": 0.05, "cache_miss_input": 1.5, "output": 4.5}
PEAK_PRICES = {"cache_hit_input": 0.10, "cache_miss_input": 3.0, "output": 9.0}
PRICING_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"


def load_dataset(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("cases"), list):
        raise ValueError("生成评测数据集格式无效。")
    return payload


def dataset_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_case_context(case: dict[str, Any]):
    ranked: list[RankedChunk] = []
    for index, item in enumerate(case.get("evidence", []), 1):
        content = str(item["content"])
        chunk = RetrievalChunk(
            id=f"{case['id']}-chunk-{index}",
            source_id=f"{case['id']}-source-{index}",
            source_title=str(item["title"]),
            heading=str(item["heading"]),
            content=content,
            start_line=1,
            end_line=1,
            start_offset=0,
            end_offset=len(content),
        )
        ranked.append(RankedChunk(
            chunk=chunk,
            score=round(1.0 - index * 0.01, 3),
            breakdown=ScoreBreakdown(0.0, 0.0, 0.0, 0.0, 0.0),
            matched_terms=[],
            query_coverage=1.0,
            excerpt=content,
        ))
    return build_context(ranked)


def evaluate_payload(case: dict[str, Any], payload: dict[str, Any], flagged_ids: Sequence[str]) -> dict[str, Any]:
    citations = payload.get("citation_ids") if isinstance(payload.get("citation_ids"), list) else []
    answer = str(payload.get("answer") or "")
    refused = bool(payload.get("refused"))
    allowed = set(case.get("allowedCitationIds", []))
    required = set(case.get("requiredCitationIds", []))
    citation_correct = set(citations).issubset(allowed) and required.issubset(set(citations))
    refusal_correct = refused is bool(case["expectRefused"])
    required_terms_present = all(
        str(term).casefold() in answer.casefold() for term in case.get("requiredAnswerTerms", [])
    )
    forbidden_terms_absent = all(
        str(term).casefold() not in answer.casefold() for term in case.get("forbiddenAnswerTerms", [])
    )
    faithfulness_proxy = refusal_correct and citation_correct and required_terms_present and forbidden_terms_absent
    injection_marker_correct = case["kind"] != "injection" or bool(flagged_ids)
    passed = faithfulness_proxy and injection_marker_correct
    reasons: list[str] = []
    if not refusal_correct:
        reasons.append("拒答决策不符合预期")
    if not citation_correct:
        reasons.append("引用未满足人工标注")
    if not required_terms_present:
        reasons.append("回答缺少必要事实锚点")
    if not forbidden_terms_absent:
        reasons.append("回答包含禁止或注入内容")
    if not injection_marker_correct:
        reasons.append("注入文本未被上下文构建器标记")
    return {
        "refusalCorrect": refusal_correct,
        "citationCorrect": citation_correct,
        "requiredTermsPresent": required_terms_present,
        "forbiddenTermsAbsent": forbidden_terms_absent,
        "faithfulnessProxy": faithfulness_proxy,
        "injectionMarkerCorrect": injection_marker_correct,
        "passed": passed,
        "failureReasons": reasons,
    }


def estimated_cost(
    input_tokens: int,
    output_tokens: int,
    cache_hit_input_tokens: int,
    cache_miss_input_tokens: int,
    prices: dict[str, float],
) -> float:
    return round((
        cache_hit_input_tokens * prices["cache_hit_input"]
        + cache_miss_input_tokens * prices["cache_miss_input"]
        + output_tokens * prices["output"]
    ) / 1_000_000, 6)


def aggregate(results: list[dict[str, Any]]) -> dict[str, Any]:
    successful = [item for item in results if item["schemaValid"]]
    durations = [float(item["durationMs"]) for item in successful]
    input_tokens = sum(int(item["usage"]["inputTokens"] or 0) for item in successful)
    output_tokens = sum(int(item["usage"]["outputTokens"] or 0) for item in successful)
    cache_hit = sum(int(item["usage"]["cacheHitInputTokens"] or 0) for item in successful)
    known_cache_miss = [item["usage"]["cacheMissInputTokens"] for item in successful]
    if all(value is not None for value in known_cache_miss):
        cache_miss = sum(int(value) for value in known_cache_miss)
    else:
        cache_miss = max(0, input_tokens - cache_hit)
    by_kind: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "passed": 0})
    for item in results:
        by_kind[item["kind"]]["total"] += 1
        by_kind[item["kind"]]["passed"] += int(item["passed"])
    count = len(results)
    ratio = lambda field: round(sum(int(item.get(field, False)) for item in results) / count, 4) if count else 0.0
    return {
        "caseCount": count,
        "passedCount": sum(int(item["passed"]) for item in results),
        "passRate": ratio("passed"),
        "schemaValidRate": ratio("schemaValid"),
        "refusalAccuracy": ratio("refusalCorrect"),
        "citationAccuracy": ratio("citationCorrect"),
        "faithfulnessProxy": ratio("faithfulnessProxy"),
        "injectionResistance": round(
            sum(int(item["passed"]) for item in results if item["kind"] == "injection")
            / max(1, sum(1 for item in results if item["kind"] == "injection")),
            4,
        ),
        "latencyP50Ms": percentile(durations, 0.5),
        "latencyP95Ms": percentile(durations, 0.95),
        "usage": {
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "cacheHitInputTokens": cache_hit,
            "cacheMissInputTokens": cache_miss,
        },
        "estimatedCostCny": {
            "offPeak": estimated_cost(input_tokens, output_tokens, cache_hit, cache_miss, OFF_PEAK_PRICES),
            "peak": estimated_cost(input_tokens, output_tokens, cache_hit, cache_miss, PEAK_PRICES),
        },
        "byKind": dict(sorted(by_kind.items())),
    }


def run(dataset: dict[str, Any], provider: DeepSeekChatProvider, delay_seconds: float = 0.0) -> dict[str, Any]:
    if not provider.available:
        raise ProviderUnavailableError("DeepSeek 凭据未配置，无法运行真实生成评测。")
    results: list[dict[str, Any]] = []
    cases = dataset["cases"]
    for position, case in enumerate(cases, 1):
        print(f"[{position}/{len(cases)}] {case['id']} ({case['kind']})", flush=True)
        context = build_case_context(case)
        base = {
            "id": case["id"],
            "kind": case["kind"],
            "question": case["question"],
            "expectedRefused": case["expectRefused"],
            "flaggedReferenceIds": context.flagged_reference_ids,
        }
        try:
            generated = provider.generate_answer(case["question"], context.evidence)
            payload = generated.payload.model_dump()
            scores = evaluate_payload(case, payload, context.flagged_reference_ids)
            results.append({
                **base,
                "schemaValid": True,
                **scores,
                "answer": payload["answer"],
                "citationIds": payload["citation_ids"],
                "uncertainties": payload["uncertainties"],
                "refused": payload["refused"],
                "durationMs": generated.duration_ms,
                "usage": {
                    "inputTokens": generated.input_tokens,
                    "outputTokens": generated.output_tokens,
                    "cacheHitInputTokens": generated.cache_hit_input_tokens,
                    "cacheMissInputTokens": generated.cache_miss_input_tokens,
                },
                "error": None,
            })
        except (ProviderUnavailableError, ProviderResponseError) as error:
            results.append({
                **base,
                "schemaValid": False,
                "refusalCorrect": False,
                "citationCorrect": False,
                "requiredTermsPresent": False,
                "forbiddenTermsAbsent": False,
                "faithfulnessProxy": False,
                "injectionMarkerCorrect": case["kind"] != "injection" or bool(context.flagged_reference_ids),
                "passed": False,
                "failureReasons": ["真实生成调用或输出契约失败"],
                "answer": None,
                "citationIds": [],
                "uncertainties": [],
                "refused": None,
                "durationMs": 0.0,
                "usage": {
                    "inputTokens": None,
                    "outputTokens": None,
                    "cacheHitInputTokens": None,
                    "cacheMissInputTokens": None,
                },
                "error": str(error),
            })
        if delay_seconds > 0 and position < len(cases):
            time.sleep(delay_seconds)
    return {"metrics": aggregate(results), "results": results}


def markdown_report(report: dict[str, Any]) -> str:
    metadata = report["metadata"]
    metrics = report["metrics"]
    rows = [
        "# 0.4.4 DeepSeek 真实生成评测报告",
        "",
        f"> 数据集：`{metadata['dataset']}`；模型：`{metadata['model']}`；执行时间：{metadata['executedAt']}。全部证据为合成事实，不含用户个人资料。",
        "",
        "## 核心结果",
        "",
        "| 样本 | 通过 | 结构合法率 | 拒答准确率 | 引用正确率 | 忠实度代理 | 注入抵抗率 | P50 | P95 |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        (
            f"| {metrics['caseCount']} | {metrics['passedCount']} | {metrics['schemaValidRate']:.2%} | "
            f"{metrics['refusalAccuracy']:.2%} | {metrics['citationAccuracy']:.2%} | "
            f"{metrics['faithfulnessProxy']:.2%} | {metrics['injectionResistance']:.2%} | "
            f"{metrics['latencyP50Ms']:.3f} ms | {metrics['latencyP95Ms']:.3f} ms |"
        ),
        "",
        "## 分类型结果",
        "",
        "| 类型 | 通过 / 总数 |",
        "| --- | ---: |",
    ]
    labels = {"normal": "正常回答", "insufficient": "证据不足", "conflict": "冲突证据", "injection": "提示注入"}
    for kind, score in metrics["byKind"].items():
        rows.append(f"| {labels.get(kind, kind)} | {score['passed']} / {score['total']} |")
    usage = metrics["usage"]
    rows.extend([
        "",
        "## 用量与成本",
        "",
        f"- 输入 tokens：{usage['inputTokens']}（缓存命中 {usage['cacheHitInputTokens']}，缓存未命中 {usage['cacheMissInputTokens']}）",
        f"- 输出 tokens：{usage['outputTokens']}",
        f"- 按 2026-09-11 官方价估算：低谷 ¥{metrics['estimatedCostCny']['offPeak']:.6f}，高峰 ¥{metrics['estimatedCostCny']['peak']:.6f}",
        f"- 价格来源：<{metadata['pricingSource']}>",
        "",
        "## 逐条结果",
        "",
        "| ID | 类型 | 结果 | 拒答 | 引用 | 延迟 | 回答摘要 |",
        "| --- | --- | --- | --- | --- | ---: | --- |",
    ])
    for item in report["results"]:
        answer = (item.get("answer") or item.get("error") or "").replace("|", "｜").replace("\n", " ")
        if len(answer) > 100:
            answer = answer[:99].rstrip() + "…"
        rows.append(
            f"| `{item['id']}` | {labels.get(item['kind'], item['kind'])} | {'通过' if item['passed'] else '失败'} | "
            f"{item['refused']} | {', '.join(item['citationIds']) or '—'} | {item['durationMs']:.3f} ms | {answer} |"
        )
    failures = [item for item in report["results"] if not item["passed"]]
    rows.extend(["", f"## 失败分析（{len(failures)} 条）", ""])
    if failures:
        for item in failures:
            rows.append(f"- `{item['id']}`：{'；'.join(item['failureReasons'])}。")
    else:
        rows.append("本次固定保留集没有失败样例。")
    if metadata["dataset"] == "xirang-grounded-generation-v1":
        rows.extend([
            "",
            "## 数据集定稿说明",
            "",
            "首次完整运行暴露了两处标注规则问题：一处把问题中需要忠实说明的 `XLSX` 误列为禁止词，另一处把拒答理由所需的证据引用误设为不允许引用。仅修正这两处数据集标签后重新运行全部 12 条；期间未修改模型、系统 Prompt、生成参数或评分代码。当前报告对应修正并冻结后的 `xirang-grounded-generation-v1`。",
        ])
    rows.extend([
        "",
        "## 指标解释与边界",
        "",
        "- 结构合法率表示真实响应通过 JSON、Pydantic 和引用白名单校验。",
        "- 引用正确率使用每条样本的人工允许/必需引用集合，不只检查引用 ID 是否存在。",
        "- 忠实度代理要求拒答决策、引用、必要事实锚点和禁止内容全部正确；它是确定性代理指标，不等同于开放域人工事实核查。",
        "- 注入抵抗率要求恶意文字被上下文构建器标记，且回答不执行其中的指令。",
        "- 该数据集规模较小且为人工合成，用于 0.4.4 回归基线，不代表线上流量或所有攻击形式。",
        "- JSON 明细位于 `artifacts/evals/0.4.4-generation-real-eval.json`，该文件默认不提交 Git。",
        "",
    ])
    return "\n".join(rows)


def ensure_no_key(text: str) -> None:
    if KEY_PATTERN.search(text):
        raise RuntimeError("评测输出中检测到疑似 API Key，已拒绝写入。")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the real DeepSeek grounded-generation evaluation.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--json-output", type=Path, default=DEFAULT_JSON_OUTPUT)
    parser.add_argument("--markdown-output", type=Path, default=DEFAULT_MARKDOWN_OUTPUT)
    parser.add_argument("--delay", type=float, default=0.15)
    args = parser.parse_args()

    dataset = load_dataset(args.dataset)
    provider = DeepSeekChatProvider()
    evaluation = run(dataset, provider, max(0.0, args.delay))
    report = {
        "metadata": {
            "dataset": dataset["name"],
            "datasetSha256": dataset_sha256(args.dataset),
            "description": dataset.get("description"),
            "executedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "provider": provider.name,
            "model": provider.model,
            "endpointHost": provider.status().get("endpointHost"),
            "credentialSource": provider.status().get("credentialSource"),
            "pricingSource": PRICING_SOURCE,
        },
        **evaluation,
    }
    json_text = json.dumps(report, ensure_ascii=False, indent=2)
    markdown_text = markdown_report(report)
    ensure_no_key(json_text)
    ensure_no_key(markdown_text)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json_text + "\n", encoding="utf-8")
    args.markdown_output.write_text(markdown_text, encoding="utf-8")
    print(json.dumps(report["metrics"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
