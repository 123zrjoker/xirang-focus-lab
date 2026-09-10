const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const previewBase = process.argv[2] || 'http://127.0.0.1:5173/'
const outputDirectory = path.resolve(__dirname, '..', 'artifacts')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

async function pause(ms = 250) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function capture(window, filename) {
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window.webContents.capturePage()
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, filename), image.toPNG())
}

async function setField(window, selector, value) {
  await window.webContents.executeJavaScript(`
    (() => {
      const field = document.querySelector(${JSON.stringify(selector)})
      if (!field) throw new Error('找不到输入字段：${selector}')
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)})
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })()
  `)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1050,
    webPreferences: { partition: `qa-notes-todos-${Date.now()}` },
  })

  await window.loadURL(`${previewBase}#/notes`)
  await window.webContents.executeJavaScript('localStorage.clear()')
  await window.reload()
  await pause(450)

  await window.webContents.executeJavaScript("document.querySelector('.notes-new-button').click()")
  await setField(window, '.note-composer input', '真实使用观察')
  await setField(window, '.note-composer textarea', '启动前最难的不是任务本身，而是不知道第一步要做到多小。\n\n下一次试着只要求自己打开文档。')
  await window.webContents.executeJavaScript("document.querySelector('.note-composer-footer .button.primary').click()")
  await pause()
  await window.webContents.executeJavaScript("document.querySelector('.notes-new-button').click()")
  await setField(window, '.note-composer input', '今天的一点发现')
  await setField(window, '.note-composer textarea', '短热身有帮助，但只在抗拒明显时使用。')
  await window.webContents.executeJavaScript("document.querySelector('.note-composer-footer .button.primary').click()")
  await pause()

  await window.webContents.executeJavaScript("[...document.querySelectorAll('.personal-note-card')].find((card) => card.textContent.includes('今天的一点发现')).querySelector('.personal-note-open').click()")
  await setField(window, '.note-composer textarea', '短热身有帮助，但只在抗拒明显时使用。\n这条内容已经完成编辑。')
  await window.webContents.executeJavaScript("document.querySelector('.note-composer-footer .button.primary').click()")
  await pause()
  await setField(window, '.notes-search-field input', '启动前')
  await pause()
  const filteredNotes = await window.webContents.executeJavaScript("document.querySelectorAll('.personal-note-card').length")
  if (filteredNotes !== 1) throw new Error(`笔记搜索结果不正确，实际为 ${filteredNotes}`)
  await setField(window, '.notes-search-field input', '')
  await pause()

  const notesText = await window.webContents.executeJavaScript('document.body.innerText')
  if (!notesText.includes('真实使用观察') || !notesText.includes('这条内容已经完成编辑')) throw new Error('笔记没有正确保存、编辑或渲染')
  await capture(window, 'notes-todos-notes-desktop.png')

  await window.reload()
  await pause(400)
  const restoredNotes = await window.webContents.executeJavaScript("JSON.parse(localStorage.getItem('xirang-state')).personalNotes.length")
  if (restoredNotes !== 2) throw new Error(`刷新后笔记恢复失败，实际为 ${restoredNotes}`)

  await window.webContents.executeJavaScript("document.querySelectorAll('.notes-section-switch > button')[1].click()")
  await pause()
  await setField(window, '#notes-capture-input', '整理明天会议需要的材料')
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.todo-capture button')].find((button) => button.textContent.includes('加入待办')).click()")
  await pause()
  await setField(window, '#notes-capture-input', '阅读第三阶段使用反馈')
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.todo-capture button')].find((button) => button.textContent.includes('加入待办')).click()")
  await pause()

  const todoText = await window.webContents.executeJavaScript('document.body.innerText')
  const schemaVersion = await window.webContents.executeJavaScript("JSON.parse(localStorage.getItem('xirang-state')).schemaVersion")
  if (!todoText.includes('整理明天会议需要的材料') || schemaVersion !== 10) throw new Error('待办没有正确保存，或数据未升级到 v10')

  await window.webContents.executeJavaScript("[...document.querySelectorAll('.todo-row')].find((row) => row.textContent.includes('整理明天会议需要的材料')).querySelector('.todo-check').click()")
  await pause()
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.todo-list-toolbar > div button')].find((button) => button.textContent.includes('已完成')).click()")
  await pause()
  const completedVisible = await window.webContents.executeJavaScript("document.querySelector('.todo-list').textContent.includes('整理明天会议需要的材料')")
  if (!completedVisible) throw new Error('待办勾选完成后没有进入已完成列表')
  await window.webContents.executeJavaScript("document.querySelector('.todo-row .todo-check.checked').click()")
  await pause()
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.todo-list-toolbar > div button')].find((button) => button.textContent.includes('待处理')).click()")
  await pause()
  await capture(window, 'notes-todos-todos-desktop.png')

  await window.webContents.executeJavaScript("[...document.querySelectorAll('.todo-row')].find((row) => row.textContent.includes('阅读第三阶段使用反馈')).querySelector('.todo-actions button.primary').click()")
  await pause(350)
  const focusTask = await window.webContents.executeJavaScript("document.querySelector('.goal-input')?.value")
  const currentTodo = await window.webContents.executeJavaScript("JSON.parse(localStorage.getItem('xirang-state')).actionSlips.find((item) => item.status === 'current')?.title")
  if (focusTask !== '阅读第三阶段使用反馈' || currentTodo !== focusTask) throw new Error('待办没有正确进入现实专注并设为当前行动')

  await window.loadURL(`${previewBase}#/notes`)
  await pause(400)
  await window.webContents.executeJavaScript("document.querySelectorAll('.notes-section-switch > button')[1].click()")
  await pause()
  await setField(window, '#notes-capture-input', '把反馈拆成一个能开始的动作')
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.todo-capture button')].find((button) => button.textContent.includes('加入待办')).click()")
  await pause()
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.todo-row')].find((row) => row.textContent.includes('把反馈拆成一个能开始的动作')).querySelectorAll('.todo-actions button')[1].click()")
  await pause(350)
  const launchTask = await window.webContents.executeJavaScript("document.querySelector('.launch-detail-form label:nth-child(1) input')?.value")
  if (launchTask !== '把反馈拆成一个能开始的动作') throw new Error('待办没有正确带入启动舱')

  await window.loadURL(`${previewBase}#/today`)
  await pause(400)
  const todayText = await window.webContents.executeJavaScript('document.body.innerText')
  if (!todayText.includes('便签 · 笔记与待办') || !todayText.includes('笔记 2') || !todayText.includes('待办 3')) throw new Error('今日页没有同时展示笔记和待办状态')
  await capture(window, 'notes-todos-today-desktop.png')

  await window.loadURL(`${previewBase}#/notes`)
  await pause(350)
  await window.webContents.executeJavaScript("document.querySelectorAll('.notes-section-switch > button')[1].click()")
  await pause()

  window.setSize(430, 900)
  await pause(300)
  await capture(window, 'notes-todos-todos-mobile.png')
  await window.webContents.executeJavaScript("document.querySelectorAll('.notes-section-switch > button')[0].click()")
  await pause()
  await capture(window, 'notes-todos-notes-mobile.png')

  await window.close()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
