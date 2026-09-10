const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const previewBase = process.argv[2] || 'http://127.0.0.1:5173/'
const outputDirectory = path.resolve(__dirname, '..', 'artifacts')

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

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1100,
    webPreferences: { partition: `qa-action-insights-${Date.now()}` },
  })

  await window.loadURL(`${previewBase}#/progress`)
  await window.webContents.executeJavaScript('localStorage.clear()')
  await window.reload()
  await pause(400)

  await window.webContents.executeJavaScript(`
    (() => {
      const state = JSON.parse(localStorage.getItem('xirang-state'))
      const ago = (days, hour = 9) => {
        const date = new Date()
        date.setDate(date.getDate() - days)
        date.setHours(hour, 0, 0, 0)
        return date.toISOString()
      }
      state.profile.onboardingComplete = true
      state.actionSlips = [
        { id: 'todo-1', title: '完成研究方法部分初稿', status: 'current', createdAt: ago(1), updatedAt: ago(0), focusSessionIds: ['focus-1', 'focus-2'] },
        { id: 'todo-2', title: '整理访谈记录', status: 'completed', createdAt: ago(2), updatedAt: ago(1), completedAt: ago(1), focusSessionIds: ['focus-3'] },
        { id: 'todo-3', title: '检查图表数据', status: 'completed', createdAt: ago(3), updatedAt: ago(2), completedAt: ago(2), focusSessionIds: ['focus-4'] },
        { id: 'todo-4', title: '阅读第三阶段使用反馈', status: 'inbox', createdAt: ago(4), updatedAt: ago(4), focusSessionIds: [] },
        { id: 'todo-5', title: '确定下一轮测试范围', status: 'completed', createdAt: ago(5), updatedAt: ago(3), completedAt: ago(3), focusSessionIds: ['focus-5', 'focus-6'] },
        { id: 'todo-stalled', title: '重新整理资料目录', status: 'inbox', createdAt: ago(15), updatedAt: ago(15), focusSessionIds: [] },
      ]
      const specs = [
        ['focus-1', 'todo-1', 1, 72, 2, '复核研究问题与小标题', 'launch-1', ['phone', 'phone']],
        ['focus-2', 'todo-1', 2, 64, 1, '', null, ['difficulty']],
        ['focus-3', 'todo-2', 1, 90, 0, '标出需要补充确认的两处', 'launch-3', []],
        ['focus-4', 'todo-3', 2, 85, 1, '核对图 3 的来源', null, ['environment']],
        ['focus-5', 'todo-5', 3, 78, 2, '写下三条验收标准', 'launch-5', ['phone', 'fatigue']],
        ['focus-6', 'todo-5', 5, 100, 0, '安排第一次可用性测试', null, []],
        ['focus-7', null, 11, 60, 2, '', 'launch-7', ['difficulty', 'fatigue']],
        ['focus-8', null, 18, 75, 1, '继续完善交互文案', null, ['phone']],
      ]
      state.focusSessions = specs.map(([id, actionSlipId, days, completionRate, distractionCount, nextStep, launchId, reasons], index) => ({
        id,
        taskName: actionSlipId ? state.actionSlips.find((item) => item.id === actionSlipId).title : index === 6 ? '梳理版本计划' : '完善交互文案',
        plannedDurationMin: 25,
        actualDurationSec: 1200 + index * 90,
        completionRate,
        distractionCount,
        pageLeaveCount: 0,
        subjectiveFocus: index % 3 + 3,
        endReason: 'completed',
        distractions: reasons.map((reason, reasonIndex) => ({ id: id + '-d-' + reasonIndex, note: '', reason, createdAt: ago(days, 9) })),
        round: 1,
        focusMode: 'free',
        pomodoroCycle: 1,
        completedAt: ago(days, 10),
        ...(actionSlipId ? { actionSlipId } : {}),
        ...(launchId ? { launchId } : {}),
        ...(nextStep ? { nextStep } : {}),
      }))
      state.focusLaunches = specs.filter((item) => item[6]).map(([id, actionSlipId, days, , , , launchId], index) => ({
        id: launchId,
        mode: 'known-task',
        status: 'completed',
        createdAt: ago(days, 9),
        updatedAt: ago(days, 10),
        completedAt: ago(days, 10),
        candidates: [],
        taskName: actionSlipId ? state.actionSlips.find((item) => item.id === actionSlipId).title : '梳理版本计划',
        taskCategory: 'writing',
        firstAction: '打开当前文档',
        completionDefinition: '完成一个可以检查的小段落',
        plannedDurationMin: 25,
        energyBefore: 2,
        resistanceBefore: [3, 1, 2, 2][index],
        warmupType: 'visual',
        focusSessionId: id,
        ...(actionSlipId ? { actionSlipId } : {}),
      }))
      localStorage.setItem('xirang-state', JSON.stringify(state))
    })()
  `)
  await window.reload()
  await pause(500)

  const sevenDayText = await window.webContents.executeJavaScript("document.querySelector('.action-insights')?.innerText || ''")
  if (!sevenDayText.includes('行动洞察') || !sevenDayText.includes('初步观察') || !sevenDayText.includes('手机')) {
    throw new Error('近 7 天行动洞察没有按预期渲染')
  }
  const sevenDayCards = await window.webContents.executeJavaScript("document.querySelectorAll('.action-insight-metrics article').length")
  if (sevenDayCards !== 4) throw new Error(`行动指标卡数量不正确：${sevenDayCards}`)

  await window.webContents.executeJavaScript("document.querySelector('.action-insights').scrollIntoView({ block: 'start' })")
  await pause()
  await capture(window, '0.3.3-action-insights-desktop.png')

  await window.webContents.executeJavaScript("document.querySelectorAll('.progress-range-switch button')[1].click()")
  await pause()
  const thirtyDayText = await window.webContents.executeJavaScript("document.querySelector('.action-insights')?.innerText || ''")
  if (!thirtyDayText.includes('近 30 天') || !thirtyDayText.includes('8 次现实专注')) throw new Error('时间范围切换没有更新行动洞察')

  window.setSize(430, 900)
  await pause(350)
  await window.webContents.executeJavaScript("document.querySelector('.action-insights').scrollIntoView({ block: 'start' })")
  await pause()
  const horizontalOverflow = await window.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth')
  if (horizontalOverflow) throw new Error('手机端行动洞察出现横向溢出')
  await capture(window, '0.3.3-action-insights-mobile.png')

  await window.close()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
