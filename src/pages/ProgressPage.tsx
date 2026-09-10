import { useState } from 'react'
import { AssessmentHistoryPanel } from '../components/AssessmentHistoryPanel'
import { ActionInsightsPanel } from '../components/ActionInsightsPanel'
import { ProgressTrendChart } from '../components/ProgressTrendChart'
import type { TrendPoint } from '../components/ProgressTrendChart'
import { taskLabel } from '../lib/metrics'
import {
  buildActivityHeatmap,
  buildWeeklyProgress,
  filterByRange,
  localDateKey,
  type ProgressRange,
} from '../lib/progressAnalytics'
import type { AppState, FocusSession, TaskType, TrainingSession } from '../types'

interface ProgressPageProps {
  state: AppState
  onStartRetest: () => void
}

const taskTypes: TaskType[] = ['schulte', 'vigilance', 'go-no-go', 'stroop']
const rangeLabels: Record<ProgressRange, string> = { '7d': '近 7 天', '30d': '近 30 天', all: '全部' }

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function dateLabel(completedAt: string) {
  return new Date(completedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function toPoints<T extends { completedAt: string }>(items: T[], value: (item: T) => number): TrendPoint[] {
  return [...items]
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .map((item) => ({ label: dateLabel(item.completedAt), value: value(item) }))
}

function trainingMinutes(items: TrainingSession[]) {
  return items.reduce((sum, item) => sum + item.durationSec, 0) / 60
}

function focusMinutes(items: FocusSession[]) {
  return items.reduce((sum, item) => sum + item.actualDurationSec, 0) / 60
}

export function ProgressPage({ state, onStartRetest }: ProgressPageProps) {
  const [range, setRange] = useState<ProgressRange>('7d')
  const [selectedTask, setSelectedTask] = useState<TaskType>('schulte')
  const rangeTraining = filterByRange(state.sessions, range)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
  const rangeFocus = filterByRange(state.focusSessions, range)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
  const weekly = buildWeeklyProgress(state)
  const heatmap = buildActivityHeatmap(state, range)
  const selectedSessions = rangeTraining.filter((item) => item.taskType === selectedTask)
  const selectedReactionSessions = selectedSessions.filter((item) => item.medianReactionMs > 0)
  const activeDays = new Set([...rangeTraining, ...rangeFocus].map((item) => localDateKey(item.completedAt))).size
  const rawTotalMinutes = trainingMinutes(rangeTraining) + focusMinutes(rangeFocus)
  const totalMinutes = rawTotalMinutes > 0 ? Math.max(1, Math.round(rawTotalMinutes)) : 0
  const recentSessions = [...rangeTraining].slice(-8).reverse()
  const assessments = state.assessments ?? []
  const hasAnyData = state.sessions.length > 0 || state.focusSessions.length > 0 || state.focusLaunches.length > 0 || state.actionSlips.length > 0 || assessments.length > 0

  const accuracyPoints = toPoints(selectedSessions, (item) => item.accuracy * 100)
  const reactionPoints = toPoints(selectedReactionSessions, (item) => item.medianReactionMs)
  const levelPoints = toPoints(selectedSessions, (item) => item.level)
  const focusDurationPoints = toPoints(rangeFocus, (item) => item.actualDurationSec / 60)
  const focusCompletionPoints = toPoints(rangeFocus, (item) => item.completionRate)
  const focusRatingPoints = toPoints(rangeFocus, (item) => item.subjectiveFocus)
  const focusDistractionPoints = toPoints(rangeFocus, (item) => item.distractionCount)
  const heatmapWeeks = Math.ceil(heatmap.length / 7)
  const heatmapDescription = range === 'all' && heatmapWeeks >= 24
    ? '全部趋势参与统计，日历最多展示最近 24 周'
    : `${rangeLabels[range]}的训练与现实专注活跃度`

  return (
    <section className="page-width inner-page progress-page">
      <div className="page-title-row progress-title-row">
        <div><p className="eyebrow">个人数据</p><h1>看趋势，不追逐一次高分</h1><p>所有指标都从你的个人基线出发，不代表人群排名。</p></div>
        <div className="progress-range-switch" aria-label="趋势时间范围">
          {(['7d', '30d', 'all'] as ProgressRange[]).map((item) => (
            <button key={item} type="button" className={range === item ? 'active' : ''} onClick={() => setRange(item)}>{rangeLabels[item]}</button>
          ))}
        </div>
      </div>

      {!hasAnyData ? (
        <div className="empty-state card-surface"><span>↗</span><h2>完成一次训练或专注后，这里会出现趋势</h2><p>我们会优先展示正确率、稳定性和现实任务完成情况。</p></div>
      ) : (
        <>
          <div className="weekly-report-grid">
            <article className="weekly-report card-surface">
              <div><p className="eyebrow">本地周报</p><span>按固定规则生成 · 数据不会离开此设备</span></div>
              <blockquote>{weekly.summary}</blockquote>
              <div className="weekly-report-facts"><span><strong>{weekly.trainingCount}</strong>次训练</span><span><strong>{weekly.focusCount}</strong>次现实专注</span><span><strong>{weekly.activeDays}</strong>个活跃日</span></div>
            </article>
            <article className="weekly-goal card-surface">
              <div className="card-header"><div><p className="eyebrow">本周目标</p><h2>{weekly.completedMinutes}/{weekly.targetMinutes} 分钟</h2></div><strong>{weekly.progress}%</strong></div>
              <i><b style={{ width: `${Math.min(100, weekly.progress)}%` }} /></i>
              <p>{weekly.onTrack ? '截至今天达到计划节奏，继续保持。' : `截至今天计划进度为 ${weekly.elapsedTargetMinutes} 分钟，可以从一次短训练开始补回节奏。`}</p>
              <div><span>训练 {weekly.trainingMinutes} 分钟</span><span>现实专注 {weekly.focusMinutes} 分钟</span></div>
            </article>
          </div>

          <div className="range-summary-grid">
            <article className="card-surface"><span>{rangeLabels[range]}训练</span><strong>{rangeTraining.length}</strong><small>次认知练习</small></article>
            <article className="card-surface"><span>{rangeLabels[range]}专注</span><strong>{rangeFocus.length}</strong><small>次现实任务</small></article>
            <article className="card-surface"><span>累计投入</span><strong>{totalMinutes}</strong><small>训练与专注分钟</small></article>
            <article className="card-surface"><span>活跃天数</span><strong>{activeDays}</strong><small>有记录的自然日</small></article>
          </div>

          <ActionInsightsPanel state={state} range={range} rangeLabel={rangeLabels[range]} />

          <AssessmentHistoryPanel assessments={assessments} sessions={state.sessions} onStartRetest={onStartRetest} />

          <article className="activity-heatmap-card card-surface">
            <div className="card-header"><div><p className="eyebrow">训练日历</p><h2>活动热力图</h2><p>{heatmapDescription}</p></div><span>{heatmapWeeks} 周</span></div>
            <div className="heatmap-scroll">
              <div className="heatmap-weekdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
              <div className="activity-heatmap" style={{ gridTemplateColumns: `repeat(${heatmapWeeks}, 13px)` }}>
                {heatmap.map((day) => (
                  <span
                    className={`intensity-${day.intensity}`}
                    key={day.key}
                    title={`${day.key} · ${day.minutes} 分钟 · ${day.trainingCount} 次训练 · ${day.focusCount} 次专注`}
                    aria-label={`${day.key}，投入 ${day.minutes} 分钟`}
                  />
                ))}
              </div>
            </div>
            <div className="heatmap-legend"><span>少</span><i className="intensity-0" /><i className="intensity-1" /><i className="intensity-2" /><i className="intensity-3" /><i className="intensity-4" /><span>达到目标</span></div>
          </article>

          <section className="task-trends card-surface">
            <div className="section-card-heading"><div><p className="eyebrow">认知训练趋势</p><h2>每一次训练都是一个数据点</h2><p>正确率、反应时和当次等级分开呈现，避免把不同量纲混成一个分数。</p></div></div>
            <div className="task-trend-tabs">
              {taskTypes.map((taskType) => {
                const count = rangeTraining.filter((item) => item.taskType === taskType).length
                return <button key={taskType} type="button" className={selectedTask === taskType ? 'active' : ''} onClick={() => setSelectedTask(taskType)}><span>{taskLabel(taskType)}</span><small>{count} 次</small></button>
              })}
            </div>
            <div className="task-trend-summary">
              <span>当前查看<strong>{taskLabel(selectedTask)}</strong></span>
              <span>漏答<strong>{selectedSessions.reduce((sum, item) => sum + item.omissions, 0)}</strong></span>
              <span>{selectedTask === 'schulte' ? '误点' : '误按'}<strong>{selectedSessions.reduce((sum, item) => sum + item.commissions, 0)}</strong></span>
            </div>
            <div className="task-trend-grid">
              <ProgressTrendChart
                title="正确率"
                points={accuracyPoints}
                headline={selectedSessions.length ? `平均 ${Math.round(average(selectedSessions.map((item) => item.accuracy)) * 100)}%` : '暂无'}
                description={`${selectedSessions.length} 次记录`}
                formatValue={(value) => `${Math.round(value)}%`}
                domain={[0, 100]}
                tone="green"
              />
              <ProgressTrendChart
                title="中位反应时"
                points={reactionPoints}
                headline={selectedReactionSessions.length ? `均值 ${Math.round(average(selectedReactionSessions.map((item) => item.medianReactionMs)))}ms` : '暂无'}
                description="数值越低代表反应越快"
                formatValue={(value) => `${Math.round(value)}ms`}
                tone="blue"
              />
              <ProgressTrendChart
                title="训练等级"
                points={levelPoints}
                headline={selectedSessions.length ? `当前 ${selectedSessions[selectedSessions.length - 1].level} 级` : '暂无'}
                description="展示每次训练采用的难度"
                formatValue={(value) => `${Math.round(value)} 级`}
                domain={[1, 5]}
                tone="gold"
              />
            </div>
          </section>

          <section className="focus-trends card-surface">
            <div className="section-card-heading"><div><p className="eyebrow">现实专注趋势</p><h2>小游戏之外，真实任务完成得怎么样</h2><p>把时长、完成度、主观专注感和分心次数分别观察。</p></div></div>
            <div className="focus-trend-grid">
              <ProgressTrendChart
                title="单次专注时长"
                points={focusDurationPoints}
                headline={rangeFocus.length ? `平均 ${Math.round(focusMinutes(rangeFocus) / rangeFocus.length)} 分钟` : '暂无'}
                description={`${rangeFocus.length} 次现实专注`}
                formatValue={(value) => `${Math.round(value)} 分钟`}
                tone="green"
              />
              <ProgressTrendChart
                title="任务完成度"
                points={focusCompletionPoints}
                headline={rangeFocus.length ? `平均 ${Math.round(average(rangeFocus.map((item) => item.completionRate)))}%` : '暂无'}
                description="结束复盘中的自评完成度"
                formatValue={(value) => `${Math.round(value)}%`}
                domain={[0, 100]}
                tone="blue"
              />
              <ProgressTrendChart
                title="主观专注感"
                points={focusRatingPoints}
                headline={rangeFocus.length ? `平均 ${average(rangeFocus.map((item) => item.subjectiveFocus)).toFixed(1)}/5` : '暂无'}
                description="每次结束后的 1～5 分自评"
                formatValue={(value) => `${value.toFixed(1)}/5`}
                domain={[1, 5]}
                tone="gold"
              />
              <ProgressTrendChart
                title="分心次数"
                points={focusDistractionPoints}
                headline={rangeFocus.length ? `共 ${rangeFocus.reduce((sum, item) => sum + item.distractionCount, 0)} 次` : '暂无'}
                description="数值越低代表干扰越少"
                formatValue={(value) => `${Math.round(value)} 次`}
                tone="coral"
              />
            </div>
          </section>

          <div className="progress-detail">
            <div className="error-breakdown card-surface wide">
              <p className="eyebrow">错误类型</p><h2>漏答与误按分开看</h2>
              <div className="error-table-heading"><span>任务</span><span>漏答</span><span>误按/误点</span></div>
              {taskTypes.map((taskType) => {
                const items = rangeTraining.filter((item) => item.taskType === taskType)
                return <div className="error-table-row" key={taskType}><span>{taskLabel(taskType)}<small>{items.length} 次训练</small></span><strong>{items.reduce((sum, item) => sum + item.omissions, 0)}</strong><strong>{items.reduce((sum, item) => sum + item.commissions, 0)}</strong></div>
              })}
            </div>
          </div>

          <div className="recent-table card-surface">
            <div className="card-header"><div><p className="eyebrow">最近记录</p><h2>{rangeLabels[range]}的训练明细</h2></div></div>
            {recentSessions.length ? recentSessions.map((session) => (
              <div className="recent-row enhanced" key={session.id}>
                <span>{taskLabel(session.taskType)}<small>{new Date(session.completedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span>
                <strong>{Math.round(session.accuracy * 100)}%<small>正确率</small></strong>
                <strong>{session.medianReactionMs ? `${Math.round(session.medianReactionMs)}ms` : '—'}<small>中位反应</small></strong>
                <strong>{session.omissions}/{session.commissions}<small>漏答/误按</small></strong>
                <strong>{session.level} 级<small>当次难度</small></strong>
                <em>{session.score} 分</em>
              </div>
            )) : <p className="inline-empty">这个时间范围内还没有训练记录。</p>}
          </div>
        </>
      )}
    </section>
  )
}
