from server.evals.run_model_performance import (
    PeakMemorySampler,
    chunks,
    duration_ms,
    latency_summary,
    process_rss_bytes,
)


def test_model_performance_helpers_are_platform_safe() -> None:
    before = process_rss_bytes()
    with PeakMemorySampler() as sampler:
        elapsed = duration_ms(lambda: sum(range(100)))

    assert before > 0
    assert sampler.peak_bytes >= sampler.baseline_bytes > 0
    assert sampler.delta_mib >= 0
    assert elapsed >= 0


def test_model_performance_dataset_and_percentiles_are_deterministic() -> None:
    corpus = chunks(16)
    summary = latency_summary([1.0, 2.0, 3.0, 4.0, 5.0])

    assert len(corpus) == 16
    assert corpus[0].id == "performance-chunk-0"
    assert summary == {"p50Ms": 3.0, "p95Ms": 5.0, "maxMs": 5.0}
