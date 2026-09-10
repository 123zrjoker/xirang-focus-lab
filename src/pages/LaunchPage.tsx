import { useMemo, useState } from 'react'
import { LaunchWarmup } from '../components/LaunchWarmup'
import {
  createLaunchDraft,
  launchCategoryLabels,
  launchWarmupLabels,
  recommendLaunchWarmup,
  validateLaunchDetails,
} from '../lib/launchFlow'
import { recommendLaunchCandidate } from '../lib/taskSelection'
import type {
  ActionSlip,
  FocusLaunchSession,
  LaunchCandidate,
  LaunchLevel,
  LaunchMode,
  LaunchTaskCategory,
  LaunchWarmupResult,
} from '../types'

interface LaunchPageProps {
  launch: FocusLaunchSession | null
  actionSlips: ActionSlip[]
  onChange: (launch: FocusLaunchSession) => void
  onCreate: (mode: LaunchMode, taskName?: string, actionSlipId?: string) => void
  onCancel: () => void
  onStartFocus: (launch: FocusLaunchSession) => void
  onRemoveActionSlip: (id: string) => void
}

const categoryEntries = Object.entries(launchCategoryLabels) as [LaunchTaskCategory, string][]
const levelLabels: Record<LaunchLevel, string> = { 1: '低', 2: '中', 3: '高' }

function updated(launch: FocusLaunchSession, patch: Partial<FocusLaunchSession>) {
  return { ...launch, ...patch, updatedAt: new Date().toISOString() }
}

function LevelPicker({ value, onChange }: { value: LaunchLevel; onChange: (value: LaunchLevel) => void }) {
  return <div className="launch-level-picker">{([1, 2, 3] as LaunchLevel[]).map((item) => <button key={item} className={value === item ? 'active' : ''} type="button" onClick={() => onChange(item)}>{levelLabels[item]}</button>)}</div>
}

export function LaunchPage({
  launch,
  actionSlips,
  onChange,
  onCreate,
  onCancel,
  onStartFocus,
  onRemoveActionSlip,
}: LaunchPageProps) {
  const [message, setMessage] = useState('')
  const recommendation = useMemo(() => launch?.mode === 'choose-task' ? recommendLaunchCandidate(launch.candidates) : null, [launch])

  if (!launch) {
    return (
      <section className="page-width inner-page launch-entry-page">
        <div className="page-title-row launch-title-row">
          <div><p className="eyebrow">专注启动舱</p><h1>先开始，再让状态跟上。</h1><p>息壤只帮助你决定现在做什么，并把第一步缩小到可以立即行动。</p></div>
          <button className="button text-button" type="button" onClick={onCancel}>返回</button>
        </div>
        <div className="launch-mode-grid">
          <button type="button" className="launch-mode-card known" onClick={() => onCreate('known-task')}>
            <span>01</span><small>任务已经明确</small><h2>我知道要做什么</h2><p>把任务缩小成第一个动作，约 30 秒进入专注。</p><strong>从这件事开始 →</strong>
          </button>
          <button type="button" className="launch-mode-card choose" onClick={() => onCreate('choose-task')}>
            <span>02</span><small>脑中事情太多</small><h2>帮我选出一件</h2><p>最多放入三件事，用透明规则缩小选择。</p><strong>整理当前任务 →</strong>
          </button>
        </div>
        {actionSlips.length > 0 && (
          <div className="later-task-panel card-surface">
            <div><p className="eyebrow">行动便签 · 先放这里</p><h2>从已经记下的事情开始</h2></div>
            <div>{actionSlips.map((slip) => <article key={slip.id}><button type="button" onClick={() => onCreate('known-task', slip.title, slip.id)}>{slip.title}<span>拆成第一步 →</span></button><button type="button" onClick={() => onRemoveActionSlip(slip.id)}>移除</button></article>)}</div>
          </div>
        )}
      </section>
    )
  }
  const currentLaunch = launch

  if (launch.status === 'warming-up' && launch.warmupType !== 'none') {
    function finishWarmup(result?: LaunchWarmupResult) {
      onStartFocus(updated(currentLaunch, { warmupResult: result }))
    }
    return <LaunchWarmup type={launch.warmupType} onComplete={finishWarmup} onSkip={() => finishWarmup()} />
  }

  if (launch.mode === 'choose-task' && !launch.selectedCandidateId) {
    function changeCandidate(id: string, patch: Partial<LaunchCandidate>) {
      onChange(updated(currentLaunch, { candidates: currentLaunch.candidates.map((candidate) => candidate.id === id ? { ...candidate, ...patch } : candidate) }))
    }
    function selectCandidate(candidate: LaunchCandidate) {
      if (!candidate.title.trim()) return
      onChange(updated(currentLaunch, { selectedCandidateId: candidate.id, taskName: candidate.title.trim() }))
    }
    const filledCount = launch.candidates.filter((candidate) => candidate.title.trim()).length
    return (
      <section className="page-width inner-page launch-choice-page">
        <div className="launch-step-heading"><button type="button" onClick={onCancel}>← 取消</button><div><p className="eyebrow">第一步 · 缩小选择</p><h1>把脑中的事情，先放下三件。</h1><p>不做完整任务管理，只决定现在从哪一件开始。</p></div><span>最多 3 件</span></div>
        <div className="launch-candidates">
          {launch.candidates.map((candidate, index) => (
            <article className="card-surface" key={candidate.id}>
              <label>任务 {index + 1}</label>
              <input value={candidate.title} maxLength={120} placeholder={index === 0 ? '例如：修改明天要交的报告' : '写下另一件占据注意力的事'} onChange={(event) => changeCandidate(candidate.id, { title: event.target.value })} />
              <div className="candidate-dimensions">
                <span>重要性<LevelPicker value={candidate.importance} onChange={(value) => changeCandidate(candidate.id, { importance: value })} /></span>
                <span>紧迫性<LevelPicker value={candidate.urgency} onChange={(value) => changeCandidate(candidate.id, { urgency: value })} /></span>
                <span>容易启动<LevelPicker value={candidate.startability} onChange={(value) => changeCandidate(candidate.id, { startability: value })} /></span>
              </div>
              {candidate.title.trim() && <button className="candidate-direct" type="button" onClick={() => selectCandidate(candidate)}>直接选这件</button>}
            </article>
          ))}
        </div>
        <div className="launch-recommendation card-surface">
          <div><p className="eyebrow">本地透明推荐</p><h2>{filledCount < 2 ? '至少写下两件事' : recommendation?.candidate.title}</h2><p>{filledCount < 2 ? '如果其实只有一件任务，可以返回选择“我知道要做什么”。' : recommendation?.reason}</p></div>
          <button className="button primary" disabled={filledCount < 2 || !recommendation} type="button" onClick={() => recommendation && selectCandidate(recommendation.candidate)}>采用推荐并继续 →</button>
        </div>
      </section>
    )
  }

  if (launch.status === 'ready') {
    const recommendedWarmup = recommendLaunchWarmup(launch)
    const optionalWarmup = recommendedWarmup === 'none' ? 'visual' : recommendedWarmup
    return (
      <section className="page-width inner-page launch-ready-page">
        <div className="launch-ready-summary">
          <p className="eyebrow">准备进入现实专注</p><h1>{launch.taskName}</h1>
          <div><span>第一个动作<strong>{launch.firstAction}</strong></span><span>本轮完成标准<strong>{launch.completionDefinition}</strong></span><span>计划时长<strong>{launch.plannedDurationMin} 分钟</strong></span></div>
        </div>
        <div className="launch-ready-actions card-surface">
          <p className="eyebrow">启动方式</p><h2>{recommendedWarmup === 'none' ? '现在直接开始，阻力最小。' : `建议先做一次${launchWarmupLabels[recommendedWarmup]}。`}</h2>
          <p>热身只用于进入状态，不计分、不升级，也不会影响正式训练历史。</p>
          {recommendedWarmup !== 'none' && <button className="button primary large" type="button" onClick={() => onChange(updated(launch, { status: 'warming-up', warmupType: recommendedWarmup }))}>{launchWarmupLabels[recommendedWarmup]} <span>→</span></button>}
          <button className={recommendedWarmup === 'none' ? 'button primary large' : 'button secondary'} type="button" onClick={() => onStartFocus(updated(launch, { warmupType: 'none' }))}>跳过热身，直接开始</button>
          {recommendedWarmup === 'none' && <button className="button text-button" type="button" onClick={() => onChange(updated(launch, { status: 'warming-up', warmupType: optionalWarmup }))}>也可以试试 {launchWarmupLabels[optionalWarmup]}</button>}
          <button className="button text-button" type="button" onClick={() => onChange(updated(launch, { status: 'draft' }))}>返回修改</button>
        </div>
      </section>
    )
  }

  function finishDetails() {
    const errors = validateLaunchDetails(currentLaunch)
    if (errors.length) {
      setMessage(errors[0])
      return
    }
    setMessage('')
    onChange(updated(currentLaunch, { status: 'ready', warmupType: recommendLaunchWarmup(currentLaunch) }))
  }

  return (
    <section className="page-width inner-page launch-detail-page">
      <div className="launch-step-heading"><button type="button" onClick={() => launch.mode === 'choose-task' ? onChange(updated(launch, { selectedCandidateId: undefined, taskName: '' })) : onCancel()}>← 返回</button><div><p className="eyebrow">第二步 · 缩小行动</p><h1>不要完成整件事，<br />只确定第一个动作。</h1><p>动作越具体，开始时需要做的决定就越少。</p></div><span>约 30 秒</span></div>
      <div className="launch-detail-layout">
        <div className="launch-detail-form card-surface">
          <label>这次真正要推进的任务<input value={launch.taskName} maxLength={120} placeholder="例如：修改明天要交的报告" onChange={(event) => onChange(updated(launch, { taskName: event.target.value }))} /></label>
          <label>任务类型<select value={launch.taskCategory} onChange={(event) => onChange(updated(launch, { taskCategory: event.target.value as LaunchTaskCategory }))}>{categoryEntries.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>第一个可以立刻执行的动作<input value={launch.firstAction} maxLength={200} placeholder="例如：打开报告文档，找到结论部分" onChange={(event) => onChange(updated(launch, { firstAction: event.target.value }))} /><small>试着用“打开、找到、写下、修改、完成”开头。</small></label>
          <label>这一轮结束时，希望得到什么<input value={launch.completionDefinition} maxLength={300} placeholder="例如：改完结论部分的前三段" onChange={(event) => onChange(updated(launch, { completionDefinition: event.target.value }))} /></label>
        </div>
        <div className="launch-detail-settings card-surface">
          <label>计划时长</label><div className="launch-duration-row">{[15, 25, 45].map((minutes) => <button key={minutes} className={launch.plannedDurationMin === minutes ? 'active' : ''} type="button" onClick={() => onChange(updated(launch, { plannedDurationMin: minutes }))}>{minutes}<small>分钟</small></button>)}</div>
          <label>当前精力<LevelPicker value={launch.energyBefore} onChange={(value) => onChange(updated(launch, { energyBefore: value }))} /></label>
          <label>开始这件事的抗拒程度<LevelPicker value={launch.resistanceBefore} onChange={(value) => onChange(updated(launch, { resistanceBefore: value }))} /></label>
          {message && <p className="launch-form-message">{message}</p>}
          <button className="button primary large" type="button" onClick={finishDetails}>确认第一步，继续 →</button>
          <small>默认值已经足够使用，不需要精确评价自己的状态。</small>
        </div>
      </div>
    </section>
  )
}
