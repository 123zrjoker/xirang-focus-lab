from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import statistics
import time
from pathlib import Path
from threading import Event, Thread
from typing import Callable

from server import __version__
from server.evals.run_performance import corpus_payload, percentile
from server.hybrid import MMarcoCrossEncoderReranker
from server.retrieval import RetrievalChunk
from server.semantic import BgeEmbeddingProvider, LocalVectorIndex


MIB = 1024 * 1024
DEFAULT_THRESHOLDS = {
    "embeddingColdMs": 30_000.0,
    "embeddingWarmP95Ms": 2_000.0,
    "embeddingCacheHitP95Ms": 50.0,
    "indexBuildMs": 120_000.0,
    "vectorCacheHitP95Ms": 100.0,
    "rerankerColdMs": 30_000.0,
    "rerankerWarmP95Ms": 5_000.0,
    "peakRssDeltaMiB": 2_048.0,
}


class ProcessMemoryCounters(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


def process_rss_bytes() -> int:
    if os.name == "nt":
        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ProcessMemoryCounters),
            ctypes.c_ulong,
        ]
        psapi.GetProcessMemoryInfo.restype = ctypes.c_int
        process = kernel32.GetCurrentProcess()
        if not psapi.GetProcessMemoryInfo(process, ctypes.byref(counters), counters.cb):
            raise OSError("GetProcessMemoryInfo failed")
        return int(counters.WorkingSetSize)
    statm = Path("/proc/self/statm")
    if statm.exists():
        resident_pages = int(statm.read_text(encoding="utf-8").split()[1])
        return resident_pages * os.sysconf("SC_PAGE_SIZE")
    import resource

    maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(maximum * (1 if platform.system() == "Darwin" else 1024))


class PeakMemorySampler:
    def __init__(self, interval_seconds: float = 0.02) -> None:
        self.interval_seconds = interval_seconds
        self.baseline_bytes = 0
        self.peak_bytes = 0
        self._stop = Event()
        self._thread: Thread | None = None

    def __enter__(self) -> "PeakMemorySampler":
        self.baseline_bytes = process_rss_bytes()
        self.peak_bytes = self.baseline_bytes

        def sample() -> None:
            while not self._stop.wait(self.interval_seconds):
                self.peak_bytes = max(self.peak_bytes, process_rss_bytes())

        self._thread = Thread(target=sample, name="xirang-memory-sampler", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_args) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
        self.peak_bytes = max(self.peak_bytes, process_rss_bytes())

    @property
    def delta_mib(self) -> float:
        return round(max(0, self.peak_bytes - self.baseline_bytes) / MIB, 3)


def duration_ms(operation: Callable[[], object]) -> float:
    started = time.perf_counter()
    operation()
    return round((time.perf_counter() - started) * 1_000, 3)


def latency_summary(values: list[float]) -> dict[str, float]:
    return {
        "p50Ms": round(statistics.median(values), 3),
        "p95Ms": round(percentile(values, 0.95), 3),
        "maxMs": round(max(values), 3),
    }


def chunks(count: int) -> list[RetrievalChunk]:
    return [RetrievalChunk(
        id=str(item["id"]),
        source_id=str(item["sourceId"]),
        source_title=str(item["sourceTitle"]),
        heading=str(item["heading"]),
        content=str(item["content"]),
        start_line=int(item["startLine"]),
        end_line=int(item["endLine"]),
        start_offset=int(item["startOffset"]),
        end_offset=int(item["endOffset"]),
    ) for item in corpus_payload(count)]


def render_markdown(report: dict[str, object]) -> str:
    metrics = report["metrics"]
    checks = report["checks"]
    rows = [
        "# 0.7.0 本地模型与资源性能基线",
        "",
        f"> 执行时间：{report['executedAt']}；平台：{report['platform']}；Python：{report['pythonVersion']}。",
        "",
        f"> 使用随项目固定的本地模型与 {report['chunkCount']} 个合成文本块；仅用于同类 CPU 环境回归。",
        "",
        "| 指标 | 结果 |",
        "| --- | ---: |",
        f"| BGE 首次查询（含模型加载） | {metrics['embedding']['coldMs']:.3f} ms |",
        f"| BGE 热模型未缓存查询 P50 / P95 | {metrics['embedding']['warmUncached']['p50Ms']:.3f} / {metrics['embedding']['warmUncached']['p95Ms']:.3f} ms |",
        f"| BGE 查询向量缓存命中 P50 / P95 | {metrics['embedding']['cacheHit']['p50Ms']:.3f} / {metrics['embedding']['cacheHit']['p95Ms']:.3f} ms |",
        f"| 向量索引构建 | {metrics['index']['buildMs']:.3f} ms |",
        f"| 向量结果缓存命中 P50 / P95 | {metrics['index']['cacheHit']['p50Ms']:.3f} / {metrics['index']['cacheHit']['p95Ms']:.3f} ms |",
        f"| Cross-Encoder 首次重排 | {metrics['reranker']['coldMs']:.3f} ms |",
        f"| Cross-Encoder 热重排 P50 / P95 | {metrics['reranker']['warm']['p50Ms']:.3f} / {metrics['reranker']['warm']['p95Ms']:.3f} ms |",
        f"| 进程 RSS 基线 / 峰值 / 增量 | {metrics['memory']['baselineMiB']:.3f} / {metrics['memory']['peakMiB']:.3f} / {metrics['memory']['peakDeltaMiB']:.3f} MiB |",
        "",
        "## 门禁",
        "",
        "| 检查 | 实测 | 上限 | 结果 |",
        "| --- | ---: | ---: | --- |",
    ]
    for check in checks:
        rows.append(
            f"| {check['name']} | {check['actual']:.3f} {check['unit']} | "
            f"{check['maximum']:.3f} {check['unit']} | {'通过' if check['passed'] else '失败'} |"
        )
    rows.extend(["", f"总体门禁：{'通过' if report['passed'] else '失败'}。"])
    return "\n".join(rows) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark local BGE, Qdrant and ONNX reranker resources.")
    parser.add_argument("--chunks", type=int, default=64)
    parser.add_argument("--output", type=Path, default=Path("artifacts/performance/0.7.0-model-resource-baseline.md"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 16 <= args.chunks <= 500:
        raise SystemExit("chunks must be between 16 and 500")

    baseline_rss = process_rss_bytes()
    embedding = BgeEmbeddingProvider()
    reranker = MMarcoCrossEncoderReranker()
    if not embedding.available or not reranker.available:
        raise SystemExit("local BGE and reranker models must be available before running this benchmark")

    peaks = [baseline_rss]
    with PeakMemorySampler() as cold_memory:
        embedding_cold_ms = duration_ms(lambda: embedding.encode_query("如何减少手机分心并开始专注"))
    peaks.append(cold_memory.peak_bytes)

    warm_uncached = [duration_ms(lambda index=index: embedding.encode_query(f"专注启动方法 {index}")) for index in range(8)]
    cache_hit = [duration_ms(lambda: embedding.encode_query("如何减少手机分心并开始专注")) for _ in range(40)]

    index = LocalVectorIndex(provider=embedding, memory=True)
    corpus = chunks(args.chunks)
    try:
        with PeakMemorySampler() as index_memory:
            index_result = index.sync(corpus)
        peaks.append(index_memory.peak_bytes)
        index.search("文字型 PDF 如何处理", top_k=5, apply_threshold=False)
        vector_cache_hit = [
            duration_ms(lambda: index.search("文字型 PDF 如何处理", top_k=5, apply_threshold=False))
            for _ in range(40)
        ]

        passages = [item.content for item in corpus[:8]]
        with PeakMemorySampler() as reranker_memory:
            reranker_cold_ms = duration_ms(lambda: reranker.score("如何开始专注", passages))
        peaks.append(reranker_memory.peak_bytes)
        reranker_warm = [duration_ms(lambda: reranker.score("如何开始专注", passages)) for _ in range(10)]
        peaks.append(process_rss_bytes())
        index_cache_status = index.cache_status()
    finally:
        index.close()

    peak_rss = max(peaks)
    peak_delta_mib = round(max(0, peak_rss - baseline_rss) / MIB, 3)
    metrics = {
        "embedding": {
            "coldMs": embedding_cold_ms,
            "warmUncached": latency_summary(warm_uncached),
            "cacheHit": latency_summary(cache_hit),
            "cache": embedding.query_cache_status(),
        },
        "index": {
            "buildMs": index_result.duration_ms,
            "buildPeakDeltaMiB": index_memory.delta_mib,
            "cacheHit": latency_summary(vector_cache_hit),
            "cache": index_cache_status,
        },
        "reranker": {
            "coldMs": reranker_cold_ms,
            "warm": latency_summary(reranker_warm),
            "peakDeltaMiB": reranker_memory.delta_mib,
        },
        "memory": {
            "baselineMiB": round(baseline_rss / MIB, 3),
            "peakMiB": round(peak_rss / MIB, 3),
            "peakDeltaMiB": peak_delta_mib,
        },
    }
    checks = [
        {"name": "BGE cold query", "actual": embedding_cold_ms, "maximum": DEFAULT_THRESHOLDS["embeddingColdMs"], "unit": "ms"},
        {"name": "BGE warm query P95", "actual": metrics["embedding"]["warmUncached"]["p95Ms"], "maximum": DEFAULT_THRESHOLDS["embeddingWarmP95Ms"], "unit": "ms"},
        {"name": "BGE cache hit P95", "actual": metrics["embedding"]["cacheHit"]["p95Ms"], "maximum": DEFAULT_THRESHOLDS["embeddingCacheHitP95Ms"], "unit": "ms"},
        {"name": "Vector index build", "actual": index_result.duration_ms, "maximum": DEFAULT_THRESHOLDS["indexBuildMs"], "unit": "ms"},
        {"name": "Vector result cache hit P95", "actual": metrics["index"]["cacheHit"]["p95Ms"], "maximum": DEFAULT_THRESHOLDS["vectorCacheHitP95Ms"], "unit": "ms"},
        {"name": "Reranker cold", "actual": reranker_cold_ms, "maximum": DEFAULT_THRESHOLDS["rerankerColdMs"], "unit": "ms"},
        {"name": "Reranker warm P95", "actual": metrics["reranker"]["warm"]["p95Ms"], "maximum": DEFAULT_THRESHOLDS["rerankerWarmP95Ms"], "unit": "ms"},
        {"name": "Peak RSS delta", "actual": peak_delta_mib, "maximum": DEFAULT_THRESHOLDS["peakRssDeltaMiB"], "unit": "MiB"},
    ]
    for check in checks:
        check["passed"] = check["actual"] <= check["maximum"]
    report: dict[str, object] = {
        "version": __version__,
        "executedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "platform": f"{platform.system()} {platform.release()} {platform.machine()}",
        "pythonVersion": platform.python_version(),
        "chunkCount": len(corpus),
        "metrics": metrics,
        "checks": checks,
        "passed": all(check["passed"] for check in checks),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_markdown(report), encoding="utf-8")
    args.output.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
