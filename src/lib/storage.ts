import type {
  ActionSlip,
  ActionSlipStatus,
  AgentSavedPlan,
  ActiveFocusSession,
  ActiveFocusStatus,
  AssessmentContext,
  AssessmentDevice,
  AssessmentEnvironment,
  AssessmentInputMethod,
  AssessmentKind,
  AssessmentRecord,
  AppSettings,
  AppState,
  AttentionProfile,
  DailyPlan,
  DailyPlanMode,
  DistractionReason,
  FocusDistraction,
  FocusBreakKind,
  FocusEndReason,
  FocusMode,
  FocusSession,
  FocusLaunchSession,
  GoalType,
  LaunchCandidate,
  LaunchLevel,
  LaunchMode,
  LaunchStatus,
  LaunchTaskCategory,
  LaunchWarmupResult,
  LaunchWarmupType,
  PersonalNote,
  TaskResult,
  TaskType,
  TrainingSession,
  TaskAdaptationState,
} from '../types'
import { createTaskAdaptationState } from './adaptiveDifficulty'

export const CURRENT_SCHEMA_VERSION = 11
export const MIN_SUPPORTED_SCHEMA_VERSION = 1

export class UnsupportedStateVersionError extends Error {
  constructor(version: unknown) {
    const numericVersion = Number(version)
    super(Number.isInteger(numericVersion) && numericVersion > CURRENT_SCHEMA_VERSION
      ? `本机数据来自更新版本的息壤（v${numericVersion}），当前版本仅支持到 v${CURRENT_SCHEMA_VERSION}。`
      : `本机数据的格式版本（${String(version)}）不受支持，当前版本支持 v${MIN_SUPPORTED_SCHEMA_VERSION}～v${CURRENT_SCHEMA_VERSION}。`)
    this.name = 'UnsupportedStateVersionError'
  }
}

const STORAGE_KEY = 'xirang-state'
const ACTIVE_FOCUS_KEY = 'xirang-active-focus-v1'
const ACTIVE_LAUNCH_KEY = 'xirang-active-launch-v1'
const LEGACY_STORAGE_KEYS = ['focus-lab-state-v1']
const taskTypes: TaskType[] = ['schulte', 'go-no-go', 'vigilance', 'stroop']
const goals: GoalType[] = ['study', 'work', 'phone']
const distractionReasons: DistractionReason[] = ['phone', 'environment', 'difficulty', 'fatigue', 'other']
const focusEndReasons: FocusEndReason[] = ['completed', 'interrupted', 'abandoned']
const focusModes: FocusMode[] = ['free', 'pomodoro']
const focusBreakKinds: FocusBreakKind[] = ['short', 'long']
const activeFocusStatuses: ActiveFocusStatus[] = ['preparing', 'running', 'paused', 'review', 'break', 'break-ready']
const assessmentKinds: AssessmentKind[] = ['baseline', 'retest', 'quick-check']
const assessmentDevices: AssessmentDevice[] = ['desktop', 'tablet', 'mobile']
const assessmentInputMethods: AssessmentInputMethod[] = ['mouse', 'trackpad', 'touch', 'keyboard']
const assessmentEnvironments: AssessmentEnvironment[] = ['quiet', 'some-noise', 'disrupted']
const launchModes: LaunchMode[] = ['known-task', 'choose-task']
const launchStatuses: LaunchStatus[] = ['draft', 'ready', 'warming-up', 'focusing', 'completed', 'abandoned']
const launchTaskCategories: LaunchTaskCategory[] = ['reading', 'writing', 'study', 'coding', 'admin', 'life', 'other']
const launchWarmupTypes: LaunchWarmupType[] = ['visual', 'inhibition', 'none']
const actionSlipStatuses: ActionSlipStatus[] = ['inbox', 'current', 'completed']
let storageCompatibilityIssue: string | null = null

const defaultSettings: AppSettings = {
  soundEnabled: true,
  animationsEnabled: true,
  trainingTipsEnabled: true,
  desktopNotificationsEnabled: false,
  fontSize: 'standard',
}

export function createDefaultState(): AppState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: {
      goal: 'study',
      dailyTargetMinutes: 10,
      preferredFocusMinutes: 25,
      onboardingComplete: false,
      levels: {
        schulte: 1,
        'go-no-go': 1,
        vigilance: 1,
        stroop: 1,
      },
      adaptation: {
        schulte: createTaskAdaptationState(),
        'go-no-go': createTaskAdaptationState(),
        vigilance: createTaskAdaptationState(),
        stroop: createTaskAdaptationState(),
      },
    },
    settings: { ...defaultSettings },
    assessments: [],
    sessions: [],
    focusSessions: [],
    dailyPlans: [],
    focusLaunches: [],
    actionSlips: [],
    personalNotes: [],
    agentPlans: [],
  }
}

export const defaultState = createDefaultState()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function validDate(value: unknown, fallback = new Date().toISOString()) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback
}

function parseMetadata(value: unknown) {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, number | string] =>
    typeof entry[1] === 'string' || (typeof entry[1] === 'number' && Number.isFinite(entry[1])),
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}

function parseTaskResult(value: unknown): TaskResult | null {
  if (!isRecord(value) || !taskTypes.includes(value.taskType as TaskType)) return null
  const taskType = value.taskType as TaskType
  return {
    taskType,
    durationSec: Math.max(0, finiteNumber(value.durationSec)),
    accuracy: clamp(finiteNumber(value.accuracy), 0, 1),
    medianReactionMs: Math.max(0, finiteNumber(value.medianReactionMs)),
    omissions: Math.max(0, Math.round(finiteNumber(value.omissions))),
    commissions: Math.max(0, Math.round(finiteNumber(value.commissions))),
    errors: Math.max(0, Math.round(finiteNumber(value.errors))),
    score: clamp(Math.round(finiteNumber(value.score)), 0, 100),
    level: clamp(Math.round(finiteNumber(value.level, 1)), 1, 5),
    metadata: parseMetadata(value.metadata),
  }
}

function parseTrainingSession(value: unknown): TrainingSession | null {
  const result = parseTaskResult(value)
  if (!result || !isRecord(value)) return null
  return {
    ...result,
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    completedAt: validDate(value.completedAt),
  }
}

function parseLaunchLevel(value: unknown, fallback: LaunchLevel = 2): LaunchLevel {
  return clamp(Math.round(finiteNumber(value, fallback)), 1, 3) as LaunchLevel
}

function parseOptionalLaunchCategory(value: unknown) {
  return launchTaskCategories.includes(value as LaunchTaskCategory) ? value as LaunchTaskCategory : undefined
}

function parseFocusSession(value: unknown): FocusSession | null {
  if (!isRecord(value) || typeof value.taskName !== 'string') return null
  const distractions = parseDistractions(value.distractions)
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    completedAt: validDate(value.completedAt),
    taskName: value.taskName.slice(0, 500),
    plannedDurationMin: Math.max(1, Math.round(finiteNumber(value.plannedDurationMin, 25))),
    actualDurationSec: Math.max(0, finiteNumber(value.actualDurationSec)),
    completionRate: clamp(Math.round(finiteNumber(value.completionRate)), 0, 100),
    distractionCount: Math.max(distractions.length, Math.max(0, Math.round(finiteNumber(value.distractionCount)))),
    pageLeaveCount: Math.max(0, Math.round(finiteNumber(value.pageLeaveCount))),
    subjectiveFocus: clamp(Math.round(finiteNumber(value.subjectiveFocus, 3)), 1, 5),
    endReason: focusEndReasons.includes(value.endReason as FocusEndReason) ? value.endReason as FocusEndReason : 'completed',
    distractions,
    round: Math.max(1, Math.round(finiteNumber(value.round, 1))),
    focusMode: focusModes.includes(value.focusMode as FocusMode) ? value.focusMode as FocusMode : 'free',
    pomodoroCycle: clamp(Math.round(finiteNumber(value.pomodoroCycle, 1)), 1, 4),
    launchId: typeof value.launchId === 'string' && value.launchId ? value.launchId.slice(0, 100) : undefined,
    taskCategory: parseOptionalLaunchCategory(value.taskCategory),
    firstAction: typeof value.firstAction === 'string' && value.firstAction ? value.firstAction.slice(0, 200) : undefined,
    completionDefinition: typeof value.completionDefinition === 'string' && value.completionDefinition ? value.completionDefinition.slice(0, 300) : undefined,
    energyBefore: value.energyBefore === undefined ? undefined : parseLaunchLevel(value.energyBefore),
    resistanceBefore: value.resistanceBefore === undefined ? undefined : parseLaunchLevel(value.resistanceBefore),
    actionSlipId: typeof value.actionSlipId === 'string' && value.actionSlipId ? value.actionSlipId.slice(0, 100) : undefined,
    nextStep: typeof value.nextStep === 'string' && value.nextStep.trim() ? value.nextStep.trim().slice(0, 300) : undefined,
  }
}

function parseDistractions(value: unknown): FocusDistraction[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.note !== 'string') return []
    const reason = distractionReasons.includes(item.reason as DistractionReason)
      ? item.reason as DistractionReason
      : 'other'
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
      note: item.note.slice(0, 500),
      reason,
      createdAt: validDate(item.createdAt),
    }]
  }).slice(-200)
}

function parseActiveFocus(value: unknown): ActiveFocusSession | null {
  if (!isRecord(value) || typeof value.taskName !== 'string') return null
  const status = activeFocusStatuses.includes(value.status as ActiveFocusStatus)
    ? value.status as ActiveFocusStatus
    : null
  if (!status) return null
  const checks = isRecord(value.preparationChecks) ? value.preparationChecks : {}
  const endReason = focusEndReasons.includes(value.endReason as FocusEndReason)
    ? value.endReason as FocusEndReason
    : undefined
  return {
    version: 1,
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    status,
    taskName: value.taskName.slice(0, 500),
    plannedDurationMin: clamp(Math.round(finiteNumber(value.plannedDurationMin, 25)), 1, 180),
    remainingSec: Math.max(0, Math.round(finiteNumber(value.remainingSec))),
    elapsedFocusSec: Math.max(0, finiteNumber(value.elapsedFocusSec)),
    endAt: typeof value.endAt === 'string' && !Number.isNaN(Date.parse(value.endAt)) ? value.endAt : undefined,
    distractions: parseDistractions(value.distractions),
    pageLeaveCount: Math.max(0, Math.round(finiteNumber(value.pageLeaveCount))),
    completionRate: clamp(Math.round(finiteNumber(value.completionRate, 100)), 0, 100),
    subjectiveFocus: clamp(Math.round(finiteNumber(value.subjectiveFocus, 4)), 1, 5),
    endReason,
    preparationChecks: {
      phoneAway: Boolean(checks.phoneAway),
      workspaceReady: Boolean(checks.workspaceReady),
      goalClear: Boolean(checks.goalClear),
    },
    round: Math.max(1, Math.round(finiteNumber(value.round, 1))),
    focusMode: focusModes.includes(value.focusMode as FocusMode) ? value.focusMode as FocusMode : 'free',
    pomodoroCycle: clamp(Math.round(finiteNumber(value.pomodoroCycle, 1)), 1, 4),
    breakKind: focusBreakKinds.includes(value.breakKind as FocusBreakKind) ? value.breakKind as FocusBreakKind : undefined,
    launchId: typeof value.launchId === 'string' && value.launchId ? value.launchId.slice(0, 100) : undefined,
    taskCategory: parseOptionalLaunchCategory(value.taskCategory),
    firstAction: typeof value.firstAction === 'string' && value.firstAction ? value.firstAction.slice(0, 200) : undefined,
    completionDefinition: typeof value.completionDefinition === 'string' && value.completionDefinition ? value.completionDefinition.slice(0, 300) : undefined,
    energyBefore: value.energyBefore === undefined ? undefined : parseLaunchLevel(value.energyBefore),
    resistanceBefore: value.resistanceBefore === undefined ? undefined : parseLaunchLevel(value.resistanceBefore),
    actionSlipId: typeof value.actionSlipId === 'string' && value.actionSlipId ? value.actionSlipId.slice(0, 100) : undefined,
    nextStep: typeof value.nextStep === 'string' && value.nextStep.trim() ? value.nextStep.trim().slice(0, 300) : undefined,
  }
}

function parseLaunchCandidate(value: unknown): LaunchCandidate | null {
  if (!isRecord(value) || typeof value.title !== 'string') return null
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 100) : crypto.randomUUID(),
    title: value.title.trim().slice(0, 120),
    importance: parseLaunchLevel(value.importance),
    urgency: parseLaunchLevel(value.urgency),
    startability: parseLaunchLevel(value.startability),
  }
}

function parseLaunchWarmupResult(value: unknown): LaunchWarmupResult | undefined {
  if (!isRecord(value) || !['visual', 'inhibition'].includes(String(value.type))) return undefined
  return {
    type: value.type as LaunchWarmupResult['type'],
    durationSec: clamp(finiteNumber(value.durationSec, 60), 0, 90),
    correctCount: Math.max(0, Math.round(finiteNumber(value.correctCount))),
    errorCount: Math.max(0, Math.round(finiteNumber(value.errorCount))),
    completedAt: validDate(value.completedAt),
  }
}

function parseFocusLaunch(value: unknown): FocusLaunchSession | null {
  if (!isRecord(value)) return null
  const mode = launchModes.includes(value.mode as LaunchMode) ? value.mode as LaunchMode : 'known-task'
  const status = launchStatuses.includes(value.status as LaunchStatus) ? value.status as LaunchStatus : 'draft'
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.map(parseLaunchCandidate).filter((item): item is LaunchCandidate => item !== null).slice(0, 3)
    : []
  const taskCategory = launchTaskCategories.includes(value.taskCategory as LaunchTaskCategory)
    ? value.taskCategory as LaunchTaskCategory
    : 'other'
  const warmupType = launchWarmupTypes.includes(value.warmupType as LaunchWarmupType)
    ? value.warmupType as LaunchWarmupType
    : 'none'
  const createdAt = validDate(value.createdAt)
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 100) : crypto.randomUUID(),
    mode,
    status,
    createdAt,
    updatedAt: validDate(value.updatedAt, createdAt),
    completedAt: typeof value.completedAt === 'string' && !Number.isNaN(Date.parse(value.completedAt)) ? value.completedAt : undefined,
    candidates,
    selectedCandidateId: typeof value.selectedCandidateId === 'string' && value.selectedCandidateId ? value.selectedCandidateId.slice(0, 100) : undefined,
    taskName: typeof value.taskName === 'string' ? value.taskName.trim().slice(0, 120) : '',
    taskCategory,
    firstAction: typeof value.firstAction === 'string' ? value.firstAction.trim().slice(0, 200) : '',
    completionDefinition: typeof value.completionDefinition === 'string' ? value.completionDefinition.trim().slice(0, 300) : '',
    plannedDurationMin: clamp(Math.round(finiteNumber(value.plannedDurationMin, 25)), 5, 180),
    energyBefore: parseLaunchLevel(value.energyBefore),
    resistanceBefore: parseLaunchLevel(value.resistanceBefore),
    warmupType,
    warmupResult: parseLaunchWarmupResult(value.warmupResult),
    focusSessionId: typeof value.focusSessionId === 'string' && value.focusSessionId ? value.focusSessionId.slice(0, 100) : undefined,
    actionSlipId: typeof value.actionSlipId === 'string' && value.actionSlipId ? value.actionSlipId.slice(0, 100) : undefined,
  }
}

function parseLegacyLaterTask(value: unknown): ActionSlip | null {
  if (!isRecord(value) || typeof value.title !== 'string' || !value.title.trim()) return null
  const createdAt = validDate(value.createdAt)
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 100) : crypto.randomUUID(),
    title: value.title.trim().replace(/\s+/g, ' ').slice(0, 240),
    status: 'inbox',
    createdAt,
    updatedAt: createdAt,
    sourceLaunchId: typeof value.sourceLaunchId === 'string' && value.sourceLaunchId ? value.sourceLaunchId.slice(0, 100) : undefined,
    focusSessionIds: [],
  }
}

function parseActionSlip(value: unknown): ActionSlip | null {
  if (!isRecord(value) || typeof value.title !== 'string' || !value.title.trim()) return null
  const createdAt = validDate(value.createdAt)
  const status = actionSlipStatuses.includes(value.status as ActionSlipStatus)
    ? value.status as ActionSlipStatus
    : 'inbox'
  const focusSessionIds = Array.isArray(value.focusSessionIds)
    ? value.focusSessionIds.filter((item): item is string => typeof item === 'string' && Boolean(item)).map((item) => item.slice(0, 100)).slice(-100)
    : []
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 100) : crypto.randomUUID(),
    title: value.title.trim().replace(/\s+/g, ' ').slice(0, 240),
    status,
    createdAt,
    updatedAt: validDate(value.updatedAt, createdAt),
    completedAt: status === 'completed' && typeof value.completedAt === 'string' && !Number.isNaN(Date.parse(value.completedAt)) ? value.completedAt : undefined,
    nextStep: typeof value.nextStep === 'string' && value.nextStep.trim() ? value.nextStep.trim().slice(0, 300) : undefined,
    sourceLaunchId: typeof value.sourceLaunchId === 'string' && value.sourceLaunchId ? value.sourceLaunchId.slice(0, 100) : undefined,
    focusSessionIds,
  }
}

function parsePersonalNote(value: unknown): PersonalNote | null {
  if (!isRecord(value)) return null
  const content = typeof value.content === 'string'
    ? value.content.replace(/\r\n?/g, '\n').trim().slice(0, 6000)
    : ''
  const title = typeof value.title === 'string'
    ? value.title.trim().replace(/\s+/g, ' ').slice(0, 80)
    : ''
  if (!title && !content) return null
  const createdAt = validDate(value.createdAt)
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 100) : crypto.randomUUID(),
    title: title || content.split('\n')[0].trim().replace(/\s+/g, ' ').slice(0, 80) || '未命名笔记',
    content,
    createdAt,
    updatedAt: validDate(value.updatedAt, createdAt),
  }
}

function parseAttentionProfile(value: unknown): AttentionProfile | undefined {
  if (!isRecord(value)) return undefined
  return {
    completedAt: validDate(value.completedAt),
    visualSearch: clamp(Math.round(finiteNumber(value.visualSearch)), 0, 100),
    sustainedAttention: clamp(Math.round(finiteNumber(value.sustainedAttention)), 0, 100),
    interferenceControl: clamp(Math.round(finiteNumber(value.interferenceControl)), 0, 100),
    responseInhibition: clamp(Math.round(finiteNumber(value.responseInhibition)), 0, 100),
  }
}

function parseAssessmentContext(value: unknown): AssessmentContext | undefined {
  if (!isRecord(value)) return undefined
  const device = assessmentDevices.includes(value.device as AssessmentDevice) ? value.device as AssessmentDevice : null
  const inputMethod = assessmentInputMethods.includes(value.inputMethod as AssessmentInputMethod) ? value.inputMethod as AssessmentInputMethod : null
  const environment = assessmentEnvironments.includes(value.environment as AssessmentEnvironment) ? value.environment as AssessmentEnvironment : null
  if (!device || !inputMethod || !environment) return undefined
  return {
    device,
    inputMethod,
    sleepQuality: clamp(Math.round(finiteNumber(value.sleepQuality, 2)), 1, 3) as AssessmentContext['sleepQuality'],
    fatigueLevel: clamp(Math.round(finiteNumber(value.fatigueLevel, 2)), 1, 3) as AssessmentContext['fatigueLevel'],
    environment,
    interrupted: Boolean(value.interrupted),
  }
}

function parseAssessmentRecord(value: unknown): AssessmentRecord | null {
  if (!isRecord(value)) return null
  const profile = parseAttentionProfile(value.profile)
  if (!profile) return null
  const completedAt = validDate(value.completedAt ?? profile.completedAt)
  const results = Array.isArray(value.results)
    ? value.results.map(parseTaskResult).filter((item): item is TaskResult => item !== null)
    : []
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    kind: assessmentKinds.includes(value.kind as AssessmentKind) ? value.kind as AssessmentKind : 'retest',
    completedAt,
    profile: { ...profile, completedAt },
    results,
    context: parseAssessmentContext(value.context),
  }
}

function parseDailyPlan(value: unknown): DailyPlan | null {
  if (!isRecord(value) || typeof value.dateKey !== 'string' || !Array.isArray(value.items)) return null
  const modes: DailyPlanMode[] = ['standard', 'low-energy', 'quick']
  const mode = modes.includes(value.mode as DailyPlanMode) ? value.mode as DailyPlanMode : 'standard'
  const items = value.items.flatMap((item) => {
    if (!isRecord(item) || !taskTypes.includes(item.taskType as TaskType)) return []
    return [{
      taskType: item.taskType as TaskType,
      estimatedMinutes: clamp(Math.round(finiteNumber(item.estimatedMinutes, 3)), 1, 15),
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 300) : '根据个人近期表现安排',
    }]
  })
  if (!items.length) return null
  return {
    dateKey: value.dateKey.slice(0, 10),
    createdAt: validDate(value.createdAt),
    mode,
    intensity: value.intensity === 'light' ? 'light' : 'regular',
    items,
    focusMinutes: clamp(Math.round(finiteNumber(value.focusMinutes, 25)), 5, 180),
    focusReason: typeof value.focusReason === 'string' ? value.focusReason.slice(0, 500) : '把训练带回真实任务。',
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 500) : '根据个人表现生成。',
  }
}

function parseAgentSavedPlan(value: unknown): AgentSavedPlan | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.threadId !== 'string'
    || typeof value.runId !== 'string' || typeof value.title !== 'string' || typeof value.summary !== 'string'
    || typeof value.baseStateRevision !== 'string' || !Array.isArray(value.items)) return null
  const items = value.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.firstStep !== 'string'
      || typeof item.completionCriteria !== 'string' || typeof item.rationale !== 'string') return []
    return [{
      title: item.title.slice(0, 240),
      firstStep: item.firstStep.slice(0, 300),
      completionCriteria: item.completionCriteria.slice(0, 400),
      estimatedMinutes: clamp(Math.round(finiteNumber(item.estimatedMinutes, 25)), 5, 240),
      rationale: item.rationale.slice(0, 500),
      sourceActionSlipIds: Array.isArray(item.sourceActionSlipIds)
        ? item.sourceActionSlipIds.filter((id): id is string => typeof id === 'string').slice(0, 10)
        : [],
      evidenceRefs: Array.isArray(item.evidenceRefs)
        ? item.evidenceRefs.filter((id): id is string => typeof id === 'string').slice(0, 8)
        : [],
    }]
  }).slice(0, 7)
  if (!items.length) return null
  return {
    id: value.id.slice(0, 100),
    threadId: value.threadId.slice(0, 100),
    runId: value.runId.slice(0, 100),
    createdAt: validDate(value.createdAt),
    baseStateRevision: value.baseStateRevision.slice(0, 128),
    title: value.title.slice(0, 120),
    summary: value.summary.slice(0, 1_000),
    items,
    assumptions: Array.isArray(value.assumptions)
      ? value.assumptions.filter((item): item is string => typeof item === 'string').slice(0, 10)
      : [],
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [],
  }
}

function parseAdaptationState(value: unknown): TaskAdaptationState {
  const defaults = createTaskAdaptationState()
  if (!isRecord(value)) return defaults
  const outcomes: TaskAdaptationState['lastOutcome'][] = ['insufficient', 'qualified', 'difficult', 'stable', 'protected']
  return {
    qualifiedWindows: clamp(Math.round(finiteNumber(value.qualifiedWindows)), 0, 2),
    difficultWindows: clamp(Math.round(finiteNumber(value.difficultWindows)), 0, 2),
    protectionRemaining: clamp(Math.round(finiteNumber(value.protectionRemaining)), 0, 2),
    lastOutcome: outcomes.includes(value.lastOutcome as TaskAdaptationState['lastOutcome'])
      ? value.lastOutcome as TaskAdaptationState['lastOutcome']
      : defaults.lastOutcome,
    lastChangedAt: typeof value.lastChangedAt === 'string' && !Number.isNaN(Date.parse(value.lastChangedAt))
      ? value.lastChangedAt
      : undefined,
  }
}

export function migrateState(value: unknown): AppState {
  const defaults = createDefaultState()
  if (!isRecord(value)) return defaults
  const declaredSchemaVersion = Number(value.schemaVersion ?? 1)
  if (
    value.schemaVersion !== undefined
    && (!Number.isInteger(declaredSchemaVersion)
      || declaredSchemaVersion < MIN_SUPPORTED_SCHEMA_VERSION
      || declaredSchemaVersion > CURRENT_SCHEMA_VERSION)
  ) {
    throw new UnsupportedStateVersionError(value.schemaVersion)
  }

  const profile = isRecord(value.profile) ? value.profile : {}
  const levels = isRecord(profile.levels) ? profile.levels : {}
  const adaptation = isRecord(profile.adaptation) ? profile.adaptation : {}
  const settings = isRecord(value.settings) ? value.settings : {}
  const goal = goals.includes(profile.goal as GoalType) ? profile.goal as GoalType : defaults.profile.goal
  const parsedSessions = Array.isArray(value.sessions)
    ? value.sessions.map(parseTrainingSession).filter((item): item is TrainingSession => item !== null)
    : []
  const focusSessions = Array.isArray(value.focusSessions)
    ? value.focusSessions.map(parseFocusSession).filter((item): item is FocusSession => item !== null)
    : []
  const dailyPlans = Array.isArray(value.dailyPlans)
    ? value.dailyPlans.map(parseDailyPlan).filter((item): item is DailyPlan => item !== null).slice(-90)
    : []
  const focusLaunches = Array.isArray(value.focusLaunches)
    ? value.focusLaunches.map(parseFocusLaunch).filter((item): item is FocusLaunchSession => item !== null).slice(-500)
    : []
  const parsedActionSlips = Array.isArray(value.actionSlips)
    ? value.actionSlips.map(parseActionSlip).filter((item): item is ActionSlip => item !== null).slice(-500)
    : []
  const personalNotes = Array.isArray(value.personalNotes)
    ? value.personalNotes.map(parsePersonalNote).filter((item): item is PersonalNote => item !== null).slice(-300)
    : []
  const agentPlans = Array.isArray(value.agentPlans)
    ? value.agentPlans.map(parseAgentSavedPlan).filter((item): item is AgentSavedPlan => item !== null).slice(-50)
    : []
  const legacyLaterTasks = Array.isArray(value.laterTasks)
    ? value.laterTasks.map(parseLegacyLaterTask).filter((item): item is ActionSlip => item !== null).slice(-20)
    : []
  const activeTitles = new Set(parsedActionSlips.filter((item) => item.status !== 'completed').map((item) => item.title.toLocaleLowerCase()))
  const mergedActionSlips = [...parsedActionSlips]
  legacyLaterTasks.forEach((item) => {
    const key = item.title.toLocaleLowerCase()
    if (!activeTitles.has(key)) {
      activeTitles.add(key)
      mergedActionSlips.push(item)
    }
  })
  const currentId = mergedActionSlips
    .filter((item) => item.status === 'current')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]?.id
  const actionSlips = mergedActionSlips.map((item) => item.status === 'current' && item.id !== currentId
    ? { ...item, status: 'inbox' as const }
    : item).slice(-500)
  const attentionProfile = parseAttentionProfile(value.attentionProfile)
  const parsedAssessments = Array.isArray(value.assessments)
    ? value.assessments.map(parseAssessmentRecord).filter((item): item is AssessmentRecord => item !== null)
    : []
  const legacyAssessmentTaskTypes: TaskType[] = ['schulte', 'go-no-go', 'stroop']
  const legacyProfileTime = attentionProfile ? Date.parse(attentionProfile.completedAt) : 0
  const legacyAssessmentSessions = !parsedAssessments.length && attentionProfile
    ? legacyAssessmentTaskTypes.flatMap((taskType) => {
        const candidate = parsedSessions
          .filter((item) => {
            const timestamp = Date.parse(item.completedAt)
            return item.taskType === taskType
              && timestamp >= legacyProfileTime
              && timestamp <= legacyProfileTime + 30 * 60 * 1000
          })
          .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))[0]
        return candidate ? [candidate] : []
      })
    : []
  const hasLegacyAssessmentSet = legacyAssessmentSessions.length === legacyAssessmentTaskTypes.length
  const legacyAssessmentIds = new Set(hasLegacyAssessmentSet ? legacyAssessmentSessions.map((item) => item.id) : [])
  const sessions = parsedSessions.filter((item) => !legacyAssessmentIds.has(item.id))
  const assessments = parsedAssessments.length
    ? parsedAssessments.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    : attentionProfile
      ? [{
          id: crypto.randomUUID(),
          kind: 'baseline' as const,
          completedAt: attentionProfile.completedAt,
          profile: attentionProfile,
          results: hasLegacyAssessmentSet
            ? legacyAssessmentSessions.map((item) => parseTaskResult(item)!).filter(Boolean)
            : [],
        }]
      : []
  const baselineProfile = attentionProfile
    ?? assessments.find((item) => item.kind === 'baseline')?.profile

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: {
      goal,
      dailyTargetMinutes: clamp(Math.round(finiteNumber(profile.dailyTargetMinutes, 10)), 5, 120),
      preferredFocusMinutes: clamp(Math.round(finiteNumber(profile.preferredFocusMinutes, 25)), 5, 180),
      onboardingComplete: typeof profile.onboardingComplete === 'boolean' ? profile.onboardingComplete : false,
      levels: {
        schulte: clamp(Math.round(finiteNumber(levels.schulte, 1)), 1, 5),
        'go-no-go': clamp(Math.round(finiteNumber(levels['go-no-go'], 1)), 1, 5),
        vigilance: clamp(Math.round(finiteNumber(levels.vigilance, 1)), 1, 5),
        stroop: clamp(Math.round(finiteNumber(levels.stroop, 1)), 1, 5),
      },
      adaptation: {
        schulte: parseAdaptationState(adaptation.schulte),
        'go-no-go': parseAdaptationState(adaptation['go-no-go']),
        vigilance: parseAdaptationState(adaptation.vigilance),
        stroop: parseAdaptationState(adaptation.stroop),
      },
    },
    settings: {
      soundEnabled: typeof settings.soundEnabled === 'boolean' ? settings.soundEnabled : defaultSettings.soundEnabled,
      animationsEnabled: typeof settings.animationsEnabled === 'boolean' ? settings.animationsEnabled : defaultSettings.animationsEnabled,
      trainingTipsEnabled: typeof settings.trainingTipsEnabled === 'boolean' ? settings.trainingTipsEnabled : defaultSettings.trainingTipsEnabled,
      desktopNotificationsEnabled: typeof settings.desktopNotificationsEnabled === 'boolean'
        ? settings.desktopNotificationsEnabled
        : defaultSettings.desktopNotificationsEnabled,
      fontSize: ['small', 'standard', 'large'].includes(settings.fontSize as string)
        ? settings.fontSize as AppSettings['fontSize']
        : defaultSettings.fontSize,
    },
    attentionProfile: baselineProfile,
    assessments,
    sessions,
    focusSessions,
    dailyPlans,
    focusLaunches,
    actionSlips,
    personalNotes,
    agentPlans,
  }
}

export function loadState(): AppState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
      ?? LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean)
    const state = raw ? migrateState(JSON.parse(raw)) : createDefaultState()
    storageCompatibilityIssue = null
    return state
  } catch (error) {
    if (error instanceof UnsupportedStateVersionError) storageCompatibilityIssue = error.message
    return createDefaultState()
  }
}

export function saveState(state: AppState) {
  if (storageCompatibilityIssue) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, schemaVersion: CURRENT_SCHEMA_VERSION }))
  } catch {
    // The UI remains usable if the browser temporarily rejects local storage.
  }
}

export function clearStoredState() {
  window.localStorage.removeItem(STORAGE_KEY)
  window.localStorage.removeItem(ACTIVE_FOCUS_KEY)
  window.localStorage.removeItem(ACTIVE_LAUNCH_KEY)
  LEGACY_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key))
  storageCompatibilityIssue = null
}

export function getStorageCompatibilityIssue() {
  return storageCompatibilityIssue
}

export function resetStorageCompatibilityBlock() {
  storageCompatibilityIssue = null
}

export function loadActiveFocus() {
  try {
    const raw = window.localStorage.getItem(ACTIVE_FOCUS_KEY)
    return raw ? parseActiveFocus(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function saveActiveFocus(session: ActiveFocusSession) {
  try {
    window.localStorage.setItem(ACTIVE_FOCUS_KEY, JSON.stringify(session))
  } catch {
    // Active-session recovery is best effort when storage is unavailable.
  }
}

export function clearActiveFocus() {
  window.localStorage.removeItem(ACTIVE_FOCUS_KEY)
}

export function loadActiveLaunch() {
  try {
    const raw = window.localStorage.getItem(ACTIVE_LAUNCH_KEY)
    return raw ? parseFocusLaunch(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function saveActiveLaunch(launch: FocusLaunchSession) {
  try {
    window.localStorage.setItem(ACTIVE_LAUNCH_KEY, JSON.stringify(launch))
  } catch {
    // Draft recovery remains best effort when local storage is unavailable.
  }
}

export function clearActiveLaunch() {
  window.localStorage.removeItem(ACTIVE_LAUNCH_KEY)
}

export function toTrainingSession(result: TaskResult): TrainingSession {
  return {
    ...result,
    id: crypto.randomUUID(),
    completedAt: new Date().toISOString(),
  }
}

export function createFocusSession(
  input: Omit<FocusSession, 'id' | 'completedAt'>,
): FocusSession {
  return {
    ...input,
    id: crypto.randomUUID(),
    completedAt: new Date().toISOString(),
  }
}
