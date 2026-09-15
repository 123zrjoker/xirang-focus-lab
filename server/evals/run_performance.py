from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import tempfile
import time
from pathlib import Path
from typing import Callable


DEFAULT_THRESHOLDS_MS = {
    "healthP95Ms": 250.0,
    "diagnosticsP95Ms": 250.0,
    "keywordSearchP95Ms": 500.0,
}


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1))
    return ordered[index]


def measure(operation: Callable[[], None], *, warmup: int, iterations: int) -> dict[str, float]:
    for _ in range(warmup):
        operation()
    durations: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        operation()
        durations.append((time.perf_counter() - started) * 1_000)
    return {
        "p50Ms": round(statistics.median(durations), 3),
        "p95Ms": round(percentile(durations, 0.95), 3),
        "maxMs": round(max(durations), 3),
    }


def corpus_payload(count: int = 100) -> list[dict[str, object]]:
    topics = [
        ("低阻力启动", "先把任务缩小成可以立刻执行的动作，只打开文档并写下标题。"),
        ("减少手机分心", "开始专注前将手机调成静音并放到看不见的位置。"),
        ("专注复盘", "记录分心原因、完成度和下一步，避免只记录时长。"),
        ("知识库导入", "文字型 PDF 可以提取文字层，扫描 PDF 当前需要 OCR。"),
    ]
    result = []
    for index in range(count):
        heading, content = topics[index % len(topics)]
        result.append({
            "id": f"performance-chunk-{index}",
            "sourceId": f"performance-source-{index // 5}",
            "sourceTitle": f"性能基准资料 {index // 5}",
            "heading": heading,
            "content": f"{content} 样本编号 {index}。",
            "startLine": index + 1,
            "endLine": index + 1,
            "startOffset": 0,
            "endOffset": len(content),
        })
    return result


def render_markdown(report: dict[str, object]) -> str:
    metrics = report["metrics"]
    checks = report["checks"]
    rows = [
        "# 0.7.0 本机 API 性能基线",
        "",
        f"> 执行时间：{report['executedAt']}；平台：{report['platform']}；Python：{report['pythonVersion']}。",
        "",
        f"> 预热 {report['warmup']} 次，每项采样 {report['iterations']} 次；结果仅用于同类环境回归，不代表所有设备体验。",
        "",
        "| 操作 | P50 | P95 | Max | 门禁 |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    labels = {
        "health": "GET /api/health",
        "diagnostics": "GET /api/diagnostics",
        "keywordSearch": "POST /api/retrieval/search（100 块 BM25）",
    }
    check_by_name = {item["name"]: item for item in checks}
    for name, label in labels.items():
        metric = metrics[name]
        check = check_by_name[name]
        rows.append(
            f"| {label} | {metric['p50Ms']:.3f} ms | {metric['p95Ms']:.3f} ms | "
            f"{metric['maxMs']:.3f} ms | {'通过' if check['passed'] else '失败'}（≤ {check['maximumMs']:.0f} ms） |"
        )
    rows.extend([
        "",
        f"总体门禁：{'通过' if report['passed'] else '失败'}。",
        "",
    ])
    return "\n".join(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run deterministic local API latency gates.")
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=40)
    parser.add_argument("--output", type=Path, default=Path("artifacts/performance/0.7.0-api-baseline.md"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.warmup < 0 or not 5 <= args.iterations <= 500:
        raise SystemExit("warmup must be non-negative and iterations must be between 5 and 500")

    with tempfile.TemporaryDirectory(prefix="xirang-performance-") as temporary:
        os.environ["XIRANG_DATA_DIR"] = temporary
        from fastapi.testclient import TestClient
        from server import __version__
        from server.main import app, close_agent_runtime

        chunks = corpus_payload()
        try:
            with TestClient(app) as client:
                def health() -> None:
                    response = client.get("/api/health")
                    if response.status_code != 200 or response.json().get("status") != "ok":
                        raise RuntimeError("health benchmark request failed")

                def diagnostics() -> None:
                    response = client.get("/api/diagnostics")
                    if response.status_code != 200 or response.json().get("status") != "ok":
                        raise RuntimeError("diagnostics benchmark request failed")

                def keyword_search() -> None:
                    response = client.post("/api/retrieval/search", json={
                        "query": "如何减少手机分心并开始专注",
                        "mode": "keyword",
                        "topK": 5,
                        "chunks": chunks,
                    })
                    if response.status_code != 200 or not response.json().get("results"):
                        raise RuntimeError("keyword benchmark request failed")

                metrics = {
                    "health": measure(health, warmup=args.warmup, iterations=args.iterations),
                    "diagnostics": measure(diagnostics, warmup=args.warmup, iterations=args.iterations),
                    "keywordSearch": measure(keyword_search, warmup=args.warmup, iterations=args.iterations),
                }
        finally:
            close_agent_runtime()

    checks = [
        {
            "name": "health",
            "actualMs": metrics["health"]["p95Ms"],
            "maximumMs": DEFAULT_THRESHOLDS_MS["healthP95Ms"],
            "passed": metrics["health"]["p95Ms"] <= DEFAULT_THRESHOLDS_MS["healthP95Ms"],
        },
        {
            "name": "diagnostics",
            "actualMs": metrics["diagnostics"]["p95Ms"],
            "maximumMs": DEFAULT_THRESHOLDS_MS["diagnosticsP95Ms"],
            "passed": metrics["diagnostics"]["p95Ms"] <= DEFAULT_THRESHOLDS_MS["diagnosticsP95Ms"],
        },
        {
            "name": "keywordSearch",
            "actualMs": metrics["keywordSearch"]["p95Ms"],
            "maximumMs": DEFAULT_THRESHOLDS_MS["keywordSearchP95Ms"],
            "passed": metrics["keywordSearch"]["p95Ms"] <= DEFAULT_THRESHOLDS_MS["keywordSearchP95Ms"],
        },
    ]
    report: dict[str, object] = {
        "version": __version__,
        "executedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "platform": f"{platform.system()} {platform.release()} {platform.machine()}",
        "pythonVersion": platform.python_version(),
        "warmup": args.warmup,
        "iterations": args.iterations,
        "metrics": metrics,
        "checks": checks,
        "passed": all(item["passed"] for item in checks),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_markdown(report), encoding="utf-8")
    args.output.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
