from __future__ import annotations

from typing import Any

from .contracts import (
    AGENT_GRAPH_VERSION,
    ActionContextSnapshot,
    AgentState,
    EvidenceItem,
    PlanDraft,
    ToolRequest,
    ToolResult,
)
from .planner import Planner
from .policies import PermissionPolicy
from .tools import ToolRegistry
from .tracing import TraceRecorder


MAX_AGENT_STEPS = 12


class AgentNodes:
    def __init__(
        self,
        planner: Planner,
        tools: ToolRegistry,
        policy: PermissionPolicy,
        trace: TraceRecorder,
    ) -> None:
        self.planner = planner
        self.tools = tools
        self.policy = policy
        self.trace = trace

    def _begin(self, state: AgentState, node: str) -> None:
        self.trace.record(state["run_id"], "node_started", node=node, details={
            "step": state.get("step_count", 0) + 1,
            "graph_version": AGENT_GRAPH_VERSION,
        })

    def _end(self, state: AgentState, node: str, details: dict[str, Any] | None = None) -> None:
        self.trace.record(state["run_id"], "node_completed", node=node, details=details or {})

    def load_user_context(self, state: AgentState) -> dict[str, Any]:
        node = "load_user_context"
        self._begin(state, node)
        snapshot = ActionContextSnapshot.model_validate(state["context_snapshot"])
        self._end(state, node, {
            "snapshot_id": snapshot.snapshot_id,
            "consent_scope": snapshot.consent_scope,
            "action_slip_count": len(snapshot.active_action_slips),
            "knowledge_source_count": len(snapshot.selected_knowledge_source_ids),
        })
        return {
            "request": snapshot.user_request,
            "status": "planning",
            "step_count": state.get("step_count", 0) + 1,
        }

    def planner_node(self, state: AgentState) -> dict[str, Any]:
        node = "planner"
        self._begin(state, node)
        next_step = state.get("step_count", 0) + 1
        if next_step > MAX_AGENT_STEPS:
            error = f"Agent 超过最大步骤数 {MAX_AGENT_STEPS}。"
            self.trace.record(state["run_id"], "run_failed", node=node, details={"reason": error})
            return {"status": "failed", "validation_errors": [error], "step_count": next_step}

        snapshot = ActionContextSnapshot.model_validate(state["context_snapshot"])
        tool_results = [ToolResult.model_validate(item) for item in state.get("tool_results", [])]
        try:
            decision = self.planner.plan(snapshot, tool_results)
        except Exception as error:
            message = f"规划器执行失败：{type(error).__name__}。"
            self.trace.record(state["run_id"], "run_failed", node=node, details={"reason": message})
            return {"status": "failed", "validation_errors": [message], "step_count": next_step}

        if decision.tool_requests:
            self._end(state, node, {
                "decision": "tools",
                "tools": [item.name for item in decision.tool_requests],
            })
            return {
                "tool_requests": [item.model_dump(mode="json") for item in decision.tool_requests],
                "status": "using_tools",
                "step_count": next_step,
            }

        assert decision.plan_draft is not None
        self._end(state, node, {"decision": "plan", "item_count": len(decision.plan_draft.items)})
        return {
            "plan_draft": decision.plan_draft.model_dump(mode="json"),
            "tool_requests": [],
            "status": "validating",
            "step_count": next_step,
        }

    def tool_router(self, state: AgentState) -> dict[str, Any]:
        node = "tool_router"
        self._begin(state, node)
        snapshot = ActionContextSnapshot.model_validate(state["context_snapshot"])
        requests = [ToolRequest.model_validate(item) for item in state.get("tool_requests", [])]
        previous_results = [ToolResult.model_validate(item) for item in state.get("tool_results", [])]
        results = [
            self.tools.execute(request, snapshot, self.policy, self.trace, state["run_id"])
            for request in requests
        ]
        all_results = [*previous_results, *results]
        evidence_by_id = {
            item.reference_id: item
            for item in (EvidenceItem.model_validate(value) for value in state.get("evidence", []))
        }
        for result in results:
            if result.status != "success":
                continue
            for value in result.output.get("evidence", []):
                item = EvidenceItem.model_validate(value)
                evidence_by_id[item.reference_id] = item
        self._end(state, node, {
            "tool_count": len(results),
            "statuses": {item.name: item.status for item in results},
        })
        return {
            "tool_requests": [],
            "tool_results": [item.model_dump(mode="json") for item in all_results],
            "evidence": [item.model_dump(mode="json") for item in evidence_by_id.values()],
            "status": "planning",
            "step_count": state.get("step_count", 0) + 1,
        }

    def validator(self, state: AgentState) -> dict[str, Any]:
        node = "validator"
        self._begin(state, node)
        errors: list[str] = []
        try:
            plan = PlanDraft.model_validate(state.get("plan_draft"))
        except Exception:
            plan = None
            errors.append("规划结果不符合 PlanDraft 契约。")

        snapshot = ActionContextSnapshot.model_validate(state["context_snapshot"])
        allowed_action_ids = {item.id for item in snapshot.active_action_slips}
        allowed_evidence_ids = {
            item.reference_id
            for item in (EvidenceItem.model_validate(value) for value in state.get("evidence", []))
        }
        if plan is not None:
            for item in plan.items:
                unknown_actions = set(item.source_action_slip_ids) - allowed_action_ids
                if unknown_actions:
                    errors.append(f"计划引用了快照外待办：{', '.join(sorted(unknown_actions))}。")
                unknown_evidence = set(item.evidence_refs) - allowed_evidence_ids
                if unknown_evidence:
                    errors.append(f"计划引用了不存在的证据：{', '.join(sorted(unknown_evidence))}。")
            unknown_summary_evidence = set(plan.evidence_refs) - allowed_evidence_ids
            if unknown_summary_evidence:
                errors.append(f"计划摘要引用了不存在的证据：{', '.join(sorted(unknown_summary_evidence))}。")
            if sum(item.estimated_minutes for item in plan.items) > 1_200:
                errors.append("计划总时长超过只读草案上限。")

        next_step = state.get("step_count", 0) + 1
        if errors:
            self.trace.record(state["run_id"], "validation_failed", node=node, details={"errors": errors})
            self.trace.record(state["run_id"], "run_failed", node=node, details={"reason": "计划校验失败。"})
            return {"status": "failed", "validation_errors": errors, "step_count": next_step}

        self._end(state, node, {"item_count": len(plan.items) if plan else 0})
        self.trace.record(state["run_id"], "run_completed", node=node, details={
            "item_count": len(plan.items) if plan else 0,
            "write_intent_count": 0,
        })
        return {"status": "completed", "validation_errors": [], "step_count": next_step}
