import { describe, expect, it } from 'vitest'
import { buildActionContextSnapshot } from '../src/lib/agentContext'
import { createDefaultState } from '../src/lib/storage'
import type { AppState } from '../src/types'

function populatedState(): AppState {
  const state = createDefaultState()
  state.profile.goal = 'work'
  state.profile.dailyTargetMinutes = 30
  state.profile.preferredFocusMinutes = 25
  state.actionSlips = [{
    id: 'todo-current', title: '完成 Agent 快照', status: 'current',
    createdAt: '2026-09-10T08:00:00.000Z', updatedAt: '2026-09-12T08:00:00.000Z',
    nextStep: '先写契约测试', focusSessionIds: [],
  }, {
    id: 'todo-done', title: '旧任务', status: 'completed',
    createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-02T08:00:00.000Z',
    completedAt: '2026-09-02T08:00:00.000Z', focusSessionIds: [],
  }]
  state.dailyPlans = [{
    dateKey: '2026-09-12', createdAt: '2026-09-12T00:00:00.000Z', mode: 'standard', intensity: 'regular',
    items: [{ taskType: 'schulte', estimatedMinutes: 3, reason: '测试' }], focusMinutes: 25,
    focusReason: '保持节奏', summary: '今天完成一个关键步骤。',
  }]
  state.focusSessions = [{
    id: 'focus-1', taskName: 'Agent 快照', plannedDurationMin: 25, actualDurationSec: 1_500,
    completionRate: 80, distractionCount: 1, pageLeaveCount: 0, subjectiveFocus: 4,
    endReason: 'completed', distractions: [{ id: 'd1', note: '私人原始备注不应发送', reason: 'phone', createdAt: '2026-09-11T02:10:00.000Z' }],
    round: 1, focusMode: 'free', pomodoroCycle: 1, completedAt: '2026-09-11T02:30:00.000Z',
  }]
  return state
}

describe('agent action context snapshot', () => {
  it('builds a bounded preview without raw focus notes or completed todos', async () => {
    const snapshot = await buildActionContextSnapshot(populatedState(), '  安排本周工作  ', {
      includeTodos: true,
      includeDailyPlans: true,
      includeFocusSummary: true,
      includeKnowledgeSources: true,
      selectedKnowledgeSourceIds: ['source-1'],
      knowledgeSourceTotal: 3,
    }, {
      now: new Date('2026-09-12T08:00:00.000Z'),
      snapshotId: 'snapshot-test-001',
      timezone: 'Asia/Shanghai',
    })

    expect(snapshot.userRequest).toBe('安排本周工作')
    expect(snapshot.activeActionSlips.map((item) => item.id)).toEqual(['todo-current'])
    expect(snapshot.focusSummary).toMatchObject({
      sessionCount: 1, totalMinutes: 25, averageCompletionRate: 80,
      averageSubjectiveFocus: 4, distractionCounts: { phone: 1 },
    })
    expect(snapshot.consentScope).toEqual(['todos', 'daily_plans', 'focus_summary', 'knowledge_sources'])
    expect(snapshot.sampleBoundaries).toMatchObject({
      actionSlipLimit: 1, actionSlipTotal: 1, dailyPlanLimit: 1, dailyPlanTotal: 1,
      knowledgeSourceTotal: 3, knowledgeSourceSelected: 1,
    })
    expect(snapshot.baseStateRevision).toMatch(/^[A-F0-9]{64}$/)
    expect(JSON.stringify(snapshot)).not.toContain('私人原始备注不应发送')
    expect(JSON.stringify(snapshot)).not.toContain('旧任务')
  })

  it('does not leak counts or data from categories the user excluded', async () => {
    const snapshot = await buildActionContextSnapshot(populatedState(), '只使用我的请求', {
      includeTodos: false,
      includeDailyPlans: false,
      includeFocusSummary: false,
      includeKnowledgeSources: false,
      selectedKnowledgeSourceIds: ['ignored-source'],
      knowledgeSourceTotal: 99,
    }, { snapshotId: 'snapshot-test-002' })

    expect(snapshot.consentScope).toEqual([])
    expect(snapshot.activeActionSlips).toEqual([])
    expect(snapshot.recentDailyPlans).toEqual([])
    expect(snapshot.focusSummary).toBeUndefined()
    expect(snapshot.selectedKnowledgeSourceIds).toEqual([])
    expect(snapshot.sampleBoundaries).toMatchObject({
      actionSlipTotal: 0, dailyPlanTotal: 0, knowledgeSourceTotal: 0, knowledgeSourceSelected: 0,
    })
  })

  it('changes the base revision when mutable action data changes', async () => {
    const state = populatedState()
    const selection = {
      includeTodos: true,
      includeDailyPlans: false,
      includeFocusSummary: false,
      includeKnowledgeSources: false,
      selectedKnowledgeSourceIds: [],
      knowledgeSourceTotal: 0,
    }
    const first = await buildActionContextSnapshot(state, '规划任务', selection, { snapshotId: 'snapshot-test-003' })
    state.actionSlips[0].title = '已改变的任务'
    const second = await buildActionContextSnapshot(state, '规划任务', selection, { snapshotId: 'snapshot-test-004' })

    expect(first.baseStateRevision).not.toBe(second.baseStateRevision)
  })
})
