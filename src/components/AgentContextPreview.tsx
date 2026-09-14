import { useEffect, useMemo, useRef, useState } from 'react'
import { buildActionContextSnapshot, type ActionContextSnapshot } from '../lib/agentContext'
import {
  getAgentThread,
  streamAgentExecutionAck,
  streamAgentPlan,
  streamAgentResume,
  type AgentApprovalDecision,
  type AgentExecutionAck,
  type AgentMutationIntent,
  type AgentPlanDraft,
  type AgentProgressEvent,
  type AgentRunResult,
} from '../lib/agentClient'
import { listKnowledgeSources, type KnowledgeSource } from '../lib/knowledgeBase'
import type { AgentFocusRequest } from '../lib/agentMutations'
import type { AppState } from '../types'

interface AgentContextPreviewProps {
  state: AppState
  onExecuteMutations: (intents: AgentMutationIntent[]) => Promise<{
    executionAck: AgentExecutionAck
    focusRequest?: AgentFocusRequest
  }>
  onStartApprovedFocus: (request: AgentFocusRequest) => void
}

const DEFAULT_REQUEST = '根据我的未完成待办和近期专注状态，制定未来 7 天可执行的行动计划。'
const PENDING_THREAD_KEY = 'xirang-agent-pending-thread-v1'

function isTerminalStatus(status: AgentRunResult['status']) {
  return ['rejected', 'completed', 'execution_failed', 'cancelled', 'failed'].includes(status)
}

function statusLabel(status: AgentRunResult['status']) {
  switch (status) {
    case 'awaiting_approval': return '等待你的批准'
    case 'approved': return '已批准'
    case 'awaiting_execution': return '等待本地执行'
    case 'completed': return '已完成'
    case 'rejected': return '已拒绝，不会写入'
    case 'execution_failed': return '执行失败，已安全停止'
    case 'failed': return '规划失败，已安全停止'
    case 'cancelled': return '已取消'
    default: return '处理中'
  }
}

export function AgentContextPreview({ state, onExecuteMutations, onStartApprovedFocus }: AgentContextPreviewProps) {
  const [request, setRequest] = useState(DEFAULT_REQUEST)
  const [includeTodos, setIncludeTodos] = useState(true)
  const [includeDailyPlans, setIncludeDailyPlans] = useState(false)
  const [includeFocusSummary, setIncludeFocusSummary] = useState(true)
  const [includeKnowledgeSources, setIncludeKnowledgeSources] = useState(false)
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [preview, setPreview] = useState<ActionContextSnapshot | null>(null)
  const [result, setResult] = useState<AgentRunResult | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<AgentProgressEvent[]>([])
  const [editing, setEditing] = useState(false)
  const [modifiedPlan, setModifiedPlan] = useState<AgentPlanDraft | null>(null)
  const [savePlan, setSavePlan] = useState(true)
  const [startFocus, setStartFocus] = useState(false)
  const [loadingSources, setLoadingSources] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const runController = useRef<AbortController | null>(null)

  useEffect(() => {
    let active = true
    void listKnowledgeSources()
      .then((items) => {
        if (active) setSources(items)
      })
      .catch(() => {
        if (active) setError('无法读取本地知识来源；待办和专注摘要仍可正常预览。')
      })
      .finally(() => {
        if (active) setLoadingSources(false)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const threadId = localStorage.getItem(PENDING_THREAD_KEY)
    if (!threadId) return
    let active = true
    void getAgentThread(threadId)
      .then((restored) => {
        if (!active) return
        setResult(restored)
        if (isTerminalStatus(restored.status)) localStorage.removeItem(PENDING_THREAD_KEY)
      })
      .catch(() => {
        if (active) localStorage.removeItem(PENDING_THREAD_KEY)
      })
    return () => { active = false }
  }, [])

  const activeTodoCount = useMemo(
    () => state.actionSlips.filter((item) => item.status !== 'completed').length,
    [state.actionSlips],
  )

  function toggleSource(id: string) {
    setPreview(null)
    setSelectedSourceIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id])
  }

  function recordProgress(event: AgentProgressEvent) {
    setProgress((current) => [...current.filter((item) => item.node !== event.node), event].slice(-8))
  }

  async function createPreview() {
    setError(null)
    setResult(null)
    setProgress([])
    setEditing(false)
    localStorage.removeItem(PENDING_THREAD_KEY)
    try {
      setPreview(await buildActionContextSnapshot(state, request, {
        includeTodos,
        includeDailyPlans,
        includeFocusSummary,
        includeKnowledgeSources,
        selectedKnowledgeSourceIds: selectedSourceIds,
        knowledgeSourceTotal: sources.length,
      }))
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : '无法生成行动上下文预览。')
    }
  }

  async function generatePlan() {
    if (!preview || running) return
    const threadId = crypto.randomUUID()
    const controller = new AbortController()
    runController.current = controller
    localStorage.setItem(PENDING_THREAD_KEY, threadId)
    setRunning(true)
    setError(null)
    setResult(null)
    setProgress([])
    try {
      const nextResult = await streamAgentPlan(preview, threadId, recordProgress, controller.signal)
      setResult(nextResult)
      if (isTerminalStatus(nextResult.status)) localStorage.removeItem(PENDING_THREAD_KEY)
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : '无法连接本地 Agent 服务。')
    } finally {
      runController.current = null
      setRunning(false)
    }
  }

  async function executeIntents(nextResult: AgentRunResult) {
    if (!nextResult.mutationIntents.length) throw new Error('后端没有返回可执行的写入意图。')
    recordProgress({ node: 'local_commit', status: 'executing', label: '正在核对状态并执行已批准操作' })
    const execution = await onExecuteMutations(nextResult.mutationIntents)
    recordProgress({ node: 'execution_ack', status: 'validating', label: '本地执行完成，正在等待服务端确认' })
    const completed = await streamAgentExecutionAck(nextResult.threadId, execution.executionAck, recordProgress)
    setResult(completed)
    if (isTerminalStatus(completed.status)) localStorage.removeItem(PENDING_THREAD_KEY)
    if (completed.status === 'completed' && execution.focusRequest) {
      onStartApprovedFocus(execution.focusRequest)
    }
  }

  async function submitDecision(decision: AgentApprovalDecision) {
    if (!result || running) return
    setRunning(true)
    setError(null)
    setProgress([])
    try {
      const resumed = await streamAgentResume(result.threadId, decision, recordProgress)
      setResult(resumed)
      setEditing(false)
      if (resumed.status === 'awaiting_execution') await executeIntents(resumed)
      else if (isTerminalStatus(resumed.status)) localStorage.removeItem(PENDING_THREAD_KEY)
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : '无法提交审批决定。')
    } finally {
      setRunning(false)
    }
  }

  function selectedOperations() {
    return [
      ...(savePlan ? ['save_plan' as const] : []),
      ...(startFocus ? ['start_focus' as const] : []),
    ]
  }

  function beginEditing() {
    if (!result?.planDraft) return
    setModifiedPlan(structuredClone(result.planDraft))
    setEditing(true)
  }

  function updateModifiedItem(index: number, patch: Partial<AgentPlanDraft['items'][number]>) {
    setModifiedPlan((current) => current ? {
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    } : current)
  }

  async function approve(modify: boolean) {
    const operations = selectedOperations()
    if (!operations.length) {
      setError('请至少选择“保存计划”或“启动第一项专注”。')
      return
    }
    if (modify && !modifiedPlan) return
    await submitDecision({
      decision: modify ? 'modify' : 'approve',
      operations,
      ...(modify && modifiedPlan ? { modifiedPlan } : {}),
    })
  }

  async function continueExecution() {
    if (!result || result.status !== 'awaiting_execution' || running) return
    setRunning(true)
    setError(null)
    setProgress([])
    try {
      await executeIntents(result)
    } catch (executionError) {
      setError(executionError instanceof Error ? executionError.message : '无法执行已批准操作。')
    } finally {
      setRunning(false)
    }
  }

  const displayedPlan = editing && modifiedPlan ? modifiedPlan : result?.planDraft
  const savedPlans = [...state.agentPlans].reverse().slice(0, 3)

  return (
    <section className="agent-context-card card-surface" aria-labelledby="agent-context-title">
      <div className="agent-context-heading">
        <div>
          <p className="eyebrow">0.5.2 · Evaluated Agent</p>
          <h2 id="agent-context-title">先预览，再规划，最后由你批准</h2>
          <p>规划阶段只读；保存计划或启动专注必须经过人工批准、状态冲突检查与幂等确认。</p>
        </div>
        <span>持久审批</span>
      </div>

      <label className="agent-request-field">
        <span>你希望规划什么</span>
        <textarea
          rows={3}
          maxLength={1_000}
          value={request}
          onChange={(event) => { setRequest(event.target.value); setPreview(null) }}
        />
        <small>{request.trim().length}/1000 字</small>
      </label>

      <fieldset className="agent-consent-grid">
        <legend>选择本次允许使用的数据</legend>
        <label>
          <input type="checkbox" checked={includeTodos} onChange={(event) => { setIncludeTodos(event.target.checked); setPreview(null) }} />
          <span><strong>未完成待办</strong><small>{activeTodoCount} 项，最多发送 20 项</small></span>
        </label>
        <label>
          <input type="checkbox" checked={includeFocusSummary} onChange={(event) => { setIncludeFocusSummary(event.target.checked); setPreview(null) }} />
          <span><strong>近 7 天专注摘要</strong><small>只发送次数、时长、平均值和分心分类计数</small></span>
        </label>
        <label>
          <input type="checkbox" checked={includeDailyPlans} onChange={(event) => { setIncludeDailyPlans(event.target.checked); setPreview(null) }} />
          <span><strong>近期本地计划</strong><small>{state.dailyPlans.length} 份，最多发送最近 7 份</small></span>
        </label>
        <label>
          <input type="checkbox" checked={includeKnowledgeSources} onChange={(event) => { setIncludeKnowledgeSources(event.target.checked); setPreview(null) }} />
          <span><strong>个人知识来源</strong><small>只允许在下方逐项选中的来源中检索</small></span>
        </label>
      </fieldset>

      {includeKnowledgeSources && (
        <div className="agent-source-picker">
          <div><strong>本次可检索来源</strong><small>未勾选的来源不会进入工具授权范围</small></div>
          {loadingSources ? <p>正在读取本地来源…</p> : sources.length ? (
            <div>
              {sources.map((source) => (
                <label key={source.id}>
                  <input type="checkbox" checked={selectedSourceIds.includes(source.id)} onChange={() => toggleSource(source.id)} />
                  <span><strong>{source.title}</strong><small>{source.kind.toUpperCase()} · 仅发送来源 ID，正文由本地检索工具按需读取</small></span>
                </label>
              ))}
            </div>
          ) : <p>知识库中还没有已授权来源。</p>}
        </div>
      )}

      <div className="agent-privacy-note">
        <strong>始终不会进入快照</strong>
        <span>已完成待办、分心原始备注、个人笔记正文、训练逐题数据、DeepSeek Key 与环境变量。</span>
      </div>

      {error && <p className="agent-context-error" role="alert">{error}</p>}
      <button className="button primary agent-preview-button" type="button" onClick={() => void createPreview()}>
        生成发送前预览
      </button>

      {preview && (
        <div className="agent-snapshot-preview" aria-live="polite">
          <div className="agent-preview-title">
            <div><small>快照已生成</small><strong>数据仍在当前浏览器中，尚未发送</strong></div>
            <span>{preview.timezone}</span>
          </div>
          <div className="agent-preview-metrics">
            <span><small>未完成待办</small><strong>{preview.activeActionSlips.length}</strong></span>
            <span><small>近期计划</small><strong>{preview.recentDailyPlans.length}</strong></span>
            <span><small>专注会话</small><strong>{preview.focusSummary?.sessionCount ?? 0}</strong></span>
            <span><small>知识来源</small><strong>{preview.selectedKnowledgeSourceIds.length}</strong></span>
          </div>
          {preview.activeActionSlips.length > 0 && (
            <ul>
              {preview.activeActionSlips.map((item) => (
                <li key={item.id}><span>{item.status === 'current' ? '现在做' : '待办'}</span><strong>{item.title}</strong><small>{item.nextStep ?? '未记录下一步'}</small></li>
              ))}
            </ul>
          )}
          <p className="agent-revision">状态修订号 <code>{preview.baseStateRevision.slice(0, 16)}…</code> 将用于发现生成期间的本地数据变化。</p>
          <details>
            <summary>查看将发送给本地 Agent 服务的完整 JSON</summary>
            <pre>{JSON.stringify(preview, null, 2)}</pre>
          </details>
          <p className="agent-cost-note">继续后会调用已配置的 DeepSeek。规划通常包含“选择只读工具”和“生成草案”两次结构化请求，可能产生少量费用。</p>
          <button className="agent-run-button" type="button" disabled={running} onClick={() => void generatePlan()}>
            {running ? 'Agent 正在读取、规划并校验…' : '生成只读计划草案'}
          </button>
        </div>
      )}

      {running && progress.length > 0 && (
        <div className="agent-progress-panel" aria-live="polite">
          <div><strong>Agent 实时进度</strong><button type="button" onClick={() => runController.current?.abort()}>停止等待（稍后可恢复）</button></div>
          <ol>
            {progress.map((item) => <li key={item.node}><span />{item.label}</li>)}
          </ol>
        </div>
      )}

      {result && (
        <div className={`agent-plan-result ${result.status}`} aria-live="polite">
          <div className="agent-plan-result-heading">
            <div>
              <small>{result.graphVersion}</small>
              {editing && modifiedPlan ? (
                <div className="agent-plan-title-editor">
                  <label>计划标题<input maxLength={120} value={modifiedPlan.title} onChange={(event) => setModifiedPlan({ ...modifiedPlan, title: event.target.value })} /></label>
                  <label>计划摘要<textarea rows={3} maxLength={1_000} value={modifiedPlan.summary} onChange={(event) => setModifiedPlan({ ...modifiedPlan, summary: event.target.value })} /></label>
                </div>
              ) : (
                <><h3>{result.planDraft?.title ?? '计划生成未完成'}</h3><p>{result.planDraft?.summary ?? result.validationErrors.join('；')}</p></>
              )}
            </div>
            <span>{statusLabel(result.status)}</span>
          </div>

          {displayedPlan && (
            <ol className="agent-plan-items">
              {displayedPlan.items.map((item, index) => (
                <li key={`${item.title}-${index}`}>
                  {editing ? (
                    <div className="agent-plan-item-editor">
                      <span>{index + 1}</span>
                      <label>任务<input maxLength={240} value={item.title} onChange={(event) => updateModifiedItem(index, { title: event.target.value })} /></label>
                      <label>分钟<input type="number" min={5} max={240} value={item.estimatedMinutes} onChange={(event) => updateModifiedItem(index, { estimatedMinutes: Number(event.target.value) })} /></label>
                      <label>第一步<textarea rows={2} maxLength={300} value={item.firstStep} onChange={(event) => updateModifiedItem(index, { firstStep: event.target.value })} /></label>
                      <label>完成标准<textarea rows={2} maxLength={400} value={item.completionCriteria} onChange={(event) => updateModifiedItem(index, { completionCriteria: event.target.value })} /></label>
                      <label>规划理由<textarea rows={2} maxLength={500} value={item.rationale} onChange={(event) => updateModifiedItem(index, { rationale: event.target.value })} /></label>
                    </div>
                  ) : (
                    <>
                      <div><span>{index + 1}</span><strong>{item.title}</strong><em>{item.estimatedMinutes} 分钟</em></div>
                      <p><b>第一步</b>{item.firstStep}</p>
                      <p><b>完成标准</b>{item.completionCriteria}</p>
                      <small>{item.rationale}</small>
                    </>
                  )}
                  {item.evidenceRefs.length > 0 && <code>依据 {item.evidenceRefs.join('、')}</code>}
                </li>
              ))}
            </ol>
          )}

          {displayedPlan?.assumptions.length ? (
            <div className="agent-plan-assumptions"><strong>假设与边界</strong><ul>{displayedPlan.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></div>
          ) : null}

          {result.status === 'awaiting_approval' && result.planDraft && (
            <section className="agent-approval-panel" aria-label="计划审批">
              <div>
                <strong>{editing ? '确认修改后的计划与获准操作' : '选择本次批准的操作'}</strong>
                <small>只有勾选并批准的操作会形成写入意图；执行前还会核对状态修订号。</small>
              </div>
              <div className="agent-operation-options">
                <label><input type="checkbox" checked={savePlan} onChange={(event) => setSavePlan(event.target.checked)} /><span><strong>保存这份计划</strong><small>写入本机计划历史，可重复识别同一操作。</small></span></label>
                <label><input type="checkbox" checked={startFocus} onChange={(event) => setStartFocus(event.target.checked)} /><span><strong>启动第一项专注</strong><small>服务端确认写入成功后才跳转到专注页。</small></span></label>
              </div>
              <div className="agent-approval-actions">
                <button type="button" className="agent-danger-button" disabled={running} onClick={() => void submitDecision({ decision: 'reject', operations: [] })}>拒绝计划</button>
                {editing ? (
                  <><button type="button" disabled={running} onClick={() => { setEditing(false); setModifiedPlan(null) }}>取消修改</button><button type="button" className="agent-approve-button" disabled={running} onClick={() => void approve(true)}>批准修改版</button></>
                ) : (
                  <><button type="button" disabled={running} onClick={beginEditing}>修改计划</button><button type="button" className="agent-approve-button" disabled={running} onClick={() => void approve(false)}>同意并执行</button></>
                )}
              </div>
            </section>
          )}

          {result.status === 'awaiting_execution' && (
            <section className="agent-execution-panel">
              <div><strong>批准已持久化，等待本地执行</strong><small>检测到上次在执行确认前中断。可安全继续；已完成的 actionId 不会重复应用。</small></div>
              <ul>{result.mutationIntents.map((intent) => <li key={intent.actionId}>{intent.toolName === 'save_plan' ? '保存计划' : '启动专注'} <code>{intent.actionId.slice(0, 12)}…</code></li>)}</ul>
              <button type="button" className="agent-approve-button" disabled={running} onClick={() => void continueExecution()}>{running ? '正在核对并执行…' : '继续执行已批准操作'}</button>
            </section>
          )}

          {result.status === 'rejected' && <p className="agent-terminal-note">你已拒绝这份计划。本地数据没有发生变化。</p>}
          {result.status === 'completed' && <p className="agent-terminal-note success">批准的操作已执行，并由服务端记录确认结果。</p>}
          {result.status === 'execution_failed' && <p className="agent-terminal-note failure">写入未获服务端确认。{result.executionAck?.items.find((item) => item.error)?.error ?? '请根据提示重新生成计划。'}</p>}

          {result.evidence.length > 0 && (
            <details className="agent-plan-evidence">
              <summary>查看 {result.evidence.length} 条规划依据</summary>
              {result.evidence.map((item) => (
                <article key={item.referenceId}>
                  <span>{item.referenceId}</span>
                  <div><strong>{item.sourceTitle}</strong><small>{item.heading || `第 ${item.startLine}–${item.endLine} 行`}</small><p>{item.content}</p></div>
                </article>
              ))}
            </details>
          )}

          <div className="agent-tool-trace">
            <span>只读工具轨迹</span>
            {result.toolResults.length
              ? result.toolResults.map((item) => <i key={item.callId} className={item.status}>{item.name} · {item.status}</i>)
              : <i>本次未调用工具</i>}
          </div>
          <p className="agent-run-id">Thread ID：{result.threadId} · Run ID：{result.runId} · 审批状态与轨迹已持久化。</p>
        </div>
      )}

      {savedPlans.length > 0 && (
        <details className="agent-saved-plans">
          <summary>本机已保存的 Agent 计划（{state.agentPlans.length}）</summary>
          <ol>
            {savedPlans.map((plan) => <li key={plan.id}><div><strong>{plan.title}</strong><small>{new Date(plan.createdAt).toLocaleString('zh-CN')}</small></div><span>{plan.items.length} 项</span></li>)}
          </ol>
        </details>
      )}
    </section>
  )
}
