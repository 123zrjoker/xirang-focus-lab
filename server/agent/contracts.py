from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional, TypedDict

from pydantic import BaseModel, ConfigDict, Field, model_validator


AGENT_SCHEMA_VERSION = 1
AGENT_GRAPH_VERSION = "0.5.1-stateful-v1"

ConsentScope = Literal["todos", "daily_plans", "focus_summary", "knowledge_sources"]
RiskLevel = Literal["read", "propose_write", "commit"]
AgentStatus = Literal[
    "created",
    "planning",
    "using_tools",
    "validating",
    "awaiting_approval",
    "approved",
    "rejected",
    "awaiting_execution",
    "completed",
    "execution_failed",
    "cancelled",
    "failed",
]
TraceKind = Literal[
    "run_started",
    "node_started",
    "node_completed",
    "tool_requested",
    "permission_decision",
    "tool_completed",
    "validation_failed",
    "approval_requested",
    "approval_resumed",
    "mutation_proposed",
    "execution_acknowledged",
    "run_completed",
    "run_failed",
]


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class GoalPreferences(ContractModel):
    goal: Literal["study", "work", "phone"]
    daily_target_minutes: int = Field(ge=1, le=600)
    preferred_focus_minutes: int = Field(ge=5, le=180)


class ActionSlipSnapshot(ContractModel):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=240)
    status: Literal["inbox", "current"]
    updated_at: datetime
    next_step: Optional[str] = Field(default=None, max_length=300)


class DailyPlanSnapshot(ContractModel):
    date_key: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    mode: Literal["standard", "low-energy", "quick"]
    focus_minutes: int = Field(ge=5, le=180)
    summary: str = Field(min_length=1, max_length=500)


class FocusSummarySnapshot(ContractModel):
    window_days: int = Field(ge=1, le=90)
    window_started_at: datetime
    session_count: int = Field(ge=0, le=10_000)
    total_minutes: int = Field(ge=0, le=100_000)
    average_completion_rate: float = Field(ge=0, le=100)
    average_subjective_focus: float = Field(ge=0, le=5)
    distraction_counts: dict[Literal["phone", "environment", "difficulty", "fatigue", "other"], int] = Field(
        default_factory=dict,
    )

    @model_validator(mode="after")
    def empty_summary_has_zero_averages(self) -> "FocusSummarySnapshot":
        if self.session_count == 0 and (self.total_minutes or self.average_completion_rate or self.average_subjective_focus):
            raise ValueError("没有专注会话时，聚合时长和平均值必须为 0。")
        return self


class SampleBoundaries(ContractModel):
    action_slip_limit: int = Field(ge=0, le=100)
    action_slip_total: int = Field(ge=0, le=100_000)
    daily_plan_limit: int = Field(ge=0, le=31)
    daily_plan_total: int = Field(ge=0, le=100_000)
    focus_window_days: int = Field(ge=1, le=90)
    knowledge_source_total: int = Field(ge=0, le=100)
    knowledge_source_selected: int = Field(ge=0, le=100)

    @model_validator(mode="after")
    def selected_counts_fit_totals(self) -> "SampleBoundaries":
        if self.action_slip_limit > self.action_slip_total:
            raise ValueError("待办样本数量不能大于待办总数。")
        if self.daily_plan_limit > self.daily_plan_total:
            raise ValueError("计划样本数量不能大于计划总数。")
        if self.knowledge_source_selected > self.knowledge_source_total:
            raise ValueError("已选知识来源数量不能大于来源总数。")
        return self


class ActionContextSnapshot(ContractModel):
    schema_version: Literal[1] = AGENT_SCHEMA_VERSION
    snapshot_id: str = Field(min_length=8, max_length=100)
    created_at: datetime
    timezone: str = Field(min_length=1, max_length=100)
    base_state_revision: str = Field(min_length=16, max_length=128)
    user_request: str = Field(min_length=1, max_length=1_000)
    goal_and_preferences: GoalPreferences
    active_action_slips: list[ActionSlipSnapshot] = Field(default_factory=list, max_length=100)
    recent_daily_plans: list[DailyPlanSnapshot] = Field(default_factory=list, max_length=31)
    focus_summary: Optional[FocusSummarySnapshot] = None
    selected_knowledge_source_ids: list[str] = Field(default_factory=list, max_length=100)
    consent_scope: list[ConsentScope] = Field(default_factory=list, max_length=4)
    sample_boundaries: SampleBoundaries

    @model_validator(mode="after")
    def consent_matches_payload(self) -> "ActionContextSnapshot":
        scopes = set(self.consent_scope)
        if self.active_action_slips and "todos" not in scopes:
            raise ValueError("快照包含待办时必须显式授权 todos。")
        if self.recent_daily_plans and "daily_plans" not in scopes:
            raise ValueError("快照包含计划时必须显式授权 daily_plans。")
        if self.focus_summary is not None and "focus_summary" not in scopes:
            raise ValueError("快照包含专注摘要时必须显式授权 focus_summary。")
        if self.selected_knowledge_source_ids and "knowledge_sources" not in scopes:
            raise ValueError("快照选择知识来源时必须显式授权 knowledge_sources。")
        if len(self.selected_knowledge_source_ids) != len(set(self.selected_knowledge_source_ids)):
            raise ValueError("知识来源 ID 不能重复。")
        if self.sample_boundaries.action_slip_limit != len(self.active_action_slips):
            raise ValueError("待办样本边界必须与快照中的待办数量一致。")
        if self.sample_boundaries.daily_plan_limit != len(self.recent_daily_plans):
            raise ValueError("计划样本边界必须与快照中的计划数量一致。")
        if self.sample_boundaries.knowledge_source_selected != len(self.selected_knowledge_source_ids):
            raise ValueError("知识来源样本边界必须与已选来源数量一致。")
        if self.focus_summary is not None and self.sample_boundaries.focus_window_days != self.focus_summary.window_days:
            raise ValueError("专注摘要窗口必须与样本边界一致。")
        return self


class EvidenceItem(ContractModel):
    reference_id: str = Field(pattern=r"^S[1-8]$")
    chunk_id: str = Field(min_length=1, max_length=200)
    source_id: str = Field(min_length=1, max_length=200)
    source_title: str = Field(min_length=1, max_length=500)
    heading: str = Field(default="", max_length=1_000)
    content: str = Field(min_length=1, max_length=1_200)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    retrieval_score: float
    instruction_flagged: bool = False


class PlanItem(ContractModel):
    title: str = Field(min_length=1, max_length=240)
    first_step: str = Field(min_length=1, max_length=300)
    completion_criteria: str = Field(min_length=1, max_length=400)
    estimated_minutes: int = Field(ge=5, le=240)
    rationale: str = Field(min_length=1, max_length=500)
    source_action_slip_ids: list[str] = Field(default_factory=list, max_length=10)
    evidence_refs: list[str] = Field(default_factory=list, max_length=8)


class PlanDraft(ContractModel):
    title: str = Field(min_length=1, max_length=120)
    summary: str = Field(min_length=1, max_length=1_000)
    items: list[PlanItem] = Field(min_length=1, max_length=7)
    assumptions: list[str] = Field(default_factory=list, max_length=10)
    evidence_refs: list[str] = Field(default_factory=list, max_length=8)


class ToolDefinition(ContractModel):
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{2,63}$")
    description: str = Field(min_length=1, max_length=500)
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    risk_level: RiskLevel
    required_permissions: list[ConsentScope] = Field(default_factory=list, max_length=4)
    timeout_ms: int = Field(default=10_000, ge=100, le=120_000)
    retry_policy: Literal["never", "safe_once"] = "never"
    idempotent: bool = True
    redaction_policy: Literal["none", "summary", "content"] = "summary"


class ToolRequest(ContractModel):
    call_id: str = Field(min_length=1, max_length=100)
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{2,63}$")
    arguments: dict[str, Any] = Field(default_factory=dict)
    purpose: str = Field(min_length=1, max_length=500)


class ToolResult(ContractModel):
    call_id: str = Field(min_length=1, max_length=100)
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{2,63}$")
    status: Literal["success", "denied", "error"]
    output: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = Field(default=None, max_length=500)
    duration_ms: float = Field(ge=0)


class PlannerDecision(ContractModel):
    tool_requests: list[ToolRequest] = Field(default_factory=list, max_length=4)
    plan_draft: Optional[PlanDraft] = None

    @model_validator(mode="after")
    def choose_tools_or_plan(self) -> "PlannerDecision":
        if bool(self.tool_requests) == bool(self.plan_draft):
            raise ValueError("规划器必须且只能返回工具请求或计划草案。")
        return self


class SavePlanArguments(ContractModel):
    thread_id: str = Field(min_length=1, max_length=100)
    run_id: str = Field(min_length=8, max_length=100)
    plan: PlanDraft


class StartFocusArguments(ContractModel):
    task_name: str = Field(min_length=1, max_length=240)
    minutes: int = Field(ge=5, le=180)
    first_step: str = Field(min_length=1, max_length=300)
    completion_criteria: str = Field(min_length=1, max_length=400)
    action_slip_id: Optional[str] = Field(default=None, max_length=100)


class MutationIntent(ContractModel):
    action_id: str = Field(min_length=8, max_length=100)
    tool_name: Literal["save_plan", "start_focus"]
    arguments: dict[str, Any]
    base_state_revision: str = Field(min_length=16, max_length=128)
    risk_level: Literal["commit"] = "commit"
    status: Literal["proposed"] = "proposed"

    @model_validator(mode="after")
    def arguments_match_tool(self) -> "MutationIntent":
        if self.tool_name == "save_plan":
            SavePlanArguments.model_validate(self.arguments)
        else:
            StartFocusArguments.model_validate(self.arguments)
        return self


class ApprovalDecision(ContractModel):
    decision: Literal["approve", "modify", "reject"]
    operations: list[Literal["save_plan", "start_focus"]] = Field(default_factory=list, max_length=2)
    modified_plan: Optional[PlanDraft] = None
    note: Optional[str] = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_decision_payload(self) -> "ApprovalDecision":
        if len(self.operations) != len(set(self.operations)):
            raise ValueError("批准操作不能重复。")
        if self.decision == "reject":
            if self.operations or self.modified_plan is not None:
                raise ValueError("拒绝决定不能携带写入操作或修改计划。")
            return self
        if not self.operations:
            raise ValueError("同意或修改计划时必须选择至少一个操作。")
        if self.decision == "modify" and self.modified_plan is None:
            raise ValueError("修改决定必须提供 modifiedPlan。")
        if self.decision == "approve" and self.modified_plan is not None:
            raise ValueError("直接同意时不能替换计划。")
        return self


class ExecutionAckItem(ContractModel):
    action_id: str = Field(min_length=8, max_length=100)
    status: Literal["applied", "already_applied", "failed"]
    error: Optional[str] = Field(default=None, max_length=500)


class ExecutionAck(ContractModel):
    observed_state_revision: str = Field(min_length=16, max_length=128)
    items: list[ExecutionAckItem] = Field(min_length=1, max_length=2)

    @model_validator(mode="after")
    def action_ids_are_unique(self) -> "ExecutionAck":
        action_ids = [item.action_id for item in self.items]
        if len(action_ids) != len(set(action_ids)):
            raise ValueError("executionAck 的 actionId 不能重复。")
        return self


class TraceEvent(ContractModel):
    event_id: str = Field(min_length=8, max_length=100)
    run_id: str = Field(min_length=8, max_length=100)
    sequence: int = Field(ge=1)
    created_at: datetime
    kind: TraceKind
    node: Optional[str] = Field(default=None, max_length=100)
    details: dict[str, Any] = Field(default_factory=dict)


class AgentRunResult(ContractModel):
    schema_version: Literal[1]
    graph_version: str
    thread_id: str
    run_id: str
    status: AgentStatus
    plan_draft: Optional[PlanDraft] = None
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=8)
    tool_results: list[ToolResult] = Field(default_factory=list, max_length=20)
    validation_errors: list[str] = Field(default_factory=list, max_length=20)
    approval_decision: Optional[ApprovalDecision] = None
    mutation_intents: list[MutationIntent] = Field(default_factory=list, max_length=2)
    execution_ack: Optional[ExecutionAck] = None
    trace: list[TraceEvent] = Field(default_factory=list, max_length=200)


class AgentState(TypedDict, total=False):
    schema_version: int
    graph_version: str
    thread_id: str
    run_id: str
    request: str
    context_snapshot: dict[str, Any]
    tool_requests: list[dict[str, Any]]
    tool_results: list[dict[str, Any]]
    evidence: list[dict[str, Any]]
    plan_draft: Optional[dict[str, Any]]
    validation_errors: list[str]
    approval_decision: Optional[dict[str, Any]]
    approved_operations: list[str]
    mutation_intents: list[dict[str, Any]]
    execution_ack: Optional[dict[str, Any]]
    status: AgentStatus
    step_count: int
