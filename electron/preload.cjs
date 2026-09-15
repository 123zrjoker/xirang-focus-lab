const { contextBridge, ipcRenderer } = require('electron')

const API_BASE_PREFIX = '--xirang-api-base='
const apiArgument = process.argv.find((value) => value.startsWith(API_BASE_PREFIX))
const apiBaseUrl = apiArgument ? apiArgument.slice(API_BASE_PREFIX.length).replace(/\/$/, '') : null

contextBridge.exposeInMainWorld('xirangDesktop', Object.freeze({
  apiBaseUrl,
  getServiceStatus: () => ipcRenderer.invoke('xirang:api-status'),
  restartService: () => ipcRenderer.invoke('xirang:api-restart'),
  onServiceStatus: (listener) => {
    if (typeof listener !== 'function') return () => {}
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('xirang:api-status-changed', handler)
    return () => ipcRenderer.removeListener('xirang:api-status-changed', handler)
  },
}))
