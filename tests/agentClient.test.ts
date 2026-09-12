import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentFoundationStatus, runAgentPlan } from '../src/lib/agentClient'
import type { ActionContextSnapshot } from '../src/lib/agentContext'

const context: ActionContextSnapshot = {
  schemaVersion: 1,
  snapshotId: 'snapshot-client-001',
  createdAt: '2026-09-12T10:00:00.000Z',
  timezone: 'Asia/Shanghai',
  baseStateRevision: 'A'.repeat(64),
  userRequest: '安排本周行动计划',
  goalAndPreferences: { goal: 'work', dailyTargetMinutes: 30, preferredFocusMinutes: 25 },
  activeActionSlips: [],
  recentDailyPlans: [],
  selectedKnowledgeSourceIds: [],
  consentScope: [],
  sampleBoundaries: {
    actionSlipLimit: 0, actionSlipTotal: 0, dailyPlanLimit: 0, dailyPlanTotal: 0,
    focusWindowDays: 7, knowledgeSourceTotal: 0, knowledgeSourceSelected: 0,
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent client', () => {
  it('reads the read-only foundation status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      graphVersion: '0.5.0-read-only-v1', mode: 'read_only', available: true,
      provider: 'deepseek', model: 'deepseek-v4-flash', tools: ['query_todos'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getAgentFoundationStatus()).resolves.toMatchObject({ mode: 'read_only', available: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/status', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('sends the exact previewed snapshot without credentials', async () => {
    const response = {
      schemaVersion: 1, graphVersion: '0.5.0-read-only-v1', threadId: 'thread-client', runId: 'run-client',
      status: 'completed', planDraft: {
        title: '计划', summary: '只读草案', items: [{
          title: '任务', firstStep: '开始', completionCriteria: '完成', estimatedMinutes: 25,
          rationale: '请求', sourceActionSlipIds: [], evidenceRefs: [],
        }], assumptions: [], evidenceRefs: [],
      }, evidence: [], toolResults: [], validationErrors: [], trace: [],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runAgentPlan(context, 'thread-client')).resolves.toMatchObject({ status: 'completed' })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/agent/plan')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ threadId: 'thread-client', context })
    expect(options.body).not.toContain('apiKey')
    expect(options.body).not.toContain('credential')
  })

  it('surfaces backend permission and configuration failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: 'DeepSeek 尚未配置，请先在设置页安全保存 API Key。',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })))

    await expect(runAgentPlan(context, 'thread-client')).rejects.toThrow('DeepSeek 尚未配置')
  })
})
