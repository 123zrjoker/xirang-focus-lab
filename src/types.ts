export type Page = 'home' | 'today' | 'notes' | 'launch' | 'training' | 'focus' | 'progress' | 'settings' | 'assessment'

export type TaskType = 'schulte' | 'go-no-go' | 'vigilance' | 'stroop'

export type SchulteVariant = 'numbers' | 'letters' | 'alternating' | 'color-switch' | 'radial' | 'dynamic'

export type GoNoGoVariant = 'adaptive' | 'rule-switch' | 'more-stops' | 'fewer-stops'

export type StroopVariant = 'color' | 'direction' | 'size'

export type VigilanceVariant = 'adaptive' | 'fast' | 'rare' | 'extended'

export type GoalType = 'study' | 'work' | 'phone'

export type FocusEndReason = 'completed' | 'interrupted' | 'abandoned'

export type FocusMode = 'free' | 'pomodoro'

export type FocusBreakKind = 'short' | 'long'

export type LaunchMode = 'known-task' | 'choose-task'

export type LaunchStatus = 'draft' | 'ready' | 'warming-up' | 'focusing' | 'completed' | 'abandoned'

export type LaunchTaskCategory = 'reading' | 'writing' | 'study' | 'coding' | 'admin' | 'life' | 'other'

export type LaunchWarmupType = 'visual' | 'inhibition' | 'none'

export type LaunchLevel = 1 | 2 | 3

export type ActionSlipStatus = 'inbox' | 'current' | 'completed'

export interface ActionSlip {
  id: string
  title: string
  status: ActionSlipStatus
  createdAt: string
  updatedAt: string
  completedAt?: string
  nextStep?: string
  sourceLaunchId?: string
  focusSessionIds: string[]
}

export interface PersonalNote {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
}

export interface LaunchCandidate {
  id: string
  title: string
  importance: LaunchLevel
  urgency: LaunchLevel
  startability: LaunchLevel
}

export interface LaunchWarmupResult {
  type: Exclude<LaunchWarmupType, 'none'>
  durationSec: number
  correctCount: number
  errorCount: number
  completedAt: string
}

export interface FocusLaunchSession {
  id: string
  mode: LaunchMode
  status: LaunchStatus
  createdAt: string
  updatedAt: string
  completedAt?: string
  candidates: LaunchCandidate[]
  selectedCandidateId?: string
  taskName: string
  taskCategory: LaunchTaskCategory
  firstAction: string
  completionDefinition: string
  plannedDurationMin: number
  energyBefore: LaunchLevel
  resistanceBefore: LaunchLevel
  warmupType: LaunchWarmupType
  warmupResult?: LaunchWarmupResult
  focusSessionId?: string
  actionSlipId?: string
}

export interface FocusLaunchContext {
  launchId: string
  taskName: string
  taskCategory: LaunchTaskCategory
  firstAction: string
  completionDefinition: string
  plannedDurationMin: number
  energyBefore: LaunchLevel
  resistanceBefore: LaunchLevel
  actionSlipId?: string
}

export type DistractionReason = 'phone' | 'environment' | 'difficulty' | 'fatigue' | 'other'

export interface FocusDistraction {
  id: string
  note: string
  reason: DistractionReason
  createdAt: string
}

export interface FocusPreparationChecks {
  phoneAway: boolean
  workspaceReady: boolean
  goalClear: boolean
}

export type ActiveFocusStatus = 'preparing' | 'running' | 'paused' | 'review' | 'break' | 'break-ready'

export interface ActiveFocusSession {
  version: 1
  id: string
  status: ActiveFocusStatus
  taskName: string
  plannedDurationMin: number
  remainingSec: number
  elapsedFocusSec: number
  endAt?: string
  distractions: FocusDistraction[]
  pageLeaveCount: number
  completionRate: number
  subjectiveFocus: number
  endReason?: FocusEndReason
  preparationChecks: FocusPreparationChecks
  round: number
  focusMode: FocusMode
  pomodoroCycle: number
  breakKind?: FocusBreakKind
  launchId?: string
  taskCategory?: LaunchTaskCategory
  firstAction?: string
  completionDefinition?: string
  energyBefore?: LaunchLevel
  resistanceBefore?: LaunchLevel
  actionSlipId?: string
  nextStep?: string
}

export type DailyPlanMode = 'standard' | 'low-energy' | 'quick'

export interface DailyPlanItem {
  taskType: TaskType
  estimatedMinutes: number
  reason: string
}

export interface DailyPlan {
  dateKey: string
  createdAt: string
  mode: DailyPlanMode
  intensity: 'regular' | 'light'
  items: DailyPlanItem[]
  focusMinutes: number
  focusReason: string
  summary: string
}

export interface TaskResult {
  taskType: TaskType
  durationSec: number
  accuracy: number
  medianReactionMs: number
  omissions: number
  commissions: number
  errors: number
  score: number
  level: number
  metadata?: Record<string, number | string>
}

export interface TrainingSession extends TaskResult {
  id: string
  completedAt: string
}

export interface FocusSession {
  id: string
  taskName: string
  plannedDurationMin: number
  actualDurationSec: number
  completionRate: number
  distractionCount: number
  pageLeaveCount: number
  subjectiveFocus: number
  endReason: FocusEndReason
  distractions: FocusDistraction[]
  round: number
  focusMode: FocusMode
  pomodoroCycle: number
  completedAt: string
  launchId?: string
  taskCategory?: LaunchTaskCategory
  firstAction?: string
  completionDefinition?: string
  energyBefore?: LaunchLevel
  resistanceBefore?: LaunchLevel
  actionSlipId?: string
  nextStep?: string
}

export interface AttentionProfile {
  completedAt: string
  visualSearch: number
  sustainedAttention: number
  interferenceControl: number
  responseInhibition: number
}

export type AssessmentKind = 'baseline' | 'retest' | 'quick-check'

export type AssessmentDevice = 'desktop' | 'tablet' | 'mobile'

export type AssessmentInputMethod = 'mouse' | 'trackpad' | 'touch' | 'keyboard'

export type AssessmentEnvironment = 'quiet' | 'some-noise' | 'disrupted'

export interface AssessmentContext {
  device: AssessmentDevice
  inputMethod: AssessmentInputMethod
  sleepQuality: 1 | 2 | 3
  fatigueLevel: 1 | 2 | 3
  environment: AssessmentEnvironment
  interrupted: boolean
}

export interface AssessmentRecord {
  id: string
  kind: AssessmentKind
  completedAt: string
  profile: AttentionProfile
  results: TaskResult[]
  context?: AssessmentContext
}

export interface UserProfile {
  goal: GoalType
  dailyTargetMinutes: number
  preferredFocusMinutes: number
  onboardingComplete: boolean
  levels: Record<TaskType, number>
  adaptation: Record<TaskType, TaskAdaptationState>
}

export interface TaskAdaptationState {
  qualifiedWindows: number
  difficultWindows: number
  protectionRemaining: number
  lastOutcome: 'insufficient' | 'qualified' | 'difficult' | 'stable' | 'protected'
  lastChangedAt?: string
}

export interface AppSettings {
  soundEnabled: boolean
  animationsEnabled: boolean
  trainingTipsEnabled: boolean
  desktopNotificationsEnabled: boolean
}

export interface AppState {
  schemaVersion: number
  profile: UserProfile
  settings: AppSettings
  attentionProfile?: AttentionProfile
  assessments: AssessmentRecord[]
  sessions: TrainingSession[]
  focusSessions: FocusSession[]
  dailyPlans: DailyPlan[]
  focusLaunches: FocusLaunchSession[]
  actionSlips: ActionSlip[]
  personalNotes: PersonalNote[]
}
