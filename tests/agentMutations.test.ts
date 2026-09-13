import { describe, expect, it } from 'vitest'
import { calculateActionStateRevision } from '../src/lib/agentContext'
import type { AgentMutationIntent, AgentPlanDraft } from '../src/lib/agentClient'
import { applyAgentMutationIntents, createApprovedFocusSession } from '../src/lib/agentMutations'
import { createDefaultState } from '../src/lib/storage'

const plan: AgentPlanDraft = {
  title: '本周行动计划',
  summary: '先完成最小可执行步骤。',
  items: [{
    title: '完成状态恢复测试',
    firstStep: '打开测试文件',
    completionCriteria: '重启后仍能恢复审批状态',
    estimatedMinutes: 25,
    rationale: '优先验证持久化边界',
    sourceActionSlipIds: [],
    evidenceRefs: [],
  }],
  assumptions: ['本机存储可用'],
  evidenceRefs: [],
}

async function intentsForCurrentState(): Promise<AgentMutationIntent[]> {
  const state = createDefaultState()
  const base = await calculateActionStateRevision(state)
  return [{
    actionId: 'save-action-1',
    toolName: 'save_plan',
    arguments: { threadId: 'thread-1', runId: 'run-1', plan },
    baseStateRevision: base,
    riskLevel: 'commit',
    status: 'proposed',
  }, {
    actionId: 'focus-action-1',
    toolName: 'start_focus',
    arguments: {
      taskName: plan.items[0].title,
      minutes: 25,
      firstStep: plan.items[0].firstStep,
      completionCriteria: plan.items[0].completionCriteria,
    },
    baseStateRevision: base,
    riskLevel: 'commit',
    status: 'proposed',
  }]
}

describe('approved agent mutation intents', () => {
  it('applies save and focus atomically and treats a retry as already applied', async () => {
    const state = createDefaultState()
    const intents = await intentsForCurrentState()
    const first = await applyAgentMutationIntents(state, intents, [], new Date('2026-09-13T08:00:00.000Z'))

    expect(first.nextState.agentPlans).toHaveLength(1)
    expect(first.focusRequests).toHaveLength(1)
    expect(first.executionAck.items.map((item) => item.status)).toEqual(['applied', 'applied'])

    const retry = await applyAgentMutationIntents(first.nextState, intents, first.appliedActionIds)
    expect(retry.nextState.agentPlans).toHaveLength(1)
    expect(retry.focusRequests).toHaveLength(1)
    expect(retry.executionAck.items.map((item) => item.status)).toEqual(['already_applied', 'already_applied'])

    const focus = createApprovedFocusSession(first.focusRequests[0], new Date('2026-09-13T08:00:00.000Z'))
    expect(focus).toMatchObject({
      id: 'agent-focus-focus-action-1', status: 'preparing', remainingSec: 30,
      firstAction: '打开测试文件', completionDefinition: '重启后仍能恢复审批状态',
    })

    const recoveredWithoutLedger = await applyAgentMutationIntents(
      first.nextState,
      intents,
      [],
      new Date(),
      focus.id,
    )
    expect(recoveredWithoutLedger.executionAck.items.map((item) => item.status))
      .toEqual(['already_applied', 'already_applied'])
    expect(recoveredWithoutLedger.focusRequests).toHaveLength(1)

    const retryWithoutLedger = await applyAgentMutationIntents(first.nextState, intents, [], new Date(), focus.id)
    expect(retryWithoutLedger.executionAck.items.map((item) => item.status)).toEqual(['already_applied', 'already_applied'])
    expect(retryWithoutLedger.focusRequests).toHaveLength(1)
  })

  it('fails the whole batch when the local state revision changed', async () => {
    const state = createDefaultState()
    const intents = await intentsForCurrentState()
    state.actionSlips.push({
      id: 'changed', title: '规划后新增的任务', status: 'inbox',
      createdAt: '2026-09-13T08:00:00.000Z', updatedAt: '2026-09-13T08:00:00.000Z', focusSessionIds: [],
    })

    const result = await applyAgentMutationIntents(state, intents, [])
    expect(result.nextState).toBe(state)
    expect(result.focusRequests).toEqual([])
    expect(result.executionAck.items.every((item) => item.status === 'failed')).toBe(true)
    expect(result.executionAck.items[0].error).toContain('状态')
  })

  it('does not partially save when another intent has invalid arguments', async () => {
    const state = createDefaultState()
    const intents = await intentsForCurrentState()
    intents[1] = { ...intents[1], arguments: { ...intents[1].arguments, minutes: 0 } }

    const result = await applyAgentMutationIntents(state, intents, [])
    expect(result.nextState).toBe(state)
    expect(result.nextState.agentPlans).toEqual([])
    expect(result.executionAck.items.every((item) => item.status === 'failed')).toBe(true)
  })

  it('fails closed when a focus session is already active', async () => {
    const state = createDefaultState()
    const intents = await intentsForCurrentState()

    const result = await applyAgentMutationIntents(state, intents, [], new Date(), 'another-active-focus')
    expect(result.nextState).toBe(state)
    expect(result.executionAck.items[0].error).toContain('已有专注会话')
  })
})
