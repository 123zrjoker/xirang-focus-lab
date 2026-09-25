const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const previewBase = process.argv[2] || 'http://127.0.0.1:5173/'
const projectRoot = path.resolve(__dirname, '..')
const outputDirectory = path.join(projectRoot, 'artifacts')
const backupPath = path.join(projectRoot, 'docs', 'portfolio', 'demo-data', 'xirang-demo-backup.json')
const knowledgePath = path.join(projectRoot, 'docs', 'portfolio', 'demo-data', 'focus-methods-demo.md')
const partition = `qa-portfolio-demo-${Date.now()}`
let currentStep = '启动验收'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

function pause(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(window, expression, label, timeoutMs = 8000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await window.webContents.executeJavaScript(expression)) return
    await pause(180)
  }
  throw new Error(`等待超时：${label}`)
}

async function dispatchTextFile(window, selector, fileName, content, mimeType) {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('找不到文件输入框：${selector}')
    const transfer = new DataTransfer()
    transfer.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

async function capture(window, filename, selector) {
  if (selector) {
    const scrollState = await window.webContents.executeJavaScript(`(() => {
      document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important')
      const target = document.querySelector(${JSON.stringify(selector)})
      if (!target) throw new Error('找不到截图区域：${selector}')
      target.scrollIntoView({ behavior: 'auto', block: 'start' })
      const scroller = document.scrollingElement
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 18)
      return { selector: ${JSON.stringify(selector)}, scrollTop: scroller.scrollTop, targetTop: target.getBoundingClientRect().top }
    })()`)
    console.log(`截图定位：${JSON.stringify(scrollState)}`)
    await pause(350)
  }
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window.webContents.capturePage()
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, filename), image.toPNG())
}

async function knowledgeSnapshot(window) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.open('xirang-knowledge-base')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const stores = ['sources', 'permissions', 'chunks']
      if (stores.some((name) => !database.objectStoreNames.contains(name))) {
        database.close()
        reject(new Error('知识库对象仓库不完整'))
        return
      }
      const transaction = database.transaction(stores, 'readonly')
      const readAll = (name) => new Promise((done, fail) => {
        const read = transaction.objectStore(name).getAll()
        read.onsuccess = () => done(read.result)
        read.onerror = () => fail(read.error)
      })
      Promise.all(stores.map(readAll)).then(([sources, permissions, chunks]) => {
        resolve({ databaseVersion: database.version, sources, permissions, chunks })
        database.close()
      }, reject)
    }
  })`)
}

function privacyFindings(...texts) {
  const combined = texts.join('\n')
  const checks = [
    ['Windows 用户目录', /[A-Z]:\\\\Users\\\\[^\\\\\s]+/i],
    ['Windows 绝对路径', /[A-Z]:\\\\(?:[^\\\\\r\n]+\\\\)+[^\\\\\r\n]*/i],
    ['API Key', /\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/],
    ['电子邮箱', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ['中国大陆手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/],
  ]
  return checks.filter(([, pattern]) => pattern.test(combined)).map(([label]) => label)
}

app.whenReady().then(async () => {
  const backupText = fs.readFileSync(backupPath, 'utf8')
  const knowledgeText = fs.readFileSync(knowledgePath, 'utf8')
  const findings = privacyFindings(backupText, knowledgeText)
  if (findings.length) throw new Error(`演示资料隐私检查失败：${findings.join('、')}`)

  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1100,
    webPreferences: { partition },
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`渲染进程：${event.message}`)
  })

  currentStep = '打开全新浏览器数据空间'
  await window.loadURL(`${previewBase}#/settings`)
  await pause(500)
  const initialState = await window.webContents.executeJavaScript("JSON.parse(localStorage.getItem('xirang-state'))")
  if (initialState.sessions.length || initialState.focusSessions.length || initialState.actionSlips.length || initialState.personalNotes.length) {
    throw new Error('全新浏览器数据空间不是空状态')
  }

  currentStep = '从设置页导入合成备份'
  await window.webContents.executeJavaScript('window.confirm = () => true; true')
  await dispatchTextFile(
    window,
    '.data-actions input[type=file][accept*="json"]',
    path.basename(backupPath),
    backupText,
    'application/json',
  )
  await waitFor(
    window,
    `(() => {
      const state = JSON.parse(localStorage.getItem('xirang-state'))
      return state.schemaVersion === 11 && state.sessions.length === 3 && state.focusSessions.length === 3 &&
        state.actionSlips.length === 3 && state.personalNotes.length === 1 && state.agentPlans.length === 1
    })()`,
    '合成备份写入本地状态',
  )
  const importMessage = await window.webContents.executeJavaScript("document.querySelector('.settings-message.success')?.innerText || ''")
  if (!importMessage.includes('旧版应用数据已导入')) throw new Error(`导入成功提示不正确：${importMessage}`)
  const summaryText = await window.webContents.executeJavaScript("document.querySelector('.data-summary')?.innerText || ''")
  for (const expected of ['认知训练\n3', '现实专注\n3', '行动待办\n3', '个人笔记\n1', '数据格式\nv11']) {
    if (!summaryText.includes(expected)) throw new Error(`数据中心缺少导入结果：${expected}`)
  }
  await capture(window, '0.8.0-demo-import-data.png', '.data-card')

  currentStep = '打开知识工作区'
  await window.webContents.executeJavaScript("window.location.hash = '/knowledge'")
  await waitFor(window, "document.querySelector('.knowledge-manager')", '知识工作区加载')

  currentStep = '导入合成知识文档'
  await dispatchTextFile(
    window,
    '.knowledge-source-section.files input[type=file][multiple]',
    path.basename(knowledgePath),
    knowledgeText,
    'text/markdown',
  )
  let snapshot
  const startedAt = Date.now()
  while (Date.now() - startedAt < 8000) {
    snapshot = await knowledgeSnapshot(window)
    if (snapshot.sources.length === 1 && snapshot.permissions.length === 1 && snapshot.chunks.length >= 3) break
    await pause(180)
  }
  if (!snapshot || snapshot.sources.length !== 1 || snapshot.permissions.length !== 1 || snapshot.chunks.length < 3) {
    throw new Error('合成知识文档没有完成授权、保存和分块')
  }
  const importedSource = snapshot.sources[0]
  if (importedSource.title !== 'focus-methods-demo' || importedSource.kind !== 'markdown') {
    throw new Error('导入的知识来源元数据不正确')
  }
  if (!snapshot.chunks.some((chunk) => chunk.heading.includes('把任务缩小成第一步'))) {
    throw new Error('知识分块没有保留 Markdown 标题')
  }

  currentStep = '授权备份中的合成个人笔记'
  await window.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.knowledge-note-list article')]
      .find((node) => node.textContent.includes('演示数据说明'))
    if (!item) throw new Error('找不到合成个人笔记')
    item.querySelector('.toggle-switch').click()
  })()`)
  const noteStartedAt = Date.now()
  while (Date.now() - noteStartedAt < 8000) {
    snapshot = await knowledgeSnapshot(window)
    if (snapshot.sources.length === 2 && snapshot.permissions.length === 2) break
    await pause(180)
  }
  if (snapshot.sources.length !== 2 || snapshot.permissions.length !== 2) {
    throw new Error('合成个人笔记没有完成显式授权')
  }
  const knowledgeUiText = await window.webContents.executeJavaScript("document.querySelector('.knowledge-manager')?.innerText || ''")
  if (!knowledgeUiText.includes('focus-methods-demo') || !knowledgeUiText.includes('已切分')) {
    throw new Error('知识库界面没有显示导入与分块结果')
  }
  window.setSize(1440, 800)
  await pause(250)
  await capture(window, '0.8.0-demo-import-knowledge.png', '.knowledge-source-section.files')
  snapshot = await knowledgeSnapshot(window)

  const finalState = await window.webContents.executeJavaScript("JSON.parse(localStorage.getItem('xirang-state'))")
  const report = {
    checkedAt: new Date().toISOString(),
    previewBase,
    dataSpace: { kind: 'ephemeral-electron-partition', partition },
    backup: {
      file: path.relative(projectRoot, backupPath).replaceAll('\\', '/'),
      schemaVersion: finalState.schemaVersion,
      sessions: finalState.sessions.length,
      focusSessions: finalState.focusSessions.length,
      dailyPlans: finalState.dailyPlans.length,
      actionSlips: finalState.actionSlips.length,
      personalNotes: finalState.personalNotes.length,
      agentPlans: finalState.agentPlans.length,
    },
    knowledgeBase: {
      file: path.relative(projectRoot, knowledgePath).replaceAll('\\', '/'),
      databaseVersion: snapshot.databaseVersion,
      sources: snapshot.sources.length,
      permissions: snapshot.permissions.length,
      chunks: snapshot.chunks.length,
    },
    privacy: {
      status: 'passed',
      checks: ['Windows 用户目录', 'Windows 绝对路径', 'API Key', '电子邮箱', '中国大陆手机号'],
      findings,
    },
    screenshots: [
      'artifacts/0.8.0-demo-import-data.png',
      'artifacts/0.8.0-demo-import-knowledge.png',
    ],
    status: 'passed',
  }
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, '0.8.0-demo-import-walkthrough.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))

  await window.close()
  app.quit()
}).catch((error) => {
  console.error(`失败阶段：${currentStep}`)
  console.error(error)
  app.exit(1)
})
