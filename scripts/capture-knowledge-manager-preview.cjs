const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')

const previewBase = process.argv[2] || 'http://127.0.0.1:5173/'
const outputDirectory = path.resolve(__dirname, '..', 'artifacts')
let currentStep = '启动验收'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

async function pause(ms = 300) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function capture(window, filename) {
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window.webContents.capturePage()
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, filename), image.toPNG())
}

async function knowledgeSourceCount(window) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.open('xirang-knowledge-base')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('sources', 'readonly')
      const countRequest = transaction.objectStore('sources').count()
      countRequest.onsuccess = () => { resolve(countRequest.result); database.close() }
      countRequest.onerror = () => reject(countRequest.error)
    }
  })`)
}

async function sourceContent(window, title) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.open('xirang-knowledge-base')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('sources', 'readonly')
      const allRequest = transaction.objectStore('sources').getAll()
      allRequest.onsuccess = () => {
        resolve((allRequest.result.find((item) => item.title === ${JSON.stringify(title)}) || {}).content || '')
        database.close()
      }
      allRequest.onerror = () => reject(allRequest.error)
    }
  })`)
}

async function knowledgeStorageSnapshot(window) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.open('xirang-knowledge-base')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const storeNames = Array.from(database.objectStoreNames)
      const requiredStores = ['sources', 'permissions', 'chunks', 'retrievals', 'metadata']
      if (requiredStores.some((store) => !storeNames.includes(store))) {
        database.close()
        reject(new Error('知识库对象仓库不完整：' + storeNames.join(', ')))
        return
      }
      const transaction = database.transaction(requiredStores, 'readonly')
      const readAll = (store) => new Promise((done, fail) => {
        const read = transaction.objectStore(store).getAll()
        read.onsuccess = () => done(read.result)
        read.onerror = () => fail(read.error)
      })
      Promise.all(requiredStores.map(readAll)).then(([sources, permissions, chunks, retrievals, metadata]) => {
        resolve({
          version: database.version,
          storeNames,
          sources,
          permissionCount: permissions.length,
          chunks,
          retrievalCount: retrievals.length,
          metadata,
        })
        database.close()
      }, (error) => {
        database.close()
        reject(error)
      })
    }
  })`)
}

async function waitForStorage(window, predicate, label, timeoutMs = 6000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await knowledgeStorageSnapshot(window)
    if (predicate(snapshot)) return snapshot
    await pause(180)
  }
  throw new Error(`等待超时：${label}`)
}

async function verifyLegacyMigration(previewUrl) {
  const migrationWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { partition: `qa-knowledge-migration-${Date.now()}` },
  })
  try {
    await migrationWindow.loadURL(`${previewUrl}#/today`)
    await pause(250)
    await migrationWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const remove = indexedDB.deleteDatabase('xirang-knowledge-base')
      remove.onerror = () => reject(remove.error)
      remove.onblocked = () => reject(new Error('旧知识库删除被阻塞'))
      remove.onsuccess = () => {
        const request = indexedDB.open('xirang-knowledge-base', 1)
        request.onerror = () => reject(request.error)
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('sources', { keyPath: 'id' })
          store.createIndex('kind', 'kind', { unique: false })
          store.createIndex('sourceNoteId', 'sourceNoteId', { unique: false })
          store.createIndex('updatedAt', 'updatedAt', { unique: false })
        }
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction('sources', 'readwrite')
          transaction.objectStore('sources').put({
            id: 'legacy-source', kind: 'text', title: '旧版资料', content: '旧版知识正文仍需保留。',
            contentFingerprint: 'legacy-fingerprint', sizeBytes: 30,
            createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z',
            originalFileName: '旧版资料.txt'
          })
          transaction.oncomplete = () => { database.close(); resolve(true) }
          transaction.onerror = () => { const error = transaction.error; database.close(); reject(error) }
        }
      }
    })`)
    await migrationWindow.loadURL(`${previewUrl}#/settings`)
    const snapshot = await waitForStorage(migrationWindow, (state) => state.sources.length === 1 && state.chunks.length === 1, '旧版资料自动分块')
    const migratedSource = snapshot.sources.find((source) => source.id === 'legacy-source')
    if (snapshot.version !== 2 || snapshot.permissionCount !== 1 || !migratedSource) {
      throw new Error('IndexedDB v1 数据没有完整迁移到 v2')
    }
    if (!/^[A-F0-9]{64}$/.test(migratedSource.contentHash || '') || migratedSource.hashAlgorithm !== 'SHA-256') {
      throw new Error('旧版知识来源没有补齐 SHA-256 校验信息')
    }
    const migratedChunks = snapshot.chunks.filter((chunk) => chunk.sourceId === 'legacy-source')
    if (migratedChunks.length !== 1 || migratedChunks[0].sourceTitle !== '旧版资料' || migratedChunks[0].processorVersion !== 1) {
      throw new Error('旧版知识来源没有自动完成正文提取与分块')
    }
  } finally {
    await migrationWindow.close()
  }
}

async function dispatchFile(window, selector, fileName, content, mimeType) {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('找不到文件输入框：${selector}')
    const transfer = new DataTransfer()
    transfer.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

async function dispatchBinaryFile(window, selector, fileName, buffer, mimeType) {
  const base64 = buffer.toString('base64')
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('找不到文件输入框：${selector}')
    const binary = atob(${JSON.stringify(base64)})
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

async function createDocxBuffer() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`)
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`)
  zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`)
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>专注学习计划</w:t></w:r></w:p>
  <w:p><w:r><w:t>先明确本周目标，再把任务缩小为可以立即执行的一步。</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>执行清单</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>下一步</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>论文</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>打开方法章节</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:sectPr/>
</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function createTextPdfBuffer(pageLines) {
  const escapePdfText = (value) => value.replace(/([\\()])/g, '\\$1')
  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  const pageReferences = []
  pageLines.forEach((lines, pageIndex) => {
    const pageObject = 4 + pageIndex * 2
    const streamObject = pageObject + 1
    pageReferences.push(`${pageObject} 0 R`)
    const textCommands = lines.map((line, lineIndex) => `${lineIndex ? '0 -24 Td ' : ''}(${escapePdfText(line)}) Tj`).join('\n')
    const stream = `BT /F1 14 Tf 72 720 Td\n${textCommands}\nET`
    objects[pageObject] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamObject} 0 R >>`
    objects[streamObject] = `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`
  })
  objects[2] = `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pageLines.length} >>`
  let pdf = '%PDF-1.4\n%XIRANG\n'
  const offsets = [0]
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(pdf, 'ascii')
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii')
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let index = 1; index < objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'ascii')
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1200,
    webPreferences: { partition: `qa-knowledge-manager-${Date.now()}` },
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`渲染进程：${event.message}`)
  })

  currentStep = '加载设置页'
  await window.loadURL(`${previewBase}#/settings`)
  await pause(400)
  await window.webContents.executeJavaScript('localStorage.clear()')
  await window.reload()
  await pause(450)
  currentStep = '写入测试笔记'
  await window.webContents.executeJavaScript(`(() => {
    const state = JSON.parse(localStorage.getItem('xirang-state'))
    state.profile.onboardingComplete = true
    state.personalNotes = [
      { id: 'note-start', title: '启动困难观察', content: '最难的往往不是任务本身，而是不知道第一步要做到多小。', createdAt: '2026-09-05T08:00:00.000Z', updatedAt: '2026-09-05T08:00:00.000Z' },
      { id: 'note-review', title: '一周复盘', content: '手机分心主要出现在任务边界不清楚的时候。', createdAt: '2026-09-05T09:00:00.000Z', updatedAt: '2026-09-05T09:00:00.000Z' }
    ]
    localStorage.setItem('xirang-state', JSON.stringify(state))
  })()`)
  await window.reload()
  await pause(500)

  currentStep = '检查知识库初始界面'
  const initialText = await window.webContents.executeJavaScript("document.querySelector('.knowledge-manager')?.innerText || ''")
  if (!initialText.includes('个人知识来源') || !initialText.includes('AI 未接入') || !initialText.includes('启动困难观察')) {
    throw new Error('个人知识库管理区没有正确加载')
  }

  currentStep = '授权个人笔记'
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.knowledge-note-list article')].find((item) => item.textContent.includes('启动困难观察')).querySelector('.toggle-switch').click()")
  await waitForStorage(window, (snapshot) => snapshot.sources.length === 1 && snapshot.chunks.length > 0, '个人笔记分块')
  if (await knowledgeSourceCount(window) !== 1) throw new Error('个人笔记授权后没有写入 IndexedDB')
  const authorizedSnapshot = await knowledgeStorageSnapshot(window)
  const authorizedSource = authorizedSnapshot.sources[0]
  if (authorizedSnapshot.version !== 2 || authorizedSnapshot.storeNames.length !== 5) throw new Error('IndexedDB v2 存储结构没有正确建立')
  if (authorizedSnapshot.permissionCount !== 1) throw new Error('个人笔记授权后没有建立独立授权记录')
  if (!/^[A-F0-9]{64}$/.test(authorizedSource.contentHash || '') || authorizedSource.hashAlgorithm !== 'SHA-256') throw new Error('知识来源没有写入 SHA-256 校验信息')
  if (authorizedSnapshot.chunks.length !== 1 || authorizedSnapshot.chunks[0].sourceTitle !== '启动困难观察') throw new Error('个人笔记没有生成可追溯文本块')
  await window.reload()
  await pause(450)
  const restoredStatus = await window.webContents.executeJavaScript("[...document.querySelectorAll('.knowledge-note-list article')].find((item) => item.textContent.includes('启动困难观察'))?.querySelector('.knowledge-status')?.textContent")
  if (restoredStatus !== '已切分 1 块') throw new Error(`刷新后笔记分块状态没有恢复：${restoredStatus}`)

  currentStep = '修改原始笔记'
  await window.webContents.executeJavaScript(`(() => {
    const state = JSON.parse(localStorage.getItem('xirang-state'))
    state.personalNotes = state.personalNotes.map((note) => note.id === 'note-start'
      ? { ...note, content: note.content + '\\n下一次只要求自己打开文档。', updatedAt: '2026-09-05T10:00:00.000Z' }
      : note)
    localStorage.setItem('xirang-state', JSON.stringify(state))
  })()`)
  await window.reload()
  await pause(450)
  const outdatedStatus = await window.webContents.executeJavaScript("[...document.querySelectorAll('.knowledge-note-list article')].find((item) => item.textContent.includes('启动困难观察'))?.querySelector('.knowledge-status')?.textContent")
  if (outdatedStatus !== '需要同步') throw new Error(`笔记修改后没有提示需要同步：${outdatedStatus}`)
  currentStep = '同步笔记快照'
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.knowledge-note-list article')].find((item) => item.textContent.includes('启动困难观察')).querySelector('.knowledge-sync-button').click()")
  await waitForStorage(window, (snapshot) => snapshot.chunks.some((chunk) => chunk.content.includes('只要求自己打开文档')), '同步后的笔记重新分块')
  if (!(await sourceContent(window, '启动困难观察')).includes('只要求自己打开文档')) throw new Error('同步最新没有更新笔记快照')

  const importSelector = '.knowledge-source-section.files input[type=file][multiple]'
  const markdownOriginal = `# 本周目标\n\n${'围绕**研究方法**整理样本标准、变量定义和分析步骤，确保每项判断都能回到原始记录。'.repeat(12)}\n\n## 下一步\n\n${'先复核样本筛选标准，再记录需要补充的信息和对应负责人。'.repeat(18)}`
  currentStep = '导入 Markdown 文档'
  await dispatchFile(window, importSelector, '论文推进计划.md', markdownOriginal, 'text/markdown')
  const importedSnapshot = await waitForStorage(window, (snapshot) => snapshot.sources.length === 2 && snapshot.chunks.length >= 3, 'Markdown 文档分块')
  if (await knowledgeSourceCount(window) !== 2) throw new Error('Markdown 文档没有写入 IndexedDB')
  const importedText = await window.webContents.executeJavaScript("document.querySelector('.knowledge-file-list')?.innerText || ''")
  if (!importedText.includes('论文推进计划') || !importedText.includes('已切分')) throw new Error('导入文档没有正确显示分块状态')
  const importedSource = importedSnapshot.sources.find((source) => source.title === '论文推进计划')
  if (!importedSource) throw new Error('找不到刚导入的 Markdown 知识来源')
  const originalImportedChunks = importedSnapshot.chunks.filter((chunk) => chunk.sourceId === importedSource.id)
  const originalNoteChunkIds = importedSnapshot.chunks.filter((chunk) => chunk.sourceId !== importedSource.id).map((chunk) => chunk.id)
  if (originalImportedChunks.length < 2) throw new Error('Markdown 没有按标题切成多个文本块')
  if (!originalImportedChunks.some((chunk) => chunk.heading.includes('本周目标')) || !originalImportedChunks.some((chunk) => chunk.heading.includes('下一步'))) throw new Error('文本块没有保存 Markdown 章节')
  if (originalImportedChunks.some((chunk) => chunk.characterCount > 700 || chunk.characterCount < 300)) throw new Error('常规 Markdown 文本块没有保持在 300～700 字范围')
  if (originalImportedChunks.some((chunk) => !chunk.sourceTitle || chunk.startLine < 1 || chunk.startOffset >= chunk.endOffset || !/^[A-F0-9]{64}$/.test(chunk.contentHash || ''))) throw new Error('文本块缺少资料名称、原文位置或内容哈希')
  if (originalImportedChunks.some((chunk) => chunk.content.includes('**'))) throw new Error('Markdown 正文提取后仍残留强调语法')

  currentStep = '验证未变化资料不重复处理'
  await window.webContents.executeJavaScript('window.confirm = () => true; true')
  await dispatchFile(window, importSelector, '论文推进计划.md', markdownOriginal, 'text/markdown')
  await pause(600)
  const unchangedSnapshot = await knowledgeStorageSnapshot(window)
  const unchangedImportedChunkIds = unchangedSnapshot.chunks.filter((chunk) => chunk.sourceId === importedSource.id).map((chunk) => chunk.id)
  if (JSON.stringify(unchangedImportedChunkIds) !== JSON.stringify(originalImportedChunks.map((chunk) => chunk.id))) throw new Error('内容未变化时错误地重建了文本块')
  if (JSON.stringify(unchangedSnapshot.chunks.filter((chunk) => chunk.sourceId !== importedSource.id).map((chunk) => chunk.id)) !== JSON.stringify(originalNoteChunkIds)) throw new Error('未变化的个人笔记被错误地重新处理')

  currentStep = '更新同名 Markdown 文档'
  const markdownUpdated = markdownOriginal.replace('先复核样本筛选标准', '先复核更新后的样本筛选标准')
  await dispatchFile(window, importSelector, '论文推进计划.md', markdownUpdated, 'text/markdown')
  const updatedSnapshot = await waitForStorage(window, (snapshot) => snapshot.chunks.some((chunk) => chunk.content.includes('更新后的样本筛选标准')), '变化资料重新分块')
  if (!(await sourceContent(window, '论文推进计划')).includes('更新后的样本筛选标准')) throw new Error('同名文档更新失败')
  const updatedImportedChunkIds = updatedSnapshot.chunks.filter((chunk) => chunk.sourceId === importedSource.id).map((chunk) => chunk.id)
  if (updatedImportedChunkIds.some((id) => originalImportedChunks.some((chunk) => chunk.id === id))) throw new Error('发生变化的资料没有替换旧文本块')
  if (JSON.stringify(updatedSnapshot.chunks.filter((chunk) => chunk.sourceId !== importedSource.id).map((chunk) => chunk.id)) !== JSON.stringify(originalNoteChunkIds)) throw new Error('更新一份资料时重新处理了其他资料')

  currentStep = '导入 Word DOCX'
  await dispatchBinaryFile(
    window,
    importSelector,
    '专注学习计划.docx',
    await createDocxBuffer(),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  const docxSnapshot = await waitForStorage(window, (snapshot) => snapshot.sources.some((source) => source.kind === 'docx') && snapshot.chunks.some((chunk) => chunk.sourceTitle === '专注学习计划'), 'DOCX 正文提取与分块')
  const docxSource = docxSnapshot.sources.find((source) => source.kind === 'docx')
  const docxChunks = docxSnapshot.chunks.filter((chunk) => chunk.sourceId === docxSource.id)
  if (!docxSource.content.includes('专注学习计划') || !docxSource.content.includes('打开方法章节')) throw new Error('DOCX 没有提取标题、段落或表格内容')
  if (!docxChunks.some((chunk) => chunk.heading.includes('执行清单'))) throw new Error('DOCX 文本块没有保存标题层级')

  currentStep = '导入双页文字型 PDF'
  const pdfBuffer = createTextPdfBuffer([
    ['Attention training plan', 'Start with one small action.'],
    ['Weekly review', 'Keep the next step visible.'],
  ])
  await dispatchBinaryFile(window, importSelector, '双页专注计划.pdf', pdfBuffer, 'application/pdf')
  const pdfSnapshot = await waitForStorage(window, (snapshot) => snapshot.sources.some((source) => source.kind === 'pdf') && snapshot.chunks.filter((chunk) => chunk.sourceTitle === '双页专注计划').length === 2, '文字型 PDF 按页提取与分块')
  const pdfSource = pdfSnapshot.sources.find((source) => source.kind === 'pdf')
  const pdfChunks = pdfSnapshot.chunks.filter((chunk) => chunk.sourceId === pdfSource.id)
  if (pdfSource.pageCount !== 2 || !pdfSource.content.includes('Attention training plan') || !pdfSource.content.includes('Weekly review')) throw new Error('文字型 PDF 正文或页数提取不正确')
  if (pdfChunks.map((chunk) => chunk.heading).join('|') !== '第 1 页|第 2 页') throw new Error(`PDF 文本块没有保留页码：${pdfChunks.map((chunk) => chunk.heading).join('|')}`)

  await window.webContents.executeJavaScript("document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.querySelector('.knowledge-manager').offsetTop - 18)")
  await pause(450)
  await capture(window, '0.3.7-docx-pdf-desktop.png')

  currentStep = '预览 PDF 分页文本块'
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.knowledge-file-list article')].find((item) => item.textContent.includes('双页专注计划')).querySelector('.knowledge-file-actions button:nth-child(2)').click()")
  await pause(250)
  const previewText = await window.webContents.executeJavaScript("document.querySelector('.knowledge-chunk-preview')?.innerText || ''")
  if (!previewText.includes('第 1 页') || !previewText.includes('第 2 页') || !previewText.includes('Attention training plan')) throw new Error('PDF 文本块预览没有显示页码与提取正文')
  await capture(window, '0.3.7-pdf-chunks-preview.png')
  await window.webContents.executeJavaScript("document.querySelector('.knowledge-preview header > button').click()")

  currentStep = '检查移动端布局'
  window.setSize(430, 900)
  await pause(350)
  await window.webContents.executeJavaScript("document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.querySelector('.knowledge-manager').offsetTop - 8)")
  await pause(450)
  const horizontalOverflow = await window.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth')
  if (horizontalOverflow) throw new Error('手机端知识库管理区出现横向溢出')
  await capture(window, '0.3.7-docx-pdf-mobile-overview.png')
  await window.webContents.executeJavaScript("window.scrollTo(0, document.querySelector('.knowledge-source-section.files').offsetTop - 18)")
  await pause(350)
  await capture(window, '0.3.7-docx-pdf-mobile.png')

  currentStep = '拒绝无文字 PDF 并提示 OCR 边界'
  await dispatchBinaryFile(window, importSelector, '扫描空白页.pdf', createTextPdfBuffer([[]]), 'application/pdf')
  await pause(700)
  const extractionError = await window.webContents.executeJavaScript("document.querySelector('.knowledge-notice.error')?.innerText || ''")
  if (!extractionError.includes('OCR')) throw new Error('无文字 PDF 没有显示 OCR 边界提示')
  if ((await knowledgeStorageSnapshot(window)).sources.length !== 4) throw new Error('无文字 PDF 被错误写入知识库')

  currentStep = '移除导入文档'
  await window.webContents.executeJavaScript("document.querySelector('.knowledge-file-list article .knowledge-file-actions button:last-child').click()")
  await pause(400)
  if (await knowledgeSourceCount(window) !== 3) throw new Error('移除导入文档后 IndexedDB 记录数不正确')
  if ((await knowledgeStorageSnapshot(window)).permissionCount !== 3) throw new Error('移除知识来源后授权记录没有级联删除')

  currentStep = '清空设备数据'
  await window.webContents.executeJavaScript("document.querySelector('.danger-card > button').click()")
  await pause(150)
  await window.webContents.executeJavaScript("document.querySelector('.clear-confirmation .confirm').click()")
  await pause(500)
  if (await knowledgeSourceCount(window) !== 0) throw new Error('清空设备数据时没有清除知识库')
  const clearedSnapshot = await knowledgeStorageSnapshot(window)
  if (clearedSnapshot.permissionCount || clearedSnapshot.chunks.length || clearedSnapshot.retrievalCount) throw new Error('清空设备数据后知识库关联数据仍有残留')
  const clearedUiCount = await window.webContents.executeJavaScript("document.querySelector('.knowledge-summary span strong')?.textContent")
  if (clearedUiCount !== '0') throw new Error(`清空设备数据后界面知识来源数未刷新：${clearedUiCount}`)

  currentStep = '验证 IndexedDB v1 自动迁移'
  await verifyLegacyMigration(previewBase)

  await window.close()
  app.quit()
}).catch((error) => {
  console.error(`失败阶段：${currentStep}`)
  console.error(error)
  app.exit(1)
})
