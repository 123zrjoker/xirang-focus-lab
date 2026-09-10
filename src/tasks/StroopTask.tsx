import { useEffect, useRef, useState } from 'react'
import { median, scoreResult, shuffle } from '../lib/metrics'
import { getStroopDifficulty } from '../lib/adaptiveDifficulty'
import type { StroopVariant, TaskAdaptationState, TaskResult, TrainingSession } from '../types'
import { PracticeResultCard, ResultCard, TaskFrame, TaskStartOptions, TaskVariantSelector, type TaskVariantOption } from '../components/TaskFrame'

const colorMap = {
  red: { label: '红', hex: '#ef6a5b' },
  blue: { label: '蓝', hex: '#3f6fed' },
  green: { label: '绿', hex: '#239b72' },
  yellow: { label: '黄', hex: '#d99716' },
}

const directionMap = {
  left: { label: '左', symbol: '←' },
  right: { label: '右', symbol: '→' },
  up: { label: '上', symbol: '↑' },
  down: { label: '下', symbol: '↓' },
}

const sizeMap = {
  small: { label: '小' },
  large: { label: '大' },
}

type ColorName = keyof typeof colorMap
type DirectionName = keyof typeof directionMap
type SizeName = keyof typeof sizeMap
type AnswerKey = ColorName | DirectionName | SizeName

interface StroopTrial {
  answer: AnswerKey
  distractor: AnswerKey
  congruent: boolean
}

interface StroopTaskProps {
  level?: number
  assessment?: boolean
  initialVariant?: StroopVariant
  trialCountOverride?: number
  history?: TrainingSession[]
  adaptation?: TaskAdaptationState
  onComplete: (result: TaskResult) => void
  onExit?: () => void
}

const variantOptions: TaskVariantOption<StroopVariant>[] = [
  { value: 'color', label: '颜色冲突', description: '忽略文字，判断字体颜色' },
  { value: 'direction', label: '方向冲突', description: '忽略方向词，判断箭头' },
  { value: 'size', label: '大小冲突', description: '忽略字义，判断字体大小' },
]

export function StroopTask({
  level = 1,
  assessment = false,
  initialVariant = 'color',
  trialCountOverride,
  history = [],
  adaptation,
  onComplete,
  onExit,
}: StroopTaskProps) {
  const difficulty = assessment
    ? { trialCount: 20, congruentRatio: 0.34, colorCount: 4, responseDeadlineMs: 0 }
    : getStroopDifficulty(level)
  const [variant, setVariant] = useState<StroopVariant>(assessment ? 'color' : initialVariant)
  const [phase, setPhase] = useState<'practice' | 'formal'>('formal')
  const trialCount = phase === 'practice' ? 8 : trialCountOverride ?? difficulty.trialCount
  const colorNames = (Object.keys(colorMap) as ColorName[]).slice(0, difficulty.colorCount)
  const activeKeys: AnswerKey[] = variant === 'color'
    ? colorNames
    : variant === 'direction'
      ? Object.keys(directionMap) as DirectionName[]
      : Object.keys(sizeMap) as SizeName[]
  const [trials, setTrials] = useState<StroopTrial[]>([])
  const [index, setIndex] = useState(-1)
  const [running, setRunning] = useState(false)
  const [correct, setCorrect] = useState(0)
  const [errors, setErrors] = useState(0)
  const [omissions, setOmissions] = useState(0)
  const [result, setResult] = useState<TaskResult | null>(null)
  const shownAt = useRef(0)
  const startedAt = useRef(0)
  const reactionTimes = useRef<number[]>([])
  const congruentTimes = useRef<number[]>([])
  const incongruentTimes = useRef<number[]>([])
  const stats = useRef({ correct: 0, errors: 0, omissions: 0 })
  const responded = useRef(false)

  function makeTrials(round: 'practice' | 'formal') {
    const count = round === 'practice' ? 8 : trialCountOverride ?? difficulty.trialCount
    const congruentCount = Math.round(count * difficulty.congruentRatio)
    return shuffle(Array.from({ length: count }, (_, trialIndex) => {
      const answer = activeKeys[Math.floor(Math.random() * activeKeys.length)]
      const congruent = trialIndex < congruentCount
      const alternatives = activeKeys.filter((name) => name !== answer)
      const distractor = congruent ? answer : alternatives[Math.floor(Math.random() * alternatives.length)]
      return { answer, distractor, congruent }
    }))
  }

  function start(nextPhase: 'practice' | 'formal' = phase) {
    setPhase(nextPhase)
    setTrials(makeTrials(nextPhase))
    setIndex(0)
    setCorrect(0)
    setErrors(0)
    setOmissions(0)
    stats.current = { correct: 0, errors: 0, omissions: 0 }
    reactionTimes.current = []
    congruentTimes.current = []
    incongruentTimes.current = []
    setResult(null)
    setRunning(true)
    startedAt.current = performance.now()
    shownAt.current = performance.now()
  }

  function changeVariant(next: StroopVariant) {
    setVariant(next)
    setPhase('formal')
    setTrials([])
    setIndex(-1)
    setRunning(false)
    setResult(null)
  }

  useEffect(() => {
    if (!running || index < 0) return
    if (index >= trials.length) {
      const durationSec = (performance.now() - startedAt.current) / 1000
      const congruentMedian = median(congruentTimes.current)
      const incongruentMedian = median(incongruentTimes.current)
      const totalErrors = stats.current.errors + stats.current.omissions
      const base = {
        taskType: 'stroop' as const,
        durationSec,
        accuracy: stats.current.correct / trials.length,
        medianReactionMs: median(reactionTimes.current),
        omissions: stats.current.omissions,
        commissions: stats.current.errors,
        errors: totalErrors,
        level,
        metadata: {
          trialCount: trials.length,
          congruentRatio: difficulty.congruentRatio,
          colorCount: variant === 'color' ? difficulty.colorCount : 0,
          responseDeadlineMs: phase === 'practice' ? 0 : difficulty.responseDeadlineMs,
          congruentMedian,
          incongruentMedian,
          interferenceCost: Math.max(0, incongruentMedian - congruentMedian),
          variant,
          round: phase,
        },
      }
      setRunning(false)
      setResult({ ...base, score: scoreResult(base) })
      return
    }
    responded.current = false
    shownAt.current = performance.now()
    const deadline = phase === 'practice' ? 0 : difficulty.responseDeadlineMs
    if (!deadline) return
    const deadlineTimer = window.setTimeout(() => {
      if (responded.current) return
      responded.current = true
      stats.current.omissions += 1
      setOmissions(stats.current.omissions)
      setIndex((current) => current + 1)
    }, deadline)
    return () => window.clearTimeout(deadlineTimer)
  }, [index, level, running, trials])

  function answer(answerKey: AnswerKey) {
    if (!running || responded.current || !trials[index]) return
    responded.current = true
    const trial = trials[index]
    const elapsed = performance.now() - shownAt.current
    if (answerKey === trial.answer) {
      stats.current.correct += 1
      setCorrect(stats.current.correct)
      reactionTimes.current.push(elapsed)
      if (trial.congruent) congruentTimes.current.push(elapsed)
      else incongruentTimes.current.push(elapsed)
    } else {
      stats.current.errors += 1
      setErrors(stats.current.errors)
    }
    setIndex((current) => current + 1)
  }

  const current = trials[index]

  function renderStimulus() {
    if (!running || !current) return <div className="stage-copy"><strong>线索会干扰你</strong><small>只判断当前规则要求的属性</small></div>
    if (variant === 'color') {
      const answerColor = current.answer as ColorName
      const distractorColor = current.distractor as ColorName
      return <span style={{ color: colorMap[answerColor].hex }}>{colorMap[distractorColor].label}</span>
    }
    if (variant === 'direction') {
      const answerDirection = current.answer as DirectionName
      const distractorDirection = current.distractor as DirectionName
      return <div className="direction-conflict"><small>{directionMap[distractorDirection].label}</small><span>{directionMap[answerDirection].symbol}</span></div>
    }
    const answerSize = current.answer as SizeName
    const distractorSize = current.distractor as SizeName
    return <span className={`size-conflict ${answerSize}`}>{sizeMap[distractorSize].label}</span>
  }

  function optionLabel(key: AnswerKey) {
    if (variant === 'color') return colorMap[key as ColorName].label
    if (variant === 'direction') return directionMap[key as DirectionName].symbol
    return sizeMap[key as SizeName].label
  }

  return (
    <TaskFrame
      eyebrow={assessment ? '初始测评 · 3/3' : phase === 'practice' ? '抗干扰 · 不计分练习' : '抗干扰 · 正式训练'}
      title={variant === 'color' ? '颜色，而不是文字' : variant === 'direction' ? '箭头，而不是方向词' : '大小，而不是字义'}
      description={variant === 'color' ? '忽略文字含义，选择字体颜色。' : variant === 'direction' ? '忽略小字方向词，选择箭头实际指向。' : '忽略“大/小”的字义，选择字体实际大小。'}
      onExit={onExit}
    >
      {result ? (
        phase === 'practice'
          ? <PracticeResultCard result={result} onRetry={() => start('practice')} onContinue={() => start('formal')} />
          : <ResultCard result={result} history={history} adaptation={adaptation} showInsights={!assessment} onRetry={() => start('formal')} onContinue={() => onComplete(result)} continueLabel={assessment ? '查看注意画像' : '保存成绩'} />
      ) : (
        <>
          {!assessment && !running && <TaskVariantSelector value={variant} options={variantOptions} onChange={changeVariant} />}
          {!assessment && <div className="difficulty-parameters"><span>{phase === 'practice' ? '不计分练习' : `等级 ${level}`}</span><span>{trialCount} 次刺激</span><span>冲突占比 {Math.round((1 - difficulty.congruentRatio) * 100)}%</span><span>{variant === 'color' ? `${difficulty.colorCount} 种颜色` : variant === 'direction' ? '4 个方向' : '2 种大小'}</span><span>{phase === 'practice' || !difficulty.responseDeadlineMs ? '不限作答时间' : `${difficulty.responseDeadlineMs}ms 时限`}</span></div>}
          <div className={`stroop-stage mode-${variant}`}>{renderStimulus()}</div>
          <div className={`conflict-options options-${activeKeys.length}`}>
            {activeKeys.map((key) => (
              <button key={key} type="button" onClick={() => answer(key)} disabled={!running}>
                {variant === 'color' && <i style={{ background: colorMap[key as ColorName].hex }} />}
                {optionLabel(key)}
              </button>
            ))}
          </div>
          <div className="task-status-row small four">
            <div><span>进度</span><strong>{Math.max(0, index)}/{trialCount}</strong></div>
            <div><span>正确</span><strong>{correct}</strong></div>
            <div><span>错误</span><strong>{errors}</strong></div>
            <div><span>超时</span><strong>{omissions}</strong></div>
          </div>
          {!running && (
            <TaskStartOptions
              formalLabel={assessment ? '直接开始测评' : '开始正式训练'}
              onFormal={() => start('formal')}
              onPractice={() => start('practice')}
            />
          )}
        </>
      )}
    </TaskFrame>
  )
}
