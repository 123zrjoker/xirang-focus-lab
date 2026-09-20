# 招聘方复现指南

目标是在不使用私人数据、不配置 DeepSeek Key 的情况下，运行合成演示、Fake Agent Eval 和主要工程门禁。默认路径不会调用付费 API。

## 环境

- Windows 10/11 x64
- Node.js 22.12 或更高的 22.x 版本
- Python 3.11
- 首次安装 JavaScript/Python 依赖需要网络
- 仅验证 BM25、Agent Fake Eval 和普通界面时不需要下载本地模型

在已授权的仓库副本根目录执行：

```powershell
npm ci
npm run setup:api:py311
```

## 先验证公开材料

```powershell
npm run portfolio:check
```

该检查会验证必需文件、相对链接、合成数据标记、架构图图源哈希、本机绝对路径和疑似明文密钥。它已经进入 `quality:gate`。

## 运行脱敏合成演示

1. 建议使用全新的浏览器配置或先在“设置 → 数据管理”导出自己的备份；导入会替换当前应用状态。
2. 启动本机 API：

   ```powershell
   npm run dev:api
   ```

3. 另开终端启动网站：

   ```powershell
   npm run dev -- --host 127.0.0.1
   ```

4. 打开 `http://127.0.0.1:5173`，进入“设置 → 数据管理”，导入 [`xirang-demo-backup.json`](demo-data/xirang-demo-backup.json)。
5. 在“设置 → AI 与知识库”导入 [`focus-methods-demo.md`](demo-data/focus-methods-demo.md)，明确授权后即可验证分块、BM25 检索和最小证据预览。
6. 数据页选择“全部”范围，可查看合成训练和现实专注记录。所有记录均为演示数据，不是用户行为样本。

更完整的演示步骤见[演示数据说明](demo-data/README.md)和[演示脚本](demo-script.md)。

## 运行无付费 Agent Eval

```powershell
npm run eval:agent
```

预期结果：15 条确定性用例全部通过，批准前写入、审批绕过、未授权工具执行、重复副作用和敏感信息泄露均为 0。报告写入 [`artifacts/evals/0.5.2-agent-fake-eval.md`](../../artifacts/evals/0.5.2-agent-fake-eval.md)。

Fake Eval 使用合成快照、脚本规划器和故障工具。它验证工具选择、轨迹、审批、SQLite 恢复、版本兼容、状态冲突、幂等、提示注入和故障恢复，但不能证明真实模型在开放域请求上的质量。

## 分层验证

快速检查前端与 Electron：

```powershell
npm test
npm run test:desktop
npm run build
```

验证 API：

```powershell
npm run test:api
```

执行默认完整质量门禁：

```powershell
npm run quality:gate
```

执行依赖审计和 CycloneDX SBOM：

```powershell
npm run setup:quality
npm run quality:security
```

0.7.0 冻结结果为前端 55、Electron 8、API 66 个用例通过，Fake Eval 15/15，依赖已知漏洞为 0。新环境的输出可能因依赖源和硬件不同而耗时不同；通过标准由脚本内门禁决定。

## 可选：本地向量与重排

首次下载固定版本 BGE 和 Cross-Encoder，约 230 MB：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/download_retrieval_models.ps1
```

然后可在检索实验台选择向量、混合或重排模式，也可执行：

```powershell
npm run perf:models
```

模型推理在本机 CPU 完成。下载模型需要网络，但查询不会把知识正文发送到模型托管服务。

## 可选且付费：真实 DeepSeek 保留集

这不是默认复现步骤。只有操作者已理解费用、在本机安全保存了凭据，并明确允许真实调用时才执行：

```powershell
npm run eval:agent:real -- --allow-paid-api
```

已冻结的 5 条保留集报告见 [`0.5.2-agent-deepseek-holdout.md`](../../artifacts/evals/0.5.2-agent-deepseek-holdout.md)。不要仅为代码审阅重复付费运行，也不要把 Key 写进命令、仓库、截图或录屏。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `py -3.11` 找不到解释器 | 安装 Python 3.11，并确认 Python Launcher 可用 |
| 向量或重排模式提示模型缺失 | 运行模型下载脚本，或继续使用不需要模型的 BM25 |
| Agent 界面提示未配置 DeepSeek | 这是正常边界；使用 Fake Eval 完成无付费复现 |
| BGE 第一次查询较慢 | 首次需要加载模型；冻结机器的冷查询约 18.47 秒 |
| 导入演示数据后原记录消失 | 导入会替换当前业务状态；应在全新配置中运行或先导出备份 |
| Windows 提示未知发布者 | 当前包没有商业代码签名；公开分发门禁尚未完成 |
