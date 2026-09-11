import { useEffect, useState, type FormEvent } from 'react'
import {
  deleteDeepSeekCredential,
  getDeepSeekCredentialStatus,
  saveDeepSeekCredential,
  type DeepSeekCredentialStatus,
} from '../lib/knowledgeRetrieval'

interface AIProviderSettingsProps {
  onChanged?: () => void
}

type Notice = { tone: 'success' | 'error' | 'neutral'; text: string }

function sourceLabel(status: DeepSeekCredentialStatus) {
  if (status.credentialSource === 'windows_dpapi_current_user') return 'Windows 当前用户加密存储'
  if (status.credentialSource === 'environment') return '当前后端进程环境变量'
  if (status.credentialSource === 'storage_error') return '加密凭据读取失败'
  if (status.configured) return '当前后端进程内存'
  return '尚未保存'
}

export function AIProviderSettings({ onChanged }: AIProviderSettingsProps) {
  const [status, setStatus] = useState<DeepSeekCredentialStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState<'load' | 'save' | 'delete' | null>('load')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  async function loadStatus() {
    setBusy('load')
    try {
      setStatus(await getDeepSeekCredentialStatus())
    } catch (error) {
      setStatus(null)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '无法读取 DeepSeek 配置状态。' })
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  async function saveCredential(event: FormEvent) {
    event.preventDefault()
    const normalized = apiKey.trim()
    if (normalized.length < 16) {
      setNotice({ tone: 'error', text: '请输入完整的 DeepSeek API Key。' })
      return
    }
    setBusy('save')
    setNotice(null)
    try {
      const next = await saveDeepSeekCredential(normalized)
      setStatus(next)
      setApiKey('')
      setRevealed(false)
      setConfirmDelete(false)
      setNotice({ tone: 'success', text: 'DeepSeek API Key 已加密保存；以后启动后端时无需再次输入。' })
      onChanged?.()
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'DeepSeek API Key 保存失败。' })
    } finally {
      setBusy(null)
    }
  }

  async function removeCredential() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setNotice({ tone: 'neutral', text: '再次点击“确认删除”才会移除本机保存的 Key。' })
      return
    }
    setBusy('delete')
    setNotice(null)
    try {
      const next = await deleteDeepSeekCredential()
      setStatus(next)
      setApiKey('')
      setRevealed(false)
      setConfirmDelete(false)
      setNotice({ tone: 'success', text: '本机保存的 DeepSeek API Key 已删除。' })
      onChanged?.()
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'DeepSeek API Key 删除失败。' })
    } finally {
      setBusy(null)
    }
  }

  const configured = Boolean(status?.configured)
  const storageSupported = status?.persistentStorageSupported !== false

  return (
    <section className="settings-card ai-provider-settings card-surface" aria-labelledby="ai-provider-title">
      <div className="settings-card-heading ai-provider-heading">
        <span>03</span>
        <div><p className="eyebrow">AI Provider</p><h2 id="ai-provider-title">DeepSeek 安全凭据</h2></div>
        <span className={`ai-provider-status ${configured ? 'ready' : status?.credentialStorageError ? 'error' : ''}`}>
          <i />{busy === 'load' ? '正在检测' : configured ? '已配置' : '未配置'}
        </span>
      </div>

      <p className="ai-provider-intro">
        Key 只提交给本机后端并使用 Windows DPAPI 加密，明文不会写入源码、浏览器存储、应用数据备份或接口响应。
      </p>

      <div className="ai-provider-meta">
        <span><small>平台</small><strong>DeepSeek</strong></span>
        <span><small>模型</small><strong>{status?.model ?? 'deepseek-v4-flash'}</strong></span>
        <span><small>凭据来源</small><strong>{status ? sourceLabel(status) : '等待本地服务'}</strong></span>
      </div>

      <form className="ai-key-form" onSubmit={saveCredential}>
        <label htmlFor="deepseek-api-key">
          <span>{configured ? '输入新 Key 以替换' : 'DeepSeek API Key'}</span>
          <small>{configured ? '留空不会改变当前 Key；服务器不会回显已保存的值。' : '保存一次后，后续启动无需重复输入。'}</small>
        </label>
        <div className="ai-key-input-row">
          <input
            id="deepseek-api-key"
            type={revealed ? 'text' : 'password'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={configured ? '••••••••••••••••' : 'sk-…'}
            disabled={Boolean(busy) || !storageSupported}
            maxLength={512}
          />
          <button type="button" onClick={() => setRevealed((current) => !current)} disabled={!apiKey || Boolean(busy)}>
            {revealed ? '隐藏' : '显示'}
          </button>
          <button className="button primary" type="submit" disabled={!apiKey.trim() || Boolean(busy) || !storageSupported}>
            {busy === 'save' ? '正在保存…' : configured ? '替换并保存' : '加密保存'}
          </button>
        </div>
      </form>

      {configured && (
        <div className="ai-key-delete-row">
          <p>只有主动替换或删除时才会改变已保存的凭据。</p>
          <div>
            {confirmDelete && <button type="button" onClick={() => { setConfirmDelete(false); setNotice(null) }}>取消</button>}
            <button className={confirmDelete ? 'confirm' : ''} type="button" disabled={Boolean(busy)} onClick={() => void removeCredential()}>
              {busy === 'delete' ? '正在删除…' : confirmDelete ? '确认删除' : '删除 Key'}
            </button>
          </div>
        </div>
      )}

      {!storageSupported && <p className="ai-key-warning">当前系统不支持 Windows DPAPI 安全持久化，请使用后端环境变量。</p>}
      {status?.credentialStorageError && <p className="ai-key-warning">本机加密凭据无法读取。请删除后重新保存，或检查是否更换了 Windows 用户。</p>}
      {notice && <div className={`ai-key-notice ${notice.tone}`} role="status"><span>{notice.tone === 'success' ? '✓' : notice.tone === 'error' ? '!' : 'i'}</span><p>{notice.text}</p></div>}

      <p className="ai-provider-boundary">加密文件只能由当前 Windows 用户在本机解密；删除应用数据不会自动删除 Key，必须在这里单独删除。</p>
    </section>
  )
}
