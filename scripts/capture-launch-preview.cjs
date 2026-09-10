const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const previewUrl = process.argv[2] || 'http://127.0.0.1:5173/#/launch'
const outputDirectory = path.resolve(__dirname, '..', 'artifacts')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

async function capture(window, filename) {
  const image = await window.webContents.capturePage()
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, filename), image.toPNG())
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: { partition: `qa-preview-${Date.now()}` },
  })
  await window.loadURL(previewUrl)
  await new Promise((resolve) => setTimeout(resolve, 800))
  const entryText = await window.webContents.executeJavaScript('document.body.innerText')
  if (!entryText.includes('专注启动舱') || !entryText.includes('我知道要做什么')) throw new Error('启动舱入口没有正确渲染')
  await capture(window, '0.3.0-launch-entry.png')

  await window.webContents.executeJavaScript("document.querySelector('.launch-mode-card.known')?.click()")
  await new Promise((resolve) => setTimeout(resolve, 500))
  const detailText = await window.webContents.executeJavaScript('document.body.innerText')
  if (!detailText.includes('第一个可以立刻执行的动作')) throw new Error('明确任务详情页没有正确渲染')
  await capture(window, '0.3.0-launch-known-task.png')

  await window.webContents.executeJavaScript(`
    (() => {
      const setInput = (selector, value) => {
        const input = document.querySelector(selector)
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setInput('.launch-detail-form label:nth-child(1) input', '修改明天要交的报告')
      setInput('.launch-detail-form label:nth-child(3) input', '打开报告文档，找到结论部分')
      setInput('.launch-detail-form label:nth-child(4) input', '改完结论部分的前三段')
    })()
  `)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await window.webContents.executeJavaScript("document.querySelector('.launch-detail-settings .button.primary')?.click()")
  await new Promise((resolve) => setTimeout(resolve, 300))
  const readyText = await window.webContents.executeJavaScript('document.body.innerText')
  if (!readyText.includes('准备进入现实专注') || !readyText.includes('打开报告文档，找到结论部分')) throw new Error('启动建议页没有保留任务上下文')
  await capture(window, '0.3.0-launch-ready.png')

  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('.launch-ready-actions button')].find((button) => button.textContent.includes('直接开始'))?.click()
  `)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const focusText = await window.webContents.executeJavaScript('document.body.innerText')
  if (!focusText.includes('现实专注室') || !focusText.includes('打开报告文档，找到结论部分')) throw new Error('现实专注页没有收到启动上下文')
  await capture(window, '0.3.0-launch-focus-setup.png')

  await window.webContents.executeJavaScript('localStorage.clear()')
  const [previewBase, previewHash = '/launch'] = previewUrl.split('#')
  await window.loadURL(`${previewBase}?qa=choose#${previewHash}`)
  await new Promise((resolve) => setTimeout(resolve, 800))
  await window.webContents.executeJavaScript("document.querySelector('.launch-mode-card.choose')?.click()")
  await new Promise((resolve) => setTimeout(resolve, 500))
  const candidateInputCount = await window.webContents.executeJavaScript("document.querySelectorAll('.launch-candidates article > input').length")
  if (candidateInputCount < 2) {
    const bodyText = await window.webContents.executeJavaScript('document.body.innerText')
    throw new Error(`多任务页面只找到 ${candidateInputCount} 个候选输入框；URL=${window.webContents.getURL()}；页面=${bodyText.slice(0, 240).replaceAll('\n', ' / ')}`)
  }
  await window.webContents.executeJavaScript(`
    (() => {
      const inputs = [...document.querySelectorAll('.launch-candidates article > input')]
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      const pairs = [['修改今天要交的报告', inputs[0]], ['整理下周阅读资料', inputs[1]]]
      pairs.forEach(([value, input]) => {
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    })()
  `)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const chooseText = await window.webContents.executeJavaScript('document.body.innerText')
  if (!chooseText.includes('采用推荐并继续') || !chooseText.includes('修改今天要交的报告')) throw new Error('多任务推荐页没有正确渲染')
  await capture(window, '0.3.0-launch-choose-task.png')
  await window.webContents.executeJavaScript("document.querySelector('.launch-recommendation .button.primary')?.click()")
  await new Promise((resolve) => setTimeout(resolve, 250))
  const selectedTaskValue = await window.webContents.executeJavaScript("document.querySelector('.launch-detail-form label:nth-child(1) input')?.value")
  if (selectedTaskValue !== '修改今天要交的报告') throw new Error('推荐任务没有进入第一动作详情页')

  await window.webContents.executeJavaScript('localStorage.clear()')
  window.setSize(430, 900)
  await window.loadURL(`${previewBase}?qa=mobile#${previewHash}`)
  await new Promise((resolve) => setTimeout(resolve, 600))
  await capture(window, '0.3.0-launch-entry-mobile.png')
  window.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
