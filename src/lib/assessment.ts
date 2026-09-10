import type {
  AssessmentContext,
  AssessmentKind,
  AssessmentRecord,
  AttentionProfile,
  TrainingSession,
} from '../types'

export interface RetestStatus {
  lastFormal?: AssessmentRecord
  daysSince: number
  trainingCount: number
  recommended: boolean
  nextKind: Exclude<AssessmentKind, 'baseline'>
  reason: string
}

export interface AssessmentComparability {
  quality: 'good' | 'caution'
  issues: string[]
}

export const assessmentDimensions: Array<{ key: keyof Omit<AttentionProfile, 'completedAt'>; label: string }> = [
  { key: 'visualSearch', label: '视觉搜索' },
  { key: 'sustainedAttention', label: '持续稳定' },
  { key: 'interferenceControl', label: '抗干扰' },
  { key: 'responseInhibition', label: '反应抑制' },
]

export function assessmentKindLabel(kind: AssessmentKind) {
  return {
    baseline: '初始基线',
    retest: '阶段复测',
    'quick-check': '快速检查',
  }[kind]
}

export function getFormalAssessments(assessments: AssessmentRecord[]) {
  return [...assessments]
    .filter((item) => item.kind !== 'quick-check')
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
}

export function getRetestStatus(
  assessments: AssessmentRecord[],
  sessions: TrainingSession[],
  now = new Date(),
): RetestStatus {
  const formal = getFormalAssessments(assessments)
  const lastFormal = formal[formal.length - 1]
  if (!lastFormal) {
    return {
      daysSince: 0,
      trainingCount: 0,
      recommended: false,
      nextKind: 'retest',
      reason: '完成初始测评后，系统才会开始计算阶段复测时间。',
    }
  }

  const lastTime = Date.parse(lastFormal.completedAt)
  const nowTime = now.getTime()
  const legacyAssessmentGracePeriod = 15 * 60 * 1000
  const daysSince = Math.max(0, Math.floor((nowTime - lastTime) / 86400000))
  const trainingCount = sessions.filter((item) => {
    const timestamp = Date.parse(item.completedAt)
    return timestamp > lastTime + legacyAssessmentGracePeriod && timestamp <= nowTime
  }).length
  const nextKind: RetestStatus['nextKind'] = daysSince < 14 ? 'quick-check' : 'retest'

  if (daysSince >= 42) {
    return { lastFormal, daysSince, trainingCount, recommended: true, nextKind, reason: '距离上次正式测评已满 42 天，建议完成一次阶段复测。' }
  }
  if (daysSince >= 28 && trainingCount >= 8) {
    return { lastFormal, daysSince, trainingCount, recommended: true, nextKind, reason: '已满 28 天且完成至少 8 次训练，适合进行阶段复测。' }
  }
  if (daysSince >= 21 && trainingCount >= 20) {
    return { lastFormal, daysSince, trainingCount, recommended: true, nextKind, reason: '训练已达到 20 次且间隔不少于 21 天，建议高频用户进行阶段复测。' }
  }
  if (daysSince < 14) {
    return {
      lastFormal,
      daysSince,
      trainingCount,
      recommended: false,
      nextKind,
      reason: `距离上次正式测评仅 ${daysSince} 天，现在手动测评会保存为“快速检查”，不替代正式阶段记录。`,
    }
  }
  if (trainingCount >= 20 && daysSince < 21) {
    return {
      lastFormal,
      daysSince,
      trainingCount,
      recommended: false,
      nextKind,
      reason: `已经完成 20 次训练，再过 ${21 - daysSince} 天达到高频用户复测条件；现在仍可手动发起。`,
    }
  }
  if (daysSince >= 28 && trainingCount < 8) {
    return {
      lastFormal,
      daysSince,
      trainingCount,
      recommended: false,
      nextKind,
      reason: `再完成 ${8 - trainingCount} 次训练即可达到默认条件；若保持低频，${42 - daysSince} 天后仍会提示阶段复测。`,
    }
  }

  const daysToDefault = Math.max(0, 28 - daysSince)
  const sessionsToDefault = Math.max(0, 8 - trainingCount)
  const requirements = [
    daysToDefault ? `再过 ${daysToDefault} 天` : '',
    sessionsToDefault ? `再完成 ${sessionsToDefault} 次训练` : '',
  ].filter(Boolean).join('并')
  return {
    lastFormal,
    daysSince,
    trainingCount,
    recommended: false,
    nextKind,
    reason: requirements ? `${requirements}后达到默认复测条件；现在仍可手动发起。` : '现在可以手动发起阶段复测。',
  }
}

export function compareAssessmentContexts(
  previous?: AssessmentContext,
  current?: AssessmentContext,
): AssessmentComparability {
  if (!current) return { quality: 'caution', issues: ['本次没有环境记录，无法完整判断可比性。'] }
  const issues: string[] = []
  if (!previous) issues.push('上一次测评没有环境记录，本次只能作为新的环境参照。')
  if (previous && previous.device !== current.device) issues.push('本次使用的设备类型与上次不同。')
  if (previous && previous.inputMethod !== current.inputMethod) issues.push('本次输入方式与上次不同。')
  if (previous && Math.abs(previous.sleepQuality - current.sleepQuality) >= 2) issues.push('两次测评的睡眠状态差异较大。')
  if (previous && Math.abs(previous.fatigueLevel - current.fatigueLevel) >= 2) issues.push('两次测评的疲劳状态差异较大。')
  if (previous && previous.environment !== current.environment) issues.push('两次测评的环境干扰程度不同。')
  if (current.sleepQuality === 1) issues.push('本次睡眠不足，反应速度可能受到影响。')
  if (current.fatigueLevel === 3) issues.push('本次疲劳明显，结果可能低估平时状态。')
  if (current.environment === 'disrupted') issues.push('本次环境干扰明显。')
  if (current.interrupted) issues.push('测评过程受到中断。')
  return { quality: issues.length ? 'caution' : 'good', issues }
}

export function getProfileDeltas(current: AttentionProfile, previous: AttentionProfile) {
  return assessmentDimensions.map((dimension) => ({
    ...dimension,
    value: current[dimension.key] - previous[dimension.key],
  }))
}

export function shouldShowPracticeEffect(assessments: AssessmentRecord[], current?: AssessmentRecord) {
  if (current?.kind === 'quick-check') return true
  const retests = assessments.filter((item) => item.kind === 'retest')
  return retests.length <= 3
}
