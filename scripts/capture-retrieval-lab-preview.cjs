const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const previewBase = process.argv[2] || 'http://127.0.0.1:5173/'
const outputDirectory = path.resolve(__dirname, '..', 'artifacts')
let currentStep = '启动检索实验台验收'

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

async function capture(window, filename) {
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window.webContents.capturePage()
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, filename), image.toPNG())
}

async function clearKnowledgeDatabase(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('xirang-knowledge-base')
    request.onsuccess = () => resolve(true)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('知识库数据库删除被阻塞'))
  })`)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1100,
    webPreferences: { partition: `qa-retrieval-lab-${Date.now()}` },
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`渲染进程：${event.message}`)
  })

  currentStep = '加载并初始化设置页'
  await window.loadURL(`${previewBase}#/settings`)
  await pause(450)
  await window.webContents.executeJavaScript('localStorage.clear()')
  await clearKnowledgeDatabase(window)
  await window.reload()
  await pause(450)
  await window.webContents.executeJavaScript(`(() => {
    const state = JSON.parse(localStorage.getItem('xirang-state'))
    state.profile.onboardingComplete = true
    state.personalNotes = [
      {
        id: 'note-distraction',
        title: '减少手机分心',
        content: '开始专注前，把手机调成静音并放到看不见的位置。出现无关念头时先记录到分心停车场，不要立即切换任务。',
        createdAt: '2026-09-09T08:00:00.000Z',
        updatedAt: '2026-09-09T08:00:00.000Z'
      },
      {
        id: 'note-start',
        title: '低阻力启动',
        content: '遇到抗拒的任务时，先把任务缩小成一个可以立刻执行的动作，例如只打开文档并写下标题。',
        createdAt: '2026-09-09T08:10:00.000Z',
        updatedAt: '2026-09-09T08:10:00.000Z'
      }
    ]
    localStorage.setItem('xirang-state', JSON.stringify(state))
  })()`)
  await window.reload()

  currentStep = '等待本机检索服务'
  await waitFor(window, "document.querySelector('.retrieval-service-badge.ready')?.textContent.includes('已连接')", '检索服务连接')

  currentStep = '授权两篇测试笔记'
  for (const title of ['减少手机分心', '低阻力启动']) {
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.knowledge-note-list article')].find((item) => item.textContent.includes(${JSON.stringify(title)})).querySelector('.toggle-switch').click()`)
    await waitFor(window, `[...document.querySelectorAll('.knowledge-note-list article')].find((item) => item.textContent.includes(${JSON.stringify(title)}))?.querySelector('.knowledge-status')?.textContent.includes('已切分')`, `${title} 分块`)
  }
  await waitFor(window, "[...document.querySelectorAll('.knowledge-note-list .toggle-switch')].every((item) => !item.disabled)", '知识来源保存完成')

  currentStep = '构建本地向量索引'
  await window.webContents.executeJavaScript("document.querySelector('.retrieval-index-actions .button.secondary').click()")
  await waitFor(window, "document.querySelector('.retrieval-index-mark.ready') && document.querySelector('.retrieval-index-panel')?.textContent.includes('本地向量索引 ·')", '向量索引构建', 120000)

  currentStep = '切换混合重排模式'
  await window.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('.retrieval-mode select')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'hybrid_rerank')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)

  currentStep = '运行混合重排检索'
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.retrieval-query-form input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '如何减少专注时的手机分心？')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await pause(120)
  await window.webContents.executeJavaScript("document.querySelector('.retrieval-query-form button[type=submit]').click()")
  await waitFor(window, "document.querySelectorAll('.retrieval-result-list article').length > 0", '检索结果', 30000)
  const result = await window.webContents.executeJavaScript(`(() => ({
    first: document.querySelector('.retrieval-result-list article')?.innerText || '',
    metrics: document.querySelector('.retrieval-metrics')?.innerText || '',
    records: [...document.querySelectorAll('.knowledge-storage-metrics > span')].find((item) => item.textContent.includes('检索记录'))?.innerText || ''
  }))()`)
  if (!result.first.includes('减少手机分心') || !result.first.includes('RRF') || !result.first.includes('重排') || !result.first.includes('手机')) {
    throw new Error(`首条检索结果或分数解释不正确：${result.first}`)
  }
  if (!result.metrics.includes('服务端耗时') || !result.records.includes('1')) {
    throw new Error('检索耗时或本地检索记录没有正确显示')
  }

  currentStep = '检查桌面端布局'
  await window.webContents.executeJavaScript("document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.querySelector('.knowledge-retrieval-lab').offsetTop - 100)")
  await pause(300)
  if (await window.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth')) {
    throw new Error('桌面端检索实验台出现横向溢出')
  }
  await capture(window, '0.4.3-hybrid-retrieval-desktop.png')

  currentStep = '检查移动端布局'
  window.setSize(430, 900)
  await pause(350)
  await window.webContents.executeJavaScript("window.scrollTo(0, document.querySelector('.knowledge-retrieval-lab').offsetTop - 72)")
  await pause(300)
  if (await window.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth')) {
    throw new Error('移动端检索实验台出现横向溢出')
  }
  await capture(window, '0.4.3-hybrid-retrieval-mobile.png')

  currentStep = '清理验收向量索引'
  await window.webContents.executeJavaScript("fetch('/api/index', { method: 'DELETE' }).then((response) => { if (!response.ok) throw new Error('清理失败') })")
  console.log('0.4.3 混合检索实验台端到端验收通过')
  await window.close()
  app.quit()
}).catch((error) => {
  console.error(`失败阶段：${currentStep}`)
  console.error(error)
  app.exit(1)
})
