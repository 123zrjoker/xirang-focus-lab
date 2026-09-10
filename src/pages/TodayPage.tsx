import { getStreak, isSameLocalDay, taskLabel } from '../lib/metrics'
import { getRetestStatus } from '../lib/assessment'
import type { AppState, DailyPlan, DailyPlanMode, LaunchMode, Page, TaskType } from '../types'
import { ProfileRadar } from '../components/ProfileRadar'

interface TodayPageProps {
  state: AppState
  plan: DailyPlan
  onNavigate: (page: Page) => void
  onStartTask: (task: TaskType) => void
  onStartFocus: (minutes: number) => void
  onStartLaunch: (mode: LaunchMode) => void
  onChangePlanMode: (mode: DailyPlanMode) => void
}

export function TodayPage({ state, plan, onNavigate, onStartTask, onStartFocus, onStartLaunch, onChangePlanMode }: TodayPageProps) {
  const todaySessions = state.sessions.filter((item) => isSameLocalDay(item.completedAt))
  const todayFocus = state.focusSessions.filter((item) => isSameLocalDay(item.completedAt))
  const completedTypes = new Set(todaySessions.map((item) => item.taskType))
  const completedPlanCount = plan.items.filter((item) => completedTypes.has(item.taskType)).length
  const focusMinutes = Math.round(todayFocus.reduce((sum, item) => sum + item.actualDurationSec, 0) / 60)
  const practiceSeconds = todaySessions.reduce((sum, item) => sum + item.durationSec, 0)
    + todayFocus.reduce((sum, item) => sum + item.actualDurationSec, 0)
  const practiceMinutes = practiceSeconds ? Math.max(1, Math.round(practiceSeconds / 60)) : 0
  const dailyTarget = state.profile.dailyTargetMinutes
  const targetProgress = Math.min(100, (practiceMinutes / dailyTarget) * 100)
  const streak = getStreak(state)
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
  const planMinutes = plan.items.reduce((sum, item) => sum + item.estimatedMinutes, 0)
  const planTitle = plan.mode === 'quick'
    ? `快速计划 · 约 ${planMinutes} 分钟`
    : plan.mode === 'low-energy'
      ? `轻量计划 · 约 ${planMinutes} 分钟`
      : `${plan.intensity === 'light' ? '自动轻量计划' : '个性化计划'} · 约 ${planMinutes} 分钟`
  const retestStatus = getRetestStatus(state.assessments ?? [], state.sessions)
  const currentSlip = [...state.actionSlips].reverse().find((item) => item.status === 'current')
  const inboxCount = state.actionSlips.filter((item) => item.status === 'inbox').length
  const noteCount = state.personalNotes.length

  return (
    <section className="page-width inner-page today-page">
      <div className="today-greeting">
        <div><p>{dateLabel}</p><h1>今天，把一件事做好。</h1></div>
        <div className="today-streak"><span>{streak}</span><p>连续训练<small>每一天都算数</small></p></div>
      </div>

      {retestStatus.recommended && (
        <div className="retest-reminder card-surface">
          <span>阶段复测</span><div><strong>现在适合更新一次个人阶段记录</strong><small>{retestStatus.reason}</small></div><button type="button" onClick={() => onNavigate('assessment')}>开始复测 →</button>
        </div>
      )}

      <div className="today-launch-card card-surface">
        <div><p className="eyebrow">专注启动舱</p><h2>今天最重要的不是状态完美，而是开始一件事。</h2><p>任务明确就把第一步缩小；事情太多就先选出一件。随后可以直接进入现实专注。</p></div>
        <div>
          <button type="button" onClick={() => onStartLaunch('known-task')}><span>任务已经明确</span><strong>我知道要做什么</strong><i>→</i></button>
          <button type="button" onClick={() => onStartLaunch('choose-task')}><span>脑中事情太多</span><strong>帮我选出一件</strong><i>→</i></button>
        </div>
      </div>

      <button className="today-notes-teaser card-surface" type="button" onClick={() => onNavigate('notes')}>
        <span className="today-notes-icon">✎</span>
        <span className="today-notes-copy">
          <small>便签 · 笔记与待办</small>
          <strong>{currentSlip ? `正在推进：${currentSlip.title}` : inboxCount ? `${inboxCount} 项待办等你选择` : noteCount ? '想法已经收好，行动随时可以开始' : '先把脑中的事情放下来'}</strong>
          <em>{currentSlip?.nextStep ? `下一步：${currentSlip.nextStep}` : inboxCount ? '选一件设为“现在做”，其他事情继续留在这里' : '记录想法或待办，准备好时再开始'}</em>
          <span className="today-notes-meta"><i>笔记 {noteCount}</i><i>待办 {inboxCount + (currentSlip ? 1 : 0)}</i></span>
        </span>
        <span className="today-notes-action">打开便签 <i>→</i></span>
      </button>

      <div className="plan-mode-bar" aria-label="调整今日计划">
        <div><span>调整今天</span><small>切换后会重新生成今天的任务</small></div>
        <div>
          <button className={plan.mode === 'standard' ? 'active' : ''} type="button" onClick={() => onChangePlanMode('standard')}>正常计划</button>
          <button className={plan.mode === 'low-energy' ? 'active' : ''} type="button" onClick={() => onChangePlanMode('low-energy')}>今天状态不好</button>
          <button className={plan.mode === 'quick' ? 'active' : ''} type="button" onClick={() => onChangePlanMode('quick')}>时间只有 5 分钟</button>
        </div>
      </div>

      <div className="today-layout">
        <div className="daily-plan card-surface">
          <div className="card-header"><div><p className="eyebrow">本地智能推荐</p><h2>{planTitle}</h2></div><span>{completedPlanCount}/{plan.items.length}</span></div>
          <div className="daily-goal-progress">
            <div><span>每日投入目标</span><strong>{practiceMinutes}/{dailyTarget} 分钟</strong></div>
            <i><b style={{ width: `${targetProgress}%` }} /></i>
            <small>认知训练与现实专注合计</small>
          </div>
          <p className="plan-summary"><span>{plan.intensity === 'light' ? '轻' : '荐'}</span>{plan.summary}</p>
          <div className="plan-list">
            {plan.items.map((item, index) => {
              const done = completedTypes.has(item.taskType)
              return (
                <button key={item.taskType} type="button" className={done ? 'done' : ''} onClick={() => onStartTask(item.taskType)}>
                  <i>{done ? '✓' : index + 1}</i>
                  <span><strong>{taskLabel(item.taskType)}</strong><small>{item.reason}</small></span>
                  <em>{done ? '已完成' : `约 ${item.estimatedMinutes} 分钟`}</em><b>→</b>
                </button>
              )
            })}
          </div>
        </div>

        <div className="today-side">
          <div className="focus-cta card-surface">
            <p className="eyebrow light">建议现实专注 · {plan.focusMinutes} 分钟</p>
            <h2>{focusMinutes ? `今天已专注 ${focusMinutes} 分钟` : '把注意力带回一件真实任务'}</h2>
            <p>{plan.focusReason}</p>
            <button type="button" onClick={() => onStartFocus(plan.focusMinutes)}>开始 {plan.focusMinutes} 分钟专注 <span>→</span></button>
            <div className="focus-rings"><i /><i /><i /></div>
          </div>
          {state.attentionProfile && (
            <div className="mini-profile card-surface">
              <div><p className="eyebrow">初始画像</p><h3>从自己的基线出发</h3><button type="button" onClick={() => onNavigate('progress')}>查看完整数据 →</button></div>
              <ProfileRadar profile={state.attentionProfile} compact />
            </div>
          )}
        </div>
      </div>

      <div className="today-insight">
        <span>今日提示</span><p>一次训练的高分可能只是状态好；连续几周更稳定，才是值得关注的变化。</p>
      </div>
    </section>
  )
}
