import type {
  FocusLaunchContext,
  FocusLaunchSession,
  LaunchCandidate,
  LaunchMode,
  LaunchTaskCategory,
  LaunchWarmupType,
} from '../types'

export const launchCategoryLabels: Record<LaunchTaskCategory, string> = {
  reading: '阅读',
  writing: '写作',
  study: '背诵 / 学习',
  coding: '编程',
  admin: '行政办公',
  life: '生活事务',
  other: '其他',
}

export const launchWarmupLabels: Record<LaunchWarmupType, string> = {
  visual: '60 秒视觉启动',
  inhibition: '60 秒停住冲动',
  none: '直接开始',
}

export function createLaunchCandidate(title = ''): LaunchCandidate {
  return {
    id: crypto.randomUUID(),
    title,
    importance: 2,
    urgency: 2,
    startability: 2,
  }
}

export function createLaunchDraft(mode: LaunchMode, preferredMinutes = 25, actionSlipId?: string): FocusLaunchSession {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    mode,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    candidates: mode === 'choose-task'
      ? [createLaunchCandidate(), createLaunchCandidate(), createLaunchCandidate()]
      : [],
    taskName: '',
    taskCategory: 'other',
    firstAction: '',
    completionDefinition: '',
    plannedDurationMin: preferredMinutes,
    energyBefore: 2,
    resistanceBefore: 2,
    warmupType: 'none',
    actionSlipId,
  }
}

export function recommendLaunchWarmup(launch: FocusLaunchSession): LaunchWarmupType {
  if (launch.energyBefore === 1 || launch.resistanceBefore === 1) return 'none'
  if (launch.mode === 'choose-task' && launch.resistanceBefore < 3) return 'none'
  if (['reading', 'study'].includes(launch.taskCategory)) return 'visual'
  if (['writing', 'coding', 'admin'].includes(launch.taskCategory)) return 'inhibition'
  return launch.resistanceBefore === 3 ? 'visual' : 'none'
}

export function normalizeLaunchText(value: string, maxLength = 120) {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

export function validateLaunchDetails(launch: FocusLaunchSession) {
  const errors: string[] = []
  if (!normalizeLaunchText(launch.taskName)) errors.push('请写下这次真正要推进的任务。')
  if (!normalizeLaunchText(launch.firstAction)) errors.push('请把任务缩小成一个可以立刻执行的动作。')
  if (!normalizeLaunchText(launch.completionDefinition)) errors.push('请写下这一轮结束时希望得到什么。')
  return errors
}

export function toFocusLaunchContext(launch: FocusLaunchSession): FocusLaunchContext {
  return {
    launchId: launch.id,
    taskName: normalizeLaunchText(launch.taskName),
    taskCategory: launch.taskCategory,
    firstAction: normalizeLaunchText(launch.firstAction),
    completionDefinition: normalizeLaunchText(launch.completionDefinition),
    plannedDurationMin: launch.plannedDurationMin,
    energyBefore: launch.energyBefore,
    resistanceBefore: launch.resistanceBefore,
    actionSlipId: launch.actionSlipId,
  }
}
