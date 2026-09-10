from __future__ import annotations

import json
import math
from pathlib import Path

from server.retrieval import RetrievalChunk, search_chunks


DATASET_PATH = Path(__file__).with_name("dataset.json")


def load_dataset(path: Path = DATASET_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def evaluate(path: Path = DATASET_PATH, top_k: int = 5) -> dict[str, float | int | str]:
    dataset = load_dataset(path)
    chunks = [RetrievalChunk(
        id=item["id"],
        source_id=item["sourceId"],
        source_title=item["sourceTitle"],
        heading=item["heading"],
        content=item["content"],
        start_line=1,
        end_line=1,
        start_offset=0,
        end_offset=len(item["content"]),
    ) for item in dataset["chunks"]]

    reciprocal_ranks: list[float] = []
    recalls: list[float] = []
    hit_at_one = 0
    no_answer_hits = 0
    no_answer_count = 0
    durations: list[float] = []

    for item in dataset["queries"]:
        relevant = set(item["relevantChunkIds"])
        output = search_chunks(item["query"], chunks, top_k=top_k)
        durations.append(output.duration_ms)
        returned = [result.chunk.id for result in output.results]
        if not relevant:
            no_answer_count += 1
            if output.confidence == "none":
                no_answer_hits += 1
            continue
        hit_at_one += int(bool(returned) and returned[0] in relevant)
        recalls.append(len(relevant.intersection(returned)) / len(relevant))
        first_rank = next((index for index, identifier in enumerate(returned, 1) if identifier in relevant), None)
        reciprocal_ranks.append(1 / first_rank if first_rank else 0.0)

    answerable_count = len(reciprocal_ranks)
    ordered_durations = sorted(durations)
    p95_index = max(0, math.ceil(len(ordered_durations) * 0.95) - 1)
    return {
        "dataset": dataset["name"],
        "queryCount": len(dataset["queries"]),
        "answerableCount": answerable_count,
        "hitAt1": round(hit_at_one / answerable_count, 4) if answerable_count else 0.0,
        "recallAt5": round(sum(recalls) / len(recalls), 4) if recalls else 0.0,
        "mrrAt5": round(sum(reciprocal_ranks) / answerable_count, 4) if answerable_count else 0.0,
        "noAnswerAccuracy": round(no_answer_hits / no_answer_count, 4) if no_answer_count else 0.0,
        "latencyP50Ms": round(ordered_durations[len(ordered_durations) // 2], 3) if durations else 0.0,
        "latencyP95Ms": round(ordered_durations[p95_index], 3) if durations else 0.0,
    }


if __name__ == "__main__":
    print(json.dumps(evaluate(), ensure_ascii=False, indent=2))
