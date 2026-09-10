import { describe, expect, it } from 'vitest'
import { buildActionInsights } from '../src/lib/actionInsights'
import { createDefaultState } from '../src/lib/storage'
import type { ActionSlip, FocusLaunchSession, FocusSession } from '../src/types'

const now = new Date('2026-09-10T12:00:00.000Z')

const actionSlips: ActionSlip[] = [
  {
    id: 'todo-current', title: '整理研究提纲', status: 'current', createdAt: '2026-09-05T08:00:00.000Z',
    updatedAt: '2026-09-07T09:00:00.000Z', focusSessionIds: ['focus-assisted'],
  },
  {
    id: 'todo-completed', title: '完成数据检查', status: 'completed', createdAt: '2026-09-04T08:00:00.000Z',
    updatedAt: '2026-09-06T09:00:00.000Z', completedAt: '2026-09-06T09:00:00.000Z', focusSessionIds: ['focus-direct'],
  },
  {
    id: 'todo-stalled', title: '重新整理资料目录', status: 'inbox', createdAt: '2026-08-20T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z', focusSessionIds: [],
  },
]

const focusSessions: FocusSession[] = [
  {
    id: 'focus-direct', taskName: '完成数据检查', plannedDurationMin: 25, actualDurationSec: 1500,
    completionRate: 80, distractionCount: 2, pageLeaveCount: 0, subjectiveFocus: 4, endReason: 'completed',
    distractions: [
      { id: 'd1', note: '', reason: 'phone', createdAt: '2026-09-06T08:20:00.000Z' },
      { id: 'd2', note: '', reason: 'phone', createdAt: '2026-09-06T08:35:00.000Z' },
    ],
    round: 1, focusMode: 'free', pomodoroCycle: 1, completedAt: '2026-09-06T09:00:00.000Z',
    actionSlipId: 'todo-completed', nextStep: '复核异常行',
  },
  {
    id: 'focus-assisted', taskName: '整理研究提纲', plannedDurationMin: 25, actualDurationSec: 1200,
    completionRate: 60, distractionCount: 1, pageLeaveCount: 0, subjectiveFocus: 3, endReason: 'completed',
    distractions: [{ id: 'd3', note: '', reason: 'fatigue', createdAt: '2026-09-07T08:25:00.000Z' }],
    round: 1, focusMode: 'free', pomodoroCycle: 1, completedAt: '2026-09-07T09:00:00.000Z',
    actionSlipId: 'todo-current', launchId: 'launch-1',
  },
]

const focusLaunches: FocusLaunchSession[] = [{
  id: 'launch-1', mode: 'known-task', status: 'completed', createdAt: '2026-09-07T08:00:00.000Z',
  updatedAt: '2026-09-07T09:00:00.000Z', completedAt: '2026-09-07T09:00:00.000Z', candidates: [],
  taskName: '整理研究提纲', taskCategory: 'writing', firstAction: '打开提纲', completionDefinition: '列出三级标题',
  plannedDurationMin: 25, energyBefore: 2, resistanceBefore: 3, warmupType: 'visual',
  focusSessionId: 'focus-assisted', actionSlipId: 'todo-current',
}]

describe('action insights', () => {
  it('summarizes todo movement, start paths, completion and distractions within the selected range', () => {
    const state = { ...createDefaultState(), actionSlips, focusSessions, focusLaunches }
    const result = buildActionInsights(state, '7d', now)

    expect(result).toMatchObject({
      recordedTodoCount: 2,
      startedTodoCount: 2,
      startRate: 100,
      focusCount: 2,
      averageResistance: 3,
      resistanceSampleCount: 1,
      averageCompletion: 70,
      nextStepCount: 1,
      nextStepRate: 50,
      directStartCount: 1,
      assistedStartCount: 1,
      averageDistractions: 1.5,
      sampleTone: 'limited',
    })
    expect(result.distractionBreakdown[0]).toMatchObject({ reason: 'phone', count: 2 })
    expect(result.continuations[0]).toMatchObject({ taskName: '完成数据检查', nextStep: '复核异常行' })
    expect(result.stalledTodos[0]).toMatchObject({ id: 'todo-stalled', daysWaiting: 21 })
  })

  it('does not manufacture conclusions when there are no action records', () => {
    const result = buildActionInsights(createDefaultState(), '30d', now)

    expect(result.startRate).toBeNull()
    expect(result.averageResistance).toBeNull()
    expect(result.averageCompletion).toBeNull()
    expect(result.sampleTone).toBe('empty')
    expect(result.observations).toHaveLength(1)
  })

  it('keeps dated metrics inside the selected range while retaining genuinely stalled current todos', () => {
    const oldFocus = { ...focusSessions[0], id: 'focus-old', completedAt: '2026-08-20T09:00:00.000Z' }
    const state = { ...createDefaultState(), actionSlips, focusSessions: [...focusSessions, oldFocus], focusLaunches }

    expect(buildActionInsights(state, '7d', now).focusCount).toBe(2)
    expect(buildActionInsights(state, 'all', now).focusCount).toBe(3)
    expect(buildActionInsights(state, '7d', now).stalledTodos[0]?.id).toBe('todo-stalled')
  })
})
