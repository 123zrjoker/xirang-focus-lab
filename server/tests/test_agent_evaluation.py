from __future__ import annotations

import json
import sys
from copy import deepcopy

import pytest

from server.agent.contracts import AGENT_GRAPH_VERSION
from server.agent.harness import AgentHarness
from server.agent.planner import DeepSeekActionPlanner
from server.agent.prompts import build_prompt_registry
from server.agent.tracing import TraceRecorder
from server.generation import StructuredGeneration
from server.evals.agent.dataset import DEFAULT_FAKE_DATASET, DEFAULT_REAL_DATASET, load_dataset
from server.evals.agent.metrics import estimate_cost
from server.evals.agent.run import main


def test_fake_agent_evaluation_meets_frozen_gate() -> None:
    dataset = load_dataset(DEFAULT_FAKE_DATASET)

    report = AgentHarness().evaluate(dataset)

    assert len(dataset.cases) == 15
    assert report.gate["passed"] is True
    assert report.metrics["casePassRate"] == 1
    assert report.metrics["checkpointResumeRate"] == 1
    assert report.metrics["stateConflictDetectionRate"] == 1
    assert report.metrics["injectionResistanceRate"] == 1
    assert report.metrics["retryRecoveryRate"] == 1
    assert report.metrics["preApprovalMutationCount"] == 0
    assert report.metrics["approvalBypassCount"] == 0
    assert report.metrics["duplicateSideEffectCount"] == 0
    assert report.metrics["sensitiveLeakCount"] == 0
    assert report.metadata["datasetVersion"] == "0.5.2-fake-v1"
    assert report.metadata["graphVersion"] == AGENT_GRAPH_VERSION
    assert report.metadata["promptVersions"]
    assert report.metadata["toolVersions"]


def test_agent_evaluation_gate_detects_trajectory_regression() -> None:
    raw = json.loads(DEFAULT_FAKE_DATASET.read_text(encoding="utf-8"))
    raw["cases"] = [deepcopy(raw["cases"][0])]
    raw["cases"][0]["expected"]["trajectory"] = ["planner"]
    raw["thresholds"] = {"trajectoryAccuracy": {"minimum": 1}}

    report = AgentHarness().evaluate(raw)

    assert report.gate["passed"] is False
    assert report.gate["failedMetrics"] == ["trajectoryAccuracy"]
    assert report.results[0].failures == ["trajectory", "all"]


def test_trace_redacts_inline_bearer_and_assignment_secrets() -> None:
    recorder = TraceRecorder()

    event = recorder.record("eval-redaction-run", "run_started", details={
        "purpose": "Authorization: Bearer sk-secret-value-123456",
        "message": "api_key=another-secret-value",
        "input_tokens": 42,
    })
    serialized = json.dumps(event.model_dump(mode="json"), ensure_ascii=False)

    assert "sk-secret-value" not in serialized
    assert "another-secret-value" not in serialized
    assert serialized.count("[REDACTED]") == 2
    assert event.details["input_tokens"] == 42


def test_real_holdout_is_versioned_and_cli_requires_paid_opt_in(monkeypatch) -> None:
    dataset = load_dataset(DEFAULT_REAL_DATASET)
    assert dataset.kind == "real"
    assert len(dataset.cases) == 5
    assert all(case.split == "holdout" and case.scenario == "model" for case in dataset.cases)
    assert dataset.pricing is not None

    monkeypatch.setattr(sys, "argv", ["agent-eval", "--real"])
    with pytest.raises(SystemExit, match="allow-paid-api"):
        main()


def test_cost_uses_cache_breakdown_when_available() -> None:
    pricing = load_dataset(DEFAULT_REAL_DATASET).pricing
    assert pricing is not None

    input_tokens, output_tokens, cost = estimate_cost([{
        "input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
        "cache_hit_input_tokens": 250_000,
        "cache_miss_input_tokens": 750_000,
    }], pricing)

    assert input_tokens == 1_000_000
    assert output_tokens == 1_000_000
    assert cost == pytest.approx(1.6535)


def test_model_planner_repairs_an_unavailable_tool_once() -> None:
    class RepairProvider:
        name = "repair-provider"
        model = "repair-model-v1"
        available = True

        def __init__(self) -> None:
            self.calls = 0

        def generate_structured(self, *_args, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                payload = {
                    "toolRequests": [{
                        "callId": "invented-tool",
                        "name": "query_todos",
                        "arguments": {"statuses": ["current"], "limit": 20},
                        "purpose": "尝试调用不在本次白名单内的工具。",
                    }],
                    "planDraft": None,
                }
            else:
                payload = {
                    "toolRequests": [],
                    "planDraft": {
                        "title": "修复后的计划",
                        "summary": "不再调用白名单外工具。",
                        "items": [{
                            "title": "整理工作台",
                            "firstStep": "先清理桌面上的一件物品。",
                            "completionCriteria": "桌面留下一个可用区域。",
                            "estimatedMinutes": 25,
                            "rationale": "仅依据用户请求形成保守动作。",
                        }],
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

    dataset = load_dataset(DEFAULT_REAL_DATASET)
    snapshot = dataset.cases[0].snapshot
    prompts = build_prompt_registry()
    provider = RepairProvider()
    planner = DeepSeekActionPlanner(provider, prompts.get("weekly_planner").content)

    result = AgentHarness(planner=planner, prompts=prompts).run(snapshot, "repair-planner-test")

    assert result.status == "awaiting_approval"
    assert result.tool_results == []
    assert provider.calls == 2
    planner_event = next(
        event for event in result.trace
        if event.kind == "node_completed" and event.node == "planner"
    )
    assert planner_event.details["generation_attempts"] == 2
    assert planner_event.details["input_tokens"] == 200
