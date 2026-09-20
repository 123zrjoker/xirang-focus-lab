# 关键技术决策与失败案例

本页记录的是工程约束如何形成，而不是只列技术栈。每项结论都能回到代码、测试或冻结报告。

## 技术决策

### 1. 业务数据由前端拥有，Agent 只返回写入意图

选择：训练、待办、计划与专注状态继续由 React 端管理。后端在人工批准后返回 `MutationIntent`，前端核验 `baseStateRevision`、参数和 `actionId` 后原子应用，再回传 ACK。

原因：模型编排和业务持久化的故障域不同。让后端直接修改浏览器状态会绕过既有迁移、备份与 UI 恢复逻辑，也更难阻止断线重试造成重复副作用。

代价：协议多一个执行确认阶段，前后端都要处理 `awaiting_execution`。收益是写入权限、冲突和幂等可以独立测试。实现见 [`agentMutations.ts`](../../src/lib/agentMutations.ts) 与 [`contracts.py`](../../server/agent/contracts.py)。

### 2. LangGraph 管状态流转，自研 Harness 管工程策略

选择：LangGraph 负责节点、Checkpoint、Interrupt/Resume 和 Streaming；自研 `AgentHarness` 负责 Provider、Prompt/Tool Registry、权限、预算、校验、Trace 和 Eval。

原因：把全部策略绑进编排框架会让生产执行和离线评测难以复用同一契约，也会扩大迁移成本。

代价：需要维护清晰的适配层。收益是 Fake Planner、DeepSeek Planner 和故障工具可以进入同一评测入口。实现见 [`harness.py`](../../server/agent/harness.py) 与 [`server/evals/agent/`](../../server/evals/agent/)。

### 3. Checkpoint 与 Trace 留在 SQLite，未知未来版本失败关闭

选择：设备内线程状态和脱敏 Trace 共用稳定 SQLite 路径；Checkpoint 记录图版本，兼容旧 0.5.1 状态，但拒绝未知未来版本。

原因：审批可能跨页面与服务重启，但自动猜测未知状态结构可能把旧批准错误映射成新写入。

代价：不兼容版本需要明确迁移。收益是恢复边界可审计，`legacy-051-checkpoint` 和 `future-checkpoint-fails-closed` 都进入固定 Eval。

### 4. 本地混合检索优先，云端只接收最小证据

选择：BM25、BGE、Qdrant local mode、RRF 和量化 Cross-Encoder 在本机运行；只有用户主动生成答案或计划时，经过预览的最小证据或快照才发送给 DeepSeek。

原因：个人知识正文默认不应被整库上传，本地检索也能在没有 Key 时独立验证。

代价：安装包更大，CPU 冷启动与峰值内存明显。冻结机器上 BGE 首次查询约 18.47 秒，模型性能门禁因此同时记录冷、热、缓存命中和 RSS。

### 5. CI 默认运行确定性 Fake Eval，真实模型必须显式付费授权

选择：Windows CI 执行前端、Electron、API、构建、Fake Agent Eval、API 性能、依赖审计与 SBOM；真实 DeepSeek 保留集不进入普通 CI。

原因：真实模型有费用、配额和输出波动，不能成为每次提交的隐式外部副作用。

代价：真实模型漂移需要小型保留集按需复验。命令必须显式带 `--allow-paid-api`，报告同时记录 tokens、成本估算和数据集哈希。

### 6. Electron 只管理本机 sidecar，不把 Node 能力交给页面

选择：Electron 分配随机 `127.0.0.1` 端口，管理 sidecar 启停与探活；`contextIsolation` 和 sandbox 开启，preload 只暴露 API 地址、运行状态和重启动作。

原因：固定端口容易冲突，把通用 Node 能力暴露给 Renderer 会扩大攻击面。

代价：桌面壳需要额外的生命周期、日志和路径契约测试。实现见 [`api-service.cjs`](../../electron/api-service.cjs) 与 [`preload.cjs`](../../electron/preload.cjs)。

## 失败案例与修复

### A. LZMA Portable 首次启动超过烟雾测试上限

- 现象：旧 Portable 在冻结机器上首次自解压约 164 秒，超过 120 秒烟雾测试上限。
- 根因：LZMA 换取了较小体积，却把大型 Python/模型资源的首次解压成本推到用户启动路径。
- 修复：Portable 改用 ZIP 自解压，接受更大文件；0.7.0 Portable 约 31.230 秒达到 API 健康。
- 证据：[`0.6.0 桌面验收`](../../artifacts/evals/0.6.0-desktop-acceptance.md)、[`0.7.0 桌面验收`](../../artifacts/evals/0.7.0-desktop-acceptance.md)、[`package.json`](../../package.json)。

### B. 索引提交中断可能把半成品误报为可用

- 风险：向量写入不是瞬时操作；若进程在提交阶段退出，仅依赖内存状态会让下次启动无法区分完整索引与半成品。
- 修复：提交前持久化 `committing`，异常持久化 `failed`；两者都令 `ready=false`，下次同步重新比对修复。嵌入阶段可取消，提交阶段不可中断。
- 证据：[`semantic.py`](../../server/semantic.py) 与故障注入测试 [`test_semantic.py`](../../server/tests/test_semantic.py)。

### C. 重复 Resume 或 ACK 可能产生重复副作用

- 风险：网络重试、页面恢复或用户重复点击可能再次提交同一批准结果。
- 修复：服务端生成确定性 `actionId`；前端维护有界 action ledger，并同时检查已保存计划与活动专注 ID。ACK 支持 `already_applied`，重复调用返回同一结果。
- 证据：[`test_agent_stateful.py`](../../server/tests/test_agent_stateful.py) 的重复 Resume/ACK 测试，以及 Fake Eval 的 `duplicate-resume-ack` 用例。

### D. Checkpoint 结构升级可能错误恢复旧线程

- 风险：无版本检查地读取状态，可能把旧字段解释成新审批或写入语义。
- 修复：状态与图版本写入 Checkpoint；明确兼容 0.5.1，未知未来图版本返回 `incompatible_checkpoint`，不继续执行。
- 证据：Fake Eval 的 `legacy-051-checkpoint` 与 `future-checkpoint-fails-closed` 两条固定用例。

### E. 首轮真实生成评测暴露的是标注问题，不是模型问题

- 现象：首次完整运行中，一条用例把回答必须出现的 `XLSX` 同时列为禁止词，另一条错误禁止拒答理由所需引用。
- 修复：只修正两处数据集标签，模型、系统 Prompt、生成参数和评分代码均未改动，然后重跑全部 12 条并冻结数据集。
- 教训：Eval 失败先分类为模型、代码或标注问题；不能为了通过门禁偷偷调整 Prompt 后仍宣称同一基线。
- 证据：[`0.4.4 DeepSeek 真实生成评测`](../../artifacts/evals/0.4.4-generation-real-eval.md) 的“数据集定稿说明”。

## 仍未解决的发布风险

- 独立干净 Windows 上的安装、升级、审批恢复与卸载串联测试保留到 0.9.0。
- 当前没有商业代码签名证书和自定义应用图标。
- 本地模型带来约 1 GiB 的峰值 RSS 增量，低配置机器需要更明确的降级说明。
- 真实 Agent 保留集只有 5 条，足以守住契约和安全回归，不足以代表开放域规划质量。
