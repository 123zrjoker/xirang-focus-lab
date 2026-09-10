import type { AppState, FocusSession, TaskType, TrainingSession } from '../types'

export type ProgressRange = '7d' | '30d' | 'all'

export interface WeeklyProgress {
  trainingCount: number
  focusCount: number
  trainingMinutes: number
  focusMinutes: number
  completedMinutes: number
  targetMinutes: number
  elapsedTargetMinutes: number
  progress: number
  onTrack: boolean
  activeDays: number
  summary: string
}

export interface ActivityDay {
  key: string
  date: Date
  minutes: number
  trainingCount: number
  focusCount: number
  intensity: 0 | 1 | 2 | 3 | 4
}

const taskTypes: TaskType[] = ['schulte', 'vigilance', 'go-no-go', 'stroop']

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

export function localDateKey(input: Date | string) {
  const date = input instanceof Date ? input : new Date(input)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfDay(input: Date) {
  const date = new Date(input)
  date.setHours(0, 0, 0, 0)
  return date
}

export function rangeStart(range: ProgressRange, now = new Date()) {
  if (range === 'all') return undefined
  const date = startOfDay(now)
  date.setDate(date.getDate() - (range === '7d' ? 6 : 29))
  return date
}

export function filterByRange<T extends { completedAt: string }>(items: T[], range: ProgressRange, now = new Date()) {
  const start = rangeStart(range, now)
  const endTime = now.getTime()
  return items.filter((item) => {
    const timestamp = new Date(item.completedAt).getTime()
    return timestamp <= endTime && (!start || timestamp >= start.getTime())
  })
}

function weekStart(now: Date) {
  const start = startOfDay(now)
  const mondayOffset = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - mondayOffset)
  return start
}

function taskTrendSentence(sessions: TrainingSession[]) {
  const groups = taskTypes
    .map((taskType) => ({ taskType, items: sessions.filter((item) => item.taskType === taskType) }))
    .sort((a, b) => b.items.length - a.items.length)
  const strongest = groups.find((group) => group.items.length >= 3)
  if (!strongest) return '本周单项训练记录还不足 3 次，暂不判断长期变化。'

  const ordered = [...strongest.items].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
  const splitAt = Math.floor(ordered.length / 2)
  const earlier = ordered.slice(0, splitAt)
  const later = ordered.slice(splitAt)
  const earlierAccuracy = average(earlier.map((item) => item.accuracy))
  const laterAccuracy = average(later.map((item) => item.accuracy))
  const accuracyDelta = (laterAccuracy - earlierAccuracy) * 100
  const earlierReaction = average(earlier.map((item) => item.medianReactionMs).filter(Boolean))
  const laterReaction = average(later.map((item) => item.medianReactionMs).filter(Boolean))
  const reactionDelta = earlierReaction && laterReaction ? ((earlierReaction - laterReaction) / earlierReaction) * 100 : 0
  const label = {
    schulte: '舒尔特方格',
    vigilance: '持续注意',
    'go-no-go': '反应抑制',
    stroop: '抗干扰',
  }[strongest.taskType]

  const accuracyText = accuracyDelta >= 3
    ? '正确率有所提高'
    : accuracyDelta <= -3
      ? '正确率较前半周下降'
      : '正确率趋于稳定'
  const reactionText = !earlierReaction || !laterReaction
    ? '反应速度记录不足'
    : reactionDelta >= 8
      ? '后半周反应更快'
      : reactionDelta <= -8
        ? '后半周反应速度有所下降'
        : '反应速度变化不大'
  return `${label}${accuracyText}，${reactionText}。`
}

function recommendationSentence(
  training: TrainingSession[],
  focus: FocusSession[],
  goalProgress: number,
) {
  if (!training.length && !focus.length) return '下周建议先安排一次短训练和一次现实专注，建立可比较的起点。'
  const averageAccuracy = average(training.map((item) => item.accuracy))
  const averageCompletion = average(focus.map((item) => item.completionRate))
  const averageDistractions = average(focus.map((item) => item.distractionCount))

  if (training.length && averageAccuracy < 0.75) return '下周建议保持当前难度，先恢复准确率和稳定节奏。'
  if (focus.length && averageDistractions >= 2) return '下周建议保持训练节奏，并在专注前优先处理手机和环境干扰。'
  if (focus.length && averageCompletion < 70) return '下周建议把现实任务拆小，先提高每轮专注的完成度。'
  if (goalProgress < 60) return '下周建议先固定 2～3 个可执行时段，逐步接近每周投入目标。'
  if (goalProgress >= 100) return '下周建议延续当前频率，在不牺牲准确率的前提下保持难度。'
  return '下周建议保持当前难度和训练频率，继续积累稳定记录。'
}

export function buildWeeklyProgress(state: AppState, now = new Date()): WeeklyProgress {
  const start = weekStart(now)
  const endTime = now.getTime()
  const training = state.sessions.filter((item) => {
    const timestamp = new Date(item.completedAt).getTime()
    return timestamp >= start.getTime() && timestamp <= endTime
  })
  const focus = state.focusSessions.filter((item) => {
    const timestamp = new Date(item.completedAt).getTime()
    return timestamp >= start.getTime() && timestamp <= endTime
  })
  const rawTrainingMinutes = training.reduce((sum, item) => sum + item.durationSec, 0) / 60
  const rawFocusMinutes = focus.reduce((sum, item) => sum + item.actualDurationSec, 0) / 60
  const rawCompletedMinutes = rawTrainingMinutes + rawFocusMinutes
  const trainingMinutes = rawTrainingMinutes > 0 ? Math.max(1, Math.round(rawTrainingMinutes)) : 0
  const focusMinutes = rawFocusMinutes > 0 ? Math.max(1, Math.round(rawFocusMinutes)) : 0
  const completedMinutes = rawCompletedMinutes > 0 ? Math.max(1, Math.round(rawCompletedMinutes)) : 0
  const targetMinutes = state.profile.dailyTargetMinutes * 7
  const elapsedDays = ((startOfDay(now).getTime() - start.getTime()) / 86400000) + 1
  const elapsedTargetMinutes = state.profile.dailyTargetMinutes * elapsedDays
  const progress = targetMinutes ? Math.round((rawCompletedMinutes / targetMinutes) * 100) : 0
  const activeDays = new Set([...training, ...focus].map((item) => localDateKey(item.completedAt))).size
  const countSentence = `本周完成 ${training.length} 次训练和 ${focus.length} 次现实专注，累计投入 ${completedMinutes} 分钟。`
  const summary = `${countSentence}${taskTrendSentence(training)}${recommendationSentence(training, focus, progress)}`

  return {
    trainingCount: training.length,
    focusCount: focus.length,
    trainingMinutes,
    focusMinutes,
    completedMinutes,
    targetMinutes,
    elapsedTargetMinutes,
    progress,
    onTrack: rawCompletedMinutes >= elapsedTargetMinutes,
    activeDays,
    summary,
  }
}

function alignedHeatmapStart(state: AppState, range: ProgressRange, now: Date) {
  const explicitStart = rangeStart(range, now)
  const activities = [...state.sessions, ...state.focusSessions]
  const earliest = activities.length
    ? new Date(Math.min(...activities.map((item) => Date.parse(item.completedAt))))
    : now
  let start = explicitStart ?? startOfDay(earliest)
  if (range === 'all') {
    const limit = startOfDay(now)
    limit.setDate(limit.getDate() - 167)
    if (start < limit) start = limit
  }
  start = startOfDay(start)
  const mondayOffset = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - mondayOffset)
  return start
}

export function buildActivityHeatmap(state: AppState, range: ProgressRange, now = new Date()): ActivityDay[] {
  const start = alignedHeatmapStart(state, range, now)
  const end = startOfDay(now)
  const trainingByDay = new Map<string, TrainingSession[]>()
  const focusByDay = new Map<string, FocusSession[]>()

  state.sessions.forEach((item) => {
    const key = localDateKey(item.completedAt)
    trainingByDay.set(key, [...(trainingByDay.get(key) ?? []), item])
  })
  state.focusSessions.forEach((item) => {
    const key = localDateKey(item.completedAt)
    focusByDay.set(key, [...(focusByDay.get(key) ?? []), item])
  })

  const days: ActivityDay[] = []
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = new Date(cursor)
    const key = localDateKey(date)
    const training = trainingByDay.get(key) ?? []
    const focus = focusByDay.get(key) ?? []
    const minutes = (
      training.reduce((sum, item) => sum + item.durationSec, 0)
      + focus.reduce((sum, item) => sum + item.actualDurationSec, 0)
    ) / 60
    const ratio = state.profile.dailyTargetMinutes ? minutes / state.profile.dailyTargetMinutes : 0
    const intensity: ActivityDay['intensity'] = minutes <= 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 1 ? 3 : 4
    days.push({
      key,
      date,
      minutes: minutes > 0 ? Math.max(1, Math.round(minutes)) : 0,
      trainingCount: training.length,
      focusCount: focus.length,
      intensity,
    })
  }
  return days
}
