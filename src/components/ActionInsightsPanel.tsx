import { buildActionInsights } from '../lib/actionInsights'
import type { ProgressRange } from '../lib/progressAnalytics'
import type { AppState } from '../types'

interface ActionInsightsPanelProps {
  state: AppState
  range: ProgressRange
  rangeLabel: string
}

function shortDate(value: string) {
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function ActionInsightsPanel({ state, range, rangeLabel }: ActionInsightsPanelProps) {
  const insight = buildActionInsights(state, range)
  const pathTotal = insight.directStartCount + insight.assistedStartCount
  const directWidth = pathTotal ? Math.round((insight.directStartCount / pathTotal) * 100) : 0
  const assistedWidth = pathTotal ? 100 - directWidth : 0

  return (
    <section className="action-insights card-surface">
      <div className="action-insights-heading">
        <div>
          <p className="eyebrow">行动洞察</p>
          <h2>从“记下来”到真正开始</h2>
          <p>汇总{rangeLabel}的待办、启动与现实专注，只描述你的历史记录，不判断哪种方法一定有效。</p>
        </div>
        <span className={`action-sample-badge ${insight.sampleTone}`}>{insight.sampleLabel}</span>
      </div>

      <div className={`action-sample-note ${insight.sampleTone}`}>
        <span aria-hidden="true">i</span><p>{insight.sampleHint}</p>
      </div>

      <div className="action-insight-metrics">
        <article>
          <span>待办进入行动</span>
          <strong>{insight.startRate === null ? '—' : `${insight.startRate}%`}</strong>
          <small>{insight.startedTodoCount}/{insight.recordedTodoCount} 项已有当前状态或专注记录</small>
        </article>
        <article>
          <span>开始前抗拒</span>
          <strong>{insight.averageResistance === null ? '—' : `${insight.averageResistance.toFixed(1)}/3`}</strong>
          <small>{insight.resistanceSampleCount} 次通过启动舱进入行动</small>
        </article>
        <article>
          <span>现实专注完成度</span>
          <strong>{insight.averageCompletion === null ? '—' : `${Math.round(insight.averageCompletion)}%`}</strong>
          <small>{insight.focusCount} 次完成复盘</small>
        </article>
        <article>
          <span>留下下一步</span>
          <strong>{insight.nextStepRate === null ? '—' : `${insight.nextStepRate}%`}</strong>
          <small>{insight.nextStepCount}/{insight.focusCount} 次为下次保留入口</small>
        </article>
      </div>

      <div className="action-insight-grid">
        <article className="action-observation-card">
          <div><span className="action-card-icon">⌁</span><span><strong>这段时间发生了什么</strong><small>由本地规则整理</small></span></div>
          <ul>{insight.observations.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>

        <article className="action-path-card">
          <div><span className="action-card-icon mint">→</span><span><strong>待办如何进入专注</strong><small>仅统计关联待办的现实专注</small></span></div>
          {pathTotal ? (
            <>
              <div className="action-path-bar"><i style={{ width: `${directWidth}%` }} /><b style={{ width: `${assistedWidth}%` }} /></div>
              <div className="action-path-legend"><span><i />直接开始<strong>{insight.directStartCount}</strong></span><span><i />拆成第一步<strong>{insight.assistedStartCount}</strong></span></div>
            </>
          ) : <p className="action-insight-empty">从待办完成一次现实专注后，这里会显示启动路径。</p>}
        </article>

        <article className="action-distraction-card">
          <div><span className="action-card-icon coral">!</span><span><strong>分心来自哪里</strong><small>{insight.averageDistractions === null ? '暂无现实专注' : `平均每次 ${insight.averageDistractions.toFixed(1)} 次`}</small></span></div>
          {insight.distractionBreakdown.length ? (
            <div className="action-distraction-list">{insight.distractionBreakdown.map((item, index) => (
              <span key={item.reason} className={index === 0 ? 'top' : ''}><i>{item.label}</i><strong>{item.count}</strong></span>
            ))}</div>
          ) : <p className="action-insight-empty">还没有分类分心记录。</p>}
        </article>

        <article className="action-continuation-card">
          <div><span className="action-card-icon gold">↳</span><span><strong>下次从哪里继续</strong><small>最近留下的行动入口</small></span></div>
          {insight.continuations.length ? <div className="action-continuation-list">{insight.continuations.map((item) => (
            <div key={item.id}><time>{shortDate(item.completedAt)}</time><span><strong>{item.taskName}</strong><small>{item.nextStep}</small></span></div>
          ))}</div> : <p className="action-insight-empty">专注结束时可以选择留下下一步，但不是必填项。</p>}
        </article>

        <article className="action-stalled-card">
          <div><span className="action-card-icon quiet">…</span><span><strong>暂时没有推进</strong><small>当前待办中超过 7 天未更新</small></span></div>
          {insight.stalledTodos.length ? <div className="action-stalled-list">{insight.stalledTodos.map((item) => (
            <div key={item.id}><strong>{item.title}</strong><small>{item.daysWaiting} 天未更新</small></div>
          ))}</div> : <p className="action-insight-empty">没有超过 7 天未更新的待办。</p>}
          <p className="action-stalled-note">这不是催促，只用于帮助判断是否继续保留、缩小或移除。</p>
        </article>
      </div>
    </section>
  )
}
