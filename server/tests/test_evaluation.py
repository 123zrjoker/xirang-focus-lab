from server.evals.run import evaluate
from server.evals.metrics import evaluate_queries
from server.evals.project_dataset import load_project_dataset
from server.retrieval import ENGINE_NAME, search_chunks


def test_starter_dataset_meets_the_keyword_baseline() -> None:
    metrics = evaluate()

    assert metrics["queryCount"] == 20
    assert metrics["recallAt5"] >= 0.9
    assert metrics["mrrAt5"] >= 0.7
    assert metrics["noAnswerAccuracy"] == 1.0


def test_project_dataset_is_realistic_sized_and_fully_resolvable() -> None:
    definition, chunks, queries = load_project_dataset()

    assert definition["name"] == "xirang-project-docs-realistic-v1"
    assert len({chunk.source_id for chunk in chunks}) == 15
    assert len(chunks) >= 150
    assert len(queries) == 100
    assert sum(bool(item.relevance) for item in queries) == 90
    assert sum(not item.relevance for item in queries) == 10
    assert {item.kind for item in queries} >= {"exact", "synonym", "cross-section", "similar-chunks", "typo", "no-answer"}


def test_project_bm25_baseline_is_reproducible() -> None:
    definition, chunks, queries = load_project_dataset()
    metrics, failures = evaluate_queries(
        definition["name"],
        chunks,
        queries,
        lambda query, corpus, top_k: search_chunks(query, corpus, top_k),
        top_k=5,
        engine=ENGINE_NAME,
    )

    assert metrics["recallAt5"] >= 0.65
    assert metrics["mrrAt5"] >= 0.4
    assert metrics["noAnswerAccuracy"] >= 0.1
    assert failures
