from __future__ import annotations

from .contracts import AgentEvaluationReport


def markdown_report(report: AgentEvaluationReport) -> str:
    metadata = report.metadata
    metrics = report.metrics
    gate = report.gate
    rows = [
        "# 0.5.2 Agent Evaluation 报告",
        "",
        (
            f"> 数据集：`{metadata['dataset']}` / `{metadata['datasetVersion']}`；"
            f"类型：`{metadata['kind']}`；模型：`{metadata['model']}`；执行时间：{metadata['executedAt']}。"
        ),
        "",
        "## 可复现元数据",
        "",
        f"- 数据集 SHA-256：`{metadata['datasetSha256']}`",
        f"- State / Graph：`{metadata['schemaVersion']}` / `{metadata['graphVersion']}`",
        f"- Planner：`{metadata['planner']}`",
        f"- Prompt 版本：`{metadata['promptVersions']}`",
        f"- 工具版本：`{metadata['toolVersions']}`",
        "",
        "## 核心指标",
        "",
        "| 用例通过 | 工具选择 | 工具顺序 | 参数字段 | 任务结果 | 轨迹 | 安全用例 |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        (
            f"| {metrics['casePassRate']:.4f} | {metrics['toolSelectionAccuracy']:.4f} | "
            f"{metrics['toolOrderAccuracy']:.4f} | {metrics['parameterFieldAccuracy']:.4f} | "
            f"{metrics['taskOutcomeAccuracy']:.4f} | {metrics['trajectoryAccuracy']:.4f} | "
            f"{metrics['safetyCasePassRate']:.4f} |"
        ),
        "",
        "| 引用精确率 | 引用召回率 | Checkpoint 恢复 | 冲突发现 | 注入抵抗 | 重试恢复 |",
        "| ---: | ---: | ---: | ---: | ---: | ---: |",
        (
            f"| {metrics['citationPrecision']:.4f} | {metrics['citationRecall']:.4f} | "
            f"{metrics['checkpointResumeRate']:.4f} | {metrics['stateConflictDetectionRate']:.4f} | "
            f"{metrics['injectionResistanceRate']:.4f} | {metrics['retryRecoveryRate']:.4f} |"
        ),
        "",
        "## 安全硬门禁",
        "",
        f"**{'通过' if gate['passed'] else '未通过'}**（失败指标：{gate['failedMetrics'] or '无'}）",
        "",
        f"- 批准前写入意图：{metrics['preApprovalMutationCount']}",
        f"- 审批绕过：{metrics['approvalBypassCount']}",
        f"- 未授权工具实际执行：{metrics['unauthorizedToolExecutionCount']}",
        f"- 重复副作用：{metrics['duplicateSideEffectCount']}",
        f"- 敏感信息泄露：{metrics['sensitiveLeakCount']}",
        "",
        "## 工程指标",
        "",
        f"- 端到端延迟 P50 / P95：{metrics['latencyP50Ms']:.3f} / {metrics['latencyP95Ms']:.3f} ms",
        f"- 输入 / 输出 tokens：{metrics['inputTokens']} / {metrics['outputTokens']}",
        f"- 估算成本上界：${metrics['estimatedCostUsd']:.8f} USD",
        f"- 重试事件：{metrics['retryEventCount']}",
        f"- 失败分类：`{metrics['failureClasses']}`",
        "",
        "## 冻结发布阈值",
        "",
        "| 指标 | 实际值 | 最低值 | 最高值 | 门禁 |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for check in gate["checks"]:
        rows.append(
            f"| `{check['metric']}` | {check['actual']} | "
            f"{check.get('minimum') if check.get('minimum') is not None else '—'} | "
            f"{check.get('maximum') if check.get('maximum') is not None else '—'} | "
            f"{'通过' if check['passed'] else '失败'} |"
        )
    rows.extend([
        "",
        "## 用例明细",
        "",
        "| 用例 | 类别 | 场景 | 结果 | 最终状态 | 失败分类 | 延迟 |",
        "| --- | --- | --- | --- | --- | --- | ---: |",
    ])
    for item in report.results:
        rows.append(
            f"| `{item.id}` | {item.category} | {item.scenario} | "
            f"{'通过' if item.passed else '失败'} | {item.final_status} | {item.failure_class} | {item.latency_ms:.3f} ms |"
        )
    failures = [item for item in report.results if not item.passed]
    rows.extend(["", f"## 回归失败（{len(failures)} 条）", ""])
    if failures:
        for item in failures:
            rows.append(f"- `{item.id}`：{', '.join(item.failures)}")
            if item.observed_errors:
                rows.append(f"  - 脱敏运行错误：{'；'.join(item.observed_errors)}")
    else:
        rows.append("本次没有回归失败。")
    rows.extend([
        "",
        "## 解释边界",
        "",
        "Fake 数据集使用合成快照、脚本规划器和故障工具，只证明轨迹、恢复及安全边界可确定性复现。真实保留集同样使用脱敏合成快照，不代表线上用户分布；模型价格按数据集内冻结的日期与策略估算。",
        "",
    ])
    return "\n".join(rows)
