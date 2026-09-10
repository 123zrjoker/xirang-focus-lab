from __future__ import annotations

import math
import re
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Iterable, Sequence

import jieba


jieba.setLogLevel(40)
jieba.initialize()

ENGINE_NAME = "bm25-zh-v1"
MAX_QUERY_CHARACTERS = 500
MAX_CHUNKS = 2_000
MAX_CORPUS_CHARACTERS = 8_000_000

_CANDIDATE_PATTERN = re.compile(
    r"[a-z0-9]+(?:[._+#-][a-z0-9]+)*|[\u3400-\u4dbf\u4e00-\u9fff]+",
    re.IGNORECASE,
)
_STOPWORDS = {
    "啊", "吧", "的", "地", "得", "和", "或", "及", "与", "了", "呢", "吗", "嘛",
    "是", "在", "有", "我", "你", "他", "她", "它", "这", "那", "一个", "一种",
    "一下", "什么", "哪些", "怎么", "怎样", "如何", "为什么", "是否", "请问", "可以",
    "能够", "需要", "应该", "进行", "关于", "相关", "里面", "其中", "以及", "通过", "使用",
    "to", "the", "a", "an", "and", "or", "of", "is", "are", "how", "what", "why",
}


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).lower()
    return re.sub(r"\s+", " ", normalized).strip()


def tokenize(value: str) -> list[str]:
    """Tokenize Chinese and Latin text for a transparent lexical baseline."""
    normalized = normalize_text(value)
    terms: list[str] = []
    for candidate in _CANDIDATE_PATTERN.findall(normalized):
        if re.search(r"[\u3400-\u4dbf\u4e00-\u9fff]", candidate):
            pieces = jieba.lcut_for_search(candidate, HMM=False)
        else:
            pieces = [candidate]
        for piece in pieces:
            term = piece.strip()
            if not term or term in _STOPWORDS:
                continue
            if len(term) == 1 and not term.isascii():
                continue
            terms.append(term)
    return _unique_in_order(terms)


@dataclass(frozen=True)
class RetrievalChunk:
    id: str
    source_id: str
    source_title: str
    heading: str
    content: str
    start_line: int
    end_line: int
    start_offset: int
    end_offset: int


@dataclass(frozen=True)
class ScoreBreakdown:
    bm25: float
    title_boost: float
    heading_boost: float
    phrase_boost: float
    coverage_boost: float
    vector: float = 0.0
    rrf: float = 0.0
    reranker: float | None = None
    keyword_rank: int | None = None
    vector_rank: int | None = None
    rank_delta: int | None = None

    @property
    def total(self) -> float:
        return self.bm25 + self.title_boost + self.heading_boost + self.phrase_boost + self.coverage_boost


@dataclass(frozen=True)
class RankedChunk:
    chunk: RetrievalChunk
    score: float
    breakdown: ScoreBreakdown
    matched_terms: list[str]
    query_coverage: float
    excerpt: str


@dataclass(frozen=True)
class SearchOutput:
    query: str
    normalized_query: str
    query_terms: list[str]
    results: list[RankedChunk]
    duration_ms: float
    chunk_count: int
    source_count: int
    average_chunk_length: float
    confidence: str
    no_answer_reason: str | None


def _unique_in_order(terms: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(terms))


def _idf(document_count: int, document_frequency: int) -> float:
    return math.log(1 + (document_count - document_frequency + 0.5) / (document_frequency + 0.5))


def _excerpt(content: str, matched_terms: Sequence[str], limit: int = 210) -> str:
    if len(content) <= limit:
        return content
    normalized = normalize_text(content)
    positions = [normalized.find(term) for term in matched_terms if normalized.find(term) >= 0]
    center = min(positions) if positions else 0
    start = max(0, center - limit // 3)
    end = min(len(content), start + limit)
    start = max(0, end - limit)
    return f"{'…' if start else ''}{content[start:end].strip()}{'…' if end < len(content) else ''}"


def search_chunks(
    query: str,
    chunks: Sequence[RetrievalChunk],
    top_k: int = 5,
    *,
    now: callable = time.perf_counter,
) -> SearchOutput:
    started = now()
    normalized_query = normalize_text(query)
    query_terms = _unique_in_order(tokenize(normalized_query))
    document_tokens = [tokenize(chunk.content) for chunk in chunks]
    document_lengths = [len(tokens) for tokens in document_tokens]
    average_length = sum(document_lengths) / len(document_lengths) if document_lengths else 0.0
    document_count = len(chunks)

    if not query_terms or not chunks:
        return SearchOutput(
            query=query,
            normalized_query=normalized_query,
            query_terms=query_terms,
            results=[],
            duration_ms=round((now() - started) * 1_000, 3),
            chunk_count=document_count,
            source_count=len({chunk.source_id for chunk in chunks}),
            average_chunk_length=round(average_length, 2),
            confidence="none",
            no_answer_reason="查询中没有可用于检索的关键词。" if chunks else "知识库中还没有可检索的文本块。",
        )

    frequencies: dict[str, int] = {
        term: sum(1 for tokens in document_tokens if term in set(tokens))
        for term in query_terms
    }
    idf_by_term = {term: _idf(document_count, frequency) for term, frequency in frequencies.items()}
    phrase_needle = normalized_query.replace(" ", "")
    ranked: list[RankedChunk] = []
    k1 = 1.5
    b = 0.75

    for chunk, tokens, length in zip(chunks, document_tokens, document_lengths):
        counts = Counter(tokens)
        title_terms = set(tokenize(chunk.source_title))
        heading_terms = set(tokenize(chunk.heading))
        all_terms = set(tokens) | title_terms | heading_terms
        matched_terms = [term for term in query_terms if term in all_terms]
        if not matched_terms:
            continue

        bm25 = 0.0
        for term in query_terms:
            term_frequency = counts.get(term, 0)
            if not term_frequency:
                continue
            denominator = term_frequency + k1 * (
                1 - b + b * (length / average_length if average_length else 0)
            )
            bm25 += idf_by_term[term] * (term_frequency * (k1 + 1)) / denominator

        title_boost = sum(idf_by_term[term] * 0.8 for term in query_terms if term in title_terms)
        heading_boost = sum(idf_by_term[term] * 0.9 for term in query_terms if term in heading_terms)
        normalized_combined = normalize_text(f"{chunk.source_title} {chunk.heading} {chunk.content}").replace(" ", "")
        phrase_boost = 0.0
        if len(phrase_needle) >= 2 and phrase_needle in normalized_combined:
            phrase_boost = min(2.5, 0.6 + len(query_terms) * 0.18)
        coverage = len(matched_terms) / len(query_terms)
        coverage_boost = coverage * 0.4
        breakdown = ScoreBreakdown(
            bm25=bm25,
            title_boost=title_boost,
            heading_boost=heading_boost,
            phrase_boost=phrase_boost,
            coverage_boost=coverage_boost,
        )
        ranked.append(RankedChunk(
            chunk=chunk,
            score=breakdown.total,
            breakdown=breakdown,
            matched_terms=matched_terms,
            query_coverage=coverage,
            excerpt=_excerpt(chunk.content, matched_terms),
        ))

    ranked.sort(key=lambda item: (-item.score, -item.query_coverage, item.chunk.source_title, item.chunk.id))
    results = ranked[:top_k]
    confidence = "none"
    no_answer_reason: str | None = "没有文本块命中有效查询词。"
    if (
        results
        and len(query_terms) >= 3
        and results[0].query_coverage < 0.34
        and results[0].breakdown.bm25 == 0
    ):
        results = []
        no_answer_reason = "只命中了少量宽泛词，查询覆盖度不足，暂不返回可能误导的结果。"
    if results:
        confidence = "strong" if results[0].query_coverage >= 0.67 and results[0].score >= 1.5 else "possible"
        no_answer_reason = None

    return SearchOutput(
        query=query,
        normalized_query=normalized_query,
        query_terms=query_terms,
        results=results,
        duration_ms=round((now() - started) * 1_000, 3),
        chunk_count=document_count,
        source_count=len({chunk.source_id for chunk in chunks}),
        average_chunk_length=round(average_length, 2),
        confidence=confidence,
        no_answer_reason=no_answer_reason,
    )
