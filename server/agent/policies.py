from __future__ import annotations

from dataclasses import dataclass

from .contracts import ActionContextSnapshot, ToolDefinition, ToolRequest


@dataclass(frozen=True)
class PermissionDecision:
    allowed: bool
    reason: str


class PermissionPolicy:
    """Code-level permission gate for the read-only 0.5.0 graph."""

    def authorize(
        self,
        definition: ToolDefinition,
        request: ToolRequest,
        snapshot: ActionContextSnapshot,
    ) -> PermissionDecision:
        if definition.risk_level != "read":
            return PermissionDecision(False, "0.5.0 只允许执行只读工具。")

        granted = set(snapshot.consent_scope)
        missing = [permission for permission in definition.required_permissions if permission not in granted]
        if missing:
            return PermissionDecision(False, f"缺少显式授权：{', '.join(missing)}。")

        if definition.name == "retrieve_personal_knowledge":
            requested_ids = request.arguments.get("source_ids", [])
            if not isinstance(requested_ids, list):
                return PermissionDecision(False, "知识来源参数必须是列表。")
            allowed_ids = set(snapshot.selected_knowledge_source_ids)
            if any(not isinstance(item, str) or item not in allowed_ids for item in requested_ids):
                return PermissionDecision(False, "工具请求包含未授权的知识来源。")

        return PermissionDecision(True, "只读工具及其数据范围已获得本次快照授权。")
