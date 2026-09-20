# 简历项目描述候选

以下文案只描述仓库能够证明的工程事实。使用前应由本人确认实际职责、时间范围和求职方向；不要擅自添加团队规模、用户量、业务增长或“独立负责”等仓库无法证明的信息。

## 一句话版本

息壤：本地优先的 Windows 注意力训练与专注启动应用，集成 Electron 管理的 FastAPI sidecar、本地混合 RAG、可恢复人工审批 Agent，以及覆盖质量、安全、性能与桌面生命周期的 Evaluation/CI 门禁。

## 三条技术型版本

- 构建 React + Electron + FastAPI 的本地优先 Windows 应用：Electron 使用随机回环端口管理 Python sidecar 的启动、探活、重启与退出回收，并统一 DPAPI 凭据、SQLite Checkpoint、Qdrant 索引、模型和结构化日志目录。
- 设计 BM25 + BGE + RRF + Cross-Encoder 本地混合检索与引用式 RAG；在 80 条保留查询上达到 Recall@5 0.7933、MRR@5 0.5891，并用 12 条真实 DeepSeek 合成评测覆盖拒答、冲突证据、引用与提示注入。
- 实现 LangGraph + 自研 Harness 的可恢复 Agent：最小数据快照、只读工具、SQLite Interrupt/Resume、同意/修改/拒绝、状态修订冲突与幂等 Mutation Intent；15 条 Fake Eval 和 5 条 DeepSeek 保留集全部通过，固定危险计数为 0。

## 四条工程质量型版本

- 建立 Windows GitHub Actions，将前端、Electron、66 项 API 回归、生产构建、Fake Agent Eval、API 性能门禁、npm/pip 漏洞审计与 CycloneDX SBOM 纳入自动化。
- 为 Agent 和 Electron 生命周期增加串行并发保护，为 BGE 与 Qdrant 查询增加有界 LRU 缓存，为向量索引增加单任务互斥、可取消嵌入阶段、提交期故障关闭与恢复测试。
- 冻结 API、Agent SSE、本地模型和 RSS 基线：Agent SSE 首事件 P95 29.109 ms，BGE 热查询 P95 12.604 ms，Cross-Encoder 热重排 P95 81.608 ms；所有数字明确限定在冻结 Windows 环境。
- 完成 sidecar、unpacked、NSIS 与 Portable 回归及 SHA-256 冻结；Portable 从旧 LZMA 首次启动约 164 秒调整为 ZIP 方案，0.7.0 在同机约 31.230 秒达到 API 健康。

## 产品与安全平衡版本

- 将“任务记录 → 最小第一步 → 现实专注 → 本地趋势 → AI 周计划”串成产品闭环，同时保持发送前快照预览、逐类授权、审批前只读和批准后前端写入所有权。
- 将真实模型能力与工程证明分开：默认 CI 只运行可确定性复现的 Fake Eval，真实 DeepSeek 保留集要求显式付费授权，并记录数据集哈希、Prompt/工具/图版本、tokens、成本和延迟。
- 明确产品边界：不提供医学诊断，不宣称真实用户效果；凭据、Checkpoint、向量索引和待审批线程不进入跨设备备份。

## 面试展开顺序

1. 为什么让前端拥有业务数据，而不是让 Agent 直接写库。
2. 如何用 `baseStateRevision` + `actionId` + ACK 同时处理状态冲突和网络重试。
3. 为什么真实模型不进入普通 CI，以及 Fake Eval 怎样避免“只测最终文本”。
4. 索引提交、Checkpoint 版本和 sidecar 生命周期怎样失败关闭。
5. 哪些指标能说、哪些不能从合成数据外推。

## 技术栈关键词

React 19、TypeScript、Vite、Electron、Python 3.11、FastAPI、Pydantic、LangGraph、SQLite、IndexedDB、Qdrant local mode、BM25、BGE、Cross-Encoder、DeepSeek API、Vitest、pytest、Node test runner、GitHub Actions、CycloneDX、PyInstaller、electron-builder。

## 使用前必须替换或确认

- 项目起止时间与投入方式。
- 本人在架构、前端、后端、评测、桌面打包和文档中的真实职责。
- 简历允许的篇幅与目标岗位。
- 项目仓库或演示视频是否已获得公开分享权限。
- 是否保留具体 DeepSeek 成本与性能数字；若保留，必须同时保留合成数据和冻结环境限定。
