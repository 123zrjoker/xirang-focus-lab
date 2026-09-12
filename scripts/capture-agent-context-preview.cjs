const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const previewBase = process.argv[2] || 'http://127.0.0.1:5173/'
const outputDirectory = path.resolve(__dirname, '..', 'artifacts')
let currentStep = '启动行动上下文预览验收'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

function pause(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(window, expression, label, timeoutMs = 8_000) {
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

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1100,
    webPreferences: { partition: `qa-agent-context-${Date.now()}` },
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`渲染进程：${event.message}`)
  })

  currentStep = '加载并准备今日页数据'
  await window.loadURL(`${previewBase}#/today`)
  await pause(350)
  await window.webContents.executeJavaScript(`(() => {
    const state = JSON.parse(localStorage.getItem('xirang-state'))
    state.profile.onboardingComplete = true
    state.profile.goal = 'work'
    state.profile.dailyTargetMinutes = 30
    state.profile.preferredFocusMinutes = 25
    state.actionSlips = [
      {
        id: 'agent-current', title: '完成 0.5.0 Agent 契约', status: 'current',
        createdAt: '2026-09-10T08:00:00.000Z', updatedAt: '2026-09-12T08:00:00.000Z',
        nextStep: '先跑通只读状态图测试', focusSessionIds: []
      },
      {
        id: 'agent-inbox', title: '整理周计划演示数据', status: 'inbox',
        createdAt: '2026-09-11T08:00:00.000Z', updatedAt: '2026-09-11T08:00:00.000Z',
        focusSessionIds: []
      }
    ]
    state.focusSessions = [{
      id: 'focus-agent', taskName: 'Agent Foundation', plannedDurationMin: 25, actualDurationSec: 1500,
      completionRate: 88, distractionCount: 1, pageLeaveCount: 0, subjectiveFocus: 4,
      endReason: 'completed', distractions: [{
        id: 'private-note', note: '这段原始分心备注不能进入快照', reason: 'phone', createdAt: new Date().toISOString()
      }], round: 1, focusMode: 'free', pomodoroCycle: 1, completedAt: new Date().toISOString()
    }]
    localStorage.setItem('xirang-state', JSON.stringify(state))
  })()`)
  await window.reload()
  await waitFor(window, "document.querySelector('.agent-context-card')", '行动上下文卡片')

  currentStep = '生成快照并验证隐私边界'
  await window.webContents.executeJavaScript("document.querySelector('.agent-preview-button').click()")
  await waitFor(window, "document.querySelector('.agent-snapshot-preview')", '快照预览')
  const result = await window.webContents.executeJavaScript(`(() => ({
    text: document.querySelector('.agent-snapshot-preview')?.innerText || '',
    json: document.querySelector('.agent-snapshot-preview pre')?.innerText || '',
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))()`)
  if (!result.text.includes('完成 0.5.0 Agent 契约') || !result.text.includes('状态修订号')) {
    throw new Error(`快照预览内容不完整：${result.text}`)
  }
  if (result.json.includes('这段原始分心备注不能进入快照')) {
    throw new Error('快照泄露了原始分心备注')
  }
  if (result.overflow) throw new Error('桌面端行动上下文卡片出现横向溢出')

  currentStep = '截取桌面端预览'
  await window.webContents.executeJavaScript("document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.querySelector('.agent-context-card').getBoundingClientRect().top + window.scrollY - 110)")
  await pause(300)
  await capture(window, '0.5.0-agent-context-preview-desktop.png')

  currentStep = '验证并截取移动端预览'
  window.setSize(430, 900)
  await pause(350)
  await window.webContents.executeJavaScript("window.scrollTo(0, document.querySelector('.agent-context-card').getBoundingClientRect().top + window.scrollY - 68)")
  await pause(300)
  if (await window.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth')) {
    throw new Error('移动端行动上下文卡片出现横向溢出')
  }
  await capture(window, '0.5.0-agent-context-preview-mobile.png')

  console.log('0.5.0 行动上下文发送前预览验收通过')
  await window.close()
  app.quit()
}).catch((error) => {
  console.error(`失败阶段：${currentStep}`)
  console.error(error)
  app.exit(1)
})
