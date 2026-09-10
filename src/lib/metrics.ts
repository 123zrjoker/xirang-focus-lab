import type { AppState, TaskResult, TaskType } from '../types'

export function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

export function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

export function shuffle<T>(items: T[]) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

export function scoreResult(result: Omit<TaskResult, 'score'>) {
  const accuracyScore = result.accuracy * 75
  const speedTarget: Record<TaskType, number> = {
    schulte: 900,
    'go-no-go': 480,
    vigilance: 550,
    stroop: 850,
  }
  const speed = result.medianReactionMs
    ? clamp((speedTarget[result.taskType] / result.medianReactionMs) * 100)
    : 60
  return Math.round(clamp(accuracyScore + speed * 0.25))
}

export function isSameLocalDay(iso: string, date = new Date()) {
  const item = new Date(iso)
  return (
    item.getFullYear() === date.getFullYear() &&
    item.getMonth() === date.getMonth() &&
    item.getDate() === date.getDate()
  )
}

export function getStreak(state: AppState) {
  const activeDays = new Set(
    [...state.sessions, ...state.focusSessions].map((item) =>
      new Date(item.completedAt).toLocaleDateString('zh-CN'),
    ),
  )
  let streak = 0
  const cursor = new Date()
  while (activeDays.has(cursor.toLocaleDateString('zh-CN'))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

export function lastNDays(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - (count - index - 1))
    return date
  })
}

export function taskLabel(taskType: TaskType) {
  return {
    schulte: '舒尔特方格',
    'go-no-go': '反应抑制',
    vigilance: '持续注意',
    stroop: '抗干扰',
  }[taskType]
}
