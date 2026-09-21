from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from server.agent.checkpoints import build_sqlite_checkpointer
from server.agent.contracts import PlanDraft, PlanItem, PlannerDecision
from server.agent.harness import AgentHarness
from server.agent.planner import ScriptedPlanner
from server.agent.tracing import TraceRecorder


def snapshot_payload() -> dict:
    return {
        "schemaVersion": 1,
        "snapshotId": "upgrade-smoke-snapshot",
        "createdAt": "2026-09-21T09:00:00+08:00",
        "timezone": "Asia/Shanghai",
        "baseStateRevision": "upgrade-smoke-revision",
        "userRequest": "验证桌面端覆盖升级后的 Agent 检查点恢复。",
        "goalAndPreferences": {
            "goal": "work",
            "dailyTargetMinutes": 30,
            "preferredFocusMinutes": 25,
        },
        "activeActionSlips": [{
            "id": "upgrade-smoke-todo",
            "title": "完成覆盖升级验收",
            "status": "current",
            "updatedAt": "2026-09-21T08:30:00+08:00",
            "nextStep": "读取升级前写入的 SQLite 检查点。",
        }],
        "recentDailyPlans": [],
        "focusSummary": {
            "windowDays": 7,
            "windowStartedAt": "2026-09-14T00:00:00+08:00",
            "sessionCount": 1,
            "totalMinutes": 25,
            "averageCompletionRate": 100,
            "averageSubjectiveFocus": 4,
            "distractionCounts": {},
        },
        "selectedKnowledgeSourceIds": [],
        "consentScope": ["todos", "focus_summary"],
        "sampleBoundaries": {
            "actionSlipLimit": 1,
            "actionSlipTotal": 1,
            "dailyPlanLimit": 0,
            "dailyPlanTotal": 0,
            "focusWindowDays": 7,
            "knowledgeSourceTotal": 0,
            "knowledgeSourceSelected": 0,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed a deterministic Agent checkpoint for upgrade smoke tests.")
    parser.add_argument("--path", required=True, type=Path)
    parser.add_argument("--thread-id", required=True)
    args = parser.parse_args()

    checkpoint_path = args.path.expanduser().resolve()
    saver = build_sqlite_checkpointer(checkpoint_path)
    trace = TraceRecorder(checkpoint_path)
    try:
        planner = ScriptedPlanner([PlannerDecision(plan_draft=PlanDraft(
            title="覆盖升级验收计划",
            summary="该计划只用于验证跨版本 SQLite 检查点恢复。",
            items=[PlanItem(
                title="恢复升级前线程",
                firstStep="启动候选版本并读取同一线程。",
                completionCriteria="线程 ID、运行 ID、状态和图版本保持一致。",
                estimatedMinutes=10,
                rationale="验证升级不会破坏 Agent 持久状态。",
                sourceActionSlipIds=["upgrade-smoke-todo"],
            )],
        ))])
        result = AgentHarness(planner=planner, checkpointer=saver, trace=trace).run(
            snapshot_payload(),
            args.thread_id,
        )
        print(json.dumps({
            "threadId": args.thread_id,
            "runId": result.run_id,
            "status": result.status,
            "graphVersion": result.graph_version,
            "checkpointPath": str(checkpoint_path),
        }, ensure_ascii=False))
    finally:
        saver.conn.close()
        trace.close()


if __name__ == "__main__":
    main()
