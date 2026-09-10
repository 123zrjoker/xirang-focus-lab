import { useEffect, useRef, useState } from 'react'
import {
  clearActiveFocus,
  createFocusSession,
  loadActiveFocus,
  saveActiveFocus,
} from '../lib/storage'
import {
  playCompletionSound,
  prepareFeedbackAudio,
  showBreakCompleteNotification,
  showFocusCompleteNotification,
} from '../lib/feedback'
import { getNextFocusStep } from '../lib/focusFlow'
import type {
  ActiveFocusSession,
  DistractionReason,
  FocusDistraction,
  FocusEndReason,
  FocusLaunchContext,
  FocusMode,
  FocusSession,
} from '../types'

interface FocusPageProps {
  preferredMinutes: number
  initialMinutes?: number
  initialTaskName?: string
  actionSlipId?: string
  dailyTargetMinutes: number
  todayFocusMinutes: number
  soundEnabled: boolean
  desktopNotificationsEnabled: boolean
  launchContext?: FocusLaunchContext
  onSave: (session: FocusSession) => void
  onAddActionSlip: (title: string) => void
  onReturnToday: () => void
}

const reasonLabels: Record<DistractionReason, string> = {
  phone: '手机',
  environment: '环境',
  difficulty: '任务太难',
  fatigue: '疲劳',
  other: '其他',
}

const endReasonLabels: Record<FocusEndReason, string> = {
  completed: '完成',
  interrupted: '被打断',
  abandoned: '主动放弃',
}

const emptyChecks = {
  phoneAway: false,
  workspaceReady: false,
  goalClear: false,
}

function remainingFromTimestamp(session: ActiveFocusSession) {
  if (!session.endAt) return session.remainingSec
  return Math.max(0, Math.ceil((Date.parse(session.endAt) - Date.now()) / 1000))
}

function clockText(seconds: number) {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0')
  const remainder = String(seconds % 60).padStart(2, '0')
  return `${minutes}:${remainder}`
}

function DailyFocusProgress({ todayMinutes, targetMinutes }: { todayMinutes: number; targetMinutes: number }) {
  const progress = Math.min(100, (todayMinutes / Math.max(1, targetMinutes)) * 100)
  return (
    <div className="focus-target-strip">
      <div><span>今日现实专注</span><strong>{todayMinutes} 分钟</strong><small>每日投入目标 {targetMinutes} 分钟</small></div>
      <i><b style={{ width: `${progress}%` }} /></i>
    </div>
  )
}

function PomodoroProgress({ cycle, completed = false }: { cycle: number; completed?: boolean }) {
  return (
    <div className="pomodoro-progress" aria-label={`当前是第 ${cycle} 个番茄，共 4 个`}>
      <div>{[1, 2, 3, 4].map((item) => <i key={item} className={item < cycle || (completed && item === cycle) ? 'done' : item === cycle ? 'current' : ''} />)}</div>
      <span>第 {cycle}/4 个番茄</span>
    </div>
  )
}

function ParkingList({
  items,
  onCopy,
  onUseAsTask,
}: {
  items: FocusDistraction[]
  onCopy: () => void
  onUseAsTask?: (note: string) => void
}) {
  if (!items.length) return null
  return (
    <div className="saved-parking-list">
      <div><strong>分心停车场</strong><button type="button" onClick={onCopy}>复制全部</button></div>
      {items.map((item) => (
        <article key={item.id}>
          <span>{reasonLabels[item.reason]}</span>
          <p>{item.note}</p>
          {onUseAsTask && <button type="button" onClick={() => onUseAsTask(item.note)}>放入行动便签</button>}
        </article>
      ))}
    </div>
  )
}

export function FocusPage({
  preferredMinutes,
  initialMinutes,
  initialTaskName,
  actionSlipId,
  dailyTargetMinutes,
  todayFocusMinutes,
  soundEnabled,
  desktopNotificationsEnabled,
  launchContext,
  onSave,
  onAddActionSlip,
  onReturnToday,
}: FocusPageProps) {
  const [active, setActive] = useState<ActiveFocusSession | null>(() => loadActiveFocus())
  const [taskName, setTaskName] = useState(active?.taskName ?? launchContext?.taskName ?? initialTaskName ?? '')
  const [focusActionSlipId, setFocusActionSlipId] = useState(active?.actionSlipId ?? launchContext?.actionSlipId ?? actionSlipId)
  const [minutes, setMinutes] = useState(active?.plannedDurationMin ?? launchContext?.plannedDurationMin ?? initialMinutes ?? preferredMinutes)
  const [focusMode, setFocusMode] = useState<FocusMode>(active?.focusMode ?? 'free')
  const [displayRemaining, setDisplayRemaining] = useState(active ? remainingFromTimestamp(active) : 0)
  const [parkingNote, setParkingNote] = useState('')
  const [distractionReason, setDistractionReason] = useState<DistractionReason>('other')
  const [completed, setCompleted] = useState<FocusSession | null>(null)
  const [showStopMenu, setShowStopMenu] = useState(false)
  const [resumeAfterStopCancel, setResumeAfterStopCancel] = useState(false)
  const [message, setMessage] = useState('')
  const handledPhase = useRef('')

  useEffect(() => {
    if (active) saveActiveFocus(active)
    else clearActiveFocus()
  }, [active])

  useEffect(() => {
    if (active) return
    if (launchContext) {
      setTaskName(launchContext.taskName)
      setMinutes(launchContext.plannedDurationMin)
      setFocusActionSlipId(launchContext.actionSlipId)
      return
    }
    if (initialTaskName) setTaskName(initialTaskName)
    if (initialMinutes) setMinutes(initialMinutes)
    setFocusActionSlipId(actionSlipId)
  }, [active, actionSlipId, initialMinutes, initialTaskName, launchContext])

  useEffect(() => {
    if (!active || !['preparing', 'running', 'break'].includes(active.status)) {
      if (active) setDisplayRemaining(active.remainingSec)
      return
    }

    const session = active
    const phaseKey = `${session.id}:${session.status}:${session.endAt ?? ''}`
    function finishPhase() {
      if (handledPhase.current === phaseKey) return
      handledPhase.current = phaseKey
      if (session.status === 'preparing') {
        beginFocus(session)
      } else if (session.status === 'running') {
        completeFocus(session)
      } else if (session.status === 'break') {
        setActive({ ...session, status: 'break-ready', remainingSec: 0, endAt: undefined })
        if (soundEnabled) playCompletionSound()
        if (desktopNotificationsEnabled) showBreakCompleteNotification()
      }
    }

    function tick() {
      const remaining = remainingFromTimestamp(session)
      setDisplayRemaining(remaining)
      if (remaining <= 0) finishPhase()
    }

    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [active, desktopNotificationsEnabled, soundEnabled])

  useEffect(() => {
    function handleVisibility() {
      if (!document.hidden) return
      setActive((current) => current?.status === 'running'
        ? { ...current, pageLeaveCount: current.pageLeaveCount + 1 }
        : current)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  function startPreparation(name = taskName, duration = minutes, round = 1, mode = focusMode, pomodoroCycle = 1, source?: FocusSession | ActiveFocusSession) {
    const cleanName = name.trim()
    if (!cleanName) return
    const safeMinutes = mode === 'pomodoro' ? 25 : Math.min(180, Math.max(1, Math.round(duration)))
    if (soundEnabled) prepareFeedbackAudio()
    const next: ActiveFocusSession = {
      version: 1,
      id: crypto.randomUUID(),
      status: 'preparing',
      taskName: cleanName,
      plannedDurationMin: safeMinutes,
      remainingSec: 30,
      elapsedFocusSec: 0,
      endAt: new Date(Date.now() + 30_000).toISOString(),
      distractions: [],
      pageLeaveCount: 0,
      completionRate: 100,
      subjectiveFocus: 4,
      preparationChecks: { ...emptyChecks },
      round,
      focusMode: mode,
      pomodoroCycle,
      launchId: source?.launchId ?? launchContext?.launchId,
      taskCategory: source?.taskCategory ?? launchContext?.taskCategory,
      firstAction: source?.firstAction ?? launchContext?.firstAction,
      completionDefinition: source?.completionDefinition ?? launchContext?.completionDefinition,
      energyBefore: source?.energyBefore ?? launchContext?.energyBefore,
      resistanceBefore: source?.resistanceBefore ?? launchContext?.resistanceBefore,
      actionSlipId: source?.actionSlipId ?? launchContext?.actionSlipId ?? focusActionSlipId,
      nextStep: source?.nextStep,
    }
    handledPhase.current = ''
    setMinutes(safeMinutes)
    setFocusMode(mode)
    setTaskName(cleanName)
    setParkingNote('')
    setDistractionReason('other')
    setCompleted(null)
    setActive(next)
    setDisplayRemaining(30)
  }

  function beginFocus(session: ActiveFocusSession) {
    const durationSec = session.plannedDurationMin * 60
    setActive({
      ...session,
      status: 'running',
      remainingSec: durationSec,
      elapsedFocusSec: 0,
      endAt: new Date(Date.now() + durationSec * 1000).toISOString(),
    })
    setDisplayRemaining(durationSec)
  }

  function completeFocus(session: ActiveFocusSession) {
    const plannedSeconds = session.plannedDurationMin * 60
    setActive({
      ...session,
      status: 'review',
      remainingSec: 0,
      elapsedFocusSec: plannedSeconds,
      endAt: undefined,
      endReason: 'completed',
      completionRate: 100,
    })
    if (soundEnabled) playCompletionSound()
    if (desktopNotificationsEnabled) showFocusCompleteNotification(session.taskName)
  }

  function pauseFocus() {
    if (!active || active.status !== 'running') return
    const remaining = remainingFromTimestamp(active)
    const segmentElapsed = Math.max(0, active.remainingSec - remaining)
    setActive({
      ...active,
      status: 'paused',
      remainingSec: remaining,
      elapsedFocusSec: active.elapsedFocusSec + segmentElapsed,
      endAt: undefined,
    })
    setDisplayRemaining(remaining)
  }

  function resumeFocus() {
    if (!active || active.status !== 'paused') return
    handledPhase.current = ''
    setActive({
      ...active,
      status: 'running',
      endAt: new Date(Date.now() + active.remainingSec * 1000).toISOString(),
    })
  }

  function requestStop() {
    if (!active || !['running', 'paused'].includes(active.status)) return
    const wasRunning = active.status === 'running'
    if (wasRunning) {
      const remaining = remainingFromTimestamp(active)
      setActive({
        ...active,
        status: 'paused',
        remainingSec: remaining,
        elapsedFocusSec: active.elapsedFocusSec + Math.max(0, active.remainingSec - remaining),
        endAt: undefined,
      })
      setDisplayRemaining(remaining)
    }
    setResumeAfterStopCancel(wasRunning)
    setShowStopMenu(true)
  }

  function cancelStop() {
    setShowStopMenu(false)
    if (resumeAfterStopCancel) window.setTimeout(resumeFocus, 0)
  }

  function finishEarly(reason: FocusEndReason) {
    if (!active) return
    const completionRate = reason === 'completed' ? 100 : reason === 'interrupted' ? 50 : 0
    setActive({
      ...active,
      status: 'review',
      endAt: undefined,
      endReason: reason,
      completionRate,
    })
    setShowStopMenu(false)
  }

  function addDistraction() {
    if (!active || !['running', 'paused'].includes(active.status)) return
    const note = parkingNote.trim() || `${reasonLabels[distractionReason]}分心`
    const distraction: FocusDistraction = {
      id: crypto.randomUUID(),
      note,
      reason: distractionReason,
      createdAt: new Date().toISOString(),
    }
    setActive({ ...active, distractions: [...active.distractions, distraction] })
    setParkingNote('')
    setMessage(`已记录为“${reasonLabels[distractionReason]}”，结束后可以继续处理。`)
  }

  async function copyParking(items: FocusDistraction[]) {
    try {
      const text = items.map((item) => `【${reasonLabels[item.reason]}】${item.note}`).join('\n')
      await navigator.clipboard.writeText(text)
      setMessage('分心停车场内容已复制。')
    } catch {
      setMessage('复制失败，请手动选择文本。')
    }
  }

  function saveReview() {
    if (!active || active.status !== 'review') return
    const session = createFocusSession({
      taskName: active.taskName,
      plannedDurationMin: active.plannedDurationMin,
      actualDurationSec: Math.max(0, active.elapsedFocusSec),
      completionRate: active.completionRate,
      distractionCount: active.distractions.length,
      pageLeaveCount: active.pageLeaveCount,
      subjectiveFocus: active.subjectiveFocus,
      endReason: active.endReason ?? 'completed',
      distractions: active.distractions,
      round: active.round,
      focusMode: active.focusMode,
      pomodoroCycle: active.pomodoroCycle,
      launchId: active.launchId,
      taskCategory: active.taskCategory,
      firstAction: active.firstAction,
      completionDefinition: active.completionDefinition,
      energyBefore: active.energyBefore,
      resistanceBefore: active.resistanceBefore,
      actionSlipId: active.actionSlipId,
      nextStep: active.nextStep,
    })
    onSave(session)
    setCompleted(session)
    setActive(null)
    setMessage('')
  }

  function discardReview() {
    if (!window.confirm('放弃后，本次专注和分心停车场内容都不会保存。是否继续？')) return
    setActive(null)
    setCompleted(null)
    setTaskName('')
    setMessage('')
  }

  function startBreak(session: FocusSession) {
    const nextStep = getNextFocusStep(session.focusMode, session.pomodoroCycle, session.endReason)
    const breakMinutes = nextStep.breakMinutes
    const breakSeconds = breakMinutes * 60
    const next: ActiveFocusSession = {
      version: 1,
      id: crypto.randomUUID(),
      status: 'break',
      taskName: session.taskName,
      plannedDurationMin: session.plannedDurationMin,
      remainingSec: breakSeconds,
      elapsedFocusSec: 0,
      endAt: new Date(Date.now() + breakSeconds * 1000).toISOString(),
      distractions: [],
      pageLeaveCount: 0,
      completionRate: 100,
      subjectiveFocus: 4,
      preparationChecks: { ...emptyChecks },
      round: session.round + 1,
      focusMode: session.focusMode,
      pomodoroCycle: nextStep.nextPomodoroCycle,
      breakKind: nextStep.breakKind,
      launchId: session.launchId,
      taskCategory: session.taskCategory,
      firstAction: session.firstAction,
      completionDefinition: session.completionDefinition,
      energyBefore: session.energyBefore,
      resistanceBefore: session.resistanceBefore,
      actionSlipId: session.actionSlipId,
      nextStep: session.nextStep,
    }
    handledPhase.current = ''
    setCompleted(null)
    setActive(next)
    setDisplayRemaining(breakSeconds)
  }

  function startNextRound(name: string, duration: number, round: number, mode: FocusMode, pomodoroCycle: number, source?: FocusSession | ActiveFocusSession) {
    setCompleted(null)
    setFocusMode(mode)
    startPreparation(name, duration, round, mode, pomodoroCycle, source)
  }

  function saveAsActionSlip(note: string) {
    onAddActionSlip(note)
    setMessage('已把停车场内容放入行动便签。')
  }

  const circumference = 2 * Math.PI * 128

  if (active?.status === 'preparing') {
    const checks = active.preparationChecks
    const checkedCount = Object.values(checks).filter(Boolean).length
    return (
      <section className="focus-preparation page-width">
        <div className="preparation-copy">
          <p className="eyebrow">30 秒开始仪式 · {active.focusMode === 'pomodoro' ? `第 ${active.pomodoroCycle} 个番茄` : `第 ${active.round} 轮`}</p>
          <h1>先把环境准备好，<br />再把计时交给自己。</h1>
          <p>倒计时结束后会自动进入专注，也可以准备好后立即开始。</p>
          {active.focusMode === 'pomodoro' && <PomodoroProgress cycle={active.pomodoroCycle} />}
          <strong>{clockText(displayRemaining)}</strong>
        </div>
        <div className="preparation-card card-surface">
          <h2>{active.taskName}</h2>
          <p>{active.plannedDurationMin} 分钟专注</p>
          {active.firstAction && <div className="focus-launch-brief"><span>先做这一步<strong>{active.firstAction}</strong></span>{active.completionDefinition && <span>本轮完成标准<strong>{active.completionDefinition}</strong></span>}</div>}
          <div className="preparation-checklist">
            {[
              ['phoneAway', '手机已经放到视线以外'],
              ['workspaceReady', '桌面只保留需要的材料'],
              ['goalClear', '我知道这一轮结束时要得到什么'],
            ].map(([key, label]) => {
              const checkKey = key as keyof typeof checks
              return (
                <button
                  key={key}
                  type="button"
                  className={checks[checkKey] ? 'done' : ''}
                  onClick={() => setActive({ ...active, preparationChecks: { ...checks, [checkKey]: !checks[checkKey] } })}
                >
                  <i>{checks[checkKey] ? '✓' : ''}</i><span>{label}</span>
                </button>
              )
            })}
          </div>
          <div className="preparation-progress"><i style={{ width: `${(checkedCount / 3) * 100}%` }} /></div>
          <div className="button-row">
            <button className="button secondary" type="button" onClick={() => setActive(null)}>取消</button>
            <button className="button primary" type="button" onClick={() => beginFocus(active)}>{checkedCount === 3 ? '准备好了，开始' : '跳过等待，立即开始'}</button>
          </div>
        </div>
      </section>
    )
  }

  if (active?.status === 'review') {
    const breakdown = Object.entries(reasonLabels).map(([reason, label]) => ({
      reason: reason as DistractionReason,
      label,
      count: active.distractions.filter((item) => item.reason === reason).length,
    })).filter((item) => item.count > 0)
    return (
      <section className="focus-review page-width enhanced-review">
        <div>
          <p className="eyebrow">专注复盘 · {endReasonLabels[active.endReason ?? 'completed']}</p>
          <h1>刚才这段时间，<br />实际发生了什么？</h1>
          <p>诚实记录比追求满分更有价值。</p>
          {active.focusMode === 'pomodoro' && <PomodoroProgress cycle={active.pomodoroCycle} completed={active.endReason === 'completed'} />}
          <ParkingList items={active.distractions} onCopy={() => copyParking(active.distractions)} />
        </div>
        <div className="review-card card-surface">
          <div className="review-title-line"><h2>{active.taskName}</h2><span>{endReasonLabels[active.endReason ?? 'completed']}</span></div>
          <label>任务完成度 <strong>{active.completionRate}%</strong></label>
          <input type="range" min="0" max="100" step="25" value={active.completionRate} onChange={(event) => setActive({ ...active, completionRate: Number(event.target.value) })} />
          <label>主观专注感 <strong>{active.subjectiveFocus}/5</strong></label>
          <div className="rating-row">{[1, 2, 3, 4, 5].map((rating) => <button key={rating} className={active.subjectiveFocus === rating ? 'active' : ''} onClick={() => setActive({ ...active, subjectiveFocus: rating })}>{rating}</button>)}</div>
          <div className="review-metrics">
            <span>实际专注<strong>{Math.max(1, Math.round(active.elapsedFocusSec / 60))} 分钟</strong></span>
            <span>离开页面<strong>{active.pageLeaveCount} 次</strong></span>
          </div>
          {breakdown.length > 0 && <div className="distraction-breakdown">{breakdown.map((item) => <span key={item.reason}>{item.label}<strong>{item.count}</strong></span>)}</div>}
          <label className="next-step-label">如果还没完成，下次从哪里继续？ <small>可跳过</small></label>
          <input className="next-step-input" value={active.nextStep ?? ''} maxLength={300} onChange={(event) => setActive({ ...active, nextStep: event.target.value })} placeholder="例如：从数据结构部分继续" />
          <div className="button-row"><button className="button secondary" type="button" onClick={discardReview}>放弃记录</button><button className="button primary" type="button" onClick={saveReview}>保存本次专注</button></div>
        </div>
      </section>
    )
  }

  if (active?.status === 'break' || active?.status === 'break-ready') {
    const ready = active.status === 'break-ready'
    const breakMinutes = active.breakKind === 'long' ? 15 : 5
    return (
      <section className="focus-break page-width">
        <span className="break-orbit"><i>{ready ? '✓' : '休'}</i></span>
        <p className="eyebrow">{active.focusMode === 'pomodoro' ? `${active.breakKind === 'long' ? '番茄钟长休息' : '番茄钟短休息'} · ${breakMinutes} 分钟` : `连续专注 · 下一轮是第 ${active.round} 轮`}</p>
        <h1>{ready ? '休息结束，可以继续。' : active.breakKind === 'long' ? '四个番茄完成，充分休息。' : '让注意力真正休息一下。'}</h1>
        {active.focusMode === 'pomodoro' && <PomodoroProgress cycle={active.pomodoroCycle} />}
        <strong>{ready ? '00:00' : clockText(displayRemaining)}</strong>
        <p>下一轮仍然专注于“{active.taskName}”。休息时可以起身、喝水或看远处。</p>
        <div className="button-row">
          {!ready && <button className="button secondary" type="button" onClick={() => setActive({ ...active, status: 'break-ready', remainingSec: 0, endAt: undefined })}>跳过休息</button>}
          <button className="button primary" type="button" onClick={() => startNextRound(active.taskName, active.plannedDurationMin, active.round, active.focusMode, active.pomodoroCycle, active)}>{active.focusMode === 'pomodoro' ? `开始第 ${active.pomodoroCycle} 个番茄` : '开始下一轮'}</button>
          <button className="button text-button" type="button" onClick={() => { setActive(null); setTaskName('') }}>结束连续专注</button>
        </div>
      </section>
    )
  }

  if (active?.status === 'running' || active?.status === 'paused') {
    const progress = 1 - displayRemaining / (active.plannedDurationMin * 60)
    return (
      <section className="focus-session page-width">
        <div className="focus-session-top"><span>{active.focusMode === 'pomodoro' ? `番茄 ${active.pomodoroCycle}/4` : `第 ${active.round} 轮`} · 正在专注</span><strong>{active.taskName}</strong><button type="button" onClick={requestStop}>提前结束</button></div>
        {active.firstAction && <div className="focus-current-action"><span>现在只做</span><strong>{active.firstAction}</strong></div>}
        <DailyFocusProgress todayMinutes={todayFocusMinutes} targetMinutes={dailyTargetMinutes} />
        {active.focusMode === 'pomodoro' && <PomodoroProgress cycle={active.pomodoroCycle} />}
        <div className="focus-clock">
          <svg viewBox="0 0 300 300"><circle className="clock-bg" cx="150" cy="150" r="128" /><circle className="clock-value" cx="150" cy="150" r="128" style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - progress) }} /></svg>
          <div><span>{active.status === 'paused' ? '已暂停' : '保持在这一件事上'}</span><strong>{clockText(displayRemaining)}</strong><small>结束时间由系统时钟校准</small></div>
        </div>
        <div className="focus-controls enhanced-controls">
          <button className="round-control" type="button" onClick={active.status === 'paused' ? resumeFocus : pauseFocus}>{active.status === 'paused' ? '继续' : '暂停'}</button>
          <div className="distraction-area">
            <div className="distraction-reasons">
              {(Object.keys(reasonLabels) as DistractionReason[]).map((reason) => <button key={reason} type="button" className={distractionReason === reason ? 'active' : ''} onClick={() => setDistractionReason(reason)}>{reasonLabels[reason]}</button>)}
            </div>
            <div className="distraction-parking">
              <input value={parkingNote} onChange={(event) => setParkingNote(event.target.value)} placeholder="突然想到什么？先放在这里" onKeyDown={(event) => { if (event.key === 'Enter') addDistraction() }} />
              <button type="button" onClick={addDistraction}>记录分心 +</button>
            </div>
          </div>
        </div>
        {message && <p className="parking-count">{message}</p>}
        {active.distractions.length > 0 && <p className="parking-count">已暂存 {active.distractions.length} 个想法，结束后可复制或转成下次任务。</p>}
        {showStopMenu && (
          <div className="stop-reason-dialog" role="dialog" aria-modal="true" aria-label="选择提前结束原因">
            <div className="card-surface">
              <p className="eyebrow">提前结束</p><h2>这次为什么现在结束？</h2><p>选择原因后仍会进入复盘，你可以决定是否保存。</p>
              <div>
                <button type="button" onClick={() => finishEarly('completed')}><strong>已完成任务</strong><small>目标提前完成</small></button>
                <button type="button" onClick={() => finishEarly('interrupted')}><strong>被打断</strong><small>环境或其他事情中断</small></button>
                <button type="button" onClick={() => finishEarly('abandoned')}><strong>主动放弃</strong><small>决定停止本轮</small></button>
              </div>
              <button className="button secondary full" type="button" onClick={cancelStop}>取消，继续专注</button>
            </div>
          </div>
        )}
      </section>
    )
  }

  if (completed) {
    const completedTomato = completed.focusMode === 'pomodoro' && completed.endReason === 'completed'
    const nextStep = getNextFocusStep(completed.focusMode, completed.pomodoroCycle, completed.endReason)
    const breakMinutes = nextStep.breakMinutes
    const nextCycle = nextStep.nextPomodoroCycle
    return (
      <section className="focus-complete page-width enhanced-complete">
        <span className="completion-orbit"><i>✓</i></span>
        <p className="eyebrow">{completed.focusMode === 'pomodoro' ? `第 ${completed.pomodoroCycle} 个番茄` : `第 ${completed.round} 轮`}已记录 · {endReasonLabels[completed.endReason]}</p>
        <h1>你刚刚完成了一段<br />属于自己的时间。</h1>
        <p>今天累计现实专注 {todayFocusMinutes} 分钟。接下来可以休息，也可以直接继续。</p>
        {completed.focusMode === 'pomodoro' && <PomodoroProgress cycle={completed.pomodoroCycle} completed={completedTomato} />}
        {completed.nextStep && <div className="focus-next-step"><span>下次从这里继续</span><strong>{completed.nextStep}</strong></div>}
        <ParkingList items={completed.distractions} onCopy={() => copyParking(completed.distractions)} onUseAsTask={saveAsActionSlip} />
        {message && <p className="completion-message">{message}</p>}
        <div className="continuous-actions">
          <button className="button primary" type="button" onClick={() => startBreak(completed)}>休息 {breakMinutes} 分钟</button>
          <button className="button secondary" type="button" onClick={() => startNextRound(completed.taskName, completed.plannedDurationMin, completed.round + 1, completed.focusMode, nextCycle, completed)}>{completed.focusMode === 'pomodoro' ? completedTomato ? `直接开始第 ${nextCycle} 个` : '重试当前番茄' : '直接下一轮'}</button>
          <button className="button text-button" type="button" onClick={onReturnToday}>完成并返回今日</button>
        </div>
      </section>
    )
  }

  return (
    <section className="focus-setup page-width inner-page enhanced-focus-setup">
      <div className="focus-setup-copy">
        <p className="eyebrow">现实专注室</p><h1>给下一段时间，<br />一个清楚的去处。</h1>
        <p>写下唯一目标。开始前会有 30 秒准备时间，刷新或误关闭页面后也可以恢复。</p>
        <DailyFocusProgress todayMinutes={todayFocusMinutes} targetMinutes={dailyTargetMinutes} />
      </div>
      <div className="focus-setup-card card-surface">
        <label>专注方式</label>
        <div className="focus-mode-selector">
          <button type="button" className={focusMode === 'free' ? 'active' : ''} onClick={() => { setFocusMode('free'); setMinutes(preferredMinutes) }}><i className="free-mode-icon">◷</i><span><strong>自由专注</strong><small>自定义专注时长和连续轮次</small></span></button>
          <button type="button" className={focusMode === 'pomodoro' ? 'active pomodoro' : 'pomodoro'} onClick={() => { setFocusMode('pomodoro'); setMinutes(25) }}><i className="tomato-mode-icon" /><span><strong>番茄钟</strong><small>25 分钟专注，自动安排休息</small></span></button>
        </div>
        <label>这次只做什么？</label>
        <input className="goal-input" value={taskName} readOnly={Boolean(launchContext)} onChange={(event) => setTaskName(event.target.value)} placeholder="例如：读完论文第三节并写下三条笔记" />
        {launchContext && <div className="focus-launch-brief setup"><span>第一个动作<strong>{launchContext.firstAction}</strong></span><span>本轮完成标准<strong>{launchContext.completionDefinition}</strong></span></div>}
        {focusMode === 'free' ? (
          <>
            <label>专注时长</label>
            <div className="duration-options">{[5, 15, 25, 45, 60].map((value) => <button key={value} className={minutes === value ? 'active' : ''} onClick={() => setMinutes(value)}>{value}<small>分钟</small></button>)}</div>
            <label className="custom-duration-label">自定义时长 <span>1～180 分钟</span></label>
            <div className="custom-duration"><button type="button" onClick={() => setMinutes(Math.max(1, minutes - 5))}>−</button><input type="number" min="1" max="180" value={minutes} onChange={(event) => { const value = Number(event.target.value); if (value) setMinutes(Math.min(180, Math.max(1, value))) }} /><span>分钟</span><button type="button" onClick={() => setMinutes(Math.min(180, minutes + 5))}>＋</button></div>
          </>
        ) : (
          <div className="pomodoro-protocol">
            <PomodoroProgress cycle={1} />
            <div><span><strong>25</strong><small>分钟专注</small></span><i>→</i><span><strong>5</strong><small>分钟短休息</small></span><i>× 4</i><span><strong>15</strong><small>分钟长休息</small></span></div>
            <p>每完成 4 个番茄进入一次长休息；被打断或放弃时不会推进番茄计数。</p>
          </div>
        )}
        {message && <p className="setup-message">{message}</p>}
        <button className="button primary large full" type="button" onClick={() => startPreparation()} disabled={!taskName.trim()}>{focusMode === 'pomodoro' ? '开始第 1 个番茄 →' : '进入 30 秒准备 →'}</button>
      </div>
    </section>
  )
}
