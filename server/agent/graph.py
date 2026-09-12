from __future__ import annotations

from typing import Literal

from langgraph.graph import END, START, StateGraph

from .contracts import AgentState
from .nodes import AgentNodes


def _route_after_planner(state: AgentState) -> Literal["tool_router", "validator", "__end__"]:
    if state.get("status") == "failed":
        return END
    if state.get("tool_requests"):
        return "tool_router"
    return "validator"


def build_agent_graph(nodes: AgentNodes, *, checkpointer=None):
    builder = StateGraph(AgentState)
    builder.add_node("load_user_context", nodes.load_user_context)
    builder.add_node("planner", nodes.planner_node)
    builder.add_node("tool_router", nodes.tool_router)
    builder.add_node("validator", nodes.validator)
    builder.add_edge(START, "load_user_context")
    builder.add_edge("load_user_context", "planner")
    builder.add_conditional_edges("planner", _route_after_planner)
    builder.add_edge("tool_router", "planner")
    builder.add_edge("validator", END)
    return builder.compile(checkpointer=checkpointer)
