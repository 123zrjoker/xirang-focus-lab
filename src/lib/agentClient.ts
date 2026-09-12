import type { ActionContextSnapshot } from './agentContext'

export interface AgentFoundationStatus {
  graphVersion: string
  mode: 'read_only'
  available: boolean
  provider: string
  model: string | null
  tools: string[]
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

export interface AgentRunResult {
  schemaVersion: 1
  graphVersion: string
  threadId: string
  runId: string
  status: 'created' | 'planning' | 'using_tools' | 'validating' | 'completed' | 'failed'
  planDraft: AgentPlanDraft | null
  evidence: AgentEvidenceItem[]
  toolResults: AgentToolResult[]
  validationErrors: string[]
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

async function requestJson<T>(url: string, options?: RequestInit, timeoutMs = 130_000): Promise<T> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) throw new Error(await responseError(response))
    return await response.json() as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('本地 Agent 规划超时，请稍后重试。')
    }
    throw error
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
