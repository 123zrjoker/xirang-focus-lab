import { useEffect, useState } from 'react'
import {
  desktopBridge,
  type DesktopApiServiceState,
  type DesktopApiServiceStatus,
} from '../lib/apiUrl'

const stateLabels: Record<DesktopApiServiceState, string> = {
  stopped: '已停止',
  starting: '正在启动',
  ready: '运行正常',
  stopping: '正在停止',
  failed: '启动失败',
}

const launchLabels: Record<NonNullable<DesktopApiServiceStatus['launchKind']>, string> = {
  'development-python': '开发环境 Python',
  'packaged-sidecar': '内置桌面运行时',
  override: '自定义运行时',
}

export function DesktopServicePanel() {
  const bridge = desktopBridge()
  const [status, setStatus] = useState<DesktopApiServiceStatus | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    if (!bridge) return
    let active = true
    void bridge.getServiceStatus().then((value) => {
      if (active) setStatus(value)
    })
    const unsubscribe = bridge.onServiceStatus((value) => {
      if (active) setStatus(value)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [bridge])

  if (!bridge) return null
  const activeBridge = bridge

  async function restart() {
    setRestarting(true)
    try {
      setStatus(await activeBridge.restartService())
    } finally {
      setRestarting(false)
    }
  }

  const state = status?.state ?? 'starting'
  return (
    <section className="settings-card desktop-service-card card-surface">
      <div className="settings-card-heading">
        <span>03</span>
        <div><p className="eyebrow">桌面运行时</p><h2>本机 AI 服务</h2></div>
        <strong className={`desktop-service-state ${state}`} aria-live="polite">{stateLabels[state]}</strong>
      </div>
      <p className="desktop-service-description">
        桌面版会自动启动并关闭 FastAPI 服务。页面只通过随机分配的本机回环端口连接，不开放局域网访问。
      </p>
      <div className="desktop-service-details">
        <span><small>运行方式</small><strong>{status?.launchKind ? launchLabels[status.launchKind] : '正在准备'}</strong></span>
        <span><small>服务版本</small><strong>{status?.serviceVersion ?? '—'}</strong></span>
        <span><small>API 契约</small><strong>{status?.apiContractVersion ?? '—'}</strong></span>
        <span><small>本机端口</small><strong>{status?.port ?? '—'}</strong></span>
        <span><small>进程</small><strong>{status?.pid ?? '—'}</strong></span>
      </div>
      {status?.error && <p className="desktop-service-error" role="alert">{status.error}</p>}
      <div className="desktop-service-actions">
        <button className="button secondary" type="button" disabled={restarting || state === 'starting' || state === 'stopping'} onClick={() => void restart()}>
          {restarting ? '正在重启…' : '重启本机服务'}
        </button>
        <small>{state === 'ready' ? '检索、引用问答和 Agent 均可使用。' : '训练、专注和本地记录不受服务状态影响。'}</small>
      </div>
    </section>
  )
}
