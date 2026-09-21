import type { ActionContextSnapshot } from './agentContext'
import { apiUrl, desktopBridge } from './apiUrl'

export interface AgentFoundationStatus {
  graphVersion: string
  mode: 'stateful_approval'
  available: boolean
  provider: string
  model: string | null
  tools: string[]
  durable: boolean
}

export interface AgentPlanItem {
  title: string
  firstStep: string
  completionCriteria: string
  estimatedMinutes: number
  rationale: string
  sourceActionSlipIds: string[]
  evidenceRefs: string[]
}

export interface AgentPlanDraft {
  title: string
  summary: string
  items: AgentPlanItem[]
  assumptions: string[]
  evidenceRefs: string[]
}

export interface AgentEvidenceItem {
  referenceId: string
  chunkId: string
  sourceId: string
  sourceTitle: string
  heading: string
  content: string
  startLine: number
  endLine: number
  retrievalScore: number
  instructionFlagged: boolean
}

export interface AgentToolResult {
  callId: string
  name: string
  status: 'success' | 'denied' | 'error'
  output: Record<string, unknown>
  error: string | null
  durationMs: number
}

export interface AgentTraceEvent {
  eventId: string
  runId: string
  sequence: number
  createdAt: string
  kind: string
  node: string | null
  details: Record<string, unknown>
}

export type AgentOperation = 'save_plan' | 'start_focus'

export interface AgentApprovalDecision {
  decision: 'approve' | 'modify' | 'reject'
  operations: AgentOperation[]
  modifiedPlan?: AgentPlanDraft
  note?: string
}

export interface AgentMutationIntent {
  actionId: string
  toolName: AgentOperation
  arguments: Record<string, unknown>
  baseStateRevision: string
  riskLevel: 'commit'
  status: 'proposed'
}

export interface AgentExecutionAckItem {
  actionId: string
  status: 'applied' | 'already_applied' | 'failed'
  error?: string
}

export interface AgentExecutionAck {
  observedStateRevision: string
  items: AgentExecutionAckItem[]
}

export interface AgentProgressEvent {
  node: string
  status: string
  label: string
}

export interface AgentRunResult {
  schemaVersion: 1
  graphVersion: string
  threadId: string
  runId: string
  status: 'created' | 'planning' | 'using_tools' | 'validating' | 'awaiting_approval' | 'approved'
    | 'rejected' | 'awaiting_execution' | 'completed' | 'execution_failed' | 'cancelled' | 'failed'
  planDraft: AgentPlanDraft | null
  evidence: AgentEvidenceItem[]
  toolResults: AgentToolResult[]
  validationErrors: string[]
  approvalDecision: AgentApprovalDecision | null
  mutationIntents: AgentMutationIntent[]
  executionAck: AgentExecutionAck | null
  trace: AgentTraceEvent[]
}

async function responseError(response: Response) {
  try {
    const payload = await response.json() as { detail?: unknown }
    return typeof payload.detail === 'string' ? payload.detail : `本地 Agent 服务返回 ${response.status}。`
  } catch {
    return `本地 Agent 服务返回 ${response.status}。`
  }
}

function connectionError() {
  return new Error(desktopBridge()
    ? '无法连接桌面本机 Agent 服务，请在设置页查看运行状态并尝试重启。'
    : '无法连接本地 Agent 服务，请先运行 npm.cmd run dev:api。')
}

async function requestJson<T>(url: string, options?: RequestInit, timeoutMs = 130_000): Promise<T> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(apiUrl(url), { ...options, signal: controller.signal })
    } catch {
      if (controller.signal.aborted) throw new Error('本地 Agent 规划超时，请稍后重试。')
      throw connectionError()
    }
    if (!response.ok) throw new Error(await responseError(response))
    return await response.json() as T
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

export function getAgentFoundationStatus() {
  return requestJson<AgentFoundationStatus>('/api/agent/status', undefined, 8_000)
}

export function runAgentPlan(context: ActionContextSnapshot, threadId = crypto.randomUUID()) {
  return requestJson<AgentRunResult>('/api/agent/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, context }),
  })
}

export function getAgentThread(threadId: string) {
  return requestJson<AgentRunResult>(`/api/agent/threads/${encodeURIComponent(threadId)}`, undefined, 8_000)
}

export function resumeAgentThread(threadId: string, decision: AgentApprovalDecision) {
  return requestJson<AgentRunResult>(`/api/agent/threads/${encodeURIComponent(threadId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  }, 20_000)
}

export function acknowledgeAgentExecution(threadId: string, executionAck: AgentExecutionAck) {
  return requestJson<AgentRunResult>(`/api/agent/threads/${encodeURIComponent(threadId)}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executionAck }),
  }, 20_000)
}

function parseSseBlock(block: string): { event: string, data: unknown } | null {
  let event = 'message'
  const dataLines: string[] = []
  block.split(/\r?\n/).forEach((line) => {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  })
  if (!dataLines.length) return null
  return { event, data: JSON.parse(dataLines.join('\n')) }
}

async function streamAgentRequest(
  url: string,
  body: unknown,
  onProgress: (progress: AgentProgressEvent) => void,
  externalSignal?: AbortSignal,
  timeoutMs = 130_000,
): Promise<AgentRunResult> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort('timeout'), timeoutMs)
  const abortFromExternal = () => controller.abort('cancelled')
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  try {
    let response: Response
    try {
      response = await fetch(apiUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw error
      throw connectionError()
    }
    if (!response.ok) throw new Error(await responseError(response))
    if (!response.body) throw new Error('本地 Agent 服务没有返回可读取的进度流。')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalResult: AgentRunResult | null = null
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const parsed = parseSseBlock(block)
        if (!parsed) continue
        if (parsed.event === 'progress') onProgress(parsed.data as AgentProgressEvent)
        if (parsed.event === 'result') finalResult = parsed.data as AgentRunResult
        if (parsed.event === 'error') {
          const message = (parsed.data as { message?: unknown }).message
          throw new Error(typeof message === 'string' ? message : 'Agent 流式运行失败。')
        }
      }
      if (done) break
    }
    if (!finalResult) throw new Error('Agent 进度流已结束，但没有返回最终状态。')
    return finalResult
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(controller.signal.reason === 'timeout'
        ? '本地 Agent 规划超时，请稍后重试。'
        : '已停止接收本次 Agent 进度；若后台已到审批点，刷新页面可恢复。')
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }
}

export function streamAgentPlan(
  context: ActionContextSnapshot,
  threadId: string,
  onProgress: (progress: AgentProgressEvent) => void,
  externalSignal?: AbortSignal,
) {
  return streamAgentRequest(
    '/api/agent/plan/stream',
    { threadId, context },
    onProgress,
    externalSignal,
  )
}

export function streamAgentResume(
  threadId: string,
  decision: AgentApprovalDecision,
  onProgress: (progress: AgentProgressEvent) => void,
) {
  return streamAgentRequest(
    `/api/agent/threads/${encodeURIComponent(threadId)}/resume/stream`,
    { decision },
    onProgress,
    undefined,
    30_000,
  )
}

export function streamAgentExecutionAck(
  threadId: string,
  executionAck: AgentExecutionAck,
  onProgress: (progress: AgentProgressEvent) => void,
) {
  return streamAgentRequest(
    `/api/agent/threads/${encodeURIComponent(threadId)}/ack/stream`,
    { executionAck },
    onProgress,
    undefined,
    30_000,
  )
}
