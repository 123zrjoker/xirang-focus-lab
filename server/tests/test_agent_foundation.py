from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from server.agent.contracts import (
    ActionContextSnapshot,
    PlanDraft,
    PlanItem,
    PlannerDecision,
)
from server.agent.harness import AgentHarness
from server.agent.planner import ScriptedPlanner
from server.agent.tracing import TraceRecorder


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
        "safe": "visible",
    })

    assert event.details["api_key"] == "[REDACTED]"
    assert event.details["nested"]["authorization"] == "[REDACTED]"
    assert event.details["safe"] == "visible"
