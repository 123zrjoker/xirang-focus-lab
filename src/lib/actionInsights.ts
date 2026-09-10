import type { AppState, DistractionReason, FocusSession } from '../types'
import { rangeStart, type ProgressRange } from './progressAnalytics'

export interface ActionInsightSummary {
  recordedTodoCount: number
  startedTodoCount: number
  startRate: number | null
  focusCount: number
  averageResistance: number | null
  resistanceSampleCount: number
  averageCompletion: number | null
  nextStepCount: number
  nextStepRate: number | null
  directStartCount: number
  assistedStartCount: number
  averageDistractions: number | null
  distractionBreakdown: { reason: DistractionReason; label: string; count: number }[]
  continuations: { id: string; taskName: string; nextStep: string; completedAt: string }[]
  stalledTodos: { id: string; title: string; daysWaiting: number }[]
  sampleTone: 'empty' | 'limited' | 'growing' | 'reviewable'
  sampleLabel: string
  sampleHint: string
  observations: string[]
}

const distractionLabels: Record<DistractionReason, string> = {
  phone: '手机',
  environment: '环境',
  difficulty: '任务难度',
  fatigue: '疲劳',
  other: '其他',
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function isInRange(value: string, range: ProgressRange, now: Date) {
  const timestamp = Date.parse(value)
  const start = rangeStart(range, now)
  return Number.isFinite(timestamp) && timestamp <= now.getTime() && (!start || timestamp >= start.getTime())
}

function sampleDescription(focusCount: number) {
  if (focusCount === 0) return {
    sampleTone: 'empty' as const,
    sampleLabel: '等待行动记录',
    sampleHint: '还没有保存现实专注。继续正常使用即可，不需要为了生成洞察而额外记录。',
  }
  if (focusCount < 5) return {
    sampleTone: 'limited' as const,
    sampleLabel: '样本较少',
    sampleHint: `目前只有 ${focusCount} 次现实专注，只展示事实，不比较哪种方法更好。`,
  }
  if (focusCount < 12) return {
    sampleTone: 'growing' as const,
    sampleLabel: '初步观察',
    sampleHint: `已有 ${focusCount} 次现实专注，可以观察近期倾向，但仍不能解释因果。`,
  }
  return {
    sampleTone: 'reviewable' as const,
    sampleLabel: '可做阶段回顾',
    sampleHint: `已有 ${focusCount} 次现实专注，适合回顾个人近期模式；结论仍只适用于这段历史。`,
  }
}

function buildObservations(
  recordedTodoCount: number,
  startedTodoCount: number,
  startRate: number | null,
  focusSessions: FocusSession[],
  averageResistance: number | null,
  nextStepRate: number | null,
  distractionBreakdown: ActionInsightSummary['distractionBreakdown'],
) {
  const observations: string[] = []
  if (recordedTodoCount > 0) {
    observations.push(`${recordedTodoCount} 项新待办中，有 ${startedTodoCount} 项已经进入当前行动或留下专注记录${startRate === null ? '' : `（${startRate}%）`}。`)
  }
  if (focusSessions.length) {
    const completion = average(focusSessions.map((item) => item.completionRate)) ?? 0
    if (completion >= 80) observations.push(`现实专注平均完成度为 ${Math.round(completion)}%，这段时间多数任务按预期推进。`)
    else if (completion < 50) observations.push(`现实专注平均完成度为 ${Math.round(completion)}%，可以先观察任务范围或计划时长是否偏大。`)
    else observations.push(`现实专注平均完成度为 ${Math.round(completion)}%，任务通常有所推进，但并非每次都能完成。`)
  }
  if (averageResistance !== null && averageResistance >= 2.3) {
    observations.push(`通过启动舱开始前的平均抗拒为 ${averageResistance.toFixed(1)}/3，近期开始阻力偏高。`)
  }
  if (nextStepRate !== null && nextStepRate >= 60) {
    observations.push(`${nextStepRate}% 的现实专注留下了下一步，后续继续时有较明确的入口。`)
  }
  const topDistraction = distractionBreakdown[0]
  if (topDistraction && topDistraction.count >= 2) {
    observations.push(`已分类的分心中，“${topDistraction.label}”记录最多，共 ${topDistraction.count} 次。`)
  }
  if (!observations.length) observations.push('目前还没有足够的行动记录。完成一次现实专注后，这里会开始形成个人观察。')
  return observations.slice(0, 4)
}

export function buildActionInsights(state: AppState, range: ProgressRange, now = new Date()): ActionInsightSummary {
  const rangeFocus = state.focusSessions.filter((item) => isInRange(item.completedAt, range, now))
  const rangeTodos = state.actionSlips.filter((item) => isInRange(item.createdAt, range, now))
  const rangeLaunches = state.focusLaunches.filter((item) => isInRange(item.completedAt ?? item.createdAt, range, now))
  const startedIds = new Set(rangeFocus.flatMap((item) => item.actionSlipId ? [item.actionSlipId] : []))
  state.actionSlips.filter((item) => item.status === 'current').forEach((item) => startedIds.add(item.id))
  const startedTodoCount = rangeTodos.filter((item) => startedIds.has(item.id)).length
  const startRate = rangeTodos.length ? Math.round((startedTodoCount / rangeTodos.length) * 100) : null

  const resistanceValues = rangeLaunches
    .filter((item) => item.status === 'focusing' || item.status === 'completed')
    .map((item) => item.resistanceBefore)
  const averageResistance = average(resistanceValues)
  const averageCompletion = average(rangeFocus.map((item) => item.completionRate))
  const nextStepCount = rangeFocus.filter((item) => Boolean(item.nextStep?.trim())).length
  const nextStepRate = rangeFocus.length ? Math.round((nextStepCount / rangeFocus.length) * 100) : null
  const linkedFocus = rangeFocus.filter((item) => item.actionSlipId)
  const directStartCount = linkedFocus.filter((item) => !item.launchId).length
  const assistedStartCount = linkedFocus.filter((item) => item.launchId).length
  const averageDistractions = average(rangeFocus.map((item) => item.distractionCount))

  const reasonCounts = new Map<DistractionReason, number>()
  rangeFocus.flatMap((item) => item.distractions).forEach((item) => {
    reasonCounts.set(item.reason, (reasonCounts.get(item.reason) ?? 0) + 1)
  })
  const distractionBreakdown = ([...reasonCounts.entries()] as [DistractionReason, number][])
    .map(([reason, count]) => ({ reason, label: distractionLabels[reason], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))

  const continuations = rangeFocus
    .filter((item): item is FocusSession & { nextStep: string } => Boolean(item.nextStep?.trim()))
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, 4)
    .map((item) => ({ id: item.id, taskName: item.taskName, nextStep: item.nextStep.trim(), completedAt: item.completedAt }))

  const stalledTodos = state.actionSlips
    .filter((item) => item.status === 'inbox')
    .map((item) => ({
      id: item.id,
      title: item.title,
      daysWaiting: Math.floor((now.getTime() - Date.parse(item.updatedAt)) / 86_400_000),
    }))
    .filter((item) => item.daysWaiting >= 7)
    .sort((a, b) => b.daysWaiting - a.daysWaiting)
    .slice(0, 4)

  const sample = sampleDescription(rangeFocus.length)
  return {
    recordedTodoCount: rangeTodos.length,
    startedTodoCount,
    startRate,
    focusCount: rangeFocus.length,
    averageResistance,
    resistanceSampleCount: resistanceValues.length,
    averageCompletion,
    nextStepCount,
    nextStepRate,
    directStartCount,
    assistedStartCount,
    averageDistractions,
    distractionBreakdown,
    continuations,
    stalledTodos,
    ...sample,
    observations: buildObservations(
      rangeTodos.length,
      startedTodoCount,
      startRate,
      rangeFocus,
      averageResistance,
      nextStepRate,
      distractionBreakdown,
    ),
  }
}
