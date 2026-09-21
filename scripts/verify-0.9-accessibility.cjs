const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const previewBase = process.argv[2] || null
const distIndex = path.resolve(__dirname, '..', 'dist', 'index.html')
let currentStep = '启动隔离验收'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

async function pause(milliseconds = 150) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function loadSettings(window) {
  if (previewBase) {
    await window.loadURL(`${previewBase.replace(/\/$/, '')}/#/settings`)
    return
  }
  await window.loadFile(distIndex, { hash: '/settings' })
}

async function waitFor(window, expression, label, timeoutMs = 8_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await pause()
  }
  throw new Error(`等待超时：${label}`)
}

async function activeElementSnapshot(window) {
  return window.webContents.executeJavaScript(`(() => {
    const element = document.activeElement
    return {
      tag: element?.tagName || '',
      text: element?.textContent?.trim() || '',
      ariaLabel: element?.getAttribute?.('aria-label') || '',
    }
  })()`)
}

async function openPreview(window, buttonText) {
  await window.webContents.executeJavaScript(`(() => {
    const article = [...document.querySelectorAll('.knowledge-note-list article')]
      .find((item) => item.textContent.includes('键盘验收资料'))
    const button = [...(article?.querySelectorAll('.knowledge-source-actions button') || [])]
      .find((item) => item.textContent.trim() === ${JSON.stringify(buttonText)})
    if (!button) throw new Error('找不到${buttonText}预览按钮')
    button.focus()
    button.click()
  })()`)
  await waitFor(window, "document.querySelector('.knowledge-preview[role=dialog]')", `${buttonText}对话框打开`)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1_280,
    height: 900,
    webPreferences: { partition: `qa-0.9-accessibility-${Date.now()}` },
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`渲染进程：${event.message}`)
  })

  try {
    currentStep = '准备隔离业务数据'
    await loadSettings(window)
    await window.webContents.executeJavaScript('localStorage.clear()')
    await window.reload()
    await waitFor(window, "localStorage.getItem('xirang-state')", '默认业务状态写入')
    await window.webContents.executeJavaScript(`(() => {
      const state = JSON.parse(localStorage.getItem('xirang-state'))
      state.profile.onboardingComplete = true
      state.personalNotes = [{
        id: 'qa-accessibility-note',
        title: '键盘验收资料',
        content: '这是一份只存在于隔离会话中的无障碍验收资料。',
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-21T00:00:00.000Z',
      }]
      localStorage.setItem('xirang-state', JSON.stringify(state))
    })()`)
    await window.reload()
    await waitFor(window, "document.querySelector('.knowledge-note-list article')", '知识库笔记加载')

    currentStep = '生成隔离知识来源'
    await window.webContents.executeJavaScript(`(() => {
      const article = [...document.querySelectorAll('.knowledge-note-list article')]
        .find((item) => item.textContent.includes('键盘验收资料'))
      const toggle = article?.querySelector('.toggle-switch')
      if (!toggle) throw new Error('找不到知识库授权开关')
      toggle.click()
    })()`)
    await waitFor(
      window,
      "[...document.querySelectorAll('.knowledge-note-list article')].some((item) => item.textContent.includes('键盘验收资料') && item.querySelector('.knowledge-source-actions'))",
      '知识来源完成处理',
    )

    currentStep = '验证原文对话框焦点'
    await openPreview(window, '原文')
    const initialSourceFocus = await activeElementSnapshot(window)
    if (initialSourceFocus.ariaLabel !== '关闭资料预览') {
      throw new Error(`原文对话框没有把焦点放到关闭按钮：${JSON.stringify(initialSourceFocus)}`)
    }
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }))`)
    const wrappedSourceFocus = await activeElementSnapshot(window)
    if (wrappedSourceFocus.text !== '关闭') throw new Error('原文对话框没有约束 Shift+Tab 焦点。')
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }))`)
    await waitFor(window, "!document.querySelector('.knowledge-preview[role=dialog]')", '原文对话框关闭')
    const restoredSourceFocus = await activeElementSnapshot(window)
    if (restoredSourceFocus.text !== '原文') throw new Error('关闭原文对话框后没有归还触发按钮焦点。')

    currentStep = '验证分块对话框焦点'
    await openPreview(window, '分块')
    const initialChunkFocus = await activeElementSnapshot(window)
    if (initialChunkFocus.ariaLabel !== '关闭文本块预览') {
      throw new Error(`分块对话框没有把焦点放到关闭按钮：${JSON.stringify(initialChunkFocus)}`)
    }
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }))`)
    await waitFor(window, "!document.querySelector('.knowledge-preview[role=dialog]')", '分块对话框关闭')
    const restoredChunkFocus = await activeElementSnapshot(window)
    if (restoredChunkFocus.text !== '分块') throw new Error('关闭分块对话框后没有归还触发按钮焦点。')

    currentStep = '验证未来版本数据只读保护'
    const futureRaw = JSON.stringify({ schemaVersion: 999, profile: { goal: 'work' }, sessions: [] })
    await window.webContents.executeJavaScript(`localStorage.setItem('xirang-state', ${JSON.stringify(futureRaw)})`)
    await window.reload()
    await waitFor(window, "document.querySelector('.storage-compatibility-alert[role=alert]')", '兼容性保护提示')
    const protection = await window.webContents.executeJavaScript(`({
      message: document.querySelector('.storage-compatibility-alert')?.textContent || '',
      raw: localStorage.getItem('xirang-state'),
    })`)
    if (!protection.message.includes('只读保护') || protection.raw !== futureRaw) {
      throw new Error('未来版本数据没有保持只读或提示不完整。')
    }

    console.log('0.9.0 accessibility and compatibility smoke passed.')
  } finally {
    window.destroy()
    app.quit()
  }
}).catch((error) => {
  console.error(`0.9.0 accessibility smoke failed at “${currentStep}”:`, error)
  app.exit(1)
})
