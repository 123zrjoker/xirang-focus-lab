import { useEffect, useRef, useState } from 'react'
import { median, scoreResult, shuffle } from '../lib/metrics'
import { getSchulteDifficulty } from '../lib/adaptiveDifficulty'
import type { SchulteVariant, TaskAdaptationState, TaskResult, TrainingSession } from '../types'
import { PracticeResultCard, ResultCard, TaskFrame, TaskStartOptions, TaskVariantSelector, type TaskVariantOption } from '../components/TaskFrame'

interface SchulteCell {
  id: number
  order: number
  label: string
  tone?: 'warm' | 'cool'
}

interface SchulteTaskProps {
  size?: number
  level?: number
  assessment?: boolean
  initialVariant?: SchulteVariant
  history?: TrainingSession[]
  adaptation?: TaskAdaptationState
  onComplete: (result: TaskResult) => void
  onExit?: () => void
}

const variantOptions: TaskVariantOption<SchulteVariant>[] = [
  { value: 'numbers', label: '数字', description: '按 1、2、3…寻找' },
  { value: 'letters', label: '字母', description: '按 A、B、C…寻找' },
  { value: 'alternating', label: '数 · 字交替', description: '1、A、2、B…切换' },
  { value: 'color-switch', label: '颜色交替', description: '奇偶目标切换颜色' },
  { value: 'radial', label: '圆盘', description: '同心环扇形格填满圆盘' },
  { value: 'dynamic', label: '旋转圆盘', description: '完整分格圆盘持续旋转' },
]

const variantLabels: Record<SchulteVariant, string> = {
  numbers: '数字方格',
  letters: '字母方格',
  alternating: '数字字母交替',
  'color-switch': '颜色交替方格',
  radial: '圆盘舒尔特',
  dynamic: '旋转圆盘舒尔特',
}

function alphaLabel(index: number) {
  let value = index
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

function makeCells(total: number, variant: SchulteVariant): SchulteCell[] {
  return Array.from({ length: total }, (_, index) => {
    const order = index + 1
    let label = String(order)
    if (variant === 'letters') label = alphaLabel(order)
    if (variant === 'alternating') label = order % 2 ? String((order + 1) / 2) : alphaLabel(order / 2)
    return {
      id: order,
      order,
      label,
      tone: variant === 'color-switch' ? (order % 2 ? 'warm' : 'cool') : undefined,
    }
  })
}

interface DialSector {
  path: string
  textX: number
  textY: number
}

function polarPoint(radius: number, angleDegrees: number) {
  const angle = angleDegrees * Math.PI / 180
  return { x: 50 + Math.cos(angle) * radius, y: 50 + Math.sin(angle) * radius }
}

function annularSectorPath(innerRadius: number, outerRadius: number, startAngle: number, endAngle: number) {
  const outerStart = polarPoint(outerRadius, startAngle)
  const outerEnd = polarPoint(outerRadius, endAngle)
  if (!innerRadius) {
    return `M 50 50 L ${outerStart.x} ${outerStart.y} A ${outerRadius} ${outerRadius} 0 0 1 ${outerEnd.x} ${outerEnd.y} Z`
  }
  const innerEnd = polarPoint(innerRadius, endAngle)
  const innerStart = polarPoint(innerRadius, startAngle)
  return `M ${outerStart.x} ${outerStart.y} A ${outerRadius} ${outerRadius} 0 0 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 0 0 ${innerStart.x} ${innerStart.y} Z`
}

function makeDialSectors(total: number): DialSector[] {
  const ringCounts = total <= 16 ? [4, 5, 7] : total <= 25 ? [4, 6, 7, 8] : [6, 8, 10, 12]
  const radii = ringCounts.length === 3 ? [0, 19, 34, 48] : [0, 17, 28, 38, 48]
  return ringCounts.flatMap((count, ringIndex) => {
    const innerRadius = radii[ringIndex]
    const outerRadius = radii[ringIndex + 1]
    const step = 360 / count
    const offset = -90 + (ringIndex % 2 ? step / 2 : 0)
    return Array.from({ length: count }, (_, cellIndex) => {
      const startAngle = offset + cellIndex * step
      const endAngle = startAngle + step
      const textRadius = innerRadius ? (innerRadius + outerRadius) / 2 : outerRadius * 0.58
      const textPoint = polarPoint(textRadius, startAngle + step / 2)
      return {
        path: annularSectorPath(innerRadius, outerRadius, startAngle, endAngle),
        textX: textPoint.x,
        textY: textPoint.y,
      }
    })
  })
}

export function SchulteTask({
  size,
  level = 1,
  assessment = false,
  initialVariant = 'numbers',
  history = [],
  adaptation,
  onComplete,
  onExit,
}: SchulteTaskProps) {
  const difficulty = getSchulteDifficulty(level)
  const initialSize = size ?? difficulty.gridSize
  const [selectedSize, setSelectedSize] = useState(initialSize)
  const [variant, setVariant] = useState<SchulteVariant>(assessment ? 'numbers' : initialVariant)
  const total = selectedSize * selectedSize
  const [phase, setPhase] = useState<'practice' | 'formal'>('formal')
  const [grid, setGrid] = useState(() => shuffle(makeCells(initialSize * initialSize, assessment ? 'numbers' : initialVariant)))
  const [target, setTarget] = useState(1)
  const [errors, setErrors] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TaskResult | null>(null)
  const startedAt = useRef(0)
  const lastClickAt = useRef(0)
  const intervals = useRef<number[]>([])
  const roundTargetCount = phase === 'practice' ? Math.min(8, total) : total

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setElapsed((performance.now() - startedAt.current) / 1000), 50)
    return () => window.clearInterval(timer)
  }, [running])

  function resetRound(nextVariant = variant, nextSize = selectedSize) {
    setGrid(shuffle(makeCells(nextSize * nextSize, nextVariant)))
    setTarget(1)
    setErrors(0)
    setElapsed(0)
    setRunning(false)
    setResult(null)
    intervals.current = []
  }

  function changeVariant(next: SchulteVariant) {
    setVariant(next)
    setPhase('formal')
    resetRound(next, selectedSize)
  }

  function changeSize(next: number) {
    setSelectedSize(next)
    setPhase('formal')
    resetRound(variant, next)
  }

  function start(nextPhase: 'practice' | 'formal' = phase) {
    setPhase(nextPhase)
    setGrid(shuffle(makeCells(total, variant)))
    setTarget(1)
    setErrors(0)
    setElapsed(0)
    setResult(null)
    intervals.current = []
    const now = performance.now()
    startedAt.current = now
    lastClickAt.current = now
    setRunning(true)
  }

  function handleCell(cell: SchulteCell) {
    if (!running) return
    if (cell.order !== target) {
      setErrors((current) => current + 1)
      return
    }

    const now = performance.now()
    intervals.current.push(now - lastClickAt.current)
    lastClickAt.current = now

    if (target < roundTargetCount) {
      setTarget((current) => current + 1)
      return
    }

    const durationSec = (now - startedAt.current) / 1000
    const accuracy = roundTargetCount / (roundTargetCount + errors)
    const base = {
      taskType: 'schulte' as const,
      durationSec,
      accuracy,
      medianReactionMs: median(intervals.current),
      omissions: 0,
      commissions: errors,
      errors,
      level,
      metadata: {
        gridSize: selectedSize,
        trialCount: roundTargetCount,
        targetIntervalMs: difficulty.targetIntervalMs,
        distractorIntensity: difficulty.distractorIntensity,
        variant,
        round: phase,
      },
    }
    const finished = { ...base, score: scoreResult(base) }
    setElapsed(durationSec)
    setRunning(false)
    setResult(finished)
  }

  const targetCell = makeCells(total, variant)[target - 1]
  const radial = variant === 'radial' || variant === 'dynamic'
  const dialSectors = radial ? makeDialSectors(total) : []

  function renderStartOverlay() {
    if (running) return null
    return (
      <div className="task-overlay">
        <span className="focus-mark">＋</span>
        <p>准备好后，从 {makeCells(total, variant)[0].label} 开始</p>
        <TaskStartOptions
          formalLabel={assessment ? '直接开始测评' : '开始正式训练'}
          onFormal={() => start('formal')}
          onPractice={() => start('practice')}
        />
      </div>
    )
  }

  return (
    <TaskFrame
      eyebrow={assessment ? '初始测评 · 1/3' : phase === 'practice' ? '视觉搜索 · 不计分练习' : '视觉搜索 · 正式训练'}
      title={`${selectedSize}×${selectedSize} ${variantLabels[variant]}`}
      description={variant === 'alternating' ? '按 1、A、2、B…的顺序点击。' : variant === 'letters' ? '按字母顺序寻找目标。' : variant === 'radial' ? '数字放在同心环扇形格中，按顺序寻找目标。' : variant === 'dynamic' ? '同心环分格圆盘持续旋转，仍按顺序点击。' : '按目标顺序点击，保持准确，再逐渐加快速度。'}
      onExit={onExit}
    >
      {result ? (
        phase === 'practice'
          ? <PracticeResultCard result={result} onRetry={() => start('practice')} onContinue={() => start('formal')} />
          : <ResultCard result={result} history={history} adaptation={adaptation} showInsights={!assessment} onRetry={() => start('formal')} onContinue={() => onComplete(result)} continueLabel={assessment ? '继续测评' : '保存成绩'} />
      ) : (
        <>
          {!assessment && !running && (
            <>
              <TaskVariantSelector value={variant} options={variantOptions} onChange={changeVariant} />
              <div className="schulte-size-selector" aria-label="方格尺寸">
                <strong>尺寸</strong>
                {[4, 5, 6].map((option) => <button key={option} type="button" className={selectedSize === option ? 'active' : ''} onClick={() => changeSize(option)}>{option}×{option}</button>)}
              </div>
            </>
          )}
          {!assessment && <div className="difficulty-parameters"><span>{phase === 'practice' ? '不计分练习' : `等级 ${level}`}</span><span>{selectedSize}×{selectedSize}</span><span>{phase === 'practice' ? `先完成 ${roundTargetCount} 个目标` : `目标节奏 ≤ ${difficulty.targetIntervalMs}ms/格`}</span><span>{variantLabels[variant]}</span></div>}
          <div className="task-status-row">
            <div><span>当前目标</span><strong>{running ? targetCell?.label ?? target : '—'}</strong></div>
            <div><span>用时</span><strong>{elapsed.toFixed(1)}s</strong></div>
            <div><span>误点</span><strong>{errors}</strong></div>
          </div>
          {radial ? (
            <div className={`schulte-dial ${!running ? 'is-idle' : ''} ${variant === 'dynamic' && running ? 'is-rotating' : ''} dial-size-${selectedSize}`}>
              <svg className="schulte-dial-svg" viewBox="0 0 100 100" role="group" aria-label={variant === 'dynamic' ? '旋转圆盘舒尔特方格' : '圆盘舒尔特方格'}>
                <circle className="dial-background" cx="50" cy="50" r="48" />
                <g className="dial-rotor">
                  {dialSectors.map((sector, index) => {
                    const cell = grid[index]
                    if (!cell) return null
                    return (
                      <g
                        key={cell.id}
                        className={`dial-sector ${!running ? 'disabled' : ''}`}
                        role="button"
                        tabIndex={running ? 0 : -1}
                        aria-label={`目标 ${cell.label}`}
                        onClick={() => handleCell(cell)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            handleCell(cell)
                          }
                        }}
                      >
                        <path d={sector.path} />
                        <text x={sector.textX} y={sector.textY} textAnchor="middle" dominantBaseline="middle">{cell.label}</text>
                      </g>
                    )
                  })}
                </g>
                <circle className="dial-outline" cx="50" cy="50" r="48" />
              </svg>
              {renderStartOverlay()}
            </div>
          ) : (
            <div
              className={`schulte-grid ${!running ? 'is-idle' : ''} distractor-level-${assessment ? 0 : difficulty.distractorIntensity}`}
              style={{ gridTemplateColumns: `repeat(${selectedSize}, 1fr)` }}
              aria-label="舒尔特方格"
            >
              {grid.map((cell) => (
                <button
                  key={cell.id}
                  type="button"
                  className={`${cell.tone ? `tone-${cell.tone}` : ''} ${!assessment && difficulty.distractorIntensity ? `distractor-cell-${cell.id % 4}` : ''}`}
                  onClick={() => handleCell(cell)}
                  disabled={!running}
                  aria-label={`目标 ${cell.label}`}
                >
                  {cell.label}
                </button>
              ))}
              {renderStartOverlay()}
            </div>
          )}
          <p className="task-tip">提示：尽量让视线覆盖整个区域，不需要逐行扫描。</p>
        </>
      )}
    </TaskFrame>
  )
}
