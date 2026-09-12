import { useEffect, useMemo, useState } from 'react'
import { buildActionContextSnapshot, type ActionContextSnapshot } from '../lib/agentContext'
import { listKnowledgeSources, type KnowledgeSource } from '../lib/knowledgeBase'
import type { AppState } from '../types'

interface AgentContextPreviewProps {
  state: AppState
}

const DEFAULT_REQUEST = '根据我的未完成待办和近期专注状态，制定未来 7 天可执行的行动计划。'

export function AgentContextPreview({ state }: AgentContextPreviewProps) {
  const [request, setRequest] = useState(DEFAULT_REQUEST)
  const [includeTodos, setIncludeTodos] = useState(true)
  const [includeDailyPlans, setIncludeDailyPlans] = useState(false)
  const [includeFocusSummary, setIncludeFocusSummary] = useState(true)
  const [includeKnowledgeSources, setIncludeKnowledgeSources] = useState(false)
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [preview, setPreview] = useState<ActionContextSnapshot | null>(null)
  const [loadingSources, setLoadingSources] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  async function createPreview() {
    setError(null)
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

  return (
    <section className="agent-context-card card-surface" aria-labelledby="agent-context-title">
      <div className="agent-context-heading">
        <div>
          <p className="eyebrow">0.5.0 · Agent Foundation</p>
          <h2 id="agent-context-title">先看清数据，再让 Agent 规划</h2>
          <p>这一步只构造只读快照，不会保存计划、修改待办或启动专注。</p>
        </div>
        <span>只读预览</span>
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
          <button type="button" disabled title="真实规划器将在下一步接入后启用">生成计划草案（下一步启用）</button>
        </div>
      )}
    </section>
  )
}
