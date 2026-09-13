import { calculateActionStateRevision } from './agentContext'
import type {
  AgentExecutionAck,
  AgentMutationIntent,
  AgentPlanDraft,
} from './agentClient'
import type { ActiveFocusSession, AgentSavedPlan, AppState } from '../types'

const ACTION_LEDGER_KEY = 'xirang-agent-action-ledger-v1'
const MAX_LEDGER_ENTRIES = 200

export interface AgentFocusRequest {
  actionId: string
  taskName: string
  minutes: number
  firstStep: string
  completionCriteria: string
  actionSlipId?: string
}

export interface AgentMutationBatchResult {
  nextState: AppState
  executionAck: AgentExecutionAck
  focusRequests: AgentFocusRequest[]
  appliedActionIds: string[]
}

export function createApprovedFocusSession(
  request: AgentFocusRequest,
  now = new Date(),
): ActiveFocusSession {
  return {
    version: 1,
    id: `agent-focus-${request.actionId}`,
    status: 'preparing',
    taskName: request.taskName,
    plannedDurationMin: request.minutes,
    remainingSec: 30,
    elapsedFocusSec: 0,
    endAt: new Date(now.getTime() + 30_000).toISOString(),
    distractions: [],
    pageLeaveCount: 0,
    completionRate: 100,
    subjectiveFocus: 4,
    preparationChecks: { phoneAway: false, workspaceReady: false, goalClear: false },
    round: 1,
    focusMode: 'free',
    pomodoroCycle: 1,
    firstAction: request.firstStep,
    completionDefinition: request.completionCriteria,
    actionSlipId: request.actionSlipId,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`写入意图字段 ${field} 无效。`)
  }
  return value.trim()
}

function parsePlan(value: unknown): AgentPlanDraft {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.length || value.items.length > 7) {
    throw new Error('save_plan 没有合法的计划条目。')
  }
  return {
    title: requiredString(value.title, 'plan.title', 120),
    summary: requiredString(value.summary, 'plan.summary', 1_000),
    items: value.items.map((rawItem) => {
      if (!isRecord(rawItem)) throw new Error('save_plan 包含无效计划条目。')
      const estimatedMinutes = Number(rawItem.estimatedMinutes)
      if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 5 || estimatedMinutes > 240) {
        throw new Error('save_plan 的预计分钟数无效。')
      }
      return {
        title: requiredString(rawItem.title, 'item.title', 240),
        firstStep: requiredString(rawItem.firstStep, 'item.firstStep', 300),
        completionCriteria: requiredString(rawItem.completionCriteria, 'item.completionCriteria', 400),
        estimatedMinutes,
        rationale: requiredString(rawItem.rationale, 'item.rationale', 500),
        sourceActionSlipIds: Array.isArray(rawItem.sourceActionSlipIds)
          ? rawItem.sourceActionSlipIds.filter((item): item is string => typeof item === 'string').slice(0, 10)
          : [],
        evidenceRefs: Array.isArray(rawItem.evidenceRefs)
          ? rawItem.evidenceRefs.filter((item): item is string => typeof item === 'string').slice(0, 8)
          : [],
      }
    }),
    assumptions: Array.isArray(value.assumptions)
      ? value.assumptions.filter((item): item is string => typeof item === 'string').slice(0, 10)
      : [],
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [],
  }
}

function prepareSavePlan(intent: AgentMutationIntent, now: Date): AgentSavedPlan {
  if (!isRecord(intent.arguments)) throw new Error('save_plan 参数无效。')
  const plan = parsePlan(intent.arguments.plan)
  return {
    id: intent.actionId,
    threadId: requiredString(intent.arguments.threadId, 'threadId', 100),
    runId: requiredString(intent.arguments.runId, 'runId', 100),
    createdAt: now.toISOString(),
    baseStateRevision: intent.baseStateRevision,
    ...plan,
  }
}

function prepareFocus(intent: AgentMutationIntent): AgentFocusRequest {
  if (!isRecord(intent.arguments)) throw new Error('start_focus 参数无效。')
  const minutes = Number(intent.arguments.minutes)
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 180) {
    throw new Error('start_focus 的分钟数无效。')
  }
  const actionSlipId = typeof intent.arguments.actionSlipId === 'string'
    ? intent.arguments.actionSlipId.slice(0, 100)
    : undefined
  return {
    actionId: intent.actionId,
    taskName: requiredString(intent.arguments.taskName, 'taskName', 240),
    minutes,
    firstStep: requiredString(intent.arguments.firstStep, 'firstStep', 300),
    completionCriteria: requiredString(intent.arguments.completionCriteria, 'completionCriteria', 400),
    ...(actionSlipId ? { actionSlipId } : {}),
  }
}

export function loadAgentActionLedger(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(ACTION_LEDGER_KEY) ?? '[]')
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(-MAX_LEDGER_ENTRIES)
      : []
  } catch {
    return []
  }
}

export function saveAgentActionLedger(actionIds: string[]) {
  localStorage.setItem(ACTION_LEDGER_KEY, JSON.stringify([...new Set(actionIds)].slice(-MAX_LEDGER_ENTRIES)))
}

export async function applyAgentMutationIntents(
  state: AppState,
  intents: AgentMutationIntent[],
  appliedActionIds: string[] = loadAgentActionLedger(),
  now = new Date(),
  activeFocusId: string | null = null,
): Promise<AgentMutationBatchResult> {
  const observedStateRevision = await calculateActionStateRevision(state)
  const applied = new Set(appliedActionIds)
  const actionIds = intents.map((item) => item.actionId)
  const isAlreadyApplied = (intent: AgentMutationIntent) => applied.has(intent.actionId)
    || (intent.toolName === 'save_plan' && state.agentPlans.some((plan) => plan.id === intent.actionId))
    || (intent.toolName === 'start_focus' && activeFocusId === `agent-focus-${intent.actionId}`)
  const pendingIntents = intents.filter((intent) => !isAlreadyApplied(intent))
  const invalidEnvelope = !intents.length
    || new Set(actionIds).size !== actionIds.length
    || intents.some((item) => typeof item.actionId !== 'string' || item.actionId.length < 8 || item.actionId.length > 100
      || !['save_plan', 'start_focus'].includes(item.toolName)
      || typeof item.baseStateRevision !== 'string' || item.baseStateRevision.length < 16 || item.baseStateRevision.length > 128
      || item.riskLevel !== 'commit' || item.status !== 'proposed')
  const revisionConflict = pendingIntents.some((item) => item.baseStateRevision !== observedStateRevision)
  const focusConflict = Boolean(activeFocusId) && pendingIntents.some((item) => item.toolName === 'start_focus')
  if (invalidEnvelope || revisionConflict || focusConflict) {
    const error = revisionConflict
      ? '本地状态在规划后发生变化，请重新生成计划。'
      : focusConflict
        ? '已有专注会话正在进行，不能重复启动。'
        : '写入意图批次无效。'
    return {
      nextState: state,
      executionAck: {
        observedStateRevision,
        items: intents.map((item) => ({ actionId: item.actionId, status: 'failed', error })),
      },
      focusRequests: [],
      appliedActionIds: [...applied],
    }
  }

  const prepared: Array<
    | { intent: AgentMutationIntent, kind: 'already', request?: AgentFocusRequest }
    | { intent: AgentMutationIntent, kind: 'save', plan: AgentSavedPlan }
    | { intent: AgentMutationIntent, kind: 'focus', request: AgentFocusRequest }
  > = []
  try {
    intents.forEach((intent) => {
      if (isAlreadyApplied(intent)) {
        if (intent.toolName === 'save_plan') {
          prepareSavePlan(intent, now)
          prepared.push({ intent, kind: 'already' })
        } else {
          prepared.push({ intent, kind: 'already', request: prepareFocus(intent) })
        }
      } else if (intent.toolName === 'save_plan') {
        prepared.push({ intent, kind: 'save', plan: prepareSavePlan(intent, now) })
      } else if (intent.toolName === 'start_focus') {
        prepared.push({ intent, kind: 'focus', request: prepareFocus(intent) })
      } else {
        throw new Error('写入意图工具不在白名单中。')
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '写入意图参数无效。'
    return {
      nextState: state,
      executionAck: {
        observedStateRevision,
        items: intents.map((item) => ({ actionId: item.actionId, status: 'failed', error: message })),
      },
      focusRequests: [],
      appliedActionIds: [...applied],
    }
  }

  let nextState = state
  const focusRequests: AgentFocusRequest[] = []
  prepared.forEach((item) => {
    if (item.kind === 'save') {
      nextState = { ...nextState, agentPlans: [...nextState.agentPlans, item.plan].slice(-50) }
    }
    if (item.kind === 'focus') focusRequests.push(item.request)
    else if (item.kind === 'already' && item.request) focusRequests.push(item.request)
    applied.add(item.intent.actionId)
  })
  return {
    nextState,
    executionAck: {
      observedStateRevision,
      items: prepared.map((item) => ({
        actionId: item.intent.actionId,
        status: item.kind === 'already' ? 'already_applied' : 'applied',
      })),
    },
    focusRequests,
    appliedActionIds: [...applied],
  }
}
