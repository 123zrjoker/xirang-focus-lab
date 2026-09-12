from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Literal, Sequence, Type

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..generation import build_context
from ..hybrid import RERANK_ENGINE_NAME, RRF_ENGINE_NAME, hybrid_search, reranker_provider
from ..semantic import LocalVectorIndex, semantic_index
from .contracts import (
    ActionContextSnapshot,
    EvidenceItem,
    ToolDefinition,
    ToolRequest,
    ToolResult,
    to_camel,
)
from .policies import PermissionPolicy
from .tracing import TraceRecorder


class ToolInput(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class QueryTodosInput(ToolInput):
    statuses: list[Literal["inbox", "current"]] = Field(
        default_factory=lambda: ["current", "inbox"],
        min_length=1,
        max_length=2,
    )
    limit: int = Field(default=20, ge=1, le=100)


class QueryFocusSummaryInput(ToolInput):
    include_distraction_counts: bool = True


class RetrievePersonalKnowledgeInput(ToolInput):
    query: str = Field(min_length=1, max_length=500)
    source_ids: list[str] = Field(min_length=1, max_length=100)
    top_k: int = Field(default=6, ge=1, le=8)
    retrieval_mode: Literal["hybrid", "hybrid_rerank"] = "hybrid_rerank"


ToolHandler = Callable[[ActionContextSnapshot, BaseModel], dict[str, Any]]


@dataclass(frozen=True)
class RegisteredTool:
    definition: ToolDefinition
    input_model: Type[BaseModel]
    handler: ToolHandler


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}

    def register(self, tool: RegisteredTool) -> None:
        if tool.definition.name in self._tools:
            raise ValueError(f"工具已注册：{tool.definition.name}")
        if tool.definition.risk_level != "read":
            raise ValueError("0.5.0 Registry 只接受只读工具。")
        self._tools[tool.definition.name] = tool

    def definitions(self) -> list[ToolDefinition]:
        return [tool.definition for tool in self._tools.values()]

    def get(self, name: str) -> RegisteredTool:
        try:
            return self._tools[name]
        except KeyError as error:
            raise KeyError(f"未知或未注册工具：{name}") from error

    def execute(
        self,
        request: ToolRequest,
        snapshot: ActionContextSnapshot,
        policy: PermissionPolicy,
        trace: TraceRecorder,
        run_id: str,
    ) -> ToolResult:
        started = time.perf_counter()
        trace.record(
            run_id,
            "tool_requested",
            node="tool_router",
            details={"call_id": request.call_id, "tool": request.name, "purpose": request.purpose},
        )
        try:
            tool = self.get(request.name)
        except KeyError as error:
            result = ToolResult(
                call_id=request.call_id,
                name=request.name,
                status="denied",
                error=str(error),
                duration_ms=round((time.perf_counter() - started) * 1_000, 3),
            )
            trace.record(run_id, "permission_decision", node="tool_router", details={
                "call_id": request.call_id,
                "tool": request.name,
                "allowed": False,
                "reason": str(error),
            })
            return result

        decision = policy.authorize(tool.definition, request, snapshot)
        trace.record(run_id, "permission_decision", node="tool_router", details={
            "call_id": request.call_id,
            "tool": request.name,
            "allowed": decision.allowed,
            "reason": decision.reason,
        })
        if not decision.allowed:
            return ToolResult(
                call_id=request.call_id,
                name=request.name,
                status="denied",
                error=decision.reason,
                duration_ms=round((time.perf_counter() - started) * 1_000, 3),
            )

        try:
            parsed_input = tool.input_model.model_validate(request.arguments)
            output = tool.handler(snapshot, parsed_input)
            result = ToolResult(
                call_id=request.call_id,
                name=request.name,
                status="success",
                output=output,
                duration_ms=round((time.perf_counter() - started) * 1_000, 3),
            )
        except ValidationError as error:
            result = ToolResult(
                call_id=request.call_id,
                name=request.name,
                status="error",
                error=f"工具参数不符合契约（{len(error.errors())} 项校验错误）。",
                duration_ms=round((time.perf_counter() - started) * 1_000, 3),
            )
        except Exception as error:
            result = ToolResult(
                call_id=request.call_id,
                name=request.name,
                status="error",
                error=f"工具执行失败：{type(error).__name__}。",
                duration_ms=round((time.perf_counter() - started) * 1_000, 3),
            )
        trace.record(run_id, "tool_completed", node="tool_router", details={
            "call_id": request.call_id,
            "tool": request.name,
            "status": result.status,
            "duration_ms": result.duration_ms,
            "result_keys": sorted(result.output),
            "error": result.error,
        })
        return result


def _query_todos(snapshot: ActionContextSnapshot, raw_input: BaseModel) -> dict[str, Any]:
    request = QueryTodosInput.model_validate(raw_input)
    statuses = set(request.statuses)
    todos = [
        item.model_dump(mode="json")
        for item in snapshot.active_action_slips
        if item.status in statuses
    ][:request.limit]
    return {
        "todos": todos,
        "returned_count": len(todos),
        "available_count": len(snapshot.active_action_slips),
        "sample_limited": snapshot.sample_boundaries.action_slip_limit < snapshot.sample_boundaries.action_slip_total,
    }


def _query_focus_summary(snapshot: ActionContextSnapshot, raw_input: BaseModel) -> dict[str, Any]:
    request = QueryFocusSummaryInput.model_validate(raw_input)
    if snapshot.focus_summary is None:
        return {"available": False, "summary": None}
    summary = snapshot.focus_summary.model_dump(mode="json")
    if not request.include_distraction_counts:
        summary["distraction_counts"] = {}
    return {"available": True, "summary": summary}


def _knowledge_handler(
    vector_index: LocalVectorIndex,
    reranker: Any,
) -> ToolHandler:
    def retrieve(snapshot: ActionContextSnapshot, raw_input: BaseModel) -> dict[str, Any]:
        request = RetrievePersonalKnowledgeInput.model_validate(raw_input)
        allowed = set(snapshot.selected_knowledge_source_ids)
        source_ids = list(dict.fromkeys(request.source_ids))
        if any(source_id not in allowed for source_id in source_ids):
            raise PermissionError("知识检索参数超出本次授权范围。")

        chunks = vector_index.chunks()
        active_reranker = reranker if request.retrieval_mode == "hybrid_rerank" and reranker.available else None
        retrieval = hybrid_search(
            request.query,
            chunks,
            vector_index,
            request.top_k,
            reranker=active_reranker,
            source_ids=source_ids,
        )
        context = build_context(retrieval.results)
        evidence = [EvidenceItem(
            reference_id=item.reference_id,
            chunk_id=item.chunk_id,
            source_id=item.source_id,
            source_title=item.source_title,
            heading=item.heading,
            content=item.content,
            start_line=item.start_line,
            end_line=item.end_line,
            retrieval_score=round(item.retrieval_score, 6),
            instruction_flagged=item.instruction_flagged,
        ).model_dump(mode="json") for item in context.evidence]
        warnings: list[str] = []
        if request.retrieval_mode == "hybrid_rerank" and active_reranker is None:
            warnings.append("Cross-Encoder 不可用，知识工具已降级为 RRF 混合检索。")
        if context.flagged_reference_ids:
            warnings.append("部分证据含疑似指令文本，已标记为不可信内容。")
        return {
            "engine": RERANK_ENGINE_NAME if active_reranker else RRF_ENGINE_NAME,
            "mode": request.retrieval_mode,
            "confidence": retrieval.confidence,
            "no_answer_reason": retrieval.no_answer_reason,
            "evidence": evidence,
            "warnings": warnings,
        }

    return retrieve


def _schema(model: Type[BaseModel]) -> dict[str, Any]:
    return model.model_json_schema(by_alias=True)


def build_read_only_registry(
    vector_index: LocalVectorIndex = semantic_index,
    reranker: Any = reranker_provider,
) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(RegisteredTool(
        definition=ToolDefinition(
            name="query_todos",
            description="读取用户本次显式提供的未完成行动待办。",
            input_schema=_schema(QueryTodosInput),
            output_schema={"type": "object"},
            risk_level="read",
            required_permissions=["todos"],
        ),
        input_model=QueryTodosInput,
        handler=_query_todos,
    ))
    registry.register(RegisteredTool(
        definition=ToolDefinition(
            name="query_focus_summary",
            description="读取由前端确定性聚合的近期专注摘要，不读取原始会话正文。",
            input_schema=_schema(QueryFocusSummaryInput),
            output_schema={"type": "object"},
            risk_level="read",
            required_permissions=["focus_summary"],
        ),
        input_model=QueryFocusSummaryInput,
        handler=_query_focus_summary,
    ))
    registry.register(RegisteredTool(
        definition=ToolDefinition(
            name="retrieve_personal_knowledge",
            description="只在用户本次选择的知识来源中执行混合检索并返回可引用证据。",
            input_schema=_schema(RetrievePersonalKnowledgeInput),
            output_schema={"type": "object"},
            risk_level="read",
            required_permissions=["knowledge_sources"],
            timeout_ms=120_000,
            redaction_policy="content",
        ),
        input_model=RetrievePersonalKnowledgeInput,
        handler=_knowledge_handler(vector_index, reranker),
    ))
    return registry
