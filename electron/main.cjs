const path = require('node:path')
const { app, BrowserWindow, Menu, shell } = require('electron')

const APP_ID = 'com.focuslab.xirang'
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

let mainWindow = null

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

app.whenReady().then(() => {
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
