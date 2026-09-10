from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from server.retrieval import RetrievalChunk


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATASET_PATH = Path(__file__).with_name("project_dataset.json")
HEADING_PATTERN = re.compile(r"^(#{1,3})\s+(.+?)\s*$")


@dataclass(frozen=True)
class EvaluationQuery:
    id: str
    query: str
    kind: str
    relevance: dict[str, int]


def _chunk_id(source: str, heading: str, start_line: int) -> str:
    value = f"{source}:{heading}:{start_line}".encode("utf-8")
    return hashlib.sha256(value).hexdigest()[:20]


def parse_markdown_document(relative_path: str) -> list[RetrievalChunk]:
    path = PROJECT_ROOT / relative_path
    lines = path.read_text(encoding="utf-8").splitlines()
    source_title = path.stem
    sections: list[tuple[str, int, list[str]]] = []
    current_heading = source_title
    current_start = 1
    current_lines: list[str] = []

    for line_number, line in enumerate(lines, 1):
        match = HEADING_PATTERN.match(line)
        if match:
            if match.group(1) == "#" and source_title == path.stem:
                source_title = match.group(2).strip()
            if current_lines:
                sections.append((current_heading, current_start, current_lines))
            current_heading = match.group(2).strip()
            current_start = line_number
            current_lines = []
            continue
        current_lines.append(line)

    if current_lines:
        sections.append((current_heading, current_start, current_lines))

    chunks: list[RetrievalChunk] = []
    for heading, start_line, section_lines in sections:
        content = "\n".join(section_lines).strip()
        if not content:
            continue
        chunks.append(RetrievalChunk(
            id=_chunk_id(relative_path, heading, start_line),
            source_id=relative_path,
            source_title=source_title,
            heading=heading,
            content=content,
            start_line=start_line,
            end_line=start_line + len(section_lines),
            start_offset=0,
            end_offset=len(content),
        ))
    return chunks


def load_project_dataset(path: Path = DATASET_PATH) -> tuple[dict, list[RetrievalChunk], list[EvaluationQuery]]:
    definition = json.loads(path.read_text(encoding="utf-8"))
    chunks = [
        chunk
        for relative_path in definition["documents"]
        for chunk in parse_markdown_document(relative_path)
    ]
    by_selector = {(chunk.source_id, chunk.heading): chunk.id for chunk in chunks}
    queries: list[EvaluationQuery] = []

    for item in definition["queries"]:
        relevance: dict[str, int] = {}
        for target in item.get("relevance", []):
            selector = (target["source"], target["heading"])
            if selector not in by_selector:
                raise ValueError(f"评测标注无法解析：{selector[0]} / {selector[1]}")
            relevance[by_selector[selector]] = int(target.get("grade", 2))
        queries.append(EvaluationQuery(
            id=item["id"],
            query=item["query"],
            kind=item["kind"],
            relevance=relevance,
        ))
    return definition, chunks, queries


def split_queries(definition: dict, queries: list[EvaluationQuery]) -> tuple[list[EvaluationQuery], list[EvaluationQuery]]:
    development_ids = set(definition.get("developmentQueryIds", []))
    development = [item for item in queries if item.id in development_ids]
    evaluation = [item for item in queries if item.id not in development_ids]
    return development, evaluation
