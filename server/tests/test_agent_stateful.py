from __future__ import annotations

from copy import deepcopy

import pytest

from server.agent.checkpoints import (
    IncompatibleCheckpointError,
    build_sqlite_checkpointer,
    normalize_checkpoint_state,
)
from server.agent.contracts import PlanDraft, PlanItem, PlannerDecision
from server.agent.harness import AgentHarness
from server.agent.planner import ScriptedPlanner
from server.agent.tracing import TraceRecorder
from server.tests.test_agent_foundation import snapshot_payload


def plan_decision() -> PlannerDecision:
    return PlannerDecision(plan_draft=PlanDraft(
        title="可批准计划",
        summary="用于验证持久中断、恢复与幂等确认。",
        items=[PlanItem(
            title="完成持久恢复",
            firstStep="重新打开 SQLite Checkpointer。",
            completionCriteria="服务重建后仍能拒绝或批准。",
            estimatedMinutes=25,
            rationale="验证 0.5.1 的关键恢复路径。",
            sourceActionSlipIds=["todo-1"],
        )],
    ))


def test_sqlite_checkpoint_recovers_approval_after_runtime_restart(tmp_path) -> None:
    path = tmp_path / "agent" / "checkpoints.sqlite3"
    saver = build_sqlite_checkpointer(path)
    trace = TraceRecorder(path)
    first = AgentHarness(
        planner=ScriptedPlanner([plan_decision()]),
        checkpointer=saver,
        trace=trace,
    )

    paused = first.run(snapshot_payload(), "restartable-thread")
    assert paused.status == "awaiting_approval"
    run_id = paused.run_id
    first.graph.update_state(
        {"configurable": {"thread_id": "restartable-thread"}},
        {"graph_version": "0.5.1-stateful-v1"},
    )
    saver.conn.close()
    trace.close()

    restored_saver = build_sqlite_checkpointer(path)
    restored_trace = TraceRecorder(path)
    restored = AgentHarness(
        planner=ScriptedPlanner([]),
        checkpointer=restored_saver,
        trace=restored_trace,
    )

    before_resume = restored.get_state("restartable-thread")
    rejected = restored.resume("restartable-thread", {"decision": "reject", "operations": []})

    assert before_resume.run_id == run_id
    assert before_resume.graph_version == "0.5.1-stateful-v1"
    assert before_resume.status == "awaiting_approval"
    assert rejected.status == "rejected"
    assert rejected.mutation_intents == []
    assert rejected.trace[0].kind == "run_started"
    assert rejected.trace[-1].kind == "run_completed"
    restored_saver.conn.close()
    restored_trace.close()


@pytest.mark.parametrize(
    ("schema_version", "graph_version"),
    [
        (2, "0.5.2-evaluation-v1"),
        (1, "0.6.0-future-v1"),
    ],
)
def test_checkpoint_compatibility_matrix_rejects_unknown_versions(
    schema_version: int,
    graph_version: str,
) -> None:
    with pytest.raises(IncompatibleCheckpointError):
        normalize_checkpoint_state({
            "schema_version": schema_version,
            "graph_version": graph_version,
        })


def test_approve_modify_and_ack_are_idempotent() -> None:
    harness = AgentHarness(planner=ScriptedPlanner([plan_decision()]))
    paused = harness.run(snapshot_payload(), "approval-thread")
    modified = deepcopy(paused.plan_draft.model_dump(mode="json", by_alias=True))
    modified["items"][0]["title"] = "批准后的修改标题"

    proposed = harness.resume("approval-thread", {
        "decision": "modify",
        "operations": ["save_plan", "start_focus"],
        "modifiedPlan": modified,
    })
    duplicate_resume = harness.resume("approval-thread", {
        "decision": "approve",
        "operations": ["save_plan"],
    })

    assert proposed.status == "awaiting_execution"
    assert proposed.plan_draft.items[0].title == "批准后的修改标题"
    assert [item.tool_name for item in proposed.mutation_intents] == ["save_plan", "start_focus"]
    assert duplicate_resume.mutation_intents == proposed.mutation_intents

    ack = {
        "observedStateRevision": proposed.mutation_intents[0].base_state_revision,
        "items": [
            {"actionId": item.action_id, "status": "applied"}
            for item in proposed.mutation_intents
        ],
    }
    completed = harness.acknowledge("approval-thread", ack)
    duplicate_ack = harness.acknowledge("approval-thread", ack)

    assert completed.status == "completed"
    assert duplicate_ack.execution_ack == completed.execution_ack
    assert len([event for event in completed.trace if event.kind == "mutation_proposed"]) == 2


def test_revision_conflict_fails_closed() -> None:
    harness = AgentHarness(planner=ScriptedPlanner([plan_decision()]))
    harness.run(snapshot_payload(), "conflict-thread")
    proposed = harness.resume("conflict-thread", {
        "decision": "approve",
        "operations": ["save_plan"],
    })
    failed = harness.acknowledge("conflict-thread", {
        "observedStateRevision": "changed-state-revision",
        "items": [{
            "actionId": proposed.mutation_intents[0].action_id,
            "status": "failed",
            "error": "本地状态已变化。",
        }],
    })

    assert failed.status == "execution_failed"
    assert any("执行失败" in error for error in failed.validation_errors)
    assert not any(event.kind == "run_completed" for event in failed.trace)


def test_modified_plan_cannot_escape_original_snapshot_boundary() -> None:
    harness = AgentHarness(planner=ScriptedPlanner([plan_decision()]))
    paused = harness.run(snapshot_payload(), "modified-boundary-thread")
    modified = deepcopy(paused.plan_draft.model_dump(mode="json", by_alias=True))
    modified["items"][0]["sourceActionSlipIds"] = ["not-in-original-snapshot"]

    with pytest.raises(ValueError, match="快照外待办"):
        harness.resume("modified-boundary-thread", {
            "decision": "modify",
            "operations": ["save_plan"],
            "modifiedPlan": modified,
        })

    assert harness.get_state("modified-boundary-thread").status == "awaiting_approval"


def test_all_already_applied_ack_completes_after_local_revision_advanced() -> None:
    harness = AgentHarness(planner=ScriptedPlanner([plan_decision()]))
    harness.run(snapshot_payload(), "already-applied-thread")
    proposed = harness.resume("already-applied-thread", {
        "decision": "approve",
        "operations": ["save_plan", "start_focus"],
    })

    completed = harness.acknowledge("already-applied-thread", {
        "observedStateRevision": "revision-after-durable-local-commit",
        "items": [
            {"actionId": item.action_id, "status": "already_applied"}
            for item in proposed.mutation_intents
        ],
    })

    assert completed.status == "completed"
    assert completed.validation_errors == []
