import type {
  AppState,
  DailyPlan,
  DailyPlanMode,
  GoalType,
  TaskType,
  TrainingSession,
} from '../types'

const taskTypes: TaskType[] = ['schulte', 'vigilance', 'go-no-go', 'stroop']

const estimatedMinutes: Record<TaskType, number> = {
  schulte: 3,
  vigilance: 4,
  'go-no-go': 3,
  stroop: 3,
}

const goalWeights: Record<GoalType, Record<TaskType, number>> = {
  study: { schulte: 4, vigilance: 22, 'go-no-go': 8, stroop: 18 },
  work: { schulte: 20, vigilance: 9, 'go-no-go': 5, stroop: 17 },
  phone: { schulte: 3, vigilance: 14, 'go-no-go': 24, stroop: 8 },
}

const goalReasons: Record<GoalType, Partial<Record<TaskType, string>>> = {
  study: {
    vigilance: '与你的学习目标相关，练习在重复信息中保持稳定',
    stroop: '与你的学习目标相关，练习忽略无关信息',
  },
  work: {
    schulte: '与你的工作目标相关，练习快速定位关键信息',
    stroop: '与你的工作目标相关，练习在干扰下保持任务规则',
  },
  phone: {
    'go-no-go': '与你减少手机分心的目标相关，练习停住自动反应',
    vigilance: '练习发现注意离开后重新回到目标',
  },
}

const focusByGoal: Record<GoalType, { minutes: number; reason: string }> = {
  study: { minutes: 25, reason: '用一轮 25 分钟专注，把训练带回阅读、课程或备考。' },
  work: { minutes: 45, reason: '安排一段较完整的深度工作时间，只推进一个明确任务。' },
  phone: { minutes: 15, reason: '从短专注开始，并把想看手机的冲动记入分心停车场。' },
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function coefficientOfVariation(values: number[]) {
  if (values.length < 3) return 0
  const mean = average(values)
  if (!mean) return 0
  const variance = average(values.map((value) => (value - mean) ** 2))
  return Math.sqrt(variance) / mean
}

function sessionsForTask(state: AppState, taskType: TaskType) {
  return [...state.sessions]
    .filter((session) => session.taskType === taskType)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .slice(-10)
}

function recentTrend(items: TrainingSession[]) {
  if (items.length < 6) return { accuracyDrop: 0, errorsRise: 0 }
  const latest = items.slice(-3)
  const previous = items.slice(-6, -3)
  return {
    accuracyDrop: average(previous.map((item) => item.accuracy)) - average(latest.map((item) => item.accuracy)),
    errorsRise: average(latest.map((item) => item.errors)) - average(previous.map((item) => item.errors)),
  }
}

function overallFatigueSignal(state: AppState) {
  const items = [...state.sessions]
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .slice(-6)
  if (items.length < 4) return ''

  const latest = items.slice(-3)
  const previous = items.slice(0, Math.max(1, items.length - 3))
  const latestAccuracy = average(latest.map((item) => item.accuracy))
  const previousAccuracy = average(previous.map((item) => item.accuracy))
  const reactionVariation = coefficientOfVariation(
    latest.map((item) => item.medianReactionMs).filter((value) => value > 0),
  )

  if (latestAccuracy < 0.72) return '最近几次正确率偏低，今天自动减少一项训练。'
  if (previousAccuracy - latestAccuracy >= 0.08) return '最近几次正确率有所下降，今天安排较轻的组合。'
  if (reactionVariation >= 0.28) return '最近反应速度波动较大，今天优先保持稳定。'
  return ''
}

function profileScore(state: AppState, taskType: TaskType) {
  const profile = state.attentionProfile
  if (!profile) return undefined
  return {
    schulte: profile.visualSearch,
    vigilance: profile.sustainedAttention,
    'go-no-go': profile.responseInhibition,
    stroop: profile.interferenceControl,
  }[taskType]
}

function taskReason(state: AppState, taskType: TaskType) {
  const items = sessionsForTask(state, taskType)
  const recent = items.slice(-5)
  const trend = recentTrend(items)
  const accuracy = average(recent.map((item) => item.accuracy))
  const reactionVariation = coefficientOfVariation(
    recent.map((item) => item.medianReactionMs).filter((value) => value > 0),
  )
  const scores = taskTypes
    .map((type) => ({ type, score: profileScore(state, type) }))
    .filter((item): item is { type: TaskType; score: number } => item.score !== undefined)
  const weakest = [...scores].sort((a, b) => a.score - b.score)[0]?.type

  if (trend.accuracyDrop >= 0.08 || trend.errorsRise >= 1.5) return '近期失误有所增加，今天先稳住准确率'
  if (recent.length >= 3 && reactionVariation >= 0.25) return '近期反应速度波动较大，今天以稳定为主'
  if (recent.length >= 3 && accuracy < 0.8) return `最近 ${recent.length} 次正确率偏低，建议优先巩固`
  if (weakest === taskType) return '初始测评中这一维度相对薄弱，适合优先练习'
  return goalReasons[state.profile.goal][taskType] ?? '用于保持四类注意能力的训练平衡'
}

function taskPriority(state: AppState, taskType: TaskType, rotation: number) {
  const items = sessionsForTask(state, taskType)
  const recent = items.slice(-5)
  const accuracy = recent.length ? average(recent.map((item) => item.accuracy)) : 0.84
  const trend = recentTrend(items)
  const profile = profileScore(state, taskType)
  const profileNeed = profile === undefined ? 12 : (100 - profile) * 0.55
  const recentNeed = (1 - accuracy) * 55
  const trendNeed = Math.max(0, trend.accuracyDrop) * 80 + Math.max(0, trend.errorsRise) * 2
  const freshness = recent.length ? Math.min(8, Math.max(0, 5 - recent.length) * 2) : 9
  const rotationBonus = ((taskTypes.indexOf(taskType) + rotation) % taskTypes.length) * 0.15
  return profileNeed + recentNeed + trendNeed + freshness + goalWeights[state.profile.goal][taskType] + rotationBonus
}

function rotateRepeatedCombination(ranked: TaskType[], selected: TaskType[], previous?: DailyPlan) {
  if (!previous) return selected
  const currentKey = [...selected].sort().join('|')
  const previousKey = previous.items.map((item) => item.taskType).sort().join('|')
  if (currentKey !== previousKey) return selected

  const replacement = ranked.find((type) => !selected.includes(type))
  if (replacement) return [...selected.slice(0, -1), replacement]
  if (selected.length === 1 && ranked[1]) return [ranked[1]]
  return [...selected.slice(1), selected[0]]
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getTodayPlan(state: AppState, date = new Date()) {
  const key = localDateKey(date)
  return state.dailyPlans.find((plan) => plan.dateKey === key)
}

export function buildDailyPlan(state: AppState, mode: DailyPlanMode = 'standard', date = new Date()): DailyPlan {
  const dateKey = localDateKey(date)
  const rotation = date.getDate() % taskTypes.length
  const ranked = [...taskTypes].sort((a, b) => taskPriority(state, b, rotation) - taskPriority(state, a, rotation))
  const fatigueReason = mode === 'standard' ? overallFatigueSignal(state) : ''
  const itemCount = mode === 'quick' ? 1 : mode === 'low-energy' || fatigueReason ? 2 : 3
  const previous = [...state.dailyPlans]
    .filter((plan) => plan.dateKey < dateKey)
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey))[0]
  const selected = rotateRepeatedCombination(ranked, ranked.slice(0, itemCount), previous)
  const goalFocus = focusByGoal[state.profile.goal]
  const light = mode !== 'standard' || Boolean(fatigueReason)
  const focusMinutes = mode === 'quick' ? 5 : light ? Math.min(15, goalFocus.minutes) : goalFocus.minutes

  const summary = mode === 'quick'
    ? '保留今天最值得练的一项，完成后就可以停。'
    : mode === 'low-energy'
      ? '减少任务数量，今天以轻松完成和保持准确为主。'
      : fatigueReason || '根据你的目标、初始基线和最近 10 次表现生成。'

  return {
    dateKey,
    createdAt: new Date().toISOString(),
    mode,
    intensity: light ? 'light' : 'regular',
    items: selected.map((taskType) => ({
      taskType,
      estimatedMinutes: mode === 'quick' ? Math.min(3, estimatedMinutes[taskType]) : estimatedMinutes[taskType],
      reason: taskReason(state, taskType),
    })),
    focusMinutes,
    focusReason: light
      ? `今天采用轻量节奏，建议从 ${focusMinutes} 分钟现实专注开始。`
      : goalFocus.reason,
    summary,
  }
}
