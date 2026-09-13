import type { ActionSlipStatus, AppState, DailyPlanMode, DistractionReason, GoalType } from '../types'

export const AGENT_CONTEXT_SCHEMA_VERSION = 1 as const
export const DEFAULT_ACTION_SLIP_LIMIT = 20
export const DEFAULT_DAILY_PLAN_LIMIT = 7
export const DEFAULT_FOCUS_WINDOW_DAYS = 7

export type AgentConsentScope = 'todos' | 'daily_plans' | 'focus_summary' | 'knowledge_sources'

export interface AgentGoalPreferences {
  goal: GoalType
  dailyTargetMinutes: number
  preferredFocusMinutes: number
}

export interface AgentActionSlipSnapshot {
  id: string
  title: string
  status: Exclude<ActionSlipStatus, 'completed'>
  updatedAt: string
  nextStep?: string
}

export interface AgentDailyPlanSnapshot {
  dateKey: string
  mode: DailyPlanMode
  focusMinutes: number
  summary: string
}

export interface AgentFocusSummarySnapshot {
  windowDays: number
  windowStartedAt: string
  sessionCount: number
  totalMinutes: number
  averageCompletionRate: number
  averageSubjectiveFocus: number
  distractionCounts: Partial<Record<DistractionReason, number>>
}

export interface AgentSampleBoundaries {
  actionSlipLimit: number
  actionSlipTotal: number
  dailyPlanLimit: number
  dailyPlanTotal: number
  focusWindowDays: number
  knowledgeSourceTotal: number
  knowledgeSourceSelected: number
}

export interface ActionContextSnapshot {
  schemaVersion: typeof AGENT_CONTEXT_SCHEMA_VERSION
  snapshotId: string
  createdAt: string
  timezone: string
  baseStateRevision: string
  userRequest: string
  goalAndPreferences: AgentGoalPreferences
  activeActionSlips: AgentActionSlipSnapshot[]
  recentDailyPlans: AgentDailyPlanSnapshot[]
  focusSummary?: AgentFocusSummarySnapshot
  selectedKnowledgeSourceIds: string[]
  consentScope: AgentConsentScope[]
  sampleBoundaries: AgentSampleBoundaries
}

export interface AgentContextSelection {
  includeTodos: boolean
  includeDailyPlans: boolean
  includeFocusSummary: boolean
  includeKnowledgeSources: boolean
  selectedKnowledgeSourceIds: string[]
  knowledgeSourceTotal: number
  actionSlipLimit?: number
  dailyPlanLimit?: number
  focusWindowDays?: number
}

interface BuildSnapshotOptions {
  now?: Date
  snapshotId?: string
  timezone?: string
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    )
  }
  return value
}

async function sha256(value: unknown) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持快照 SHA-256 状态校验。')
  const encoded = new TextEncoder().encode(JSON.stringify(stableValue(value)))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function round(value: number, digits = 1) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function focusSummary(state: AppState, now: Date, windowDays: number): AgentFocusSummarySnapshot {
  const windowStartedAt = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1_000)
  const sessions = state.focusSessions.filter((item) => Date.parse(item.completedAt) >= windowStartedAt.getTime())
  const distractionCounts: Partial<Record<DistractionReason, number>> = {}
  sessions.forEach((session) => session.distractions.forEach((distraction) => {
    distractionCounts[distraction.reason] = (distractionCounts[distraction.reason] ?? 0) + 1
  }))
  const totalMinutes = Math.round(sessions.reduce((sum, item) => sum + item.actualDurationSec, 0) / 60)
  const averageCompletionRate = sessions.length
    ? round(sessions.reduce((sum, item) => sum + item.completionRate, 0) / sessions.length)
    : 0
  const averageSubjectiveFocus = sessions.length
    ? round(sessions.reduce((sum, item) => sum + item.subjectiveFocus, 0) / sessions.length)
    : 0
  return {
    windowDays,
    windowStartedAt: windowStartedAt.toISOString(),
    sessionCount: sessions.length,
    totalMinutes,
    averageCompletionRate,
    averageSubjectiveFocus,
    distractionCounts,
  }
}

function revisionMaterial(state: AppState) {
  return {
    schemaVersion: state.schemaVersion,
    profile: {
      goal: state.profile.goal,
      dailyTargetMinutes: state.profile.dailyTargetMinutes,
      preferredFocusMinutes: state.profile.preferredFocusMinutes,
    },
    actionSlips: state.actionSlips,
    dailyPlans: state.dailyPlans,
    focusSessions: state.focusSessions,
    agentPlans: state.agentPlans,
  }
}

export function calculateActionStateRevision(state: AppState) {
  return sha256(revisionMaterial(state))
}

export async function buildActionContextSnapshot(
  state: AppState,
  rawRequest: string,
  selection: AgentContextSelection,
  options: BuildSnapshotOptions = {},
): Promise<ActionContextSnapshot> {
  const userRequest = rawRequest.trim().replace(/\s+/g, ' ').slice(0, 1_000)
  if (!userRequest) throw new Error('请先说明希望 Agent 帮你规划什么。')

  const now = options.now ?? new Date()
  const actionSlipLimit = Math.min(100, Math.max(1, selection.actionSlipLimit ?? DEFAULT_ACTION_SLIP_LIMIT))
  const dailyPlanLimit = Math.min(31, Math.max(1, selection.dailyPlanLimit ?? DEFAULT_DAILY_PLAN_LIMIT))
  const focusWindowDays = Math.min(90, Math.max(1, selection.focusWindowDays ?? DEFAULT_FOCUS_WINDOW_DAYS))
  const activeSlips = state.actionSlips.filter((item) => item.status !== 'completed')
  const activeActionSlips: AgentActionSlipSnapshot[] = selection.includeTodos
    ? [...activeSlips]
      .sort((left, right) => {
        if (left.status === 'current' && right.status !== 'current') return -1
        if (right.status === 'current' && left.status !== 'current') return 1
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      })
      .slice(0, actionSlipLimit)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status as AgentActionSlipSnapshot['status'],
        updatedAt: item.updatedAt,
        ...(item.nextStep ? { nextStep: item.nextStep } : {}),
      }))
    : []
  const recentDailyPlans: AgentDailyPlanSnapshot[] = selection.includeDailyPlans
    ? [...state.dailyPlans]
      .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
      .slice(0, dailyPlanLimit)
      .map((item) => ({
        dateKey: item.dateKey,
        mode: item.mode,
        focusMinutes: item.focusMinutes,
        summary: item.summary,
      }))
    : []
  const selectedKnowledgeSourceIds = selection.includeKnowledgeSources
    ? [...new Set(selection.selectedKnowledgeSourceIds)].slice(0, 100)
    : []
  const consentScope: AgentConsentScope[] = []
  if (selection.includeTodos) consentScope.push('todos')
  if (selection.includeDailyPlans) consentScope.push('daily_plans')
  if (selection.includeFocusSummary) consentScope.push('focus_summary')
  if (selection.includeKnowledgeSources) consentScope.push('knowledge_sources')

  return {
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    snapshotId: options.snapshotId ?? crypto.randomUUID(),
    createdAt: now.toISOString(),
    timezone: options.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    baseStateRevision: await calculateActionStateRevision(state),
    userRequest,
    goalAndPreferences: {
      goal: state.profile.goal,
      dailyTargetMinutes: state.profile.dailyTargetMinutes,
      preferredFocusMinutes: state.profile.preferredFocusMinutes,
    },
    activeActionSlips,
    recentDailyPlans,
    ...(selection.includeFocusSummary ? { focusSummary: focusSummary(state, now, focusWindowDays) } : {}),
    selectedKnowledgeSourceIds,
    consentScope,
    sampleBoundaries: {
      actionSlipLimit: activeActionSlips.length,
      actionSlipTotal: selection.includeTodos ? activeSlips.length : 0,
      dailyPlanLimit: recentDailyPlans.length,
      dailyPlanTotal: selection.includeDailyPlans ? state.dailyPlans.length : 0,
      focusWindowDays,
      knowledgeSourceTotal: selection.includeKnowledgeSources ? selection.knowledgeSourceTotal : 0,
      knowledgeSourceSelected: selectedKnowledgeSourceIds.length,
    },
  }
}
