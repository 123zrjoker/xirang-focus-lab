from __future__ import annotations

import hashlib
import json
from typing import Any

from langgraph.types import interrupt

from .contracts import (
    AGENT_GRAPH_VERSION,
    ActionContextSnapshot,
    AgentState,
    ApprovalDecision,
    EvidenceItem,
    ExecutionAck,
    MutationIntent,
    PlanDraft,
    SavePlanArguments,
    StartFocusArguments,
    ToolRequest,
    ToolResult,
)
from .planner import Planner, PlannerExecutionError
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

    @staticmethod
    def _plan_boundary_errors(state: AgentState, plan: PlanDraft) -> list[str]:
        snapshot = ActionContextSnapshot.model_validate(state["context_snapshot"])
        allowed_action_ids = {item.id for item in snapshot.active_action_slips}
        allowed_evidence_ids = {
            item.reference_id
            for item in (EvidenceItem.model_validate(value) for value in state.get("evidence", []))
        }
        errors: list[str] = []
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
        return errors

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
        except PlannerExecutionError as error:
            message = str(error)
            self.trace.record(state["run_id"], "run_failed", node=node, details={"reason": message})
            return {"status": "failed", "validation_errors": [message], "step_count": next_step}
        except Exception as error:
            message = f"规划器执行失败：{type(error).__name__}。"
            self.trace.record(state["run_id"], "run_failed", node=node, details={"reason": message})
            return {"status": "failed", "validation_errors": [message], "step_count": next_step}

        if decision.tool_requests:
            details = {
                "decision": "tools",
                "tools": [item.name for item in decision.tool_requests],
            }
            details.update(getattr(self.planner, "last_generation_metadata", {}))
            self._end(state, node, details)
            return {
                "tool_requests": [item.model_dump(mode="json") for item in decision.tool_requests],
                "status": "using_tools",
                "step_count": next_step,
            }

        assert decision.plan_draft is not None
        details = {"decision": "plan", "item_count": len(decision.plan_draft.items)}
        details.update(getattr(self.planner, "last_generation_metadata", {}))
        self._end(state, node, details)
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
        completed_names = {item.name for item in previous_results}
        results: list[ToolResult] = []
        for request in requests:
            if request.name in completed_names:
                self.trace.record(state["run_id"], "permission_decision", node=node, details={
                    "call_id": request.call_id,
                    "tool": request.name,
                    "allowed": False,
                    "reason": "同一运行中不重复执行已完成的只读工具。",
                })
                results.append(ToolResult(
                    call_id=request.call_id,
                    name=request.name,
                    status="denied",
                    error="同一运行中不重复执行已完成的只读工具。",
                    duration_ms=0,
                ))
                continue
            results.append(self.tools.execute(request, snapshot, self.policy, self.trace, state["run_id"]))
            completed_names.add(request.name)
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

        if plan is not None:
            errors.extend(self._plan_boundary_errors(state, plan))

        next_step = state.get("step_count", 0) + 1
        if errors:
            self.trace.record(state["run_id"], "validation_failed", node=node, details={"errors": errors})
            self.trace.record(state["run_id"], "run_failed", node=node, details={"reason": "计划校验失败。"})
            return {"status": "failed", "validation_errors": errors, "step_count": next_step}

        self._end(state, node, {"item_count": len(plan.items) if plan else 0})
        return {"status": "awaiting_approval", "validation_errors": [], "step_count": next_step}

    def prepare_approval(self, state: AgentState) -> dict[str, Any]:
        node = "prepare_approval"
        self._begin(state, node)
        plan = PlanDraft.model_validate(state["plan_draft"])
        self.trace.record(state["run_id"], "approval_requested", node=node, details={
            "item_count": len(plan.items),
            "allowed_operations": ["save_plan", "start_focus"],
            "base_state_revision": ActionContextSnapshot.model_validate(
                state["context_snapshot"],
            ).base_state_revision,
        })
        self._end(state, node, {"status": "awaiting_approval"})
        return {
            "status": "awaiting_approval",
            "step_count": state.get("step_count", 0) + 1,
        }

    def human_approval(self, state: AgentState) -> dict[str, Any]:
        plan = PlanDraft.model_validate(state["plan_draft"])
        snapshot = ActionContextSnapshot.model_validate(state["context_snapshot"])
        raw_decision = interrupt({
            "kind": "plan_approval",
            "threadId": state["thread_id"],
            "runId": state["run_id"],
            "baseStateRevision": snapshot.base_state_revision,
            "planDraft": plan.model_dump(mode="json", by_alias=True),
            "allowedOperations": ["save_plan", "start_focus"],
        })
        decision = ApprovalDecision.model_validate(raw_decision)
        self.trace.record(state["run_id"], "approval_resumed", node="human_approval", details={
            "decision": decision.decision,
            "operations": decision.operations,
            "modified": decision.modified_plan is not None,
        })
        if decision.decision == "reject":
            self.trace.record(state["run_id"], "run_completed", node="human_approval", details={
                "outcome": "rejected",
                "write_intent_count": 0,
            })
            return {
                "approval_decision": decision.model_dump(mode="json"),
                "approved_operations": [],
                "status": "rejected",
                "step_count": state.get("step_count", 0) + 1,
            }
        approved_plan = decision.modified_plan or plan
        modified_errors = self._plan_boundary_errors(state, approved_plan)
        if modified_errors:
            raise ValueError("修改后的计划超出本次快照或证据边界：" + "；".join(modified_errors))
        return {
            "approval_decision": decision.model_dump(mode="json"),
            "approved_operations": decision.operations,
            "plan_draft": approved_plan.model_dump(mode="json"),
            "status": "approved",
            "step_count": state.get("step_count", 0) + 1,
        }

    @staticmethod
    def _action_id(state: AgentState, tool_name: str, arguments: dict[str, Any]) -> str:
        material = json.dumps({
            "thread_id": state["thread_id"],
            "run_id": state["run_id"],
            "tool_name": tool_name,
            "base_state_revision": ActionContextSnapshot.model_validate(
                state["context_snapshot"],
            ).base_state_revision,
            "arguments": arguments,
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return f"agent-{hashlib.sha256(material.encode('utf-8')).hexdigest()[:32]}"

    def build_mutation_intents(self, state: AgentState) -> dict[str, Any]:
        node = "build_mutation_intents"
        self._begin(state, node)
        plan = PlanDraft.model_validate(state["plan_draft"])
        snapshot = ActionContextSnapshot.model_validate(state["context_snapshot"])
        intents: list[MutationIntent] = []
        for operation in state.get("approved_operations", []):
            if operation == "save_plan":
                arguments = SavePlanArguments(
                    thread_id=state["thread_id"],
                    run_id=state["run_id"],
                    plan=plan,
                ).model_dump(mode="json", by_alias=True)
            elif operation == "start_focus":
                first = plan.items[0]
                arguments = StartFocusArguments(
                    task_name=first.title,
                    minutes=min(180, max(5, first.estimated_minutes)),
                    first_step=first.first_step,
                    completion_criteria=first.completion_criteria,
                    action_slip_id=first.source_action_slip_ids[0] if first.source_action_slip_ids else None,
                ).model_dump(mode="json", by_alias=True)
            else:
                continue
            intent = MutationIntent(
                action_id=self._action_id(state, operation, arguments),
                tool_name=operation,
                arguments=arguments,
                base_state_revision=snapshot.base_state_revision,
            )
            intents.append(intent)
            self.trace.record(state["run_id"], "mutation_proposed", node=node, details={
                "action_id": intent.action_id,
                "tool": intent.tool_name,
                "base_state_revision": intent.base_state_revision,
            })
        self._end(state, node, {"intent_count": len(intents)})
        return {
            "mutation_intents": [item.model_dump(mode="json") for item in intents],
            "status": "awaiting_execution",
            "step_count": state.get("step_count", 0) + 1,
        }

    def await_client_commit(self, state: AgentState) -> dict[str, Any]:
        intents = [MutationIntent.model_validate(item) for item in state.get("mutation_intents", [])]
        raw_ack = interrupt({
            "kind": "execution_ack",
            "threadId": state["thread_id"],
            "runId": state["run_id"],
            "mutationIntents": [item.model_dump(mode="json", by_alias=True) for item in intents],
        })
        ack = ExecutionAck.model_validate(raw_ack)
        expected_ids = {item.action_id for item in intents}
        received_ids = {item.action_id for item in ack.items}
        errors: list[str] = []
        if received_ids != expected_ids:
            errors.append("executionAck 必须且只能确认本次全部写入意图。")
        if any(item.status == "applied" for item in ack.items):
            expected_revision = intents[0].base_state_revision if intents else ""
            if ack.observed_state_revision != expected_revision:
                errors.append("前端执行前状态已变化，写入确认无效。")
        failed_items = [item for item in ack.items if item.status == "failed"]
        if failed_items:
            errors.append("前端报告写入意图执行失败。")
        status = "execution_failed" if errors else "completed"
        self.trace.record(state["run_id"], "execution_acknowledged", node="await_client_commit", details={
            "statuses": {item.action_id: item.status for item in ack.items},
            "status": status,
        })
        if errors:
            self.trace.record(state["run_id"], "run_failed", node="await_client_commit", details={
                "reason": "；".join(errors),
            })
        else:
            self.trace.record(state["run_id"], "run_completed", node="await_client_commit", details={
                "outcome": "executed",
                "write_intent_count": len(intents),
            })
        return {
            "execution_ack": ack.model_dump(mode="json"),
            "validation_errors": errors,
            "status": status,
            "step_count": state.get("step_count", 0) + 1,
        }
