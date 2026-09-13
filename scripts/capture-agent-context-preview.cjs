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
        id: 'agent-current', title: '完成 0.5.1 状态恢复', status: 'current',
        createdAt: '2026-09-10T08:00:00.000Z', updatedAt: '2026-09-12T08:00:00.000Z',
        nextStep: '先跑通持久中断与恢复测试', focusSessionIds: []
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
  if (!result.text.includes('完成 0.5.1 状态恢复') || !result.text.includes('状态修订号')) {
    throw new Error(`快照预览内容不完整：${result.text}`)
  }
  if (result.json.includes('这段原始分心备注不能进入快照')) {
    throw new Error('快照泄露了原始分心备注')
  }
  if (result.overflow) throw new Error('桌面端行动上下文卡片出现横向溢出')

  currentStep = '使用模拟 SSE 生成等待审批的计划'
  await window.webContents.executeJavaScript(`(() => {
    const originalFetch = window.fetch.bind(window)
    const previewedSnapshot = JSON.parse(document.querySelector('.agent-snapshot-preview pre').textContent)
    const initialPlan = {
      title: '未来 7 天行动计划',
      summary: '根据本次明确授权的未完成待办与专注摘要生成；批准前不会写入。',
      items: [
        {
          title: '完成 Agent 状态恢复', firstStep: '补齐重启恢复测试并运行回归。',
          completionCriteria: '重启服务后仍能恢复审批状态。', estimatedMinutes: 30,
          rationale: '来自当前待办与明确记录的下一步。', sourceActionSlipIds: ['agent-current'], evidenceRefs: []
        },
        {
          title: '整理周计划演示数据', firstStep: '准备一组不含私人正文的合成待办。',
          completionCriteria: '演示数据能覆盖审批与幂等写入。', estimatedMinutes: 25,
          rationale: '来自本次授权的收件箱待办。', sourceActionSlipIds: ['agent-inbox'], evidenceRefs: []
        },
        {
          title: '做一次移动端复查', firstStep: '以 430 像素宽度检查批准面板。',
          completionCriteria: '页面没有横向溢出，按钮可完整操作。', estimatedMinutes: 15,
          rationale: '用于验证当前批准结果界面。', sourceActionSlipIds: [], evidenceRefs: []
        }
      ],
      assumptions: ['只有明确批准的操作才会写入本机。'],
      evidenceRefs: []
    }
    let approvedPlan = initialPlan
    const result = (threadId, status, extra = {}) => ({
      schemaVersion: 1,
      graphVersion: '0.5.1-stateful-v1',
      threadId,
      runId: 'qa-run-agent-context',
      status,
      planDraft: approvedPlan,
      evidence: [],
      toolResults: [
        { callId: 'qa-todos', name: 'query_todos', status: 'success', output: {}, error: null, durationMs: 1 },
        { callId: 'qa-focus', name: 'query_focus_summary', status: 'success', output: {}, error: null, durationMs: 1 }
      ],
      validationErrors: [],
      approvalDecision: null,
      mutationIntents: [],
      executionAck: null,
      trace: [],
      ...extra,
    })
    window.fetch = async (input, init) => {
      const url = String(input)
      if (url === '/api/agent/plan/stream') {
        const body = JSON.parse(init.body)
        if (JSON.stringify(body.context) !== JSON.stringify(previewedSnapshot)) {
          throw new Error('发送的快照与预览不一致')
        }
        const paused = result(body.threadId, 'awaiting_approval')
        const stream = [
          'event: progress\\ndata: {"node":"load_user_context","status":"planning","label":"正在校验本次行动快照"}\\n\\n',
          'event: progress\\ndata: {"node":"planner","status":"planning","label":"DeepSeek 正在生成计划"}\\n\\n',
          'event: progress\\ndata: {"node":"human_approval","status":"awaiting_approval","label":"等待你的批准、修改或拒绝"}\\n\\n',
          'event: result\\ndata: ' + JSON.stringify(paused) + '\\n\\n'
        ].join('')
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.endsWith('/resume/stream')) {
        const body = JSON.parse(init.body)
        if (body.decision.decision !== 'modify' || body.decision.modifiedPlan.items[0].title !== '完成恢复与审批验收'
          || !body.decision.operations.includes('save_plan') || !body.decision.operations.includes('start_focus')) {
          throw new Error('修改后的计划没有按契约提交')
        }
        approvedPlan = body.decision.modifiedPlan
        const threadId = url.split('/')[4]
        const intent = {
          actionId: 'agent-qa-save-action-00000001', toolName: 'save_plan',
          arguments: { threadId, runId: 'qa-run-agent-context', plan: approvedPlan },
          baseStateRevision: previewedSnapshot.baseStateRevision, riskLevel: 'commit', status: 'proposed'
        }
        const focusIntent = {
          actionId: 'agent-qa-focus-action-0000001', toolName: 'start_focus',
          arguments: {
            taskName: approvedPlan.items[0].title, minutes: approvedPlan.items[0].estimatedMinutes,
            firstStep: approvedPlan.items[0].firstStep,
            completionCriteria: approvedPlan.items[0].completionCriteria,
            actionSlipId: approvedPlan.items[0].sourceActionSlipIds[0]
          },
          baseStateRevision: previewedSnapshot.baseStateRevision, riskLevel: 'commit', status: 'proposed'
        }
        const resumed = result(threadId, 'awaiting_execution', {
          approvalDecision: body.decision,
          mutationIntents: [intent, focusIntent],
        })
        const stream = 'event: progress\\ndata: {"node":"build_mutation_intents","status":"awaiting_execution","label":"正在生成幂等写入意图"}\\n\\n'
          + 'event: result\\ndata: ' + JSON.stringify(resumed) + '\\n\\n'
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.endsWith('/ack/stream')) {
        const body = JSON.parse(init.body)
        if (body.executionAck.items.length !== 2 || body.executionAck.items.some((item) => item.status !== 'applied')
          || body.executionAck.observedStateRevision !== previewedSnapshot.baseStateRevision) {
          throw new Error('本地执行确认不符合契约')
        }
        const threadId = url.split('/')[4]
        const completed = result(threadId, 'completed', {
          approvalDecision: { decision: 'modify', operations: ['save_plan', 'start_focus'], modifiedPlan: approvedPlan },
          executionAck: body.executionAck,
        })
        const stream = 'event: progress\\ndata: {"node":"await_client_commit","status":"completed","label":"服务端已确认执行结果"}\\n\\n'
          + 'event: result\\ndata: ' + JSON.stringify(completed) + '\\n\\n'
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return originalFetch(input, init)
    }
  })()`)
  await window.webContents.executeJavaScript("document.querySelector('.agent-run-button').click()")
  await waitFor(window, "document.querySelector('.agent-plan-result.awaiting_approval')", '等待审批的计划结果')
  const approvalText = await window.webContents.executeJavaScript("document.querySelector('.agent-approval-panel')?.innerText || ''")
  if (!approvalText.includes('拒绝计划') || !approvalText.includes('修改计划') || !approvalText.includes('同意并执行')) {
    throw new Error(`审批操作不完整：${approvalText}`)
  }
  await window.webContents.executeJavaScript("document.querySelectorAll('.agent-operation-options input')[1].click()")
  await waitFor(window, "document.querySelectorAll('.agent-operation-options input')[1].checked", '勾选启动专注')
  currentStep = '截取桌面端审批界面'
  await window.webContents.executeJavaScript(`(() => {
    document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important')
    document.body.style.setProperty('scroll-behavior', 'auto', 'important')
    const target = document.querySelector('.agent-approval-panel')
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 100)
  })()`)
  await waitFor(window, 'window.scrollY > 500', '滚动到桌面端审批界面')
  if (await window.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth')) {
    throw new Error('桌面端审批界面出现横向溢出')
  }
  await capture(window, '0.5.1-agent-approval-desktop.png')

  currentStep = '修改并批准计划后保存到本机'
  await window.webContents.executeJavaScript(`(() => {
    const edit = [...document.querySelectorAll('.agent-approval-actions button')].find((button) => button.textContent.includes('修改计划'))
    edit.click()
  })()`)
  await waitFor(window, "document.querySelector('.agent-plan-item-editor input')", '计划编辑器')
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.agent-plan-item-editor input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '完成恢复与审批验收')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const approve = [...document.querySelectorAll('.agent-approval-actions button')].find((button) => button.textContent.includes('批准修改版'))
    approve.click()
  })()`)
  await waitFor(window, "document.querySelector('.focus-preparation') && localStorage.getItem('xirang-active-focus-v1')", '保存计划并启动专注')
  const planResult = await window.webContents.executeJavaScript(`(() => {
    const activeFocus = JSON.parse(localStorage.getItem('xirang-active-focus-v1'))
    const savedState = JSON.parse(localStorage.getItem('xirang-state'))
    return {
    text: document.querySelector('.focus-preparation')?.innerText || '',
    activeFocus,
    savedPlan: savedState.agentPlans?.at(-1),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  })()`)
  if (!planResult.text.includes('完成恢复与审批验收') || planResult.activeFocus.status !== 'preparing'
    || planResult.activeFocus.firstAction !== '补齐重启恢复测试并运行回归。'
    || planResult.savedPlan.title !== '未来 7 天行动计划') {
    throw new Error(`批准后的保存或专注启动不完整：${JSON.stringify(planResult)}`)
  }
  if (planResult.overflow) throw new Error('批准后的专注页面出现横向溢出')

  currentStep = '验证并截取移动端计划结果'
  window.setSize(430, 900)
  await pause(350)
  await window.webContents.executeJavaScript("window.scrollTo(0, 0)")
  await pause(300)
  if (await window.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth')) {
    throw new Error('移动端批准后专注页面出现横向溢出')
  }
  await capture(window, '0.5.1-agent-approved-focus-mobile.png')

  console.log('0.5.1 持久审批、修改计划与幂等保存验收通过')
  await window.close()
  app.quit()
}).catch((error) => {
  console.error(`失败阶段：${currentStep}`)
  console.error(error)
  app.exit(1)
})
