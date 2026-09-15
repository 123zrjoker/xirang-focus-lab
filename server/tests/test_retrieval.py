from fastapi.testclient import TestClient

from server.main import app
from server.retrieval import RetrievalChunk, search_chunks, tokenize


def chunk(identifier: str, title: str, heading: str, content: str) -> RetrievalChunk:
    return RetrievalChunk(
        id=identifier,
        source_id=f"source-{identifier}",
        source_title=title,
        heading=heading,
        content=content,
        start_line=1,
        end_line=3,
        start_offset=0,
        end_offset=len(content),
    )


CORPUS = [
    chunk("start", "低阻力启动指南", "开始行动", "当任务让人抗拒时，先把任务缩小成一个可以立刻执行的动作，例如只打开文档并写下标题。"),
    chunk("focus", "专注复盘", "减少手机分心", "开始专注前将手机调成静音并放到看不见的位置，分心念头可以先写进停车场。"),
    chunk("pdf", "知识库说明", "PDF 导入", "文字型 PDF 可以提取文字层并保留页码，扫描 PDF 当前需要 OCR。"),
]


def test_tokenize_normalizes_chinese_and_latin_terms() -> None:
    terms = tokenize("请问，如何使用 FastAPI 建立 PDF 检索？")

    assert "fastapi" in terms
    assert "pdf" in terms
    assert "检索" in terms
    assert "如何" not in terms


def test_bm25_returns_traceable_best_match() -> None:
    output = search_chunks("怎样减少专注时的手机分心？", CORPUS, top_k=2)

    assert output.results[0].chunk.id == "focus"
    assert {"手机", "分心"}.issubset(set(output.results[0].matched_terms))
    assert output.results[0].breakdown.bm25 > 0
    assert output.confidence == "strong"


def test_title_and_heading_are_explainable_boosts() -> None:
    output = search_chunks("PDF 导入", CORPUS, top_k=3)

    assert output.results[0].chunk.id == "pdf"
    assert output.results[0].breakdown.heading_boost > 0
    assert output.results[0].breakdown.phrase_boost > 0


def test_no_match_returns_an_explicit_no_answer_state() -> None:
    output = search_chunks("量子芯片超导实验", CORPUS)

    assert output.results == []
    assert output.confidence == "none"
    assert output.no_answer_reason


def test_api_is_stateless_and_returns_camel_case_contract() -> None:
    client = TestClient(app)
    health = client.get("/api/health")
    diagnostics = client.get("/api/diagnostics")
    response = client.post("/api/retrieval/search", json={
        "query": "如何开始抗拒的任务",
        "topK": 2,
        "chunks": [{
            "id": item.id,
            "sourceId": item.source_id,
            "sourceTitle": item.source_title,
            "heading": item.heading,
            "content": item.content,
            "startLine": item.start_line,
            "endLine": item.end_line,
            "startOffset": item.start_offset,
            "endOffset": item.end_offset,
        } for item in CORPUS],
    })

    assert health.status_code == 200
    assert health.json()["storesData"] is False
    assert diagnostics.status_code == 200
    assert diagnostics.json()["agent"]["operationMode"] == "serialized"
    assert diagnostics.json()["runtime"]["pythonVersion"]
    assert diagnostics.json()["retrieval"]["cache"]["resultCache"]["capacity"] == 64
    assert diagnostics.json()["retrieval"]["indexTask"]["state"] == "idle"
    assert response.status_code == 200
    payload = response.json()
    assert payload["engine"] == "bm25-zh-v1"
    assert payload["results"][0]["chunkId"] == "start"
    assert payload["corpusStats"]["chunkCount"] == 3


def test_api_rejects_an_oversized_query() -> None:
    response = TestClient(app).post("/api/retrieval/search", json={
        "query": "检索" * 300,
        "chunks": [],
    })

    assert response.status_code == 422
