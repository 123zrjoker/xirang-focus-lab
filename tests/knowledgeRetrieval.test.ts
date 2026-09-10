import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkRetrievalService, searchKnowledge, syncKnowledgeIndex } from '../src/lib/knowledgeRetrieval'
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
      status: 'ok', version: '0.4.0', retrievalEngine: 'bm25-zh-v1', storesData: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkRetrievalService()).resolves.toMatchObject({ retrievalEngine: 'bm25-zh-v1', storesData: false })
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ signal: expect.any(AbortSignal) }))
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
})
