import type { TaskAdaptationState, TaskResult, TaskType, TrainingSession } from '../types'

export interface AdaptiveEvidence {
  sampleCount: number
  averageAccuracy: number
  averageReactionMs: number
  reactionVariation: number
  omissionRate: number
  commissionRate: number
  outcome: TaskAdaptationState['lastOutcome']
}

export interface AdaptiveDecision {
  nextLevel: number
  direction: 'up' | 'down' | 'same'
  reason: string
  nextState: TaskAdaptationState
  evidence: AdaptiveEvidence
}

export interface SchulteDifficultyConfig {
  gridSize: number
  targetIntervalMs: number
  distractorIntensity: 0 | 1 | 2
}

export interface GoNoGoDifficultyConfig {
  trialCount: number
  displayTimeMs: number
  gapMs: number
  noGoRatio: number
  rule: 'shape' | 'color'
}

export interface VigilanceDifficultyConfig {
  trialCount: number
  displayTimeMs: number
  gapMs: number
  targetRatio: number
}

export interface StroopDifficultyConfig {
  trialCount: number
  congruentRatio: number
  colorCount: number
  responseDeadlineMs: number
}

const speedBenchmarks: Record<TaskType, number[]> = {
  schulte: [1400, 1200, 1050, 950, 850],
  'go-no-go': [680, 620, 570, 530, 500],
  vigilance: [740, 680, 630, 590, 550],
  stroop: [1250, 1100, 980, 880, 800],
}

export function createTaskAdaptationState(): TaskAdaptationState {
  return {
    qualifiedWindows: 0,
    difficultWindows: 0,
    protectionRemaining: 0,
    lastOutcome: 'insufficient',
  }
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function coefficientOfVariation(values: number[]) {
  if (values.length < 2) return 0
  const mean = average(values)
  if (!mean) return 0
  const variance = average(values.map((value) => (value - mean) ** 2))
  return Math.sqrt(variance) / mean
}

function trialCount(item: Pick<TaskResult, 'accuracy' | 'errors' | 'metadata'>) {
  const metadataCount = Number(item.metadata?.trialCount)
  if (Number.isFinite(metadataCount) && metadataCount > 0) return metadataCount
  if (item.accuracy >= 1) return Math.max(1, item.errors + 20)
  return Math.max(1, Math.round(item.errors / Math.max(0.01, 1 - item.accuracy)))
}

function evidenceFor(taskType: TaskType, level: number, items: Array<TaskResult | TrainingSession>): AdaptiveEvidence {
  const sampleCount = items.length
  const averageAccuracy = average(items.map((item) => item.accuracy))
  const reactions = items.map((item) => item.medianReactionMs).filter((value) => value > 0)
  const averageReactionMs = average(reactions)
  const reactionVariation = coefficientOfVariation(reactions)
  const trials = items.reduce((sum, item) => sum + trialCount(item), 0)
  const omissionRate = trials ? items.reduce((sum, item) => sum + item.omissions, 0) / trials : 0
  const commissionRate = trials ? items.reduce((sum, item) => sum + item.commissions, 0) / trials : 0
  const benchmark = speedBenchmarks[taskType][Math.max(0, Math.min(4, level - 1))]

  let outcome: AdaptiveEvidence['outcome'] = 'stable'
  if (sampleCount < 3) {
    outcome = 'insufficient'
  } else if (
    averageAccuracy >= 0.9
    && omissionRate <= 0.05
    && commissionRate <= 0.06
    && reactionVariation <= 0.22
    && (!averageReactionMs || averageReactionMs <= benchmark * 1.15)
  ) {
    outcome = 'qualified'
  } else if (
    averageAccuracy < 0.75
    || omissionRate > 0.15
    || commissionRate > 0.15
    || (reactionVariation > 0.35 && averageAccuracy < 0.85)
    || (averageReactionMs > benchmark * 1.6 && averageAccuracy < 0.85)
  ) {
    outcome = 'difficult'
  }

  return { sampleCount, averageAccuracy, averageReactionMs, reactionVariation, omissionRate, commissionRate, outcome }
}

function evidenceSummary(evidence: AdaptiveEvidence) {
  const accuracy = Math.round(evidence.averageAccuracy * 100)
  const variation = Math.round(evidence.reactionVariation * 100)
  return `最近 ${evidence.sampleCount} 次平均正确率 ${accuracy}%，反应波动 ${variation}%`
}

export function evaluateAdaptiveDifficulty(
  taskType: TaskType,
  currentLevel: number,
  history: TrainingSession[],
  result: TaskResult,
  state: TaskAdaptationState = createTaskAdaptationState(),
): AdaptiveDecision {
  const recent = [...history]
    .filter((item) => item.taskType === taskType)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .slice(-2)
  const evidence = evidenceFor(taskType, currentLevel, [...recent, result])

  if (evidence.outcome === 'insufficient') {
    return {
      nextLevel: currentLevel,
      direction: 'same',
      reason: `还需要 ${3 - evidence.sampleCount} 次记录才能形成首个滚动窗口，暂时保持等级 ${currentLevel}。`,
      nextState: { ...state, lastOutcome: 'insufficient' },
      evidence,
    }
  }

  if (state.protectionRemaining > 0) {
    const remaining = state.protectionRemaining - 1
    return {
      nextLevel: currentLevel,
      direction: 'same',
      reason: `${evidenceSummary(evidence)}。当前处于升级保护期，等级 ${currentLevel} 保持不变${remaining ? `，还剩 ${remaining} 次保护` : '，保护期在本次后结束'}。`,
      nextState: {
        ...state,
        qualifiedWindows: 0,
        difficultWindows: 0,
        protectionRemaining: remaining,
        lastOutcome: 'protected',
      },
      evidence: { ...evidence, outcome: 'protected' },
    }
  }

  if (evidence.outcome === 'qualified') {
    const qualifiedWindows = state.qualifiedWindows + 1
    if (qualifiedWindows >= 2 && currentLevel < 5) {
      return {
        nextLevel: currentLevel + 1,
        direction: 'up',
        reason: `${evidenceSummary(evidence)}，已连续 2 个滚动窗口稳定达标；下一次提升到等级 ${currentLevel + 1}，并进入 2 次保护期。`,
        nextState: {
          qualifiedWindows: 0,
          difficultWindows: 0,
          protectionRemaining: 2,
          lastOutcome: 'qualified',
          lastChangedAt: new Date().toISOString(),
        },
        evidence,
      }
    }
    return {
      nextLevel: currentLevel,
      direction: 'same',
      reason: currentLevel >= 5
        ? `${evidenceSummary(evidence)}，当前已是最高等级 5。`
        : `${evidenceSummary(evidence)}，本次是连续达标的第 ${qualifiedWindows}/2 个窗口；再稳定一次才升级。`,
      nextState: { ...state, qualifiedWindows, difficultWindows: 0, lastOutcome: 'qualified' },
      evidence,
    }
  }

  if (evidence.outcome === 'difficult') {
    const difficultWindows = state.difficultWindows + 1
    if (difficultWindows >= 2 && currentLevel > 1) {
      return {
        nextLevel: currentLevel - 1,
        direction: 'down',
        reason: `${evidenceSummary(evidence)}，已连续 2 个滚动窗口显示当前难度偏高；下一次降低到等级 ${currentLevel - 1}。`,
        nextState: {
          qualifiedWindows: 0,
          difficultWindows: 0,
          protectionRemaining: 0,
          lastOutcome: 'difficult',
          lastChangedAt: new Date().toISOString(),
        },
        evidence,
      }
    }
    return {
      nextLevel: currentLevel,
      direction: 'same',
      reason: currentLevel <= 1
        ? `${evidenceSummary(evidence)}，当前已是最低等级 1，继续保持并恢复稳定。`
        : `${evidenceSummary(evidence)}，本次是明显困难的第 ${difficultWindows}/2 个窗口；再出现一次才降级。`,
      nextState: { ...state, qualifiedWindows: 0, difficultWindows, lastOutcome: 'difficult' },
      evidence,
    }
  }

  return {
    nextLevel: currentLevel,
    direction: 'same',
    reason: `${evidenceSummary(evidence)}，尚未连续达到升级或降级条件，保持等级 ${currentLevel}。`,
    nextState: { ...state, qualifiedWindows: 0, difficultWindows: 0, lastOutcome: 'stable' },
    evidence,
  }
}

export function getSchulteDifficulty(level: number): SchulteDifficultyConfig {
  return [
    { gridSize: 4, targetIntervalMs: 1500, distractorIntensity: 0 },
    { gridSize: 5, targetIntervalMs: 1300, distractorIntensity: 0 },
    { gridSize: 5, targetIntervalMs: 1100, distractorIntensity: 1 },
    { gridSize: 6, targetIntervalMs: 950, distractorIntensity: 1 },
    { gridSize: 6, targetIntervalMs: 850, distractorIntensity: 2 },
  ][Math.max(0, Math.min(4, level - 1))] as SchulteDifficultyConfig
}

export function getGoNoGoDifficulty(level: number): GoNoGoDifficultyConfig {
  return [
    { trialCount: 32, displayTimeMs: 700, gapMs: 300, noGoRatio: 0.25, rule: 'shape' },
    { trialCount: 36, displayTimeMs: 630, gapMs: 270, noGoRatio: 0.22, rule: 'shape' },
    { trialCount: 40, displayTimeMs: 560, gapMs: 230, noGoRatio: 0.19, rule: 'shape' },
    { trialCount: 44, displayTimeMs: 500, gapMs: 190, noGoRatio: 0.17, rule: 'color' },
    { trialCount: 48, displayTimeMs: 440, gapMs: 160, noGoRatio: 0.15, rule: 'color' },
  ][Math.max(0, Math.min(4, level - 1))] as GoNoGoDifficultyConfig
}

export function getVigilanceDifficulty(level: number): VigilanceDifficultyConfig {
  return [
    { trialCount: 28, displayTimeMs: 780, gapMs: 340, targetRatio: 0.29 },
    { trialCount: 32, displayTimeMs: 700, gapMs: 300, targetRatio: 0.25 },
    { trialCount: 36, displayTimeMs: 620, gapMs: 260, targetRatio: 0.22 },
    { trialCount: 42, displayTimeMs: 550, gapMs: 220, targetRatio: 0.18 },
    { trialCount: 48, displayTimeMs: 480, gapMs: 180, targetRatio: 0.15 },
  ][Math.max(0, Math.min(4, level - 1))] as VigilanceDifficultyConfig
}

export function getStroopDifficulty(level: number): StroopDifficultyConfig {
  return [
    { trialCount: 20, congruentRatio: 0.5, colorCount: 3, responseDeadlineMs: 0 },
    { trialCount: 24, congruentRatio: 0.42, colorCount: 4, responseDeadlineMs: 0 },
    { trialCount: 28, congruentRatio: 0.34, colorCount: 4, responseDeadlineMs: 2200 },
    { trialCount: 32, congruentRatio: 0.25, colorCount: 4, responseDeadlineMs: 1700 },
    { trialCount: 36, congruentRatio: 0.2, colorCount: 4, responseDeadlineMs: 1400 },
  ][Math.max(0, Math.min(4, level - 1))] as StroopDifficultyConfig
}
