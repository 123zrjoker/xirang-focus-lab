import { describe, expect, it, vi } from 'vitest'
import { attachFocusToActionSlips, completeActionSlip, createActionSlip, reopenActionSlip, setCurrentActionSlip, updateActionSlipTitle } from '../src/lib/actionSlips'
import type { FocusSession } from '../src/types'

describe('action slips', () => {
  it('creates a normalized inbox item and keeps only one current item', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'slip-1' })
    const first = createActionSlip('  修改   设计文档  ', '2026-08-31T09:00:00.000Z')
    const second = { ...createActionSlip('整理测试', '2026-08-31T09:01:00.000Z'), id: 'slip-2' }
    const withFirstCurrent = setCurrentActionSlip([first, second], 'slip-1', '2026-08-31T09:02:00.000Z')
    const withSecondCurrent = setCurrentActionSlip(withFirstCurrent, 'slip-2', '2026-08-31T09:03:00.000Z')

    expect(first.title).toBe('修改 设计文档')
    expect(withSecondCurrent.find((item) => item.id === 'slip-1')?.status).toBe('inbox')
    expect(withSecondCurrent.find((item) => item.id === 'slip-2')?.status).toBe('current')
    vi.unstubAllGlobals()
  })

  it('links a focus result, stores the optional next step and completes at 100%', () => {
    const slip = {
      id: 'slip-1', title: '修改文档', status: 'current' as const, createdAt: '2026-08-31T09:00:00.000Z',
      updatedAt: '2026-08-31T09:00:00.000Z', focusSessionIds: [],
    }
    const session: FocusSession = {
      id: 'focus-1', taskName: '修改文档', plannedDurationMin: 25, actualDurationSec: 1500,
      completionRate: 100, distractionCount: 0, pageLeaveCount: 0, subjectiveFocus: 4, endReason: 'completed',
      distractions: [], round: 1, focusMode: 'free', pomodoroCycle: 1, completedAt: '2026-08-31T09:30:00.000Z',
      actionSlipId: 'slip-1', nextStep: '  检查最后一节  ',
    }
    const [linked] = attachFocusToActionSlips([slip], session)

    expect(linked.status).toBe('completed')
    expect(linked.focusSessionIds).toEqual(['focus-1'])
    expect(linked.nextStep).toBe('检查最后一节')
    expect(completeActionSlip([slip], 'slip-1')[0].status).toBe('completed')
  })

  it('edits and reopens a completed slip without changing its identity', () => {
    const completed = {
      id: 'slip-1', title: '旧标题', status: 'completed' as const, createdAt: '2026-08-31T09:00:00.000Z',
      updatedAt: '2026-08-31T09:30:00.000Z', completedAt: '2026-08-31T09:30:00.000Z', focusSessionIds: [],
    }
    const [edited] = updateActionSlipTitle([completed], 'slip-1', '  新   标题 ', '2026-08-31T10:00:00.000Z')
    const [reopened] = reopenActionSlip([edited], 'slip-1', '2026-08-31T10:01:00.000Z')

    expect(edited.title).toBe('新 标题')
    expect(reopened).toMatchObject({ id: 'slip-1', status: 'inbox' })
    expect(reopened.completedAt).toBeUndefined()
  })
})
