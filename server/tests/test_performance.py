from server.evals.run_performance import corpus_payload, measure, percentile


def test_percentile_uses_nearest_rank() -> None:
    values = [float(value) for value in range(1, 101)]

    assert percentile(values, 0.50) == 50.0
    assert percentile(values, 0.95) == 95.0


def test_measure_and_corpus_are_deterministic() -> None:
    calls = 0

    def operation() -> None:
        nonlocal calls
        calls += 1

    result = measure(operation, warmup=2, iterations=5)
    corpus = corpus_payload(8)

    assert calls == 7
    assert result["p50Ms"] >= 0
    assert len(corpus) == 8
    assert corpus[0]["id"] == "performance-chunk-0"
    assert corpus[-1]["id"] == "performance-chunk-7"
