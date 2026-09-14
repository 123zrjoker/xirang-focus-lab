from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from uuid import uuid4

from langgraph.types import Command

from .checkpoints import build_in_memory_checkpointer, normalize_checkpoint_state
from .contracts import (
    AGENT_GRAPH_VERSION,
    AGENT_SCHEMA_VERSION,
    ActionContextSnapshot,
    AgentRunResult,
    ApprovalDecision,
    EvidenceItem,
    ExecutionAck,
    MutationIntent,
    ToolResult,
)
from .graph import build_agent_graph
from .nodes import AgentNodes
from .planner import DeterministicPlanner, Planner
from .policies import PermissionPolicy
from .prompts import PromptRegistry, build_prompt_registry
from .tools import RegisteredTool, ToolRegistry, build_read_only_registry
from .tracing import TraceRecorder


class AgentHarness:
    """Durable runtime around the read-only planning and approved-mutation workflow."""

    def __init__(
        self,
        *,
        planner: Planner | None = None,
        tools: ToolRegistry | None = None,
        policy: PermissionPolicy | None = None,
        trace: TraceRecorder | None = None,
        prompts: PromptRegistry | None = None,
        checkpointer=None,
    ) -> None:
        self.planner = planner or DeterministicPlanner()
        self.tools = tools or build_read_only_registry()
        self.policy = policy or PermissionPolicy()
        self.trace = trace or TraceRecorder()
        self.prompts = prompts or build_prompt_registry()
        self.checkpointer = checkpointer or build_in_memory_checkpointer()
        self.nodes = AgentNodes(self.planner, self.tools, self.policy, self.trace)
        self.graph = build_agent_graph(self.nodes, checkpointer=self.checkpointer)

    def _initial_state(self, snapshot: ActionContextSnapshot, thread_id: str, run_id: str) -> dict[str, Any]:
        return {
            "schema_version": AGENT_SCHEMA_VERSION,
            "graph_version": AGENT_GRAPH_VERSION,
            "thread_id": thread_id,
            "run_id": run_id,
            "request": snapshot.user_request,
            "context_snapshot": snapshot.model_dump(mode="json"),
            "tool_requests": [],
            "tool_results": [],
            "evidence": [],
            "plan_draft": None,
            "validation_errors": [],
            "approval_decision": None,
            "approved_operations": [],
            "mutation_intents": [],
            "execution_ack": None,
            "status": "created",
            "step_count": 0,
        }

    @staticmethod
    def _config(thread_id: str) -> dict[str, dict[str, str]]:
        return {"configurable": {"thread_id": thread_id}}

    @staticmethod
    def _normalize_thread_id(thread_id: str) -> str:
        normalized_thread_id = thread_id.strip()
        if not normalized_thread_id or len(normalized_thread_id) > 100:
            raise ValueError("thread_id 必须是 1～100 个字符。")
        return normalized_thread_id

    def _result_from_state(self, state: dict[str, Any]) -> AgentRunResult:
        state = normalize_checkpoint_state(state)
        return AgentRunResult(
            schema_version=AGENT_SCHEMA_VERSION,
            graph_version=state.get("graph_version", AGENT_GRAPH_VERSION),
            thread_id=state["thread_id"],
            run_id=state["run_id"],
            status=state["status"],
            plan_draft=state.get("plan_draft"),
            evidence=[EvidenceItem.model_validate(item) for item in state.get("evidence", [])],
            tool_results=[ToolResult.model_validate(item) for item in state.get("tool_results", [])],
            validation_errors=state.get("validation_errors", []),
            approval_decision=state.get("approval_decision"),
            mutation_intents=[MutationIntent.model_validate(item) for item in state.get("mutation_intents", [])],
            execution_ack=state.get("execution_ack"),
            trace=self.trace.get(state["run_id"]),
        )

    def run(self, request: ActionContextSnapshot | dict[str, Any], thread_id: str) -> AgentRunResult:
        snapshot = ActionContextSnapshot.model_validate(request)
        normalized_thread_id = self._normalize_thread_id(thread_id)
        existing = self.graph.get_state(self._config(normalized_thread_id))
        if existing.values:
            raise ValueError("thread_id 已存在；请恢复现有线程或使用新的 thread_id。")
        run_id = str(uuid4())
        self.trace.record(run_id, "run_started", details={
            "thread_id": normalized_thread_id,
            "snapshot_id": snapshot.snapshot_id,
            "planner": self.planner.name,
            "model": self.planner.model,
            "schema_version": AGENT_SCHEMA_VERSION,
            "graph_version": AGENT_GRAPH_VERSION,
            "prompt_versions": self.prompts.versions(),
            "tool_versions": self.tools.versions(),
        })
        final_state = self.graph.invoke(
            self._initial_state(snapshot, normalized_thread_id, run_id),
            config=self._config(normalized_thread_id),
        )
        return self._result_from_state(final_state)

    def get_state(self, thread_id: str) -> AgentRunResult:
        normalized_thread_id = self._normalize_thread_id(thread_id)
        snapshot = self.graph.get_state(self._config(normalized_thread_id))
        if not snapshot.values:
            raise KeyError("没有找到对应的 Agent 线程。")
        return self._result_from_state(dict(snapshot.values))

    def resume(self, thread_id: str, decision: ApprovalDecision | dict[str, Any]) -> AgentRunResult:
        normalized_thread_id = self._normalize_thread_id(thread_id)
        current = self.get_state(normalized_thread_id)
        if current.status != "awaiting_approval":
            if current.status in {"awaiting_execution", "rejected", "completed", "execution_failed"}:
                return current
            raise ValueError(f"当前线程状态 {current.status} 不能接收审批决定。")
        parsed = ApprovalDecision.model_validate(decision)
        final_state = self.graph.invoke(
            Command(resume=parsed.model_dump(mode="json", by_alias=True)),
            config=self._config(normalized_thread_id),
        )
        return self._result_from_state(final_state)

    def resume_stream(
        self,
        thread_id: str,
        decision: ApprovalDecision | dict[str, Any],
    ) -> Iterator[dict[str, Any]]:
        normalized_thread_id = self._normalize_thread_id(thread_id)
        current = self.get_state(normalized_thread_id)
        if current.status != "awaiting_approval":
            if current.status in {"awaiting_execution", "rejected", "completed", "execution_failed"}:
                return
            raise ValueError(f"当前线程状态 {current.status} 不能接收审批决定。")
        parsed = ApprovalDecision.model_validate(decision)
        yield from self.graph.stream(
            Command(resume=parsed.model_dump(mode="json", by_alias=True)),
            config=self._config(normalized_thread_id),
            stream_mode="updates",
            version="v2",
        )

    def acknowledge(self, thread_id: str, ack: ExecutionAck | dict[str, Any]) -> AgentRunResult:
        normalized_thread_id = self._normalize_thread_id(thread_id)
        current = self.get_state(normalized_thread_id)
        if current.status != "awaiting_execution":
            if current.status in {"completed", "execution_failed"}:
                return current
            raise ValueError(f"当前线程状态 {current.status} 不能接收执行确认。")
        parsed = ExecutionAck.model_validate(ack)
        final_state = self.graph.invoke(
            Command(resume=parsed.model_dump(mode="json", by_alias=True)),
            config=self._config(normalized_thread_id),
        )
        return self._result_from_state(final_state)

    def acknowledge_stream(
        self,
        thread_id: str,
        ack: ExecutionAck | dict[str, Any],
    ) -> Iterator[dict[str, Any]]:
        normalized_thread_id = self._normalize_thread_id(thread_id)
        current = self.get_state(normalized_thread_id)
        if current.status != "awaiting_execution":
            if current.status in {"completed", "execution_failed"}:
                return
            raise ValueError(f"当前线程状态 {current.status} 不能接收执行确认。")
        parsed = ExecutionAck.model_validate(ack)
        yield from self.graph.stream(
            Command(resume=parsed.model_dump(mode="json", by_alias=True)),
            config=self._config(normalized_thread_id),
            stream_mode="updates",
            version="v2",
        )

    def stream(
        self,
        request: ActionContextSnapshot | dict[str, Any],
        thread_id: str,
    ) -> Iterator[dict[str, Any]]:
        snapshot = ActionContextSnapshot.model_validate(request)
        normalized_thread_id = self._normalize_thread_id(thread_id)
        existing = self.graph.get_state(self._config(normalized_thread_id))
        if existing.values:
            raise ValueError("thread_id 已存在；请恢复现有线程或使用新的 thread_id。")
        run_id = str(uuid4())
        self.trace.record(run_id, "run_started", details={
            "thread_id": normalized_thread_id,
            "snapshot_id": snapshot.snapshot_id,
            "planner": self.planner.name,
            "model": self.planner.model,
            "schema_version": AGENT_SCHEMA_VERSION,
            "graph_version": AGENT_GRAPH_VERSION,
            "prompt_versions": self.prompts.versions(),
            "tool_versions": self.tools.versions(),
        })
        yield from self.graph.stream(
            self._initial_state(snapshot, normalized_thread_id, run_id),
            config=self._config(normalized_thread_id),
            stream_mode="updates",
            version="v2",
        )

    def register_tool(self, tool: RegisteredTool) -> None:
        self.tools.register(tool)

    def get_trace(self, run_id: str):
        return self.trace.get(run_id)

    def evaluate(self, dataset: Any):
        from ..evals.agent.runner import evaluate_dataset

        return evaluate_dataset(dataset, harness=self)
