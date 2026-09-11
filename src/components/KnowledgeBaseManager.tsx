import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  createNoteKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeStorageSummary,
  KNOWLEDGE_DB_VERSION,
  knowledgeSourceBytes,
  listKnowledgeChunks,
  listKnowledgeSources,
  MAX_KNOWLEDGE_SOURCES,
  noteKnowledgeStatus,
  saveKnowledgeSource,
  supportsKnowledgeBase,
  validateKnowledgeFile,
  type KnowledgeSource,
  type KnowledgeStorageSummary,
  type KnowledgeChunk,
} from '../lib/knowledgeBase'
import { createKnowledgeSourceFromFile } from '../lib/knowledgeDocumentExtraction'
import { KnowledgeRetrievalLab } from './KnowledgeRetrievalLab'
import {
  ensureKnowledgeSourceProcessed,
  ensureKnowledgeSourcesProcessed,
} from '../lib/knowledgeTextProcessing'
import type { PersonalNote } from '../types'

interface KnowledgeBaseManagerProps {
  notes: PersonalNote[]
  refreshKey?: number
}

type Notice = { tone: 'success' | 'error' | 'neutral'; text: string }

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function sourceTypeLabel(source: KnowledgeSource) {
  if (source.kind === 'note') return '个人笔记'
  if (source.kind === 'markdown') return 'Markdown'
  if (source.kind === 'docx') return 'Word DOCX'
  if (source.kind === 'pdf') return '文字型 PDF'
  return 'TXT'
}

function sourceFileDetail(source: KnowledgeSource) {
  const parts = [source.originalFileName]
  if (source.kind === 'pdf' && source.pageCount) parts.push(`${source.pageCount} 页`)
  if (source.kind === 'docx' || source.kind === 'pdf') parts.push(`提取正文 ${formatBytes(source.sizeBytes)}`)
  else parts.push(formatBytes(source.sizeBytes))
  if (source.extractionWarnings?.length) parts.push(`${source.extractionWarnings.length} 条提取提示`)
  return parts.filter(Boolean).join(' · ')
}

export function KnowledgeBaseManager({ notes, refreshKey = 0 }: KnowledgeBaseManagerProps) {
  const importInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [replaceSourceId, setReplaceSourceId] = useState<string | null>(null)
  const [viewSourceId, setViewSourceId] = useState<string | null>(null)
  const [viewChunksSourceId, setViewChunksSourceId] = useState<string | null>(null)
  const [noteSearch, setNoteSearch] = useState('')
  const [fileSearch, setFileSearch] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [storageSummary, setStorageSummary] = useState<KnowledgeStorageSummary | null>(null)
  const available = supportsKnowledgeBase()

  useEffect(() => {
    let active = true
    if (!available) {
      setLoading(false)
      setNotice({ tone: 'error', text: '当前浏览器不支持 IndexedDB，无法建立本地知识库。' })
      return () => { active = false }
    }
    setProcessing(true)
    listKnowledgeSources()
      .then(async (items) => {
        if (active) setSources(items)
        const results = await ensureKnowledgeSourcesProcessed(items)
        const [summary, storedChunks] = await Promise.all([
          getKnowledgeStorageSummary(),
          listKnowledgeChunks(),
        ])
        if (active) {
          setStorageSummary(summary)
          setChunks(storedChunks)
          const processedCount = results.filter((result) => result.status === 'processed').length
          if (processedCount > 0) setNotice({ tone: 'success', text: `已完成 ${processedCount} 份资料的正文提取与文本分块。` })
        }
      })
      .catch((error) => { if (active) setNotice({ tone: 'error', text: error instanceof Error ? error.message : '知识库读取失败。' }) })
      .finally(() => { if (active) { setLoading(false); setProcessing(false) } })
    return () => { active = false }
  }, [available, refreshKey])

  const noteSourceById = useMemo(() => new Map(
    sources.filter((source) => source.kind === 'note' && source.sourceNoteId).map((source) => [source.sourceNoteId!, source]),
  ), [sources])
  const importedSources = sources.filter((source) => source.kind !== 'note')
  const orphanedNoteSources = sources.filter((source) => source.kind === 'note' && !notes.some((note) => note.id === source.sourceNoteId))
  const authorizedNoteCount = notes.filter((note) => noteSourceById.has(note.id)).length
  const outdatedCount = notes.filter((note) => noteKnowledgeStatus(note, noteSourceById.get(note.id)) === 'outdated').length
  const normalizedNoteSearch = noteSearch.trim().toLocaleLowerCase()
  const visibleNotes = notes
    .filter((note) => !normalizedNoteSearch || `${note.title} ${note.content}`.toLocaleLowerCase().includes(normalizedNoteSearch))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const normalizedFileSearch = fileSearch.trim().toLocaleLowerCase()
  const visibleFiles = [...importedSources, ...orphanedNoteSources]
    .filter((source) => !normalizedFileSearch || `${source.title} ${source.originalFileName ?? ''}`.toLocaleLowerCase().includes(normalizedFileSearch))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const viewedSource = sources.find((source) => source.id === viewSourceId)
  const chunkPreviewSource = sources.find((source) => source.id === viewChunksSourceId)
  const previewChunks = chunks.filter((chunk) => chunk.sourceId === viewChunksSourceId)
  const chunkCountBySource = useMemo(() => {
    const counts = new Map<string, number>()
    chunks.forEach((chunk) => counts.set(chunk.sourceId, (counts.get(chunk.sourceId) ?? 0) + 1))
    return counts
  }, [chunks])

  function upsertLocal(source: KnowledgeSource) {
    setSources((current) => [source, ...current.filter((item) => item.id !== source.id)])
  }

  async function refreshStorageState() {
    const [summary, storedChunks] = await Promise.all([
      getKnowledgeStorageSummary(),
      listKnowledgeChunks(),
    ])
    setStorageSummary(summary)
    setChunks(storedChunks)
  }

  async function saveAndProcessSource(source: KnowledgeSource) {
    const persisted = await saveKnowledgeSource(source)
    await ensureKnowledgeSourceProcessed(persisted)
    return persisted
  }

  async function toggleNote(note: PersonalNote) {
    const existing = noteSourceById.get(note.id)
    setBusyId(note.id)
    setNotice(null)
    try {
      if (existing) {
        await deleteKnowledgeSource(existing.id)
        setSources((current) => current.filter((source) => source.id !== existing.id))
        if (viewSourceId === existing.id) setViewSourceId(null)
        if (viewChunksSourceId === existing.id) setViewChunksSourceId(null)
        setNotice({ tone: 'neutral', text: `“${note.title}”已取消知识库授权，本地快照已移除。` })
        await refreshStorageState()
      } else {
        if (sources.length >= MAX_KNOWLEDGE_SOURCES) throw new Error(`知识来源最多保留 ${MAX_KNOWLEDGE_SOURCES} 项。`)
        const source = createNoteKnowledgeSource(note)
        const persisted = await saveAndProcessSource(source)
        upsertLocal(persisted)
        setNotice({ tone: 'success', text: `“${note.title}”已授权并保存为本地知识来源。` })
        await refreshStorageState()
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '笔记授权更新失败。' })
    } finally {
      setBusyId(null)
    }
  }

  async function synchronizeNote(note: PersonalNote) {
    const existing = noteSourceById.get(note.id)
    if (!existing) return
    setBusyId(note.id)
    setNotice(null)
    try {
      const source = createNoteKnowledgeSource(note, existing)
      const persisted = await saveAndProcessSource(source)
      upsertLocal(persisted)
      setNotice({ tone: 'success', text: `“${note.title}”的本地快照已同步到最新内容。` })
      await refreshStorageState()
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '笔记同步失败。' })
    } finally {
      setBusyId(null)
    }
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const files = [...(input.files ?? [])]
    if (!files.length) return
    setImporting(true)
    setNotice(null)
    let working = [...sources]
    let savedCount = 0
    const failures: string[] = []
    try {
      for (const file of files) {
        const validation = validateKnowledgeFile(file)
        if (validation) {
          failures.push(`${file.name}：${validation}`)
          continue
        }
        const duplicate = working.find((source) => source.kind !== 'note' && source.originalFileName === file.name)
        if (!duplicate && working.length >= MAX_KNOWLEDGE_SOURCES) {
          failures.push(`${file.name}：知识来源已达到 ${MAX_KNOWLEDGE_SOURCES} 项上限。`)
          continue
        }
        if (duplicate && !window.confirm(`知识库中已有“${file.name}”。是否用这次选择的内容更新它？`)) continue
        try {
          const source = await createKnowledgeSourceFromFile(file, duplicate)
          const persisted = await saveAndProcessSource(source)
          working = [persisted, ...working.filter((item) => item.id !== persisted.id)]
          savedCount += 1
        } catch (error) {
          failures.push(`${file.name}：${error instanceof Error ? error.message : '导入失败。'}`)
        }
      }
      setSources(working)
      await refreshStorageState()
      if (failures.length) {
        setNotice({ tone: 'error', text: `${savedCount ? `已保存 ${savedCount} 份；` : ''}${failures.join('；')}` })
      } else if (savedCount) {
        setNotice({ tone: 'success', text: `已将 ${savedCount} 份资料保存到本地知识库。` })
      }
    } finally {
      setImporting(false)
      input.value = ''
    }
  }

  function chooseReplacement(sourceId: string) {
    setReplaceSourceId(sourceId)
    replaceInput.current?.click()
  }

  async function replaceFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    const existing = sources.find((source) => source.id === replaceSourceId)
    input.value = ''
    if (!file || !existing) {
      setReplaceSourceId(null)
      return
    }
    const validation = validateKnowledgeFile(file)
    if (validation) {
      setNotice({ tone: 'error', text: validation })
      setReplaceSourceId(null)
      return
    }
    setBusyId(existing.id)
    setNotice(null)
    try {
      const source = await createKnowledgeSourceFromFile(file, existing)
      const persisted = await saveAndProcessSource(source)
      upsertLocal(persisted)
      setNotice({ tone: 'success', text: `“${existing.title}”已更新为新文件内容。` })
      await refreshStorageState()
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '资料更新失败。' })
    } finally {
      setBusyId(null)
      setReplaceSourceId(null)
    }
  }

  async function removeSource(source: KnowledgeSource) {
    if (!window.confirm(`从知识库移除“${source.title}”？原笔记或原始文件不会受到影响。`)) return
    setBusyId(source.id)
    setNotice(null)
    try {
      await deleteKnowledgeSource(source.id)
      setSources((current) => current.filter((item) => item.id !== source.id))
      if (viewSourceId === source.id) setViewSourceId(null)
      if (viewChunksSourceId === source.id) setViewChunksSourceId(null)
      setNotice({ tone: 'neutral', text: `“${source.title}”已从本地知识库移除。` })
      await refreshStorageState()
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '资料移除失败。' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="settings-card knowledge-manager card-surface">
      <div className="knowledge-heading">
        <div className="settings-card-heading">
          <span>03</span>
          <div><p className="eyebrow">AI 与知识库</p><h2>个人知识来源</h2></div>
        </div>
        <span className="knowledge-offline-badge"><i />本地 RAG · 平台待配置</span>
      </div>

      <p className="knowledge-intro">只处理你主动选择的笔记和文档。TXT、Markdown、Word DOCX 与文字型 PDF 会提取正文并切成可追溯文本块；内容哈希未变化的资料不会重复处理。</p>

      {notice && <div className={`knowledge-notice ${notice.tone}`} role="status"><span>{notice.tone === 'success' ? '✓' : notice.tone === 'error' ? '!' : 'i'}</span><p>{notice.text}</p><button type="button" onClick={() => setNotice(null)} aria-label="关闭知识库提示">×</button></div>}

      <div className="knowledge-summary" aria-label="知识库概览">
        <span><small>知识来源</small><strong>{sources.length}</strong></span>
        <span><small>授权笔记</small><strong>{authorizedNoteCount}</strong></span>
        <span><small>导入文档</small><strong>{importedSources.length}</strong></span>
        <span><small>本地占用</small><strong>{formatBytes(knowledgeSourceBytes(sources))}</strong></span>
      </div>

      <div className="knowledge-storage-status" aria-label="知识库存储状态">
        <div className="knowledge-storage-copy">
          <span className="knowledge-database-icon" aria-hidden="true">DB</span>
          <div>
            <strong>{processing ? '正在处理知识资料…' : '本地文本处理已就绪'}</strong>
            <small>IndexedDB v{storageSummary?.databaseVersion ?? KNOWLEDGE_DB_VERSION} · SHA-256 增量检测 · 300～700 字/块</small>
          </div>
        </div>
        <div className="knowledge-storage-metrics">
          <span><strong>{storageSummary?.permissionCount ?? 0}</strong><small>授权记录</small></span>
          <span><strong>{storageSummary?.chunkCount ?? 0}</strong><small>文本块</small></span>
          <span><strong>{storageSummary?.retrievalCount ?? 0}</strong><small>检索记录</small></span>
          <span><strong>{storageSummary?.embeddingCount ?? 0}</strong><small>向量</small></span>
        </div>
      </div>

      <KnowledgeRetrievalLab chunks={chunks} onStored={refreshStorageState} />

      <section className="knowledge-source-section">
        <div className="knowledge-section-heading">
          <div><h3>个人笔记授权</h3><p>开关打开后，系统在 IndexedDB 中保存一份可随时移除的本地快照。</p></div>
          {outdatedCount > 0 && <span>{outdatedCount} 篇需要同步</span>}
        </div>
        {notes.length > 4 && <label className="knowledge-search"><span aria-hidden="true">⌕</span><input value={noteSearch} onChange={(event) => setNoteSearch(event.target.value)} placeholder="搜索个人笔记" /></label>}
        {loading ? <p className="knowledge-empty">正在读取本地知识库……</p> : visibleNotes.length ? (
          <div className="knowledge-note-list">{visibleNotes.map((note) => {
            const source = noteSourceById.get(note.id)
            const status = noteKnowledgeStatus(note, source)
            return (
              <article key={note.id}>
                <div className="knowledge-source-symbol note">▤</div>
                <div className="knowledge-source-copy"><strong>{note.title}</strong><small>最近编辑：{dateLabel(note.updatedAt)} · {formatBytes(new TextEncoder().encode(`${note.title}\n${note.content}`).byteLength)}</small></div>
                <span className={`knowledge-status ${status}`}>{status === 'ready' ? `已切分 ${chunkCountBySource.get(source?.id ?? '') ?? 0} 块` : status === 'outdated' ? '需要同步' : '未授权'}</span>
                {status === 'outdated' && <button className="knowledge-sync-button" type="button" disabled={busyId === note.id} onClick={() => synchronizeNote(note)}>同步最新</button>}
                {source && <div className="knowledge-source-actions"><button className="knowledge-view-button" type="button" onClick={() => setViewSourceId(source.id)}>原文</button><button className="knowledge-view-button" type="button" onClick={() => setViewChunksSourceId(source.id)}>分块</button></div>}
                <button
                  type="button"
                  className={`toggle-switch ${source ? 'active' : ''}`}
                  role="switch"
                  aria-checked={Boolean(source)}
                  aria-label={`${source ? '取消' : '允许'}“${note.title}”用于知识库`}
                  disabled={!available || busyId === note.id}
                  onClick={() => toggleNote(note)}
                ><span /></button>
              </article>
            )
          })}</div>
        ) : <p className="knowledge-empty">{noteSearch ? '没有找到相符的笔记。' : '还没有个人笔记。可以先在“便签 → 笔记”中记录内容。'}</p>}
      </section>

      <section className="knowledge-source-section files">
        <div className="knowledge-section-heading">
          <div><h3>导入本地文档</h3><p>支持 TXT、MD、Markdown（不超过 2 MB）和 DOCX、文字型 PDF（不超过 10 MB），最多保存 {MAX_KNOWLEDGE_SOURCES} 个知识来源。</p></div>
          <button className="button secondary" type="button" disabled={!available || importing} onClick={() => importInput.current?.click()}>{importing ? '正在导入…' : '＋ 选择文档'}</button>
        </div>
        <input ref={importInput} type="file" accept=".txt,.md,.markdown,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple hidden onChange={importFiles} />
        <input ref={replaceInput} type="file" accept=".txt,.md,.markdown,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={replaceFile} />
        {visibleFiles.length > 3 && <label className="knowledge-search"><span aria-hidden="true">⌕</span><input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="搜索导入资料" /></label>}
        {visibleFiles.length ? <div className="knowledge-file-list">{visibleFiles.map((source) => (
          <article key={source.id}>
            <div className={`knowledge-source-symbol ${source.kind}`}>{source.kind === 'markdown' ? 'M↓' : source.kind === 'docx' ? 'W' : source.kind === 'pdf' ? 'P' : source.kind === 'text' ? 'T' : '▤'}</div>
            <div className="knowledge-source-copy"><strong>{source.title}</strong><small>{source.kind === 'note' ? '原笔记已删除 · 保留的本地快照' : sourceFileDetail(source)} · 更新于 {dateLabel(source.updatedAt)}</small></div>
            <span className={`knowledge-status ${source.kind === 'note' ? 'outdated' : 'ready'}`}>{source.kind === 'note' ? '来源已删除' : `已切分 ${chunkCountBySource.get(source.id) ?? 0} 块`}</span>
            <div className="knowledge-file-actions"><button type="button" onClick={() => setViewSourceId(source.id)}>原文</button><button type="button" onClick={() => setViewChunksSourceId(source.id)}>分块</button>{source.kind !== 'note' && <button type="button" disabled={busyId === source.id} onClick={() => chooseReplacement(source.id)}>更新</button>}<button type="button" disabled={busyId === source.id} onClick={() => removeSource(source)}>移除</button></div>
          </article>
        ))}</div> : <div className="knowledge-import-empty"><span>DOC</span><div><strong>还没有导入文档</strong><p>支持纯文本、Markdown、Word DOCX 和文字型 PDF；提取正文只保存在本机。</p></div><button type="button" disabled={!available || importing} onClick={() => importInput.current?.click()}>选择第一份资料</button></div>}
      </section>

      <div className="knowledge-boundary"><span aria-hidden="true">◉</span><p><strong>当前边界</strong>BM25、BGE 向量、RRF 融合、Cross-Encoder 重排和引用式 RAG 上下文预览已接通；真实回答需后续配置 AI 平台。文字型 PDF 可直接提取，扫描 PDF 暂不进行 OCR。“应用数据 JSON”暂不包含知识库文档与文本块。</p></div>

      {viewedSource && (
        <div className="knowledge-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewSourceId(null) }}>
          <section className="knowledge-preview" role="dialog" aria-modal="true" aria-labelledby="knowledge-preview-title">
            <header><div><p className="eyebrow">{sourceTypeLabel(viewedSource)} · 本地快照</p><h2 id="knowledge-preview-title">{viewedSource.title}</h2><span>{formatBytes(viewedSource.sizeBytes)} · 更新于 {dateLabel(viewedSource.updatedAt)}</span></div><button type="button" onClick={() => setViewSourceId(null)} aria-label="关闭资料预览">×</button></header>
            <pre>{viewedSource.content}</pre>
            <footer><p>这里只显示保存在知识库中的{viewedSource.kind === 'docx' || viewedSource.kind === 'pdf' ? '提取正文' : '快照'}，不会修改原笔记或原始文件。</p><button className="button primary" type="button" onClick={() => setViewSourceId(null)}>关闭</button></footer>
          </section>
        </div>
      )}

      {chunkPreviewSource && (
        <div className="knowledge-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewChunksSourceId(null) }}>
          <section className="knowledge-preview knowledge-chunk-preview" role="dialog" aria-modal="true" aria-labelledby="knowledge-chunk-preview-title">
            <header><div><p className="eyebrow">文本处理结果 · {previewChunks.length} 块</p><h2 id="knowledge-chunk-preview-title">{chunkPreviewSource.title}</h2><span>每块保留资料名称、章节、行号、字符位置和内容哈希</span></div><button type="button" onClick={() => setViewChunksSourceId(null)} aria-label="关闭文本块预览">×</button></header>
            <div className="knowledge-chunk-preview-list">
              {previewChunks.map((chunk) => (
                <article key={chunk.id}>
                  <div><span>#{String(chunk.sequence + 1).padStart(2, '0')}</span><strong>{chunk.heading}</strong><small>{chunk.sourceTitle} · {chunk.characterCount} 字 · 第 {chunk.startLine}{chunk.endLine === chunk.startLine ? '' : `～${chunk.endLine}`} 行 · 字符 {chunk.startOffset}～{chunk.endOffset}</small></div>
                  <pre>{chunk.content}</pre>
                </article>
              ))}
              {!previewChunks.length && <p className="knowledge-empty">这份资料尚未生成文本块。</p>}
            </div>
            <footer><p>位置对应知识库中保存的原文快照；短章节可能少于 300 字，以避免跨章节混合。</p><button className="button primary" type="button" onClick={() => setViewChunksSourceId(null)}>关闭</button></footer>
          </section>
        </div>
      )}
    </section>
  )
}
