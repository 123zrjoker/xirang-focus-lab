# 指标证据索引

本页是 0.8.0 展示材料的数字口径。README、演示视频、简历和一页式作品集只能从这里取数；若重新评测产生新结果，应先更新冻结报告，再更新本页。

## Agent

| 可使用表述 | 冻结证据 | 解释限制 |
| --- | --- | --- |
| Fake Agent Eval 15/15，通过全部质量与安全门禁 | [`0.5.2-agent-fake-eval.md`](../../artifacts/evals/0.5.2-agent-fake-eval.md) | 合成快照、脚本规划器、故障工具 |
| 批准前写入、审批绕过、未授权工具、重复副作用、敏感泄露均为 0 | 同上 | 只覆盖固定 15 条用例 |
| SQLite 重启恢复、0.5.1 旧 Checkpoint、未来版本失败关闭、状态冲突和重复 ACK 均有固定用例 | 同上 | thread-scoped，不是跨设备长期记忆 |
| DeepSeek 保留集 5/5；P50 15.842 秒，P95 16.815 秒 | [`0.5.2-agent-deepseek-holdout.md`](../../artifacts/evals/0.5.2-agent-deepseek-holdout.md) | 5 条脱敏合成快照，不代表开放域分布 |
| 真实保留集输入/输出 11,274 / 2,176 tokens，成本上界约 $0.00505 | 同上 | 价格按报告冻结日期与策略估算 |

## 检索与引用式生成

| 可使用表述 | 冻结证据 | 解释限制 |
| --- | --- | --- |
| 15 份项目文档、100 条人工标注查询，20 条开发、80 条保留 | [`0.4.3-ablation-report.md`](../../artifacts/evals/0.4.3-ablation-report.md) | 项目内领域数据，不代表通用语义检索 |
| RRF + Cross-Encoder 在保留集 Recall@1 0.4533、Recall@5 0.7933、MRR@5 0.5891、nDCG@5 0.6383 | 同上 | 本机 CPU，延迟不含首次模型加载和索引构建 |
| 引用式 DeepSeek 生成 12/12；结构合法、拒答、引用、忠实度代理、注入抵抗均为 100% | [`0.4.4-generation-real-eval.md`](../../artifacts/evals/0.4.4-generation-real-eval.md) | 小型人工合成集；忠实度是确定性代理，不等于开放域事实核查 |
| 生成 P50 10.816 秒，P95 13.214 秒 | 同上 | 2026-09-11 的模型与网络条件 |

## 自动化、性能与安全

| 可使用表述 | 冻结证据 | 解释限制 |
| --- | --- | --- |
| 前端 55、Electron 8、API 66 个用例全部通过 | [`0.7.0-desktop-acceptance.md`](../../artifacts/evals/0.7.0-desktop-acceptance.md) | 2026-09-15 冻结提交与环境 |
| health P95 6.791 ms；diagnostics P95 16.064 ms；100 块 BM25 P95 17.834 ms；Agent SSE 首事件 P95 29.109 ms | [`0.7.0-api-baseline.md`](../../artifacts/performance/0.7.0-api-baseline.md) | 预热后本机采样，只用于同类环境回归 |
| BGE 冷查询 18.471 秒、热查询 P95 12.604 ms、缓存命中 P95 0.004 ms | [`0.7.0-model-resource-baseline.md`](../../artifacts/performance/0.7.0-model-resource-baseline.md) | 固定本地模型、同类 CPU 环境 |
| Cross-Encoder 冷启动 3.189 秒、热重排 P95 81.608 ms | 同上 | 同上 |
| 进程 RSS 峰值 1097.820 MiB，较启动增加 1000.754 MiB | 同上 | 资源基线，不是最低硬件需求 |
| npm 与 Python 已知漏洞均为 0，两个 CycloneDX SBOM 生成成功 | [`0.7.0-security-audit.md`](../../artifacts/security/0.7.0-security-audit.md) | 只代表执行时漏洞数据库与锁定依赖 |
| 首次远端 Windows CI 质量与安全 Job 全部通过 | [`0.7.0-desktop-acceptance.md`](../../artifacts/evals/0.7.0-desktop-acceptance.md) | 运行号与耗时以报告为准 |

## 桌面交付

| 可使用表述 | 冻结证据 | 解释限制 |
| --- | --- | --- |
| unpacked 7.077 秒达到 API 健康 | [`0.7.0-desktop-acceptance.md`](../../artifacts/evals/0.7.0-desktop-acceptance.md) | 当前 Windows 开发机 |
| Portable 31.230 秒达到 API 健康，退出后 sidecar 无残留 | 同上 | ZIP 自解压，文件更大 |
| Setup 安装/卸载退出码均为 0，已安装应用 7.782 秒健康 | 同上 | 受控测试目录，不替代独立干净 Windows |
| Setup、blockmap、Portable 与 sidecar SHA-256 已冻结 | 同上 | 只适用于 0.7.0 列出的产物 |

## 禁止转换的表述

| 已有证据 | 不得改写为 |
| --- | --- |
| 固定数据集 100% | “模型准确率 100%”或“任何请求都安全” |
| 本机 P95 | “所有电脑都能在该时延内完成” |
| 0 个固定安全用例失败 | “系统不存在安全漏洞” |
| 合成数据上的计划通过 | “已提升用户效率、注意力或留存” |
| 当前开发机安装通过 | “已完成公开发布级 Windows 兼容性认证” |
| DPAPI 加密保存 Key | “任何情况下都不会泄露密钥” |

## 更新流程

1. 先运行评测或验收，生成带数据集/版本/环境的原始报告。
2. 审查报告中的解释边界和失败样例，不能只复制最佳数字。
3. 更新本页的“可使用表述”和来源链接。
4. 再同步 README、视频字幕、简历与其他派生材料。
5. 运行 `npm run portfolio:check` 和完整质量门禁。
