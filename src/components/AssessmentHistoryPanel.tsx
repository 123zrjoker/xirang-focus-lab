import {
  assessmentKindLabel,
  getFormalAssessments,
  getRetestStatus,
  shouldShowPracticeEffect,
} from '../lib/assessment'
import type { AssessmentRecord, TrainingSession } from '../types'
import { AssessmentComparison } from './AssessmentComparison'
import { ProfileRadar } from './ProfileRadar'

interface AssessmentHistoryPanelProps {
  assessments: AssessmentRecord[]
  sessions: TrainingSession[]
  onStartRetest: () => void
}

export function AssessmentHistoryPanel({ assessments, sessions, onStartRetest }: AssessmentHistoryPanelProps) {
  const ordered = [...assessments].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
  const formal = getFormalAssessments(ordered)
  const baseline = formal[0]
  const latestFormal = formal[formal.length - 1]
  const status = getRetestStatus(assessments, sessions)

  if (!baseline) return null

  return (
    <section className="assessment-history-panel card-surface">
      <div className="assessment-history-heading">
        <div><p className="eyebrow">阶段复测</p><h2>让个人基线拥有时间维度</h2><p>正式复测与日常训练分开保存，快速检查不会替代阶段记录。</p></div>
        <div className={`retest-status ${status.recommended ? 'recommended' : ''}`}>
          <span>{status.recommended ? '建议复测' : status.nextKind === 'quick-check' ? '当前为快速检查' : '复测进度'}</span>
          <strong>{status.daysSince}<small>天</small> · {status.trainingCount}<small>次训练</small></strong>
          <p>{status.reason}</p>
          <button className="button primary" type="button" onClick={onStartRetest}>{status.nextKind === 'quick-check' ? '手动快速检查' : '开始阶段复测'} →</button>
        </div>
      </div>

      {latestFormal && latestFormal.id !== baseline.id ? (
        <AssessmentComparison
          previous={baseline.profile}
          current={latestFormal.profile}
          previousContext={baseline.context}
          currentContext={latestFormal.context}
          previousLabel="第一次基线"
          currentLabel="最近正式复测"
          showPracticeEffect={shouldShowPracticeEffect(assessments, latestFormal)}
        />
      ) : (
        <div className="assessment-baseline-only">
          <div><span>当前只有第一次基线</span><h3>{new Date(baseline.completedAt).toLocaleDateString('zh-CN')}</h3><p>完成第一次正式复测后，这里会并列展示雷达图和四项变化量。</p></div>
          <ProfileRadar profile={baseline.profile} compact />
        </div>
      )}

      <div className="assessment-history-list">
        <div><strong>历次测评</strong><span>共 {ordered.length} 次</span></div>
        {ordered.slice().reverse().map((record) => (
          <article key={record.id}>
            <span className={record.kind}>{assessmentKindLabel(record.kind)}</span>
            <div><strong>{new Date(record.completedAt).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })}</strong><small>{record.context ? '已记录设备与状态' : '旧记录 · 无环境信息'}</small></div>
            <div className="history-profile-values"><span>视觉 {record.profile.visualSearch}</span><span>稳定 {record.profile.sustainedAttention}</span><span>抗干扰 {record.profile.interferenceControl}</span><span>抑制 {record.profile.responseInhibition}</span></div>
          </article>
        ))}
      </div>
    </section>
  )
}
