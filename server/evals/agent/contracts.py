from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import Field, model_validator

from ...agent.contracts import ActionContextSnapshot, ApprovalDecision, ContractModel


EvaluationScenario = Literal[
    "model",
    "deterministic",
    "unauthorized_tool",
    "invalid_tool_parameters",
    "planner_error",
    "tool_timeout",
    "tool_retry",
    "injected_knowledge",
    "secret_in_tool_purpose",
    "checkpoint_restart",
    "legacy_checkpoint",
    "future_checkpoint",
    "revision_conflict",
    "duplicate_resume_ack",
]


class MetricThreshold(ContractModel):
    minimum: Optional[float] = None
    maximum: Optional[float] = None

    @model_validator(mode="after")
    def has_one_bound(self) -> "MetricThreshold":
        if self.minimum is None and self.maximum is None:
            raise ValueError("指标门槛必须至少声明 minimum 或 maximum。")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("指标门槛 minimum 不能大于 maximum。")
        return self


class PricingAssumptions(ContractModel):
    currency: Literal["USD"] = "USD"
    input_cache_hit_per_million: float = Field(ge=0)
    input_cache_miss_per_million: float = Field(ge=0)
    output_per_million: float = Field(ge=0)
    source_url: str = Field(min_length=1, max_length=500)
    captured_at: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    policy: str = Field(min_length=1, max_length=500)


class AgentCaseExpectation(ContractModel):
    final_status: str = Field(min_length=1, max_length=50)
    tool_names: list[str] = Field(default_factory=list, max_length=10)
    tool_statuses: list[str] = Field(default_factory=list, max_length=10)
    argument_keys: dict[str, list[str]] = Field(default_factory=dict)
    trajectory: list[str] = Field(default_factory=list, max_length=30)
    mutation_tools: list[str] = Field(default_factory=list, max_length=2)
    citation_ids: list[str] = Field(default_factory=list, max_length=8)
    failure_class: str = Field(default="none", min_length=1, max_length=100)
    requires_checkpoint_resume: bool = False
    requires_conflict_detection: bool = False
    requires_injection_resistance: bool = False


class AgentEvaluationCase(ContractModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,79}$")
    split: Literal["dev", "holdout"]
    category: str = Field(min_length=1, max_length=100)
    scenario: EvaluationScenario
    snapshot: ActionContextSnapshot
    decision: Optional[ApprovalDecision] = None
    ack_mode: Literal["none", "applied", "already_applied", "revision_conflict"] = "none"
    expected: AgentCaseExpectation


class AgentEvaluationDataset(ContractModel):
    name: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=100)
    kind: Literal["fake", "real"]
    description: str = Field(min_length=1, max_length=1_000)
    dataset_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    cases: list[AgentEvaluationCase] = Field(min_length=1, max_length=100)
    thresholds: dict[str, MetricThreshold] = Field(min_length=1)
    pricing: Optional[PricingAssumptions] = None

    @model_validator(mode="after")
    def case_ids_are_unique(self) -> "AgentEvaluationDataset":
        case_ids = [case.id for case in self.cases]
        if len(case_ids) != len(set(case_ids)):
            raise ValueError("Agent 评测 case id 不能重复。")
        if self.kind == "real" and any(case.scenario != "model" for case in self.cases):
            raise ValueError("真实模型数据集只能使用 model scenario。")
        return self


class AgentCaseResult(ContractModel):
    id: str
    split: str
    category: str
    scenario: str
    passed: bool
    final_status: str
    failure_class: str
    tool_names: list[str]
    tool_statuses: list[str]
    mutation_tools: list[str]
    citation_ids: list[str]
    trajectory: list[str]
    latency_ms: float = Field(ge=0)
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    estimated_cost: float = Field(ge=0)
    checks: dict[str, bool]
    failures: list[str]
    observed_errors: list[str]
    safety: dict[str, int | bool]


class AgentEvaluationReport(ContractModel):
    metadata: dict[str, Any]
    metrics: dict[str, Any]
    gate: dict[str, Any]
    results: list[AgentCaseResult]
