import { useEffect, useMemo, useRef, useState } from 'react'
import { median, scoreResult, shuffle } from '../lib/metrics'
import { getGoNoGoDifficulty } from '../lib/adaptiveDifficulty'
import type { GoNoGoVariant, TaskAdaptationState, TaskResult, TrainingSession } from '../types'
import { PracticeResultCard, ResultCard, TaskFrame, TaskStartOptions, TaskVariantSelector, type TaskVariantOption } from '../components/TaskFrame'

type Rule = 'shape' | 'color'

interface Trial {
  isGo: boolean
  shape: 'circle' | 'square'
  color: 'green' | 'coral'
  rule: Rule
}

interface GoNoGoTaskProps {
  level?: number
  assessment?: boolean
  initialVariant?: GoNoGoVariant
  trialCountOverride?: number
  history?: TrainingSession[]
  adaptation?: TaskAdaptationState
  onComplete: (result: TaskResult) => void
  onExit?: () => void
}

const variantOptions: TaskVariantOption<GoNoGoVariant>[] = [
  { value: 'adaptive', label: '自适应规则', description: '当前等级的形状或颜色规则' },
  { value: 'rule-switch', label: '规则切换', description: '形状与颜色分段切换' },
  { value: 'more-stops', label: '停手增多', description: 'No-Go 占比约 35%' },
  { value: 'fewer-stops', label: '稀少停手', description: 'No-Go 占比约 12%' },
]

export function GoNoGoTask({
  level = 1,
  assessment = false,
  initialVariant = 'adaptive',
  trialCountOverride,
  history = [],
  adaptation,
  onComplete,
  onExit,
}: GoNoGoTaskProps) {
  const baseDifficulty = assessment
    ? { trialCount: 32, displayTimeMs: 650, gapMs: 240, noGoRatio: 0.22, rule: 'shape' as const }
    : getGoNoGoDifficulty(level)
  const [variant, setVariant] = useState<GoNoGoVariant>(assessment ? 'adaptive' : initialVariant)
  const [phase, setPhase] = useState<'practice' | 'formal'>('formal')
  const noGoRatio = variant === 'more-stops' ? 0.35 : variant === 'fewer-stops' ? 0.12 : baseDifficulty.noGoRatio
  const trialCount = phase === 'practice' ? 10 : trialCountOverride ?? baseDifficulty.trialCount
  const [trials, setTrials] = useState<Trial[]>([])
  const [index, setIndex] = useState(-1)
  const [visible, setVisible] = useState(false)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ hits: 0, omissions: 0, commissions: 0 })
  const [result, setResult] = useState<TaskResult | null>(null)
  const responded = useRef(false)
  const shownAt = useRef(0)
  const reactionTimes = useRef<number[]>([])
  const statsRef = useRef(stats)
  const durationRef = useRef(0)

  const progress = useMemo(() => (index < 0 ? 0 : Math.min(100, ((index + 1) / trialCount) * 100)), [index, trialCount])

  function updateStats(key: keyof typeof stats) {
    const next = { ...statsRef.current, [key]: statsRef.current[key] + 1 }
    statsRef.current = next
    setStats(next)
  }

  function makeTrials(round: 'practice' | 'formal') {
    const count = round === 'practice' ? 10 : trialCountOverride ?? baseDifficulty.trialCount
    const minimumStops = round === 'practice' ? 3 : 5
    const noGoCount = Math.max(minimumStops, Math.round(count * noGoRatio))
    const flags = shuffle([
      ...Array.from({ length: count - noGoCount }, () => true),
      ...Array.from({ length: noGoCount }, () => false),
    ])
    return flags.map((isGo, trialIndex): Trial => {
      const rule: Rule = variant === 'rule-switch'
        ? Math.floor(trialIndex / 6) % 2 === 0 ? 'shape' : 'color'
        : baseDifficulty.rule
      return {
        isGo,
        rule,
        shape: rule === 'shape' ? (isGo ? 'circle' : 'square') : (Math.random() > 0.5 ? 'circle' : 'square'),
        color: rule === 'color' ? (isGo ? 'green' : 'coral') : (Math.random() > 0.5 ? 'green' : 'coral'),
      }
    })
  }

  function start(nextPhase: 'practice' | 'formal' = phase) {
    const nextTrials = makeTrials(nextPhase)
    setPhase(nextPhase)
    setTrials(nextTrials)
    setIndex(0)
    setVisible(false)
    setRunning(true)
    setResult(null)
    const empty = { hits: 0, omissions: 0, commissions: 0 }
    setStats(empty)
    statsRef.current = empty
    reactionTimes.current = []
    durationRef.current = performance.now()
  }

  function changeVariant(next: GoNoGoVariant) {
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
      const noGoCount = trials.filter((trial) => !trial.isGo).length
      const correct = statsRef.current.hits + noGoCount - statsRef.current.commissions
      const durationSec = (performance.now() - durationRef.current) / 1000
      const errors = statsRef.current.omissions + statsRef.current.commissions
      const base = {
        taskType: 'go-no-go' as const,
        durationSec,
        accuracy: correct / trials.length,
        medianReactionMs: median(reactionTimes.current),
        omissions: statsRef.current.omissions,
        commissions: statsRef.current.commissions,
        errors,
        level,
        metadata: {
          trialCount: trials.length,
          displayTimeMs: baseDifficulty.displayTimeMs,
          gapMs: baseDifficulty.gapMs,
          noGoRatio: trials.filter((trial) => !trial.isGo).length / trials.length,
          rule: variant === 'rule-switch' ? 'switching' : baseDifficulty.rule,
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
      if (!responded.current && trials[index].isGo) updateStats('omissions')
      setVisible(false)
    }, baseDifficulty.displayTimeMs)
    const nextTimer = window.setTimeout(() => setIndex((current) => current + 1), baseDifficulty.displayTimeMs + baseDifficulty.gapMs)
    return () => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(nextTimer)
    }
  }, [index, level, running, trials])

  function respond() {
    if (!running || !visible || responded.current || !trials[index]) return
    responded.current = true
    if (trials[index].isGo) {
      updateStats('hits')
      reactionTimes.current.push(performance.now() - shownAt.current)
    } else {
      updateStats('commissions')
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

  const currentTrial = trials[index]
  const currentRule = currentTrial?.rule ?? baseDifficulty.rule

  return (
    <TaskFrame
      eyebrow={assessment ? '初始测评 · 2/3' : phase === 'practice' ? '反应抑制 · 不计分练习' : '反应抑制 · 正式训练'}
      title="停得住，才更专注"
      description={currentRule === 'shape' ? '形状规则：圆形点击，方块停住；颜色只是干扰。' : '颜色规则：绿色点击，珊瑚色停住；形状只是干扰。'}
      onExit={onExit}
    >
      {result ? (
        phase === 'practice'
          ? <PracticeResultCard result={result} onRetry={() => start('practice')} onContinue={() => start('formal')} />
          : <ResultCard result={result} history={history} adaptation={adaptation} showInsights={!assessment} onRetry={() => start('formal')} onContinue={() => onComplete(result)} continueLabel={assessment ? '继续测评' : '保存成绩'} />
      ) : (
        <>
          {!assessment && !running && <TaskVariantSelector value={variant} options={variantOptions} onChange={changeVariant} />}
          {!assessment && <div className="difficulty-parameters"><span>{phase === 'practice' ? '不计分练习' : `等级 ${level}`}</span><span>{trialCount} 次刺激</span><span>No-Go {phase === 'practice' ? 30 : Math.round(noGoRatio * 100)}%</span><span>{variant === 'rule-switch' ? '每 6 次切换规则' : currentRule === 'shape' ? '形状规则' : '颜色规则'}</span></div>}
          {running && variant === 'rule-switch' && <div className={`rule-switch-cue ${currentRule}`}><span>当前规则</span><strong>{currentRule === 'shape' ? '看形状' : '看颜色'}</strong></div>}
          <div className="progress-track" aria-label={`训练进度 ${Math.round(progress)}%`}><span style={{ width: `${progress}%` }} /></div>
          <button type="button" className="stimulus-stage" onClick={respond} disabled={!running} aria-label="刺激反应区域">
            {running && visible && currentTrial && <span className={`stimulus ${currentTrial.shape} color-${currentTrial.color}`} />}
            {!running && (
              <span className="stage-intro">
                <span className="rule-demo"><i className={`stimulus ${currentRule === 'shape' ? 'circle color-green' : 'circle color-green'}`} />点击</span>
                <span className="rule-demo"><i className={`stimulus ${currentRule === 'shape' ? 'square color-coral' : 'circle color-coral'}`} />停住</span>
              </span>
            )}
          </button>
          <div className="task-status-row small">
            <div><span>正确反应</span><strong>{stats.hits}</strong></div>
            <div><span>漏答</span><strong>{stats.omissions}</strong></div>
            <div><span>误按</span><strong>{stats.commissions}</strong></div>
          </div>
          {!running && (
            <TaskStartOptions
              formalLabel={assessment ? '直接开始测评' : '开始正式训练'}
              onFormal={() => start('formal')}
              onPractice={() => start('practice')}
            />
          )}
          {running && <p className="keyboard-tip">点击中央区域，或按空格键作答</p>}
        </>
      )}
    </TaskFrame>
  )
}
