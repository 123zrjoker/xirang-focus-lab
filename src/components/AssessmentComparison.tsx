import {
  compareAssessmentContexts,
  getProfileDeltas,
} from '../lib/assessment'
import type { AssessmentContext, AttentionProfile } from '../types'
import { ProfileRadar } from './ProfileRadar'

interface AssessmentComparisonProps {
  previous: AttentionProfile
  current: AttentionProfile
  previousContext?: AssessmentContext
  currentContext?: AssessmentContext
  previousLabel: string
  currentLabel: string
  showPracticeEffect?: boolean
}

export function AssessmentComparison({
  previous,
  current,
  previousContext,
  currentContext,
  previousLabel,
  currentLabel,
  showPracticeEffect = false,
}: AssessmentComparisonProps) {
  const deltas = getProfileDeltas(current, previous)
  const comparability = compareAssessmentContexts(previousContext, currentContext)

  return (
    <div className="assessment-comparison">
      <div className="comparison-radars">
        <article><div><span>{previousLabel}</span><small>{new Date(previous.completedAt).toLocaleDateString('zh-CN')}</small></div><ProfileRadar profile={previous} compact /></article>
        <article className="current"><div><span>{currentLabel}</span><small>{new Date(current.completedAt).toLocaleDateString('zh-CN')}</small></div><ProfileRadar profile={current} compact /></article>
      </div>
      <div className="assessment-deltas">
        {deltas.map((item) => <span className={item.value > 0 ? 'up' : item.value < 0 ? 'down' : ''} key={item.key}>{item.label}<strong>{item.value > 0 ? '+' : ''}{item.value}</strong></span>)}
      </div>
      {showPracticeEffect && <p className="practice-effect-note"><strong>可能包含练习熟悉效应</strong>前几次复测的提高可能部分来自更熟悉规则、操作和搜索策略，当前只解释为任务表现变化。</p>}
      <div className={`comparison-quality ${comparability.quality}`}>
        <strong>{comparability.quality === 'good' ? '测评条件较一致' : '两次测评的可比性需要谨慎'}</strong>
        <p>{comparability.issues.length ? comparability.issues.join('；') : '设备、输入方式和自评状态没有记录到明显差异。'}</p>
      </div>
    </div>
  )
}
