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

  currentStep = '使用模拟只读结果生成计划'
  await window.webContents.executeJavaScript(`(() => {
    const originalFetch = window.fetch.bind(window)
    const previewedSnapshot = JSON.parse(document.querySelector('.agent-snapshot-preview pre').textContent)
    window.fetch = async (input, init) => {
      if (String(input) !== '/api/agent/plan') return originalFetch(input, init)
      const body = JSON.parse(init.body)
      if (JSON.stringify(body.context) !== JSON.stringify(previewedSnapshot)) {
        throw new Error('发送的快照与预览不一致')
      }
      return new Response(JSON.stringify({
        schemaVersion: 1,
        graphVersion: '0.5.0-read-only-v1',
        threadId: 'qa-thread-agent-context',
        runId: 'qa-run-agent-context',
        status: 'completed',
        planDraft: {
          title: '未来 7 天行动计划',
          summary: '根据本次明确授权的未完成待办与专注摘要生成；这是只读草案。',
          items: [
            {
              title: '完成 Agent 核心契约', firstStep: '补齐接口测试并运行回归。',
              completionCriteria: '新增测试通过且没有破坏既有行为。', estimatedMinutes: 30,
              rationale: '来自当前待办与明确记录的下一步。', sourceActionSlipIds: ['agent-current'], evidenceRefs: []
            },
            {
              title: '整理周计划演示数据', firstStep: '准备一组不含私人正文的合成待办。',
              completionCriteria: '演示数据能覆盖工具选择与计划生成。', estimatedMinutes: 25,
              rationale: '来自本次授权的收件箱待办。', sourceActionSlipIds: ['agent-inbox'], evidenceRefs: []
            },
            {
              title: '做一次移动端复查', firstStep: '以 430 像素宽度检查结果卡片。',
              completionCriteria: '页面没有横向溢出，计划信息可完整阅读。', estimatedMinutes: 15,
              rationale: '用于验证当前只读结果界面。', sourceActionSlipIds: [], evidenceRefs: []
            }
          ],
          assumptions: ['当前版本不会保存计划或修改待办。'],
          evidenceRefs: []
        },
        evidence: [],
        toolResults: [
          { callId: 'qa-todos', name: 'query_todos', status: 'success', output: {}, error: null, durationMs: 1 },
          { callId: 'qa-focus', name: 'query_focus_summary', status: 'success', output: {}, error: null, durationMs: 1 }
        ],
        validationErrors: [],
        trace: []
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })()`)
  await window.webContents.executeJavaScript("document.querySelector('.agent-run-button').click()")
  await waitFor(window, "document.querySelector('.agent-plan-result.completed')", '计划结果')
  const planResult = await window.webContents.executeJavaScript(`(() => ({
    text: document.querySelector('.agent-plan-result')?.innerText || '',
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))()`)
  if (!planResult.text.includes('契约校验通过') || !planResult.text.includes('当前版本没有保存或执行按钮')) {
    throw new Error(`计划结果内容不完整：${planResult.text}`)
  }
  if (planResult.overflow) throw new Error('桌面端计划结果出现横向溢出')

  currentStep = '截取桌面端计划结果'
  await window.webContents.executeJavaScript("document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.querySelector('.agent-plan-result').getBoundingClientRect().top + window.scrollY - 110)")
  await pause(300)
  await capture(window, '0.5.0-agent-plan-result-desktop.png')

  currentStep = '验证并截取移动端计划结果'
  window.setSize(430, 900)
  await pause(350)
  await window.webContents.executeJavaScript("window.scrollTo(0, document.querySelector('.agent-plan-result').getBoundingClientRect().top + window.scrollY - 68)")
  await pause(300)
  if (await window.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth')) {
    throw new Error('移动端计划结果出现横向溢出')
  }
  await capture(window, '0.5.0-agent-plan-result-mobile.png')

  console.log('0.5.0 行动上下文与只读计划结果验收通过')
  await window.close()
  app.quit()
}).catch((error) => {
  console.error(`失败阶段：${currentStep}`)
  console.error(error)
  app.exit(1)
})
