const path = require('node:path')
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const { ApiServiceSupervisor, SUPPORTED_API_CONTRACT_VERSION } = require('./api-service.cjs')
const { resolveRuntimePaths } = require('./runtime-paths.cjs')

const APP_ID = 'com.focuslab.xirang'
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) app.quit()

let mainWindow = null
let apiService = null
let quitAfterServiceStops = false

function sendServiceStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('xirang:api-status-changed', status)
}

function createMainWindow() {
  const window = new BrowserWindow({
    title: '息壤 · 注意力训练实验室',
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f6f1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: apiService?.baseUrl ? [`--xirang-api-base=${apiService.baseUrl}`] : [],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  })

  mainWindow = window
  Menu.setApplicationMenu(null)

  window.once('ready-to-show', () => {
    window.show()
    window.focus()
    if (apiService) sendServiceStatus(apiService.snapshot())
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
  })

  window.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'notifications'
  })

  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'notifications')
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  void window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.setAppUserModelId(APP_ID)

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  const appPath = app.getAppPath()
  const paths = resolveRuntimePaths({
    app,
    appPath,
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  })
  apiService = new ApiServiceSupervisor({
    paths,
    appPath,
    isPackaged: app.isPackaged,
    expectedVersion: app.getVersion(),
    expectedApiContractVersion: SUPPORTED_API_CONTRACT_VERSION,
  })
  apiService.on('status', sendServiceStatus)
  await apiService.prepare()

  ipcMain.handle('xirang:api-status', () => apiService.snapshot())
  ipcMain.handle('xirang:api-restart', async () => {
    try {
      return await apiService.restart()
    } catch {
      return apiService.snapshot()
    }
  })

  createMainWindow()
  void apiService.start().then(() => {
    const smokeExitMilliseconds = Number(process.env.XIRANG_DESKTOP_SMOKE_AUTO_EXIT_MS || 0)
    if (smokeExitMilliseconds >= 500 && smokeExitMilliseconds <= 30_000) {
      setTimeout(() => app.quit(), smokeExitMilliseconds)
    }
  }).catch(() => {
    // The renderer receives the failed state and exposes a retry action.
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}).catch((error) => {
  console.error('Unable to initialise Xirang desktop runtime:', error)
  app.quit()
})

app.on('before-quit', (event) => {
  if (quitAfterServiceStops || !apiService) return
  event.preventDefault()
  quitAfterServiceStops = true
  void apiService.stop().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
