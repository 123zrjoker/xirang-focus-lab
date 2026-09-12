from __future__ import annotations

from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import server.main as main_module
from server.agent.contracts import (
    ActionContextSnapshot,
    PlanDraft,
    PlanItem,
    PlannerDecision,
    ToolRequest,
)
from server.agent.harness import AgentHarness
from server.agent.planner import ScriptedPlanner
from server.agent.tracing import TraceRecorder
from server.generation import StructuredGeneration


def snapshot_payload() -> dict:
    return {
        "schemaVersion": 1,
        "snapshotId": "snapshot-test-001",
        "createdAt": "2026-09-12T10:00:00+08:00",
        "timezone": "Asia/Shanghai",
        "baseStateRevision": "revision-test-0001",
        "userRequest": "请根据当前待办安排本周行动计划",
        "goalAndPreferences": {
            "goal": "work",
            "dailyTargetMinutes": 30,
            "preferredFocusMinutes": 25,
        },
        "activeActionSlips": [{
            "id": "todo-1",
            "title": "完成 Agent 契约",
            "status": "current",
            "updatedAt": "2026-09-12T09:00:00+08:00",
            "nextStep": "先完成 ActionContextSnapshot 测试",
        }, {
            "id": "todo-2",
            "title": "补充只读工具测试",
            "status": "inbox",
            "updatedAt": "2026-09-11T09:00:00+08:00",
        }],
        "recentDailyPlans": [],
        "focusSummary": {
            "windowDays": 7,
            "windowStartedAt": "2026-09-05T00:00:00+08:00",
            "sessionCount": 2,
            "totalMinutes": 50,
            "averageCompletionRate": 85,
            "averageSubjectiveFocus": 4,
            "distractionCounts": {"phone": 1},
        },
        "selectedKnowledgeSourceIds": [],
        "consentScope": ["todos", "focus_summary"],
        "sampleBoundaries": {
            "actionSlipLimit": 2,
            "actionSlipTotal": 2,
            "dailyPlanLimit": 0,
            "dailyPlanTotal": 0,
            "focusWindowDays": 7,
            "knowledgeSourceTotal": 0,
            "knowledgeSourceSelected": 0,
        },
    }


def test_context_contract_requires_explicit_consent_for_included_data() -> None:
    payload = snapshot_payload()
    payload["consentScope"] = []

    with pytest.raises(ValidationError, match="todos"):
        ActionContextSnapshot.model_validate(payload)


def test_read_only_graph_routes_tools_and_returns_valid_plan() -> None:
    harness = AgentHarness()

    result = harness.run(snapshot_payload(), "thread-read-only")

    assert result.status == "completed"
    assert result.plan_draft is not None
    assert [item.source_action_slip_ids for item in result.plan_draft.items] == [["todo-1"], ["todo-2"]]
    assert {item.name for item in result.tool_results} == {"query_todos", "query_focus_summary"}
    assert all(item.status == "success" for item in result.tool_results)
    assert all(definition.risk_level == "read" for definition in harness.tools.definitions())
    assert result.model_dump().get("mutation_intents") is None
    permission_events = [event for event in result.trace if event.kind == "permission_decision"]
    assert len(permission_events) == 2
    assert all(event.details["allowed"] is True for event in permission_events)


def test_validator_rejects_plan_with_unknown_evidence() -> None:
    planner = ScriptedPlanner([PlannerDecision(plan_draft=PlanDraft(
        title="无效计划",
        summary="引用了不存在的证据。",
        items=[PlanItem(
            title="完成任务",
            firstStep="开始第一步",
            completionCriteria="留下结果",
            estimatedMinutes=25,
            rationale="测试",
            sourceActionSlipIds=["todo-1"],
            evidenceRefs=["S1"],
        )],
        evidenceRefs=["S1"],
    ))])

    result = AgentHarness(planner=planner).run(snapshot_payload(), "thread-invalid-citation")

    assert result.status == "failed"
    assert any("不存在的证据" in item for item in result.validation_errors)
    assert any(event.kind == "validation_failed" for event in result.trace)


def test_unapproved_knowledge_tool_is_denied_without_stopping_safe_plan() -> None:
    planner = ScriptedPlanner([
        PlannerDecision(tool_requests=[ToolRequest(
            call_id="unapproved-knowledge",
            name="retrieve_personal_knowledge",
            arguments={"query": "私人资料", "sourceIds": ["not-authorized"]},
            purpose="尝试读取未授权来源。",
        )]),
        PlannerDecision(plan_draft=PlanDraft(
            title="无知识来源计划",
            summary="未读取未授权资料。",
            items=[PlanItem(
                title="继续当前目标",
                firstStep="先写下一个可立即执行的动作。",
                completionCriteria="留下一个可检查的阶段结果。",
                estimatedMinutes=25,
                rationale="仅依据用户请求生成保守草案。",
            )],
        )),
    ])

    payload = snapshot_payload()
    payload["selectedKnowledgeSourceIds"] = ["authorized-source"]
    payload["consentScope"].append("knowledge_sources")
    payload["sampleBoundaries"]["knowledgeSourceTotal"] = 1
    payload["sampleBoundaries"]["knowledgeSourceSelected"] = 1
    result = AgentHarness(planner=planner).run(payload, "thread-denied-knowledge")

    assert result.status == "completed"
    assert len(result.tool_results) == 1
    assert result.tool_results[0].status == "denied"
    assert "未授权" in (result.tool_results[0].error or "")
    assert result.evidence == []


def test_stream_exposes_read_only_node_progress_in_order() -> None:
    updates = list(AgentHarness().stream(snapshot_payload(), "thread-stream-progress"))
    node_names = [next(iter(update)) for update in updates]

    assert node_names == ["load_user_context", "planner", "tool_router", "planner", "validator"]
    assert updates[-1]["validator"]["status"] == "completed"
    assert all("mutation_intents" not in update.get(node, {}) for update, node in zip(updates, node_names))


def test_same_read_tool_is_not_executed_twice_in_one_run() -> None:
    def todo_request(call_id: str) -> PlannerDecision:
        return PlannerDecision(tool_requests=[ToolRequest(
            call_id=call_id,
            name="query_todos",
            arguments={"statuses": ["current"], "limit": 20},
            purpose="读取当前待办。",
        )])

    planner = ScriptedPlanner([
        todo_request("todos-first"),
        todo_request("todos-duplicate"),
        PlannerDecision(plan_draft=PlanDraft(
            title="去重后的计划",
            summary="同一工具只执行一次。",
            items=[PlanItem(
                title="完成 Agent 契约",
                firstStep="补齐接口测试。",
                completionCriteria="测试通过。",
                estimatedMinutes=25,
                rationale="来自当前待办。",
                sourceActionSlipIds=["todo-1"],
            )],
        )),
    ])

    result = AgentHarness(planner=planner).run(snapshot_payload(), "thread-no-duplicate-tools")

    assert result.status == "completed"
    assert [item.status for item in result.tool_results] == ["success", "denied"]
    assert "不重复执行" in (result.tool_results[1].error or "")


def test_knowledge_scopemission_cannot_be_inferred_from_selected_ids() -> None:
    payload = deepcopy(snapshot_payload())
    payload["selectedKnowledgeSourceIds"] = ["source-1"]
    payload["sampleBoundaries"]["knowledgeSourceTotal"] = 1
    payload["sampleBoundaries"]["knowledgeSourceSelected"] = 1

    with pytest.raises(ValidationError, match="knowledge_sources"):
        ActionContextSnapshot.model_validate(payload)


def test_trace_recorder_redacts_credentials() -> None:
    trace = TraceRecorder()

    event = trace.record("run-test-0001", "run_started", details={
        "api_key": "must-not-appear",
        "nested": {"authorization": "Bearer must-not-appear"},
        "input_tokens": 42,
        "safe": "visible",
    })

    assert event.details["api_key"] == "[REDACTED]"
    assert event.details["nested"]["authorization"] == "[REDACTED]"
    assert event.details["input_tokens"] == 42
    assert event.details["safe"] == "visible"


def test_agent_api_uses_provider_only_after_context_manifest_and_tools(monkeypatch) -> None:
    class FakeStructuredProvider:
        name = "fake-structured-provider"
        model = "fake-agent-model"
        available = True

        def __init__(self) -> None:
            self.messages: list[list[dict]] = []

        def status(self):
            return {"provider": self.name, "model": self.model, "available": True, "configured": True}

        def generate_structured(self, messages, **_kwargs):
            self.messages.append(messages)
            if len(self.messages) == 1:
                payload = {
                    "toolRequests": [{
                        "callId": "api-read-todos",
                        "name": "query_todos",
                        "arguments": {"statuses": ["current", "inbox"], "limit": 20},
                        "purpose": "读取本次授权的未完成待办。",
                    }],
                    "planDraft": None,
                }
            else:
                payload = {
                    "toolRequests": [],
                    "planDraft": {
                        "title": "本周行动计划",
                        "summary": "先完成 Agent 契约。",
                        "items": [{
                            "title": "完成 Agent 契约",
                            "firstStep": "先完成 ActionContextSnapshot 测试",
                            "completionCriteria": "契约和测试全部通过",
                            "estimatedMinutes": 25,
                            "rationale": "来自本次授权的当前待办。",
                            "sourceActionSlipIds": ["todo-1"],
                            "evidenceRefs": [],
                        }],
                        "assumptions": [],
                        "evidenceRefs": [],
                    },
                }
            return StructuredGeneration(
                payload=payload,
                provider=self.name,
                model=self.model,
                duration_ms=10,
                input_tokens=100,
                output_tokens=50,
            )

    provider = FakeStructuredProvider()
    monkeypatch.setattr(main_module, "generation_provider", provider)
    client = TestClient(main_module.app)

    status = client.get("/api/agent/status")
    response = client.post("/api/agent/plan", json={
        "threadId": "api-agent-thread",
        "context": snapshot_payload(),
    })

    assert status.status_code == 200
    assert status.json()["mode"] == "read_only"
    assert set(status.json()["tools"]) == {
        "query_todos", "query_focus_summary", "retrieve_personal_knowledge",
    }
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["planDraft"]["items"][0]["sourceActionSlipIds"] == ["todo-1"]
    assert len(provider.messages) == 2
    assert "完成 Agent 契约" not in provider.messages[0][1]["content"]
    assert "完成 Agent 契约" in provider.messages[1][1]["content"]
    assert '"additionalProperties": false' in provider.messages[0][1]["content"]
    assert '"allowed_top_level_keys": ["toolRequests", "planDraft"]' in provider.messages[0][1]["content"]
    planner_events = [
        event for event in response.json()["trace"]
        if event["kind"] == "node_completed" and event.get("node") == "planner"
    ]
    assert planner_events[-1]["details"]["input_tokens"] == 100
