import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  createExtractedDocumentKnowledgeSource,
  createImportedKnowledgeSource,
  knowledgeFileKind,
  normalizeKnowledgeContent,
  validateKnowledgeFile,
  type KnowledgeSource,
} from './knowledgeBase'

interface PdfTextItemLike {
  str: string
  hasEOL?: boolean
  transform?: number[]
  width?: number
  height?: number
}

function elementText(element: Element) {
  const imageLabels = [...element.querySelectorAll('img')]
    .map((image) => image.getAttribute('alt')?.trim())
    .filter(Boolean)
  return normalizeKnowledgeContent([element.textContent ?? '', ...imageLabels].filter(Boolean).join(' '))
}

function tableText(table: Element) {
  return [...table.querySelectorAll('tr')]
    .map((row) => [...row.querySelectorAll(':scope > th, :scope > td')].map((cell) => elementText(cell).replace(/\|/g, '｜')))
    .filter((cells) => cells.some(Boolean))
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n')
}

function listText(list: Element, ordered: boolean) {
  return [...list.children]
    .filter((child) => child.tagName.toLocaleLowerCase() === 'li')
    .map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${elementText(item)}`)
    .filter((line) => line.replace(/^\d+\.\s*|^-\s*/, '').trim())
    .join('\n')
}

function docxBlocks(root: ParentNode): string[] {
  const blocks: string[] = []
  root.childNodes.forEach((node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.tagName.toLocaleLowerCase()
    if (/^h[1-6]$/.test(tag)) {
      const title = elementText(element)
      if (title) blocks.push(`${'#'.repeat(Number(tag[1]))} ${title}`)
      return
    }
    if (tag === 'p' || tag === 'blockquote') {
      const text = elementText(element)
      if (text) blocks.push(tag === 'blockquote' ? `> ${text}` : text)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      const text = listText(element, tag === 'ol')
      if (text) blocks.push(text)
      return
    }
    if (tag === 'table') {
      const text = tableText(element)
      if (text) blocks.push(text)
      return
    }
    if (tag === 'pre') {
      const text = element.textContent?.trim()
      if (text) blocks.push(`\`\`\`\n${text}\n\`\`\``)
      return
    }
    blocks.push(...docxBlocks(element))
  })
  return blocks
}

export function docxHtmlToKnowledgeText(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return normalizeKnowledgeContent(docxBlocks(document.body).join('\n\n'))
}

function isCjk(value: string) {
  return /[\u2e80-\u9fff\uf900-\ufaff]/.test(value)
}

function needsPdfSpace(previous: PdfTextItemLike, current: PdfTextItemLike) {
  const previousText = previous.str.trimEnd()
  const currentText = current.str.trimStart()
  if (!previousText || !currentText || isCjk(previousText.at(-1) ?? '') || isCjk(currentText[0] ?? '')) return false
  const previousX = previous.transform?.[4]
  const currentX = current.transform?.[4]
  if (typeof previousX !== 'number' || typeof currentX !== 'number') return true
  const gap = currentX - (previousX + (previous.width ?? 0))
  return gap > Math.max(0.5, (current.height ?? previous.height ?? 8) * 0.12)
}

export function pdfTextItemsToLines(items: PdfTextItemLike[]) {
  const lines: string[] = []
  let line = ''
  let previous: PdfTextItemLike | null = null
  const flush = () => {
    const value = line.trim()
    if (value) lines.push(value)
    line = ''
  }
  items.forEach((item) => {
    if (!item.str) return
    const previousY = previous?.transform?.[5]
    const currentY = item.transform?.[5]
    const movedLine = previous && typeof previousY === 'number' && typeof currentY === 'number'
      && Math.abs(previousY - currentY) > Math.max(2, (item.height ?? previous.height ?? 8) * 0.45)
    if (previous?.hasEOL || movedLine) flush()
    if (previous && line && needsPdfSpace(previous, item)) line += ' '
    line += item.str
    previous = item
  })
  flush()
  return lines
}

async function extractDocx(file: File) {
  const { default: mammoth } = await import('mammoth')
  const result = await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    { includeDefaultStyleMap: true, ignoreEmptyParagraphs: true },
  )
  return {
    content: docxHtmlToKnowledgeText(result.value),
    warnings: result.messages.map((message) => message.message).filter(Boolean),
  }
}

async function extractPdf(file: File) {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  try {
    const document = await loadingTask.promise
    const pages: string[] = []
    let emptyPageCount = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const items: PdfTextItemLike[] = textContent.items.flatMap((item) => 'str' in item ? [{
        str: item.str,
        hasEOL: item.hasEOL,
        transform: item.transform,
        width: item.width,
        height: item.height,
      }] : [])
      const lines = pdfTextItemsToLines(items)
      if (!lines.length) emptyPageCount += 1
      else pages.push(`# 第 ${pageNumber} 页\n\n${lines.join('\n')}`)
      page.cleanup()
    }
    return {
      content: normalizeKnowledgeContent(pages.join('\n\n')),
      pageCount: document.numPages,
      warnings: emptyPageCount ? [`${emptyPageCount} 页没有检测到可提取文字。`] : [],
    }
  } finally {
    await loadingTask.destroy()
  }
}

export async function createKnowledgeSourceFromFile(
  file: File,
  existing?: KnowledgeSource,
  now = new Date().toISOString(),
) {
  const validation = validateKnowledgeFile(file)
  if (validation) throw new Error(validation)
  const kind = knowledgeFileKind(file.name)
  if (kind === 'text' || kind === 'markdown') return createImportedKnowledgeSource(file.name, await file.text(), existing, now)
  if (kind === 'docx') {
    const extracted = await extractDocx(file)
    return createExtractedDocumentKnowledgeSource(file.name, kind, extracted.content, {
      mimeType: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalSizeBytes: file.size,
      warnings: extracted.warnings,
    }, existing, now)
  }
  if (kind === 'pdf') {
    const extracted = await extractPdf(file)
    return createExtractedDocumentKnowledgeSource(file.name, kind, extracted.content, {
      mimeType: file.type || 'application/pdf',
      originalSizeBytes: file.size,
      pageCount: extracted.pageCount,
      warnings: extracted.warnings,
    }, existing, now)
  }
  throw new Error('不支持这种文档格式。')
}
