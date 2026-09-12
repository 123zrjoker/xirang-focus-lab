from __future__ import annotations

from typing import Protocol, Sequence

from .contracts import (
    ActionContextSnapshot,
    PlanDraft,
    PlanItem,
    PlannerDecision,
    ToolRequest,
    ToolResult,
)


class Planner(Protocol):
    name: str
    model: str

    def plan(
        self,
        snapshot: ActionContextSnapshot,
        tool_results: Sequence[ToolResult],
    ) -> PlannerDecision: ...


class DeterministicPlanner:
    """A deterministic planner used for routing tests and offline demos."""

    name = "deterministic-planner"
    model = "fake-0.5.0-v1"

    def plan(
        self,
        snapshot: ActionContextSnapshot,
        tool_results: Sequence[ToolResult],
    ) -> PlannerDecision:
        if not tool_results:
            requests: list[ToolRequest] = []
            scopes = set(snapshot.consent_scope)
            if "todos" in scopes:
                requests.append(ToolRequest(
                    call_id="read-todos",
                    name="query_todos",
                    arguments={"statuses": ["current", "inbox"], "limit": 20},
                    purpose="读取用户本次选择的未完成任务。",
                ))
            if "focus_summary" in scopes:
                requests.append(ToolRequest(
                    call_id="read-focus-summary",
                    name="query_focus_summary",
                    arguments={"include_distraction_counts": True},
                    purpose="根据近期专注表现控制计划强度。",
                ))
            if "knowledge_sources" in scopes and snapshot.selected_knowledge_source_ids:
                requests.append(ToolRequest(
                    call_id="retrieve-knowledge",
                    name="retrieve_personal_knowledge",
                    arguments={
                        "query": snapshot.user_request,
                        "source_ids": snapshot.selected_knowledge_source_ids,
                        "top_k": 6,
                        "retrieval_mode": "hybrid_rerank",
                    },
                    purpose="在用户选定的资料中查找规划依据。",
                ))
            if requests:
                return PlannerDecision(tool_requests=requests)

        todo_result = next((item for item in tool_results if item.name == "query_todos" and item.status == "success"), None)
        knowledge_result = next((
            item for item in tool_results
            if item.name == "retrieve_personal_knowledge" and item.status == "success"
        ), None)
        todos = todo_result.output.get("todos", []) if todo_result else []
        evidence = knowledge_result.output.get("evidence", []) if knowledge_result else []
        evidence_refs = [
            item["reference_id"]
            for item in evidence
            if isinstance(item, dict) and isinstance(item.get("reference_id"), str)
        ][:8]

        plan_items: list[PlanItem] = []
        for item in todos[:5]:
            if not isinstance(item, dict) or not isinstance(item.get("title"), str):
                continue
            title = item["title"]
            first_step = item.get("next_step") or f"打开与“{title}”相关的材料，并完成第一个可见动作。"
            plan_items.append(PlanItem(
                title=title,
                first_step=first_step,
                completion_criteria=f"为“{title}”留下一个可检查的阶段结果。",
                estimated_minutes=snapshot.goal_and_preferences.preferred_focus_minutes,
                rationale="该任务来自用户本次显式选择的未完成待办。",
                source_action_slip_ids=[str(item.get("id"))],
                evidence_refs=evidence_refs[:2],
            ))

        if not plan_items:
            plan_items.append(PlanItem(
                title=snapshot.user_request[:120],
                first_step="把目标改写成一个可以在当前专注时段开始的动作。",
                completion_criteria="完成第一步，并记录下一步。",
                estimated_minutes=snapshot.goal_and_preferences.preferred_focus_minutes,
                rationale="当前快照没有提供未完成待办，因此仅依据用户请求生成保守草案。",
                evidence_refs=evidence_refs[:2],
            ))

        assumptions: list[str] = []
        failed_tools = [item.name for item in tool_results if item.status != "success"]
        if failed_tools:
            assumptions.append(f"以下只读信息未成功获取：{', '.join(failed_tools)}。")
        if snapshot.sample_boundaries.action_slip_limit < snapshot.sample_boundaries.action_slip_total:
            assumptions.append("待办仅包含快照声明的有限样本，并非完整历史。")

        return PlannerDecision(plan_draft=PlanDraft(
            title="个人行动计划草案",
            summary="根据本次显式授权的行动上下文生成；这是只读提案，不会修改本地数据。",
            items=plan_items,
            assumptions=assumptions,
            evidence_refs=evidence_refs,
        ))


class ScriptedPlanner:
    """Finite scripted planner for deterministic graph-path tests."""

    name = "scripted-planner"
    model = "scripted-test-v1"

    def __init__(self, decisions: Sequence[PlannerDecision]) -> None:
        self._decisions = list(decisions)
        self._index = 0

    def plan(
        self,
        snapshot: ActionContextSnapshot,
        tool_results: Sequence[ToolResult],
    ) -> PlannerDecision:
        del snapshot, tool_results
        if self._index >= len(self._decisions):
            raise RuntimeError("ScriptedPlanner 没有剩余决策。")
        decision = self._decisions[self._index]
        self._index += 1
        return decision
