import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiUrl, desktopBridge } from '../src/lib/apiUrl'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('desktop API URL resolution', () => {
  it('keeps browser development requests relative for the Vite proxy', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:' } })
    expect(apiUrl('/api/health')).toBe('/api/health')
  })

  it('uses the synchronous loopback URL exposed by the sandboxed preload', () => {
    const bridge = {
      apiBaseUrl: 'http://127.0.0.1:43123/',
      getServiceStatus: vi.fn(),
      restartService: vi.fn(),
      onServiceStatus: vi.fn(),
    }
    vi.stubGlobal('window', { location: { protocol: 'file:' }, xirangDesktop: bridge })
    expect(desktopBridge()).toBe(bridge)
    expect(apiUrl('/api/agent/status')).toBe('http://127.0.0.1:43123/api/agent/status')
  })

  it('retains the legacy file fallback for old standalone builds', () => {
    vi.stubGlobal('window', { location: { protocol: 'file:' } })
    expect(apiUrl('api/health')).toBe('http://127.0.0.1:8000/api/health')
  })
})
