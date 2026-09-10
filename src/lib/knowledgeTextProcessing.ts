import {
  listKnowledgeChunks,
  replaceKnowledgeChunks,
  sha256KnowledgeText,
  type KnowledgeChunk,
  type KnowledgeSource,
} from './knowledgeBase'

export const KNOWLEDGE_CHUNK_MIN_CHARACTERS = 300
export const KNOWLEDGE_CHUNK_TARGET_CHARACTERS = 500
export const KNOWLEDGE_CHUNK_MAX_CHARACTERS = 700
export const KNOWLEDGE_TEXT_PROCESSOR_VERSION = 1

export interface ExtractedKnowledgeParagraph {
  content: string
  heading: string
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
}

export interface KnowledgeProcessingResult {
  sourceId: string
  status: 'processed' | 'unchanged'
  chunks: KnowledgeChunk[]
}

interface SourceLine {
  text: string
  startOffset: number
  endOffset: number
  lineNumber: number
  literal?: boolean
}

interface ParagraphPiece extends ExtractedKnowledgeParagraph {}

interface ChunkDraft extends ExtractedKnowledgeParagraph {}

function sourceLines(content: string): SourceLine[] {
  if (!content) return []
  const lines: SourceLine[] = []
  let startOffset = 0
  let lineNumber = 1
  while (startOffset <= content.length) {
    const newlineOffset = content.indexOf('\n', startOffset)
    const endOffset = newlineOffset === -1 ? content.length : newlineOffset
    lines.push({
      text: content.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      lineNumber,
    })
    if (newlineOffset === -1) break
    startOffset = newlineOffset + 1
    lineNumber += 1
  }
  return lines
}

function stripMarkdownLine(value: string) {
  return value
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(`{1,3}|\*{1,3}|_{1,3}|~{2})/g, '')
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
    .trim()
}

function headingPath(stack: string[], fallback: string) {
  return stack.filter(Boolean).join(' › ') || fallback
}

export function extractKnowledgeParagraphs(
  source: Pick<KnowledgeSource, 'kind' | 'title' | 'content'>,
): ExtractedKnowledgeParagraph[] {
  const lines = sourceLines(source.content)
  const paragraphs: ExtractedKnowledgeParagraph[] = []
  const headingStack: string[] = []
  let buffered: SourceLine[] = []
  let fencedWith: '`' | '~' | null = null

  const currentHeading = () => headingPath(headingStack, source.title || '正文')

  const flushParagraph = () => {
    if (!buffered.length) return
    const structured = source.kind === 'markdown' || source.kind === 'docx' || source.kind === 'pdf'
    const contentLines = buffered
      .map((line) => line.literal ? line.text.trim() : structured ? stripMarkdownLine(line.text) : line.text.trim())
      .filter(Boolean)
    if (contentLines.length) {
      const first = buffered[0]
      const last = buffered[buffered.length - 1]
      const firstNonSpace = first.text.search(/\S/)
      const trailingSpaces = last.text.length - last.text.trimEnd().length
      paragraphs.push({
        content: contentLines.join('\n'),
        heading: currentHeading(),
        startOffset: first.startOffset + Math.max(0, firstNonSpace),
        endOffset: Math.max(first.startOffset, last.endOffset - trailingSpaces),
        startLine: first.lineNumber,
        endLine: last.lineNumber,
      })
    }
    buffered = []
  }

  const setHeading = (level: number, title: string) => {
    const cleanTitle = stripMarkdownLine(title).replace(/\s+#+\s*$/, '').trim()
    if (!cleanTitle) return
    headingStack[level - 1] = cleanTitle
    headingStack.length = level
  }

  for (const line of lines) {
    const trimmed = line.text.trim()
    if (source.kind === 'markdown' || source.kind === 'docx' || source.kind === 'pdf') {
      const fence = trimmed.match(/^(`{3,}|~{3,})/)
      if (fence) {
        flushParagraph()
        const marker = fence[1][0] as '`' | '~'
        fencedWith = fencedWith === marker ? null : marker
        continue
      }
      if (!fencedWith) {
        const atxHeading = line.text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/)
        if (atxHeading) {
          flushParagraph()
          setHeading(atxHeading[1].length, atxHeading[2])
          continue
        }
        const setextHeading = trimmed.match(/^(=+|-+)\s*$/)
        if (setextHeading && buffered.length === 1) {
          const titleLine = buffered[0]
          buffered = []
          setHeading(setextHeading[1][0] === '=' ? 1 : 2, titleLine.text)
          continue
        }
      }
    }
    if (!trimmed) {
      flushParagraph()
      continue
    }
    buffered.push({ ...line, literal: Boolean(fencedWith) })
  }
  flushParagraph()
  return paragraphs
}

function newlineCount(value: string) {
  return (value.match(/\n/g) ?? []).length
}

function preferredBoundary(value: string, lower: number, target: number, upper: number) {
  const boundaryPattern = /[\n。！？!?；;，,、：:]/
  for (let index = target; index <= upper; index += 1) {
    if (boundaryPattern.test(value[index - 1] ?? '')) return index
  }
  for (let index = target - 1; index >= lower; index -= 1) {
    if (boundaryPattern.test(value[index - 1] ?? '')) return index
  }
  return upper
}

function splitParagraph(paragraph: ExtractedKnowledgeParagraph): ParagraphPiece[] {
  if (paragraph.content.length <= KNOWLEDGE_CHUNK_MAX_CHARACTERS) return [paragraph]
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  while (paragraph.content.length - start > KNOWLEDGE_CHUNK_MAX_CHARACTERS) {
    const remaining = paragraph.content.length - start
    const upper = Math.min(
      KNOWLEDGE_CHUNK_MAX_CHARACTERS,
      remaining - KNOWLEDGE_CHUNK_MIN_CHARACTERS,
    )
    const target = Math.min(KNOWLEDGE_CHUNK_TARGET_CHARACTERS, upper)
    const length = preferredBoundary(
      paragraph.content.slice(start),
      Math.min(KNOWLEDGE_CHUNK_MIN_CHARACTERS, upper),
      target,
      upper,
    )
    ranges.push({ start, end: start + length })
    start += length
  }
  ranges.push({ start, end: paragraph.content.length })

  const rawSpan = Math.max(1, paragraph.endOffset - paragraph.startOffset)
  return ranges.map((range) => {
    const leading = paragraph.content.slice(range.start, range.end).search(/\S/)
    const pieceStart = range.start + Math.max(0, leading)
    const pieceText = paragraph.content.slice(pieceStart, range.end).trimEnd()
    const pieceEnd = pieceStart + pieceText.length
    const startLine = paragraph.startLine + newlineCount(paragraph.content.slice(0, pieceStart))
    const endLine = paragraph.startLine + newlineCount(paragraph.content.slice(0, Math.max(pieceStart, pieceEnd - 1)))
    return {
      content: pieceText,
      heading: paragraph.heading,
      startOffset: paragraph.startOffset + Math.floor((pieceStart / paragraph.content.length) * rawSpan),
      endOffset: paragraph.startOffset + Math.ceil((pieceEnd / paragraph.content.length) * rawSpan),
      startLine,
      endLine,
    }
  }).filter((piece) => piece.content)
}

function createChunkDrafts(source: Pick<KnowledgeSource, 'kind' | 'title' | 'content'>): ChunkDraft[] {
  const pieces = extractKnowledgeParagraphs(source).flatMap(splitParagraph)
  if (!pieces.length) {
    const fallbackContent = source.kind === 'markdown' || source.kind === 'docx' || source.kind === 'pdf'
      ? source.content
        .split('\n')
        .map((line) => stripMarkdownLine(line.replace(/^\s{0,3}#{1,6}\s+/, '')))
        .filter(Boolean)
        .join('\n')
      : source.content.trim()
    const content = fallbackContent || source.title
    return [{
      content,
      heading: source.title || '正文',
      startOffset: 0,
      endOffset: source.content.length,
      startLine: 1,
      endLine: Math.max(1, sourceLines(source.content).length),
    }]
  }
  const chunks: ChunkDraft[] = []
  let current: ParagraphPiece[] = []
  let currentLength = 0

  const flush = () => {
    if (!current.length) return
    const first = current[0]
    const last = current[current.length - 1]
    chunks.push({
      content: current.map((piece) => piece.content).join('\n\n'),
      heading: first.heading,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      startLine: first.startLine,
      endLine: last.endLine,
    })
    current = []
    currentLength = 0
  }

  for (const piece of pieces) {
    const separatorLength = current.length ? 2 : 0
    const crossesHeading = current.length > 0 && current[0].heading !== piece.heading
    if (crossesHeading || currentLength + separatorLength + piece.content.length > KNOWLEDGE_CHUNK_MAX_CHARACTERS) flush()
    current.push(piece)
    currentLength += (current.length > 1 ? 2 : 0) + piece.content.length
  }
  flush()
  return chunks
}

async function sourceContentHash(source: Pick<KnowledgeSource, 'kind' | 'title' | 'content' | 'contentHash'>) {
  return source.contentHash ?? sha256KnowledgeText(`${source.kind}\n${source.title}\n${source.content}`)
}

export async function buildKnowledgeChunks(
  source: KnowledgeSource,
  now = new Date().toISOString(),
): Promise<KnowledgeChunk[]> {
  const sourceHash = await sourceContentHash(source)
  const drafts = createChunkDrafts(source)
  return Promise.all(drafts.map(async (draft, sequence) => {
    const contentHash = await sha256KnowledgeText(`${draft.heading}\n${draft.content}`)
    return {
      id: `${source.id}:p${KNOWLEDGE_TEXT_PROCESSOR_VERSION}:${sourceHash.slice(0, 16)}:${sequence}`,
      sourceId: source.id,
      sourceTitle: source.title,
      sourceContentHash: sourceHash,
      sequence,
      content: draft.content,
      contentHash,
      heading: draft.heading,
      startOffset: draft.startOffset,
      endOffset: draft.endOffset,
      startLine: draft.startLine,
      endLine: draft.endLine,
      characterCount: draft.content.length,
      processorVersion: KNOWLEDGE_TEXT_PROCESSOR_VERSION,
      tokenEstimate: Math.max(1, Math.ceil(draft.content.length / 2)),
      createdAt: now,
      updatedAt: now,
    }
  }))
}

async function ensureSourceWithExistingChunks(
  source: KnowledgeSource,
  existing: KnowledgeChunk[],
): Promise<KnowledgeProcessingResult> {
  const sourceHash = await sourceContentHash(source)
  const unchanged = existing.length > 0
    && existing.every((chunk, sequence) => (
      chunk.sequence === sequence
      && chunk.sourceContentHash === sourceHash
      && chunk.processorVersion === KNOWLEDGE_TEXT_PROCESSOR_VERSION
    ))
  if (unchanged) return { sourceId: source.id, status: 'unchanged', chunks: existing }
  const chunks = await buildKnowledgeChunks({ ...source, contentHash: sourceHash })
  await replaceKnowledgeChunks(source.id, chunks)
  return { sourceId: source.id, status: 'processed', chunks }
}

export async function ensureKnowledgeSourceProcessed(source: KnowledgeSource) {
  return ensureSourceWithExistingChunks(source, await listKnowledgeChunks(source.id))
}

export async function ensureKnowledgeSourcesProcessed(sources: KnowledgeSource[]) {
  const allChunks = await listKnowledgeChunks()
  const chunksBySource = new Map<string, KnowledgeChunk[]>()
  allChunks.forEach((chunk) => {
    const sourceChunks = chunksBySource.get(chunk.sourceId) ?? []
    sourceChunks.push(chunk)
    chunksBySource.set(chunk.sourceId, sourceChunks)
  })
  const results: KnowledgeProcessingResult[] = []
  for (const source of sources) {
    results.push(await ensureSourceWithExistingChunks(source, chunksBySource.get(source.id) ?? []))
  }
  return results
}
