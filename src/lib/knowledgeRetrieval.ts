import type { KnowledgeChunk } from './knowledgeBase'

export interface RetrievalHealth {
  status: 'ok'
  version: string
  retrievalEngine: string
  storesData: boolean
  semanticEngine?: string
  index?: RetrievalIndexStatus
  reranker?: {
    model: string
    available: boolean
    checksum: string | null
  }
  generation?: {
    provider: string
    available: boolean
    configured: boolean
    model: string | null
    endpointHost?: string | null
    responseFormat?: string
    credentialPresent?: boolean
    credentialSource?: string
    persistentStorageSupported?: boolean
    credentialStorageError?: boolean
  }
}

export interface DeepSeekCredentialStatus {
  provider: 'deepseek'
  configured: boolean
  available: boolean
  model: string | null
  credentialSource: string
  persistentStorageSupported: boolean
  credentialStorageError: boolean
  storageDescription: string
}

export type RetrievalMode = 'keyword' | 'vector' | 'hybrid' | 'hybrid_rerank'

export interface RetrievalIndexStatus {
  ready: boolean
  chunkCount: number
  fingerprint: string | null
  model: string
  dimensions: number
  modelAvailable: boolean
  modelChecksum: string | null
  builtAt: string | null
  storage: string
}

export interface RetrievalIndexSync extends RetrievalIndexStatus {
  added: number
  updated: number
  removed: number
  unchanged: number
  durationMs: number
}

export interface RetrievalScoreBreakdown {
  bm25: number
  titleBoost: number
  headingBoost: number
  phraseBoost: number
  coverageBoost: number
  vector: number
  rrf: number
  reranker: number | null
  keywordRank: number | null
  vectorRank: number | null
  rankDelta: number | null
}

export interface KnowledgeRetrievalResult {
  chunkId: string
  sourceId: string
  sourceTitle: string
  heading: string
  content: string
  excerpt: string
  score: number
  scoreBreakdown: RetrievalScoreBreakdown
  matchedTerms: string[]
  queryCoverage: number
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
}

export interface KnowledgeRetrievalResponse {
  engine: string
  mode: RetrievalMode
  query: string
  normalizedQuery: string
  queryTerms: string[]
  results: KnowledgeRetrievalResult[]
  durationMs: number
  confidence: 'strong' | 'possible' | 'none'
  noAnswerReason: string | null
  corpusStats: {
    chunkCount: number
    sourceCount: number
    averageChunkLength: number
  }
  warnings: string[]
}

export interface RagEvidence {
  referenceId: string
  chunkId: string
  sourceId: string
  sourceTitle: string
  heading: string
  content: string
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  retrievalScore: number
  truncated: boolean
  instructionFlagged: boolean
}

export interface RagAnswerResponse {
  status: 'context_only' | 'answered' | 'refused'
  query: string
  answer: string | null
  citationIds: string[]
  uncertainties: string[]
  evidence: RagEvidence[]
  provider: string | null
  model: string | null
  retrieval: {
    engine: string
    mode: 'hybrid' | 'hybrid_rerank'
    confidence: 'strong' | 'possible' | 'none'
    durationMs: number
  }
  context: {
    evidenceCount: number
    usedCharacters: number
    omittedCount: number
    flaggedReferenceIds: string[]
  }
  generation: {
    durationMs: number
    inputTokens: number | null
    outputTokens: number | null
    cacheHitInputTokens?: number | null
    cacheMissInputTokens?: number | null
  } | null
  warnings: string[]
}

const configuredApiBase = import.meta.env.VITE_RETRIEVAL_API_URL?.replace(/\/$/, '')

function apiUrl(path: string) {
  if (configuredApiBase) return `${configuredApiBase}${path}`
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') return `http://127.0.0.1:8000${path}`
  return path
}

async function request(path: string, init?: RequestInit, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(apiUrl(path), { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('本地检索服务响应超时。')
    throw new Error('无法连接本地检索服务，请先运行 npm.cmd run dev:api。')
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

async function responseError(response: Response) {
  try {
    const payload = await response.json() as { detail?: string | Array<{ msg?: string }> }
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) return payload.detail.map((item) => item.msg).filter(Boolean).join('；')
  } catch {
    // Fall through to the stable status message.
  }
  return `检索服务返回异常（HTTP ${response.status}）。`
}

function chunkPayload(chunk: KnowledgeChunk) {
  return {
    id: chunk.id,
    sourceId: chunk.sourceId,
    sourceTitle: chunk.sourceTitle,
    heading: chunk.heading,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    contentHash: chunk.contentHash,
    sourceContentHash: chunk.sourceContentHash,
  }
}

export async function checkRetrievalService(): Promise<RetrievalHealth> {
  const response = await request('/api/health', undefined, 3_000)
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as RetrievalHealth
  if (payload.status !== 'ok' || !payload.retrievalEngine) throw new Error('检索服务状态信息不完整。')
  return payload
}

export async function getDeepSeekCredentialStatus(): Promise<DeepSeekCredentialStatus> {
  const response = await request('/api/settings/ai-provider/deepseek/credential', undefined, 5_000)
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<DeepSeekCredentialStatus>
}

export async function saveDeepSeekCredential(apiKey: string): Promise<DeepSeekCredentialStatus> {
  const response = await request('/api/settings/ai-provider/deepseek/credential', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  }, 10_000)
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<DeepSeekCredentialStatus>
}

export async function deleteDeepSeekCredential(): Promise<DeepSeekCredentialStatus> {
  const response = await request('/api/settings/ai-provider/deepseek/credential', {
    method: 'DELETE',
  }, 10_000)
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<DeepSeekCredentialStatus>
}

export async function getKnowledgeIndexStatus(): Promise<RetrievalIndexStatus> {
  const response = await request('/api/index/status', undefined, 5_000)
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<RetrievalIndexStatus>
}

export async function syncKnowledgeIndex(chunks: KnowledgeChunk[]): Promise<RetrievalIndexSync> {
  if (!chunks.length) throw new Error('知识库中还没有可构建索引的文本块。')
  const response = await request('/api/index/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chunks: chunks.map(chunkPayload) }),
  }, 10 * 60_000)
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as RetrievalIndexSync
  return { ...payload, ready: true, modelAvailable: true, modelChecksum: null, storage: 'server/data/qdrant' }
}

export async function clearKnowledgeIndex(): Promise<RetrievalIndexStatus> {
  const response = await request('/api/index', { method: 'DELETE' }, 10_000)
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<RetrievalIndexStatus>
}

export async function searchKnowledge(
  query: string,
  chunks: KnowledgeChunk[],
  topK = 5,
  mode: RetrievalMode = 'keyword',
  corpusFingerprint?: string | null,
): Promise<KnowledgeRetrievalResponse> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) throw new Error('请先输入要检索的问题。')
  if (!chunks.length) throw new Error('知识库中还没有可检索的文本块。')

  const response = await request('/api/retrieval/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: normalizedQuery,
      topK,
      mode,
      corpusFingerprint: corpusFingerprint || undefined,
      chunks: mode === 'keyword' ? chunks.map(chunkPayload) : [],
    }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as KnowledgeRetrievalResponse
  if (!payload || !Array.isArray(payload.results) || !Array.isArray(payload.queryTerms)) {
    throw new Error('检索服务返回了无法识别的数据。')
  }
  return payload
}

export async function answerKnowledgeQuestion(
  query: string,
  corpusFingerprint: string,
  previewOnly: boolean,
  retrievalMode: 'hybrid' | 'hybrid_rerank' = 'hybrid_rerank',
): Promise<RagAnswerResponse> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) throw new Error('请先输入要回答的问题。')
  if (!corpusFingerprint) throw new Error('请先同步本地向量索引。')
  const response = await request('/api/rag/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: normalizedQuery,
      corpusFingerprint,
      retrievalMode,
      topK: 6,
      previewOnly,
    }),
  }, 90_000)
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as RagAnswerResponse
  if (!payload || !Array.isArray(payload.evidence) || !Array.isArray(payload.citationIds)) {
    throw new Error('RAG 服务返回了无法识别的数据。')
  }
  return payload
}
