import { describe, expect, it, vi } from 'vitest'
import {
  createImportedKnowledgeSource,
  createExtractedDocumentKnowledgeSource,
  createNoteKnowledgeSource,
  fingerprintKnowledgeText,
  knowledgeFileKind,
  knowledgeSourceBytes,
  noteKnowledgeStatus,
  normalizeKnowledgeContent,
  sha256KnowledgeText,
  validateKnowledgeBaseBackup,
  validateKnowledgeFile,
} from '../src/lib/knowledgeBase'
import type { PersonalNote } from '../src/types'
import {
  buildKnowledgeChunks,
  extractKnowledgeParagraphs,
  KNOWLEDGE_CHUNK_MAX_CHARACTERS,
  KNOWLEDGE_CHUNK_MIN_CHARACTERS,
  KNOWLEDGE_TEXT_PROCESSOR_VERSION,
} from '../src/lib/knowledgeTextProcessing'
import type { KnowledgeSource } from '../src/lib/knowledgeBase'
import { pdfTextItemsToLines } from '../src/lib/knowledgeDocumentExtraction'

const note: PersonalNote = {
  id: 'note-1',
  title: '启动观察',
  content: '先打开文档，通常比先制定完整计划更容易开始。',
  createdAt: '2026-09-05T08:00:00.000Z',
  updatedAt: '2026-09-05T08:00:00.000Z',
}

describe('knowledge base source management', () => {
  it('creates a traceable snapshot for an authorized personal note', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'source-1' })
    const source = createNoteKnowledgeSource(note, undefined, '2026-09-05T09:00:00.000Z')

    expect(source).toMatchObject({
      id: 'source-1',
      kind: 'note',
      sourceNoteId: 'note-1',
      sourceUpdatedAt: note.updatedAt,
      title: '启动观察',
      content: note.content,
    })
    expect(noteKnowledgeStatus(note, source)).toBe('ready')
    vi.unstubAllGlobals()
  })

  it('marks the saved snapshot as outdated when the original note changes', () => {
    const source = createNoteKnowledgeSource(note, {
      id: 'source-1', kind: 'note', title: note.title, content: note.content,
      contentFingerprint: fingerprintKnowledgeText(`${note.title}\n${note.content}`), sizeBytes: 10,
      createdAt: note.createdAt, updatedAt: note.updatedAt, sourceNoteId: note.id, sourceUpdatedAt: note.updatedAt,
    })
    const edited = { ...note, content: `${note.content}\n新增内容`, updatedAt: '2026-09-05T10:00:00.000Z' }

    expect(noteKnowledgeStatus(edited, source)).toBe('outdated')
    expect(noteKnowledgeStatus(edited)).toBe('not-authorized')
  })

  it('accepts supported text, DOCX and PDF files within their size limits', () => {
    expect(knowledgeFileKind('资料.MD')).toBe('markdown')
    expect(knowledgeFileKind('记录.txt')).toBe('text')
    expect(knowledgeFileKind('报告.docx')).toBe('docx')
    expect(knowledgeFileKind('论文.PDF')).toBe('pdf')
    expect(validateKnowledgeFile({ name: '资料.pdf', size: 100 })).toBeNull()
    expect(validateKnowledgeFile({ name: '旧文档.doc', size: 100 })).toContain('只支持')
    expect(validateKnowledgeFile({ name: '空白.txt', size: 0 })).toContain('为空')
    expect(validateKnowledgeFile({ name: '太大.md', size: 2 * 1024 * 1024 + 1 })).toContain('2 MB')
    expect(validateKnowledgeFile({ name: '太大.pdf', size: 10 * 1024 * 1024 + 1 })).toContain('10 MB')
  })

  it('normalizes imported text and reports its local storage size', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'source-file' })
    const source = createImportedKnowledgeSource(' 研究计划.md', ' 第一段\r\n\r\n第二段 ')

    expect(source).toMatchObject({
      id: 'source-file',
      kind: 'markdown',
      title: '研究计划',
      content: '第一段\n\n第二段',
      originalFileName: ' 研究计划.md',
    })
    expect(source.sizeBytes).toBeGreaterThan(0)
    expect(knowledgeSourceBytes([source, source])).toBe(source.sizeBytes * 2)
    expect(normalizeKnowledgeContent('\u0000 A\r\nB ')).toBe('A\nB')
    vi.unstubAllGlobals()
  })

  it('creates a deterministic SHA-256 integrity hash', async () => {
    await expect(sha256KnowledgeText('abc')).resolves.toBe(
      'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD',
    )
  })

  it('stores extracted document metadata without retaining the binary file', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'source-pdf' })
    const source = createExtractedDocumentKnowledgeSource(
      '学习资料.pdf',
      'pdf',
      '# 第 1 页\n\n可提取正文。',
      { mimeType: 'application/pdf', originalSizeBytes: 2048, pageCount: 3, warnings: ['第 2 页为空。'] },
      undefined,
      '2026-09-07T08:00:00.000Z',
    )

    expect(source).toMatchObject({
      id: 'source-pdf', kind: 'pdf', title: '学习资料', pageCount: 3,
      originalSizeBytes: 2048, sizeBytes: expect.any(Number), extractionWarnings: ['第 2 页为空。'],
    })
    expect(source.sizeBytes).toBeLessThan(source.originalSizeBytes!)
    vi.unstubAllGlobals()
  })
})

describe('knowledge backup compatibility', () => {
  const source: KnowledgeSource = {
    id: 'source-backup', kind: 'text', title: '恢复测试', content: '可恢复正文',
    contentFingerprint: 'fingerprint', sizeBytes: 12,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
  }
  const permission = {
    sourceId: source.id, sourceKind: source.kind,
    grantedAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
  }
  const chunk = {
    id: 'chunk-backup', sourceId: source.id, sourceTitle: source.title, sourceContentHash: 'SOURCE',
    sequence: 0, content: source.content, contentHash: 'CONTENT', heading: source.title,
    startOffset: 0, endOffset: source.content.length, startLine: 1, endLine: 1,
    characterCount: source.content.length, processorVersion: 1,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
  }
  const validBackup = {
    schemaVersion: 1,
    sources: [source],
    permissions: [permission],
    chunks: [chunk],
    retrievals: [],
    metadata: [],
  }

  it('accepts a supported v1 knowledge backup before transactional restore', () => {
    expect(validateKnowledgeBaseBackup(validBackup)).toMatchObject({ schemaVersion: 1 })
  })

  it('rejects future, dangling and duplicate records before restore', () => {
    expect(() => validateKnowledgeBaseBackup({ ...validBackup, schemaVersion: 3 })).toThrow('版本不受当前应用支持')
    expect(() => validateKnowledgeBaseBackup({
      ...validBackup,
      permissions: [{ ...permission, sourceId: 'missing-source' }],
    })).toThrow('授权记录引用了不存在的来源')
    expect(() => validateKnowledgeBaseBackup({
      ...validBackup,
      chunks: [chunk, { ...chunk }],
    })).toThrow('文本块引用了不存在的来源')
  })
})

describe('knowledge text processing', () => {
  it('extracts Markdown body text and keeps its section and source position', () => {
    const content = [
      '# 总览',
      '',
      '这是 **核心内容**，参考[行动说明](https://example.com)。',
      '',
      '## 执行方法',
      '',
      '- 第一步先打开文档。',
      '- 第二步只写一个标题。',
    ].join('\n')
    const paragraphs = extractKnowledgeParagraphs({ kind: 'markdown', title: '推进指南', content })

    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]).toMatchObject({
      content: '这是 核心内容，参考行动说明。',
      heading: '总览',
      startLine: 3,
      endLine: 3,
    })
    expect(paragraphs[1]).toMatchObject({
      content: '第一步先打开文档。\n第二步只写一个标题。',
      heading: '总览 › 执行方法',
      startLine: 7,
      endLine: 8,
    })
    expect(content.slice(paragraphs[1].startOffset, paragraphs[1].endOffset)).toContain('第一步先打开文档')
  })

  it('creates traceable 300–700 character chunks without crossing headings', async () => {
    const content = [
      '# 第一章',
      '',
      '甲'.repeat(180),
      '',
      '乙'.repeat(180),
      '',
      '丙'.repeat(180),
      '',
      '# 第二章',
      '',
      '丁'.repeat(800),
    ].join('\n')
    const source: KnowledgeSource = {
      id: 'source-chunking',
      kind: 'markdown',
      title: '长文测试',
      content,
      contentFingerprint: 'fingerprint',
      sizeBytes: new TextEncoder().encode(content).byteLength,
      createdAt: '2026-09-06T08:00:00.000Z',
      updatedAt: '2026-09-06T08:00:00.000Z',
      originalFileName: '长文测试.md',
    }
    const chunks = await buildKnowledgeChunks(source, '2026-09-06T09:00:00.000Z')

    expect(chunks).toHaveLength(3)
    expect(chunks.map((chunk) => chunk.heading)).toEqual(['第一章', '第二章', '第二章'])
    chunks.forEach((chunk, sequence) => {
      expect(chunk.sequence).toBe(sequence)
      expect(chunk.sourceTitle).toBe('长文测试')
      expect(chunk.characterCount).toBeGreaterThanOrEqual(KNOWLEDGE_CHUNK_MIN_CHARACTERS)
      expect(chunk.characterCount).toBeLessThanOrEqual(KNOWLEDGE_CHUNK_MAX_CHARACTERS)
      expect(chunk.startOffset).toBeLessThan(chunk.endOffset)
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine)
      expect(chunk.contentHash).toMatch(/^[A-F0-9]{64}$/)
      expect(chunk.sourceContentHash).toMatch(/^[A-F0-9]{64}$/)
      expect(chunk.processorVersion).toBe(KNOWLEDGE_TEXT_PROCESSOR_VERSION)
    })
  })

  it('uses the source title as the section for plain TXT paragraphs', () => {
    const paragraphs = extractKnowledgeParagraphs({
      kind: 'text',
      title: '随手记录',
      content: '第一段内容。\n\n第二段内容。',
    })

    expect(paragraphs.map((paragraph) => paragraph.heading)).toEqual(['随手记录', '随手记录'])
    expect(paragraphs.map((paragraph) => [paragraph.startLine, paragraph.endLine])).toEqual([[1, 1], [3, 3]])
  })

  it('keeps a heading-only Markdown source processable', async () => {
    const content = '# 只有标题'
    const chunks = await buildKnowledgeChunks({
      id: 'heading-only', kind: 'markdown', title: '标题资料', content,
      contentFingerprint: 'heading', sizeBytes: new TextEncoder().encode(content).byteLength,
      createdAt: '2026-09-06T08:00:00.000Z', updatedAt: '2026-09-06T08:00:00.000Z',
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ content: '只有标题', heading: '标题资料', startLine: 1, endLine: 1 })
  })

  it('reconstructs readable PDF lines from positioned text items', () => {
    const lines = pdfTextItemsToLines([
      { str: 'Attention', transform: [1, 0, 0, 1, 10, 700], width: 40, height: 10 },
      { str: 'plan', transform: [1, 0, 0, 1, 55, 700], width: 18, height: 10, hasEOL: true },
      { str: '第二行', transform: [1, 0, 0, 1, 10, 680], width: 30, height: 10 },
    ])

    expect(lines).toEqual(['Attention plan', '第二行'])
  })
})
