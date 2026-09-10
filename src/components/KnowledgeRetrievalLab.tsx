import { useEffect, useState, type FormEvent } from 'react'
import {
  checkRetrievalService,
  clearKnowledgeIndex,
  searchKnowledge,
  syncKnowledgeIndex,
  type KnowledgeRetrievalResponse,
  type RetrievalHealth,
  type RetrievalIndexStatus,
  type RetrievalMode,
} from '../lib/knowledgeRetrieval'
import { saveKnowledgeRetrieval, type KnowledgeChunk } from '../lib/knowledgeBase'

interface KnowledgeRetrievalLabProps {
  chunks: KnowledgeChunk[]
  onStored?: () => void | Promise<void>
}

type ServiceState = 'checking' | 'ready' | 'offline'

const exampleQueries = [
  '我该如何更容易开始一个任务？',
  '怎样减少专注时的手机分心？',
  '知识库如何处理 PDF？',
]

function confidenceLabel(confidence: KnowledgeRetrievalResponse['confidence']) {
  if (confidence === 'strong') return '较强匹配'
  if (confidence === 'possible') return '可能相关'
  return '没有依据'
}

function modeLabel(mode: RetrievalMode) {
  if (mode === 'keyword') return 'BM25 关键词'
  if (mode === 'vector') return 'BGE 向量'
  if (mode === 'hybrid') return 'BM25 + BGE · RRF'
  return 'RRF + Cross-Encoder'
}

function lineLabel(result: KnowledgeRetrievalResponse['results'][number]) {
  return `第 ${result.startLine}${result.endLine === result.startLine ? '' : `～${result.endLine}`} 行 · 字符 ${result.startOffset}～${result.endOffset}`
}

export function KnowledgeRetrievalLab({ chunks, onStored }: KnowledgeRetrievalLabProps) {
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState(5)
  const [mode, setMode] = useState<RetrievalMode>('keyword')
  const [serviceState, setServiceState] = useState<ServiceState>('checking')
  const [health, setHealth] = useState<RetrievalHealth | null>(null)
  const [searching, setSearching] = useState(false)
  const [response, setResponse] = useState<KnowledgeRetrievalResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null)
  const [indexStatus, setIndexStatus] = useState<RetrievalIndexStatus | null>(null)
  const [indexing, setIndexing] = useState(false)

  async function detectService() {
    setServiceState('checking')
    setError(null)
    try {
      const status = await checkRetrievalService()
      setHealth(status)
      setIndexStatus(status.index ?? null)
      setServiceState('ready')
    } catch (nextError) {
      setHealth(null)
      setServiceState('offline')
      setError(nextError instanceof Error ? nextError.message : '无法连接本地检索服务。')
    }
  }

  useEffect(() => {
    void detectService()
  }, [])

  async function buildIndex() {
    setIndexing(true)
    setError(null)
    try {
      const result = await syncKnowledgeIndex(chunks)
      setIndexStatus(result)
      setMode('vector')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '向量索引构建失败。')
    } finally {
      setIndexing(false)
    }
  }

  async function removeIndex() {
    setIndexing(true)
    setError(null)
    try {
      const result = await clearKnowledgeIndex()
      setIndexStatus(result)
      setMode('keyword')
      setResponse(null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '向量索引清除失败。')
    } finally {
      setIndexing(false)
    }
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault()
    setSearching(true)
    setError(null)
    setExpandedChunkId(null)
    try {
      if (mode !== 'keyword' && !indexStatus?.ready) throw new Error('请先明确构建本地向量索引。')
      const result = await searchKnowledge(query, chunks, topK, mode, indexStatus?.fingerprint)
      setResponse(result)
      setServiceState('ready')
      await saveKnowledgeRetrieval({
        id: crypto.randomUUID(),
        query: query.trim().slice(0, 500),
        sourceIds: [...new Set(result.results.map((item) => item.sourceId))],
        chunkIds: result.results.map((item) => item.chunkId),
        resultCount: result.results.length,
        durationMs: result.durationMs,
        engine: result.engine,
        mode: result.mode,
        queryTerms: result.queryTerms,
        confidence: result.confidence,
        topScore: result.results[0]?.score,
        createdAt: new Date().toISOString(),
      })
      await onStored?.()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '本次检索失败。')
    } finally {
      setSearching(false)
    }
  }

  return (
    <section className="knowledge-retrieval-lab" aria-labelledby="retrieval-lab-title">
      <div className="retrieval-lab-heading">
        <div className="retrieval-lab-title">
          <span aria-hidden="true">R</span>
          <div>
            <p className="eyebrow">0.4.3 · Hybrid Retrieval & Reranking</p>
            <h3 id="retrieval-lab-title">检索实验台</h3>
            <p>四种模式同台对照，并展开查看召回、融合与重排轨迹。</p>
          </div>
        </div>
        <button
          className={`retrieval-service-badge ${serviceState}`}
          type="button"
          onClick={() => void detectService()}
          disabled={serviceState === 'checking'}
          title="点击重新检测本地检索服务"
        >
          <i />
          {serviceState === 'ready' ? `${health?.retrievalEngine ?? '检索服务'} 已连接` : serviceState === 'checking' ? '正在检测服务' : '检索服务未连接'}
        </button>
      </div>

      {serviceState === 'ready' && (
        <div className="retrieval-index-panel">
          <div>
            <span className={`retrieval-index-mark ${indexStatus?.ready ? 'ready' : ''}`}>V</span>
            <p>
              <strong>{indexStatus?.ready ? `本地向量索引 · ${indexStatus.chunkCount} 块` : '本地向量索引尚未构建'}</strong>
              <small>
                {indexStatus?.model ?? health?.semanticEngine ?? 'BAAI/bge-small-zh-v1.5'}
                {indexStatus?.dimensions ? ` · ${indexStatus.dimensions} 维` : ''}
                {indexStatus?.builtAt ? ` · ${new Date(indexStatus.builtAt).toLocaleString('zh-CN')}` : ''}
              </small>
              <small>重排：{health?.reranker?.available ? health.reranker.model : '多语言 Cross-Encoder 尚未安装（自动降级）'}</small>
            </p>
          </div>
          <div className="retrieval-index-actions">
            <button className="button secondary" type="button" disabled={indexing || !chunks.length || indexStatus?.modelAvailable === false} onClick={() => void buildIndex()}>
              {indexing ? '正在处理…' : indexStatus?.ready ? '增量同步索引' : '构建本地索引'}
            </button>
            {indexStatus?.ready && <button type="button" onClick={() => void removeIndex()} disabled={indexing}>清除向量</button>}
          </div>
          {indexStatus?.modelAvailable === false && <em>本机模型尚未准备好，请运行 scripts/download_retrieval_models.ps1。</em>}
        </div>
      )}

      <form className="retrieval-query-form" onSubmit={runSearch}>
        <label>
          <span>输入一个能由个人资料回答的问题</span>
          <input
            value={query}
            maxLength={500}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如：我该如何更容易开始一个任务？"
          />
        </label>
        <label className="retrieval-mode">
          <span>检索模式</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as RetrievalMode)}>
            <option value="keyword">BM25 关键词</option>
            <option value="vector" disabled={!indexStatus?.ready}>BGE 向量</option>
            <option value="hybrid" disabled={!indexStatus?.ready}>混合检索 · RRF</option>
            <option value="hybrid_rerank" disabled={!indexStatus?.ready}>混合 + Cross-Encoder</option>
          </select>
        </label>
        <label className="retrieval-top-k">
          <span>返回结果</span>
          <select value={topK} onChange={(event) => setTopK(Number(event.target.value))}>
            <option value={3}>3 条</option>
            <option value={5}>5 条</option>
            <option value={8}>8 条</option>
          </select>
        </label>
        <button className="button primary" type="submit" disabled={searching || serviceState !== 'ready' || !query.trim() || !chunks.length}>
          {searching ? '正在检索…' : '运行检索'}
        </button>
      </form>

      {!query && (
        <div className="retrieval-examples" aria-label="检索示例">
          <span>试试：</span>
          {exampleQueries.map((example) => <button type="button" key={example} onClick={() => setQuery(example)}>{example}</button>)}
        </div>
      )}

      {!chunks.length && <div className="retrieval-empty-state"><strong>还没有可检索内容</strong><p>先授权一篇个人笔记或导入一份文档，系统会自动生成文本块。</p></div>}
      {error && <div className="retrieval-error" role="alert"><span>!</span><p>{error}</p>{serviceState === 'offline' && <button type="button" onClick={() => void detectService()}>重新检测</button>}</div>}

      {response && (
        <div className="retrieval-response" aria-live="polite">
          <div className="retrieval-metrics">
            <span><small>查询词</small><strong>{response.queryTerms.length}</strong></span>
            <span><small>检索文本块</small><strong>{response.corpusStats.chunkCount}</strong></span>
            <span><small>返回结果</small><strong>{response.results.length}</strong></span>
            <span><small>服务端耗时</small><strong>{response.durationMs.toFixed(1)}<em> ms</em></strong></span>
          </div>
          <div className="retrieval-result-heading">
            <div>
              <span className={`retrieval-confidence ${response.confidence}`}>{confidenceLabel(response.confidence)}</span>
              <p>规范化查询：{response.normalizedQuery || '—'}</p>
            </div>
            <small>{modeLabel(response.mode)} · {response.engine} · {response.corpusStats.sourceCount} 个来源</small>
          </div>
          {response.warnings?.map((warning) => <p className="retrieval-warning" key={warning}>{warning}</p>)}

          {response.results.length ? (
            <div className="retrieval-result-list">
              {response.results.map((result, index) => {
                const expanded = expandedChunkId === result.chunkId
                return (
                  <article key={result.chunkId}>
                    <div className="retrieval-rank">#{String(index + 1).padStart(2, '0')}</div>
                    <div className="retrieval-result-copy">
                      <div className="retrieval-result-title">
                        <div><strong>{result.sourceTitle}</strong><span>{result.heading}</span></div>
                        <b>{result.score.toFixed(2)}</b>
                      </div>
                      <div className="retrieval-result-location">{lineLabel(result)}</div>
                      <div className="retrieval-hit-terms">
                        {result.matchedTerms.map((term) => <span key={term}>{term}</span>)}
                      </div>
                      <p>{expanded ? result.content : result.excerpt}</p>
                      <div className="retrieval-score-breakdown">
                        {response.mode === 'keyword' ? <>
                          <span>BM25 <b>{result.scoreBreakdown.bm25.toFixed(2)}</b></span>
                          <span>标题 <b>{(result.scoreBreakdown.titleBoost + result.scoreBreakdown.headingBoost).toFixed(2)}</b></span>
                          <span>短语 <b>{result.scoreBreakdown.phraseBoost.toFixed(2)}</b></span>
                        </> : response.mode === 'vector' ? <span>向量相似度 <b>{result.scoreBreakdown.vector.toFixed(3)}</b></span> : <>
                          <span>关键词排名 <b>{result.scoreBreakdown.keywordRank ?? '—'}</b></span>
                          <span>向量排名 <b>{result.scoreBreakdown.vectorRank ?? '—'}</b></span>
                          <span>RRF <b>{result.scoreBreakdown.rrf.toFixed(4)}</b></span>
                          {result.scoreBreakdown.reranker != null && <span>重排 <b>{result.scoreBreakdown.reranker.toFixed(3)}</b></span>}
                          {result.scoreBreakdown.rankDelta != null && <span>名次变化 <b>{result.scoreBreakdown.rankDelta > 0 ? '+' : ''}{result.scoreBreakdown.rankDelta}</b></span>}
                        </>}
                        <span>覆盖 <b>{Math.round(result.queryCoverage * 100)}%</b></span>
                        <button type="button" onClick={() => setExpandedChunkId(expanded ? null : result.chunkId)}>{expanded ? '收起完整片段' : '展开完整片段'}</button>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="retrieval-no-answer"><span>∅</span><div><strong>知识库中没有找到足够依据</strong><p>{response.noAnswerReason}</p></div></div>
          )}
        </div>
      )}

      <p className="retrieval-privacy-note">BM25 为无状态请求；只有明确点击构建后，授权文本和 512 维向量才写入本机 Qdrant。混合模式用 RRF 合并两路排名，重排模式再以本机多语言 Cross-Encoder 处理前 12 条候选；模型缺失时会透明降级，不调用云端模型。</p>
    </section>
  )
}
