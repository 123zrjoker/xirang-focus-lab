export type DesktopApiServiceState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed'

export const SUPPORTED_API_CONTRACT_VERSION = '1'

export interface DesktopApiServiceStatus {
  state: DesktopApiServiceState
  baseUrl: string | null
  port: number | null
  pid: number | null
  launchKind: 'development-python' | 'packaged-sidecar' | 'override' | null
  startedAt: string | null
  readyAt: string | null
  serviceVersion: string | null
  apiContractVersion: string | null
  error: string | null
}

export interface XirangDesktopBridge {
  apiBaseUrl: string | null
  getServiceStatus: () => Promise<DesktopApiServiceStatus>
  restartService: () => Promise<DesktopApiServiceStatus>
  onServiceStatus: (listener: (status: DesktopApiServiceStatus) => void) => () => void
}

declare global {
  interface Window {
    xirangDesktop?: XirangDesktopBridge
  }
}

const configuredApiBase = import.meta.env.VITE_RETRIEVAL_API_URL?.replace(/\/$/, '')

export function desktopBridge() {
  return typeof window === 'undefined' ? undefined : window.xirangDesktop
}

export function apiBaseUrl() {
  if (configuredApiBase) return configuredApiBase
  const desktopBase = desktopBridge()?.apiBaseUrl?.replace(/\/$/, '')
  if (desktopBase) return desktopBase
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') return 'http://127.0.0.1:8000'
  return ''
}

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${apiBaseUrl()}${normalizedPath}`
}
