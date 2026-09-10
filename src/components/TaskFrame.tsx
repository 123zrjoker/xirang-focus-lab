import type { ReactNode } from 'react'
import type { TaskAdaptationState, TaskResult, TrainingSession } from '../types'
import { taskLabel } from '../lib/metrics'
import { buildResultInsights } from '../lib/resultInsights'

interface TaskFrameProps {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
  onExit?: () => void
}

export interface TaskVariantOption<T extends string> {
  value: T
  label: string
  description: string
}

interface TaskVariantSelectorProps<T extends string> {
  label?: string
  value: T
  options: TaskVariantOption<T>[]
  disabled?: boolean
  onChange: (value: T) => void
}

export function TaskVariantSelector<T extends string>({
  label = '训练形式',
  value,
  options,
  disabled = false,
  onChange,
}: TaskVariantSelectorProps<T>) {
  return (
    <section className="task-variant-selector" aria-label={label}>
      <div><strong>{label}</strong><span>可以直接正式训练，也可以先练习规则</span></div>
      <div className="task-variant-options">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? 'active' : ''}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            <strong>{option.label}</strong>
            <small>{option.description}</small>
          </button>
        ))}
      </div>
    </section>
  )
}

interface PracticeResultCardProps {
  result: TaskResult
  onRetry: () => void
  onContinue: () => void
}

interface TaskStartOptionsProps {
  formalLabel?: string
  practiceLabel?: string
  onFormal: () => void
  onPractice: () => void
}

export function TaskStartOptions({
  formalLabel = '开始正式训练',
  practiceLabel = '先做不计分练习',
  onFormal,
  onPractice,
}: TaskStartOptionsProps) {
  return (
    <div className="task-start-options">
      <div>
        <button className="button primary" type="button" onClick={onFormal}>{formalLabel}</button>
        <button className="button secondary" type="button" onClick={onPractice}>{practiceLabel}</button>
      </div>
      <small>练习结果不会保存，也不会影响个人趋势或难度。</small>
    </div>
  )
}

export function PracticeResultCard({ result, onRetry, onContinue }: PracticeResultCardProps) {
  const passed = result.accuracy >= 0.7
  return (
    <div className={`practice-result-card ${passed ? 'passed' : 'retry'}`} aria-live="polite">
      <span className="result-badge">不计分练习</span>
      <h3>{passed ? '规则已经掌握' : '这轮还不够稳定'}</h3>
      <p>{passed ? '这轮不会保存，也不会影响难度。现在可以进入正式训练。' : '练习正确率不足 70%，建议再熟悉一次；你也可以自行选择进入正式训练。'}</p>
      <div className="practice-metrics">
        <div><span>练习正确率</span><strong>{Math.round(result.accuracy * 100)}%</strong></div>
        <div><span>练习失误</span><strong>{result.errors}</strong></div>
      </div>
      <div className="button-row">
        <button className="button secondary" type="button" onClick={onRetry}>重新练习</button>
        <button className="button primary" type="button" onClick={onContinue}>开始正式训练 →</button>
      </div>
    </div>
  )
}

export function TaskFrame({ eyebrow, title, description, children, onExit }: TaskFrameProps) {
  return (
    <section className="task-shell">
      <div className="task-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {onExit && (
          <button className="icon-button" type="button" onClick={onExit} aria-label="退出训练">
            ×
          </button>
        )}
      </div>
      {children}
    </section>
  )
}

interface ResultCardProps {
  result: TaskResult
  onContinue: () => void
  onRetry: () => void
  continueLabel?: string
  history?: TrainingSession[]
  showInsights?: boolean
  adaptation?: TaskAdaptationState
}

export function ResultCard({ result, onContinue, onRetry, continueLabel = '完成训练', history = [], showInsights = true, adaptation }: ResultCardProps) {
  const insights = showInsights ? buildResultInsights(result, history, adaptation) : null
  return (
    <div className="result-card" aria-live="polite">
      <span className="result-badge">训练完成</span>
      <h3>{taskLabel(result.taskType)} · {result.score} 分</h3>
      <p className="result-summary">
        先看正确率，再看速度。稳定而准确，比一次偶然的最快纪录更有意义。
      </p>
      <div className="metric-grid compact">
        <div><span>正确率</span><strong>{Math.round(result.accuracy * 100)}%</strong></div>
        <div><span>中位反应</span><strong>{result.medianReactionMs ? `${Math.round(result.medianReactionMs)}ms` : '—'}</strong></div>
        <div><span>用时</span><strong>{result.durationSec.toFixed(1)}s</strong></div>
        <div><span>失误</span><strong>{result.errors}</strong></div>
      </div>
      {insights && (
        <section className="result-insights" aria-label="本次训练个人比较">
          <div className="insight-heading">
            <div><span>个人趋势</span><h4>{insights.summary}</h4></div>
            <small>{insights.historyCount ? `对比最近 ${insights.historyCount} 次` : '建立个人起点'}</small>
          </div>
          <div className="comparison-grid">
            {insights.comparisons.map((comparison) => (
              <article className={comparison.tone} key={comparison.label}>
                <span>{comparison.label}</span><strong>{comparison.value}</strong><small>{comparison.detail}</small>
              </article>
            ))}
          </div>
          <div className="insight-detail-grid">
            <article className="result-insight-advice"><span>错误解读</span><strong>{insights.errorTitle}</strong><p>{insights.errorExplanation}</p></article>
            <article className={`difficulty ${insights.difficultyDirection}`}><span>难度变化</span><strong>{insights.difficultyDirection === 'up' ? '↑ 提高' : insights.difficultyDirection === 'down' ? '↓ 降低' : '— 保持'}</strong><p>{insights.difficultyReason}</p></article>
            <article className="result-insight-advice"><span>下一次建议</span><strong>从一个动作开始</strong><p>{insights.recommendation}</p></article>
          </div>
          <p className="personal-comparison-note">本次状态仅用于和自己的近期记录比较，不代表人群排名、能力标签或医学结论。</p>
        </section>
      )}
      <div className="button-row">
        <button className="button secondary" type="button" onClick={onRetry}>再练一次</button>
        <button className="button primary" type="button" onClick={onContinue}>{continueLabel}</button>
      </div>
    </div>
  )
}
