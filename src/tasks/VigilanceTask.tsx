import { useEffect, useRef, useState } from 'react'
import { median, scoreResult, shuffle } from '../lib/metrics'
import { getVigilanceDifficulty } from '../lib/adaptiveDifficulty'
import type { TaskAdaptationState, TaskResult, TrainingSession, VigilanceVariant } from '../types'
import { PracticeResultCard, ResultCard, TaskFrame, TaskStartOptions, TaskVariantSelector, type TaskVariantOption } from '../components/TaskFrame'

interface SignalTrial {
  target: boolean
  angle: number
}

interface VigilanceTaskProps {
  level?: number
  initialVariant?: VigilanceVariant
  trialCountOverride?: number
  history?: TrainingSession[]
  adaptation?: TaskAdaptationState
  onComplete: (result: TaskResult) => void
  onExit?: () => void
}

const variantOptions: TaskVariantOption<VigilanceVariant>[] = [
  { value: 'adaptive', label: '稳定节奏', description: '跟随当前等级自动调整' },
  { value: 'fast', label: '快速节奏', description: '刺激与间隔缩短约 20%' },
  { value: 'rare', label: '稀有目标', description: '双环目标约占 10%' },
  { value: 'extended', label: '延长监测', description: '训练时长增加约 50%' },
]

export function VigilanceTask({
  level = 1,
  initialVariant = 'adaptive',
  trialCountOverride,
  history = [],
  adaptation,
  onComplete,
  onExit,
}: VigilanceTaskProps) {
  const baseDifficulty = getVigilanceDifficulty(level)
  const [variant, setVariant] = useState<VigilanceVariant>(initialVariant)
  const [phase, setPhase] = useState<'practice' | 'formal'>('formal')
  const displayTimeMs = variant === 'fast' ? Math.round(baseDifficulty.displayTimeMs * 0.8) : baseDifficulty.displayTimeMs
  const gapMs = variant === 'fast' ? Math.round(baseDifficulty.gapMs * 0.8) : baseDifficulty.gapMs
  const targetRatio = variant === 'rare' ? 0.1 : baseDifficulty.targetRatio
  const baseTrialCount = trialCountOverride ?? (variant === 'extended' ? Math.round(baseDifficulty.trialCount * 1.5) : baseDifficulty.trialCount)
  const trialCount = phase === 'practice' ? 10 : baseTrialCount
  const [trials, setTrials] = useState<SignalTrial[]>([])
  const [index, setIndex] = useState(-1)
  const [visible, setVisible] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TaskResult | null>(null)
  const [displayStats, setDisplayStats] = useState({ hits: 0, omissions: 0, falseAlarms: 0 })
  const stats = useRef({ hits: 0, omissions: 0, falseAlarms: 0 })
  const responded = useRef(false)
  const shownAt = useRef(0)
  const startedAt = useRef(0)
  const reactionTimes = useRef<number[]>([])

  function addStat(key: keyof typeof stats.current) {
    stats.current[key] += 1
    setDisplayStats({ ...stats.current })
  }

  function start(nextPhase: 'practice' | 'formal' = phase) {
    const count = nextPhase === 'practice' ? 10 : baseTrialCount
    const targetCount = nextPhase === 'practice' ? 3 : Math.max(3, Math.round(count * targetRatio))
    setPhase(nextPhase)
    setTrials(shuffle([
      ...Array.from({ length: targetCount }, (_, trialIndex) => ({ target: true, angle: trialIndex * 17 })),
      ...Array.from({ length: count - targetCount }, (_, trialIndex) => ({ target: false, angle: trialIndex * 23 })),
    ]))
    stats.current = { hits: 0, omissions: 0, falseAlarms: 0 }
    setDisplayStats({ ...stats.current })
    reactionTimes.current = []
    setIndex(0)
    setVisible(false)
    setResult(null)
    setRunning(true)
    startedAt.current = performance.now()
  }

  function changeVariant(next: VigilanceVariant) {
    setVariant(next)
    setPhase('formal')
    setTrials([])
    setIndex(-1)
    setVisible(false)
    setRunning(false)
    setResult(null)
  }

  useEffect(() => {
    if (!running || index < 0) return
    if (index >= trials.length) {
      const errors = stats.current.omissions + stats.current.falseAlarms
      const correct = trials.length - errors
      const durationSec = (performance.now() - startedAt.current) / 1000
      const base = {
        taskType: 'vigilance' as const,
        durationSec,
        accuracy: correct / trials.length,
        medianReactionMs: median(reactionTimes.current),
        omissions: stats.current.omissions,
        commissions: stats.current.falseAlarms,
        errors,
        level,
        metadata: {
          trialCount: trials.length,
          targetCount: trials.filter((trial) => trial.target).length,
          targetRatio: trials.filter((trial) => trial.target).length / trials.length,
          displayTimeMs,
          gapMs,
          variant,
          round: phase,
        },
      }
      setRunning(false)
      setResult({ ...base, score: scoreResult(base) })
      return
    }

    responded.current = false
    setVisible(true)
    shownAt.current = performance.now()
    const hideTimer = window.setTimeout(() => {
      if (trials[index].target && !responded.current) addStat('omissions')
      setVisible(false)
    }, displayTimeMs)
    const nextTimer = window.setTimeout(() => setIndex((current) => current + 1), displayTimeMs + gapMs)
    return () => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(nextTimer)
    }
  }, [index, level, running, trials])

  function respond() {
    if (!running || !visible || responded.current || !trials[index]) return
    responded.current = true
    if (trials[index].target) {
      addStat('hits')
      reactionTimes.current.push(performance.now() - shownAt.current)
    } else {
      addStat('falseAlarms')
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.code !== 'Space' || !running) return
      event.preventDefault()
      respond()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [index, running, trials, visible])

  const current = trials[index]
  const progress = index < 0 ? 0 : Math.min(100, ((index + 1) / trialCount) * 100)

  return (
    <TaskFrame
      eyebrow={phase === 'practice' ? '持续注意 · 不计分练习' : '持续注意 · 正式训练'}
      title="信号监测"
      description="只有看到双环信号时才点击。单环信号是干扰项。"
      onExit={onExit}
    >
      {result ? (
        phase === 'practice'
          ? <PracticeResultCard result={result} onRetry={() => start('practice')} onContinue={() => start('formal')} />
          : <ResultCard result={result} history={history} adaptation={adaptation} onRetry={() => start('formal')} onContinue={() => onComplete(result)} />
      ) : (
        <>
          {!running && <TaskVariantSelector value={variant} options={variantOptions} onChange={changeVariant} />}
          <div className="difficulty-parameters"><span>{phase === 'practice' ? '不计分练习' : `等级 ${level}`}</span><span>{trialCount} 次刺激</span><span>目标占比 {phase === 'practice' ? 30 : Math.round(targetRatio * 100)}%</span><span>显示 {displayTimeMs}ms</span><span>间隔 {gapMs}ms</span></div>
          <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
          <button className="radar-stage" type="button" onClick={respond} disabled={!running}>
            <span className="radar-sweep" />
            {running && visible && current && (
              <span className={`radar-signal ${current.target ? 'target' : ''}`} style={{ transform: `rotate(${current.angle}deg)` }}><i /></span>
            )}
            {!running && <span className="radar-label">等待监测</span>}
          </button>
          <div className="task-status-row small">
            <div><span>捕获</span><strong>{displayStats.hits}</strong></div>
            <div><span>漏过</span><strong>{displayStats.omissions}</strong></div>
            <div><span>误报</span><strong>{displayStats.falseAlarms}</strong></div>
          </div>
          {!running && (
            <TaskStartOptions
              onFormal={() => start('formal')}
              onPractice={() => start('practice')}
            />
          )}
        </>
      )}
    </TaskFrame>
  )
}
