import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAgentFoundationStatus,
  runAgentPlan,
  streamAgentExecutionAck,
  streamAgentPlan,
  streamAgentResume,
} from '../src/lib/agentClient'
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
  it('reads the durable stateful foundation status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      graphVersion: '0.5.1-stateful-v1', mode: 'stateful_approval', available: true,
      provider: 'deepseek', model: 'deepseek-v4-flash', tools: ['query_todos'], durable: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getAgentFoundationStatus()).resolves.toMatchObject({ mode: 'stateful_approval', available: true, durable: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/status', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('sends the exact previewed snapshot without credentials', async () => {
    const response = {
      schemaVersion: 1, graphVersion: '0.5.1-stateful-v1', threadId: 'thread-client', runId: 'run-client',
      status: 'awaiting_approval', planDraft: {
        title: '计划', summary: '只读草案', items: [{
          title: '任务', firstStep: '开始', completionCriteria: '完成', estimatedMinutes: 25,
          rationale: '请求', sourceActionSlipIds: [], evidenceRefs: [],
        }], assumptions: [], evidenceRefs: [],
      }, evidence: [], toolResults: [], validationErrors: [], approvalDecision: null,
      mutationIntents: [], executionAck: null, trace: [],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runAgentPlan(context, 'thread-client')).resolves.toMatchObject({ status: 'awaiting_approval' })
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

  it('parses progress and the approval interrupt result from an SSE stream', async () => {
    const result = {
      schemaVersion: 1, graphVersion: '0.5.1-stateful-v1', threadId: 'thread-stream', runId: 'run-stream',
      status: 'awaiting_approval', planDraft: null, evidence: [], toolResults: [], validationErrors: [],
      approvalDecision: null, mutationIntents: [], executionAck: null, trace: [],
    }
    const body = [
      'event: progress\ndata: {"node":"planner","status":"planning","label":"正在生成计划草案"}\n\n',
      `event: result\ndata: ${JSON.stringify(result)}\n\n`,
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })))
    const progress: string[] = []

    await expect(streamAgentPlan(context, 'thread-stream', (event) => progress.push(event.node)))
      .resolves.toMatchObject({ status: 'awaiting_approval', threadId: 'thread-stream' })
    expect(progress).toEqual(['planner'])
  })

  it('streams approval resume and execution acknowledgement with exact payloads', async () => {
    const result = {
      schemaVersion: 1, graphVersion: '0.5.1-stateful-v1', threadId: 'thread-stream', runId: 'run-stream',
      status: 'completed', planDraft: null, evidence: [], toolResults: [], validationErrors: [],
      approvalDecision: null, mutationIntents: [], executionAck: null, trace: [],
    }
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      `event: progress\ndata: {"node":"transition","status":"running","label":"处理中"}\n\nevent: result\ndata: ${JSON.stringify(result)}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )))
    vi.stubGlobal('fetch', fetchMock)
    const decision = { decision: 'approve' as const, operations: ['save_plan' as const] }
    const ack = {
      observedStateRevision: 'A'.repeat(64),
      items: [{ actionId: 'agent-action-1', status: 'applied' as const }],
    }

    await streamAgentResume('thread-stream', decision, () => undefined)
    await streamAgentExecutionAck('thread-stream', ack, () => undefined)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/agent/threads/thread-stream/resume/stream')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ decision })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/agent/threads/thread-stream/ack/stream')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ executionAck: ack })
  })
})
