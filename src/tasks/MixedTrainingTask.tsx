import { useEffect, useState } from 'react'
import { taskLabel } from '../lib/metrics'
import type { TaskAdaptationState, TaskResult, TaskType, TrainingSession } from '../types'
import { TaskFrame } from '../components/TaskFrame'
import { GoNoGoTask } from './GoNoGoTask'
import { SchulteTask } from './SchulteTask'
import { StroopTask } from './StroopTask'
import { VigilanceTask } from './VigilanceTask'

type BundleId = 'search-control' | 'steady-focus' | 'interference-reset'

interface BundleDefinition {
  id: BundleId
  title: string
  skill: string
  description: string
  steps: [TaskType, TaskType]
}

const bundles: BundleDefinition[] = [
  {
    id: 'search-control',
    title: '搜索 × 停手',
    skill: '视觉搜索 + 反应抑制',
    description: '动态舒尔特之后切换 Go/No-Go 规则，适合进入学习或工作前热身。',
    steps: ['schulte', 'go-no-go'],
  },
  {
    id: 'steady-focus',
    title: '监测 × 抗扰',
    skill: '持续注意 + 方向冲突',
    description: '先守住稀少目标，再处理方向冲突，观察后半段是否仍然稳定。',
    steps: ['vigilance', 'stroop'],
  },
  {
    id: 'interference-reset',
    title: '冲突 × 停手',
    skill: '大小冲突 + 高比例停手',
    description: '在两种规则间快速重置，适合减少凭惯性作答。',
    steps: ['stroop', 'go-no-go'],
  },
]

interface MixedTrainingTaskProps {
  levels: Record<TaskType, number>
  history: TrainingSession[]
  adaptation: Record<TaskType, TaskAdaptationState>
  onComplete: (results: TaskResult[]) => void
  onExit: () => void
}

function formatClock(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function MixedTrainingTask({ levels, history, adaptation, onComplete, onExit }: MixedTrainingTaskProps) {
  const [bundleId, setBundleId] = useState<BundleId>('search-control')
  const [started, setStarted] = useState(false)
  const [stage, setStage] = useState(0)
  const [results, setResults] = useState<TaskResult[]>([])
  const [elapsedSec, setElapsedSec] = useState(0)
  const bundle = bundles.find((item) => item.id === bundleId) ?? bundles[0]

  useEffect(() => {
    if (!started || stage >= 2) return
    const startedAt = Date.now() - elapsedSec * 1000
    const timer = window.setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [started, stage])

  function begin() {
    setResults([])
    setStage(0)
    setElapsedSec(0)
    setStarted(true)
  }

  function acceptResult(result: TaskResult) {
    const nextResults = [...results, result]
    setResults(nextResults)
    setStage((current) => current + 1)
  }

  if (!started) {
    return (
      <TaskFrame eyebrow="混合训练 · 约 5 分钟" title="两项短任务，一次完成" description="每项都先经过不计分练习。正式结果会分别记入对应能力，不生成含义模糊的总能力分。" onExit={onExit}>
        <div className="mixed-bundle-grid">
          {bundles.map((item) => (
            <button key={item.id} type="button" className={bundleId === item.id ? 'active' : ''} onClick={() => setBundleId(item.id)}>
              <span>{item.skill}</span>
              <strong>{item.title}</strong>
              <p>{item.description}</p>
              <small>{item.steps.map(taskLabel).join(' → ')}</small>
            </button>
          ))}
        </div>
        <div className="mixed-bundle-note"><span>5:00</span><div><strong>约5分钟训练包</strong><p>实际用时取决于作答速度；练习回合不计分，两个正式结果会分开保存。</p></div></div>
        <button className="button primary centered" type="button" onClick={begin}>开始训练包 →</button>
      </TaskFrame>
    )
  }

  if (stage >= 2) {
    const averageAccuracy = results.reduce((sum, item) => sum + item.accuracy, 0) / Math.max(1, results.length)
    const averageScore = Math.round(results.reduce((sum, item) => sum + item.score, 0) / Math.max(1, results.length))
    return (
      <TaskFrame eyebrow="混合训练 · 已完成" title="两种能力都练到了" description="确认后，两项正式成绩将分别进入趋势与自适应难度记录。" onExit={onExit}>
        <div className="mixed-result">
          <span className="result-badge">训练包完成</span>
          <h3>{averageScore} 分</h3>
          <p>综合分只用于概览，系统仍按两个单项结果分别分析。</p>
          <div className="metric-grid compact">
            <div><span>实际用时</span><strong>{formatClock(elapsedSec)}</strong></div>
            <div><span>平均正确率</span><strong>{Math.round(averageAccuracy * 100)}%</strong></div>
            {results.map((result) => <div key={result.taskType}><span>{taskLabel(result.taskType)}</span><strong>{result.score}分</strong></div>)}
          </div>
          <div className="mixed-result-list">
            {results.map((result, index) => <article key={result.taskType}><span>0{index + 1}</span><div><strong>{taskLabel(result.taskType)}</strong><small>{Math.round(result.accuracy * 100)}% 正确 · {result.errors} 次失误</small></div></article>)}
          </div>
          <div className="button-row">
            <button className="button secondary" type="button" onClick={() => setStarted(false)}>更换训练包</button>
            <button className="button primary" type="button" onClick={() => onComplete(results)}>保存两项成绩</button>
          </div>
        </div>
      </TaskFrame>
    )
  }

  const currentType = bundle.steps[stage]
  const strip = <div className="mixed-progress-strip"><span>训练包 {stage + 1}/2</span><strong>{taskLabel(currentType)}</strong><time>{formatClock(elapsedSec)} / 约 5:00</time></div>

  return (
    <div className="mixed-task-stage">
      {strip}
      {currentType === 'schulte' && <SchulteTask key={`${bundle.id}-${stage}`} size={5} level={levels.schulte} initialVariant="dynamic" history={history} adaptation={adaptation.schulte} onComplete={acceptResult} onExit={onExit} />}
      {currentType === 'vigilance' && <VigilanceTask key={`${bundle.id}-${stage}`} level={levels.vigilance} initialVariant="rare" trialCountOverride={72} history={history} adaptation={adaptation.vigilance} onComplete={acceptResult} onExit={onExit} />}
      {currentType === 'stroop' && <StroopTask key={`${bundle.id}-${stage}`} level={levels.stroop} initialVariant={bundle.id === 'steady-focus' ? 'direction' : 'size'} trialCountOverride={36} history={history} adaptation={adaptation.stroop} onComplete={acceptResult} onExit={onExit} />}
      {currentType === 'go-no-go' && <GoNoGoTask key={`${bundle.id}-${stage}`} level={levels['go-no-go']} initialVariant={bundle.id === 'interference-reset' ? 'more-stops' : 'rule-switch'} trialCountOverride={60} history={history} adaptation={adaptation['go-no-go']} onComplete={acceptResult} onExit={onExit} />}
    </div>
  )
}
