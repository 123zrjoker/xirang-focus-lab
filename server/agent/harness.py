from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from uuid import uuid4

from .checkpoints import build_in_memory_checkpointer
from .contracts import (
    AGENT_GRAPH_VERSION,
    AGENT_SCHEMA_VERSION,
    ActionContextSnapshot,
    AgentRunResult,
    EvidenceItem,
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
    """Cross-cutting runtime around the read-only LangGraph workflow."""

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
            "status": "created",
            "step_count": 0,
        }

    def run(self, request: ActionContextSnapshot | dict[str, Any], thread_id: str) -> AgentRunResult:
        snapshot = ActionContextSnapshot.model_validate(request)
        normalized_thread_id = thread_id.strip()
        if not normalized_thread_id or len(normalized_thread_id) > 100:
            raise ValueError("thread_id 必须是 1～100 个字符。")
        run_id = str(uuid4())
        self.trace.record(run_id, "run_started", details={
            "thread_id": normalized_thread_id,
            "snapshot_id": snapshot.snapshot_id,
            "planner": self.planner.name,
            "model": self.planner.model,
            "prompt_versions": self.prompts.versions(),
        })
        final_state = self.graph.invoke(
            self._initial_state(snapshot, normalized_thread_id, run_id),
            config={"configurable": {"thread_id": normalized_thread_id}},
        )
        return AgentRunResult(
            schema_version=AGENT_SCHEMA_VERSION,
            graph_version=AGENT_GRAPH_VERSION,
            thread_id=normalized_thread_id,
            run_id=run_id,
            status=final_state["status"],
            plan_draft=final_state.get("plan_draft"),
            evidence=[EvidenceItem.model_validate(item) for item in final_state.get("evidence", [])],
            tool_results=[ToolResult.model_validate(item) for item in final_state.get("tool_results", [])],
            validation_errors=final_state.get("validation_errors", []),
            trace=self.trace.get(run_id),
        )

    def stream(
        self,
        request: ActionContextSnapshot | dict[str, Any],
        thread_id: str,
    ) -> Iterator[dict[str, Any]]:
        snapshot = ActionContextSnapshot.model_validate(request)
        run_id = str(uuid4())
        self.trace.record(run_id, "run_started", details={
            "thread_id": thread_id,
            "snapshot_id": snapshot.snapshot_id,
            "planner": self.planner.name,
            "model": self.planner.model,
            "prompt_versions": self.prompts.versions(),
        })
        yield from self.graph.stream(
            self._initial_state(snapshot, thread_id, run_id),
            config={"configurable": {"thread_id": thread_id}},
            stream_mode="updates",
        )

    def register_tool(self, tool: RegisteredTool) -> None:
        self.tools.register(tool)

    def get_trace(self, run_id: str):
        return self.trace.get(run_id)

    def resume(self, thread_id: str, decision: dict[str, Any]):
        del thread_id, decision
        raise RuntimeError("Interrupt/Resume 将在 0.5.1 启用。")

    def evaluate(self, dataset: Any):
        del dataset
        raise RuntimeError("Agent Evaluation Harness 将在 0.5.2 启用。")
