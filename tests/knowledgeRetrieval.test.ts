import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  answerKnowledgeQuestion,
  checkRetrievalService,
  deleteDeepSeekCredential,
  getDeepSeekCredentialStatus,
  saveDeepSeekCredential,
  searchKnowledge,
  syncKnowledgeIndex,
} from '../src/lib/knowledgeRetrieval'
import type { KnowledgeChunk } from '../src/lib/knowledgeBase'

const chunk: KnowledgeChunk = {
  id: 'chunk-1',
  sourceId: 'source-1',
  sourceTitle: '启动指南',
  sourceContentHash: 'SOURCE',
  sequence: 0,
  content: '先打开文档，再写下一个标题。',
  contentHash: 'CONTENT',
  heading: '第一步',
  startOffset: 0,
  endOffset: 15,
  startLine: 3,
  endLine: 3,
  characterCount: 15,
  processorVersion: 1,
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('knowledge retrieval client', () => {
  it('checks the stateless local service health contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ok', version: '0.8.0', apiContractVersion: '1', retrievalEngine: 'bm25-zh-v1', storesData: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkRetrievalService()).resolves.toMatchObject({
      version: '0.8.0', apiContractVersion: '1', retrievalEngine: 'bm25-zh-v1', storesData: false,
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('rejects a health response without an API contract version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ok', version: '0.8.0', retrievalEngine: 'bm25-zh-v1', storesData: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(checkRetrievalService()).rejects.toThrow('检索服务状态信息不完整')
  })

  it('rejects an incompatible API contract instead of using it silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ok', version: '0.9.0', apiContractVersion: '2', retrievalEngine: 'future-engine', storesData: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(checkRetrievalService()).rejects.toThrow('当前应用需要 1，服务返回 2')
  })

  it('gives a desktop recovery action when the service is unreachable', async () => {
    vi.stubGlobal('window', {
      location: { protocol: 'file:' },
      xirangDesktop: { apiBaseUrl: 'http://127.0.0.1:43123' },
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await expect(checkRetrievalService()).rejects.toThrow('请在设置页查看运行状态并尝试重启')
  })

  it('sends only retrieval fields and accepts explainable results', async () => {
    const payload = {
      engine: 'bm25-zh-v1', query: '如何开始', normalizedQuery: '如何开始', queryTerms: ['开始'],
      durationMs: 2.4, confidence: 'strong', noAnswerReason: null,
      corpusStats: { chunkCount: 1, sourceCount: 1, averageChunkLength: 8 },
      results: [{
        chunkId: chunk.id, sourceId: chunk.sourceId, sourceTitle: chunk.sourceTitle, heading: chunk.heading,
        content: chunk.content, excerpt: chunk.content, score: 2.1,
        scoreBreakdown: { bm25: 1.2, titleBoost: 0, headingBoost: 0.5, phraseBoost: 0, coverageBoost: 0.4 },
        matchedTerms: ['开始'], queryCoverage: 1, startLine: 3, endLine: 3, startOffset: 0, endOffset: 15,
      }],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchKnowledge('  如何开始  ', [chunk], 3)).resolves.toMatchObject({ engine: 'bm25-zh-v1', confidence: 'strong' })
    const [, options] = fetchMock.mock.calls[0]
    expect(JSON.parse(options.body)).toEqual({
      query: '如何开始', topK: 3, mode: 'keyword',
      chunks: [{
        id: 'chunk-1', sourceId: 'source-1', sourceTitle: '启动指南', heading: '第一步',
        content: '先打开文档，再写下一个标题。', startLine: 3, endLine: 3, startOffset: 0, endOffset: 15,
        contentHash: 'CONTENT', sourceContentHash: 'SOURCE',
      }],
    })
  })

  it('explicitly syncs local vectors with integrity metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      fingerprint: 'abc', added: 1, updated: 0, removed: 0, unchanged: 0,
      chunkCount: 1, durationMs: 32, builtAt: '2026-09-09T00:00:00Z', model: 'BAAI/bge-small-zh-v1.5', dimensions: 512,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(syncKnowledgeIndex([chunk])).resolves.toMatchObject({ ready: true, fingerprint: 'abc', dimensions: 512 })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/index/sync')
    expect(JSON.parse(options.body).chunks[0]).toMatchObject({ contentHash: 'CONTENT', sourceContentHash: 'SOURCE' })
  })

  it('reports a clear service error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: '查询失败。' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })))

    await expect(searchKnowledge('开始任务', [chunk])).rejects.toThrow('查询失败。')
  })

  it('previews the exact grounded context without requiring an AI key', async () => {
    const payload = {
      status: 'context_only', query: '如何开始', answer: null, citationIds: [], uncertainties: [],
      provider: null, model: null, generation: null, warnings: [],
      retrieval: { engine: 'hybrid', mode: 'hybrid_rerank', confidence: 'strong', durationMs: 20 },
      context: { evidenceCount: 1, usedCharacters: 15, omittedCount: 0, flaggedReferenceIds: [] },
      evidence: [{
        referenceId: 'S1', chunkId: chunk.id, sourceId: chunk.sourceId, sourceTitle: chunk.sourceTitle,
        heading: chunk.heading, content: chunk.content, startLine: 3, endLine: 3,
        startOffset: 0, endOffset: 15, retrievalScore: 0.9, truncated: false, instructionFlagged: false,
      }],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(answerKnowledgeQuestion('  如何开始  ', 'a'.repeat(64), true)).resolves.toMatchObject({
      status: 'context_only', context: { evidenceCount: 1 },
    })
    const [, options] = fetchMock.mock.calls[0]
    expect(JSON.parse(options.body)).toEqual({
      query: '如何开始', corpusFingerprint: 'a'.repeat(64), retrievalMode: 'hybrid_rerank', topK: 6, previewOnly: true,
    })
  })

  it('manages the DeepSeek credential through the local backend without a read-back field', async () => {
    const status = {
      provider: 'deepseek', configured: true, available: true, model: 'deepseek-v4-flash',
      credentialSource: 'windows_dpapi_current_user', persistentStorageSupported: true,
      credentialStorageError: false, storageDescription: 'Windows DPAPI',
    }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(status), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getDeepSeekCredentialStatus()).resolves.toMatchObject({ configured: true })
    await expect(saveDeepSeekCredential('credential-client-test-value')).resolves.toMatchObject({ available: true })
    await expect(deleteDeepSeekCredential()).resolves.toMatchObject({ configured: true })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/settings/ai-provider/deepseek/credential')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ apiKey: 'credential-client-test-value' })
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE' })
    expect(JSON.stringify(status)).not.toContain('credential-client-test-value')
  })
})
