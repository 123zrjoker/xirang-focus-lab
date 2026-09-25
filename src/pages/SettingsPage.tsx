import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { AIProviderSettings } from '../components/AIProviderSettings'
import { DesktopServicePanel } from '../components/DesktopServicePanel'
import {
  createBackupText,
  createCsvText,
  downloadTextFile,
  exportDateStamp,
  parseBackupData,
} from '../lib/dataTransfer'
import {
  notificationCapability,
  requestDesktopNotificationPermission,
} from '../lib/feedback'
import { CURRENT_SCHEMA_VERSION } from '../lib/storage'
import { exportKnowledgeBase, restoreKnowledgeBase } from '../lib/knowledgeBase'
import type { AppSettings, AppState, UserProfile } from '../types'

interface SettingsPageProps {
  state: AppState
  onUpdateProfile: (patch: Partial<UserProfile>) => void
  onUpdateSettings: (patch: Partial<AppSettings>) => void
  onReplaceState: (state: AppState) => void
  onClear: () => void | Promise<void>
}

interface ToggleRowProps {
  title: string
  description: string
  checked: boolean
  onChange: () => void
  detail?: ReactNode
}

function ToggleRow({ title, description, checked, onChange, detail }: ToggleRowProps) {
  return (
    <div className="setting-toggle-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
        {detail}
      </div>
      <button
        type="button"
        className={`toggle-switch ${checked ? 'active' : ''}`}
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={onChange}
      >
        <span />
      </button>
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function SettingsPage({
  state,
  onUpdateProfile,
  onUpdateSettings,
  onReplaceState,
  onClear,
}: SettingsPageProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'neutral'; text: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState(notificationCapability())

  const assessments = state.assessments ?? []
  const latestActivity = [
    ...state.sessions.map((item) => item.completedAt),
    ...state.focusSessions.map((item) => item.completedAt),
    ...assessments.map((item) => item.completedAt),
    ...state.actionSlips.map((item) => item.updatedAt),
    ...state.personalNotes.map((item) => item.updatedAt),
  ]
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  const dataSize = new Blob([JSON.stringify(state)]).size

  async function exportBackup() {
    try {
      const knowledgeBase = await exportKnowledgeBase()
      downloadTextFile(
        createBackupText(state, knowledgeBase),
        `息壤-完整数据备份-${exportDateStamp()}.json`,
        'application/json;charset=utf-8',
      )
      setMessage({ tone: 'success', text: '应用记录与知识库已导出；DeepSeek Key 和临时 Agent 线程不会进入备份。' })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '完整备份导出失败。' })
    }
  }

  function exportCsv() {
    downloadTextFile(
      createCsvText(state),
      `息壤-全部记录-${exportDateStamp()}.csv`,
      'text/csv;charset=utf-8',
    )
    setMessage({ tone: 'success', text: '全部记录 CSV 已导出，可使用 Excel 或其他表格软件打开。' })
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('备份文件超过 100 MB，无法导入。')
      const backup = parseBackupData(await file.text())
      const nextState = backup.state
      const confirmed = window.confirm('导入会替换此设备上的当前数据。是否继续？')
      if (!confirmed) return
      if (nextState.settings.desktopNotificationsEnabled && notificationCapability() !== 'granted') {
        nextState.settings.desktopNotificationsEnabled = false
      }
      if (backup.knowledgeBase) await restoreKnowledgeBase(backup.knowledgeBase)
      onReplaceState(nextState)
      setNotificationPermission(notificationCapability())
      setConfirmClear(false)
      setMessage({ tone: 'success', text: backup.knowledgeBase
        ? '应用记录与知识库已恢复。加密 API Key 需要沿用本机凭据或重新授权。'
        : '旧版应用数据已导入；当前知识库保持不变。' })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '导入失败，请检查备份文件。' })
    } finally {
      input.value = ''
    }
  }

  async function toggleNotifications() {
    if (state.settings.desktopNotificationsEnabled) {
      onUpdateSettings({ desktopNotificationsEnabled: false })
      setMessage({ tone: 'neutral', text: '专注完成通知已关闭。' })
      return
    }
    const granted = await requestDesktopNotificationPermission()
    const permission = notificationCapability()
    setNotificationPermission(permission)
    if (granted) {
      onUpdateSettings({ desktopNotificationsEnabled: true })
      setMessage({ tone: 'success', text: '通知已开启，专注倒计时结束时会提醒你。' })
    } else {
      onUpdateSettings({ desktopNotificationsEnabled: false })
      setMessage({
        tone: 'error',
        text: permission === 'denied'
          ? '系统已拒绝通知权限。如需开启，请先在系统或浏览器设置中允许通知。'
          : '当前环境不支持桌面通知。',
      })
    }
  }

  async function clearAllData() {
    try {
      await onClear()
      setConfirmClear(false)
      setMessage({ tone: 'success', text: '此设备上的应用数据与知识库资料已清空。' })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '设备数据没有完全清空，请重试。' })
    }
  }

  return (
    <section className="page-width inner-page settings-page">
      <div className="page-title-row">
        <div>
          <p className="eyebrow">本地设置</p>
          <h1>把使用方式留在自己手里</h1>
          <p>设置和记录只保存在此设备。应用数据 JSON 可用于浏览器与桌面版之间迁移。</p>
        </div>
        <span className="local-only-badge">仅本机保存</span>
      </div>

      {message && (
        <div className={`settings-message ${message.tone}`} role="status">
          <span>{message.tone === 'success' ? '✓' : message.tone === 'error' ? '!' : 'i'}</span>
          <p>{message.text}</p>
          <button type="button" onClick={() => setMessage(null)} aria-label="关闭提示">×</button>
        </div>
      )}

      <div className="settings-layout">
        <div className="settings-main">
          <section className="settings-card card-surface">
            <div className="settings-card-heading">
              <span>01</span>
              <div><p className="eyebrow">日常偏好</p><h2>训练与专注</h2></div>
            </div>

            <div className="setting-field">
              <div><strong>每日投入目标</strong><p>今日页会统计认知训练与现实专注的合计时间。</p></div>
              <div className="setting-options compact">
                {[5, 10, 15, 20, 30].map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className={state.profile.dailyTargetMinutes === minutes ? 'active' : ''}
                    onClick={() => onUpdateProfile({ dailyTargetMinutes: minutes })}
                  >
                    {minutes}<small>分钟</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-field">
              <div><strong>默认专注时长</strong><p>每次进入专注室时，默认选中这个时长。</p></div>
              <div className="setting-options">
                {[15, 25, 45, 60].map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className={state.profile.preferredFocusMinutes === minutes ? 'active' : ''}
                    onClick={() => onUpdateProfile({ preferredFocusMinutes: minutes })}
                  >
                    {minutes}<small>分钟</small>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-card card-surface">
            <div className="settings-card-heading">
              <span>02</span>
              <div><p className="eyebrow">体验设置</p><h2>显示、反馈与提醒</h2></div>
            </div>
            <div className="font-size-setting">
              <div>
                <strong>界面字体大小</strong>
                <p>调整正文、标签和操作文字；训练刺激与数据图形保持原有比例。</p>
              </div>
              <div className="font-size-options" role="group" aria-label="界面字体大小">
                {([
                  ['small', '较小', 'A'],
                  ['standard', '标准', 'A'],
                  ['large', '较大', 'A'],
                ] as const).map(([value, label, preview]) => (
                  <button
                    key={value}
                    type="button"
                    className={state.settings.fontSize === value ? 'active' : ''}
                    aria-pressed={state.settings.fontSize === value}
                    onClick={() => onUpdateSettings({ fontSize: value })}
                  >
                    <span className={`font-size-sample ${value}`}>{preview}</span>
                    <small>{label}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="toggle-list">
              <ToggleRow
                title="完成提示音"
                description="保存训练成绩或专注倒计时结束时播放轻提示音。"
                checked={state.settings.soundEnabled}
                onChange={() => onUpdateSettings({ soundEnabled: !state.settings.soundEnabled })}
              />
              <ToggleRow
                title="界面动画"
                description="关闭后会停用页面过渡和装饰动画，适合容易被动态效果干扰时使用。"
                checked={state.settings.animationsEnabled}
                onChange={() => onUpdateSettings({ animationsEnabled: !state.settings.animationsEnabled })}
              />
              <ToggleRow
                title="训练技巧提示"
                description="控制今日提示、结果建议和训练页中的非必要技巧说明。"
                checked={state.settings.trainingTipsEnabled}
                onChange={() => onUpdateSettings({ trainingTipsEnabled: !state.settings.trainingTipsEnabled })}
              />
              <ToggleRow
                title="专注完成通知"
                description="倒计时结束时发送系统通知，需要浏览器或 Windows 授权。"
                checked={state.settings.desktopNotificationsEnabled}
                onChange={toggleNotifications}
                detail={
                  <small className="permission-state">
                    权限状态：{notificationPermission === 'granted' ? '已允许' : notificationPermission === 'denied' ? '已拒绝' : notificationPermission === 'default' ? '尚未询问' : '不支持'}
                  </small>
                }
              />
            </div>
          </section>

          <DesktopServicePanel />

          <AIProviderSettings />
        </div>

        <aside className="settings-side">
          <section className="data-card card-surface">
            <p className="eyebrow">数据中心</p>
            <h2>此设备上的记录</h2>
            <div className="data-summary">
              <span><small>认知训练</small><strong>{state.sessions.length}</strong></span>
              <span><small>现实专注</small><strong>{state.focusSessions.length}</strong></span>
              <span><small>阶段测评</small><strong>{assessments.length}</strong></span>
              <span><small>本地计划</small><strong>{state.dailyPlans.length}</strong></span>
              <span><small>行动待办</small><strong>{state.actionSlips.length}</strong></span>
              <span><small>个人笔记</small><strong>{state.personalNotes.length}</strong></span>
              <span><small>数据大小</small><strong>{formatBytes(dataSize)}</strong></span>
              <span><small>数据格式</small><strong>v{CURRENT_SCHEMA_VERSION}</strong></span>
            </div>
            <p className="last-activity">
              {latestActivity
                ? `最近记录：${new Date(latestActivity).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                : '还没有保存任何记录。'}
            </p>
            <div className="data-actions">
              <button className="button primary full" type="button" onClick={() => void exportBackup()}>导出完整备份 JSON</button>
              <button className="button secondary full" type="button" onClick={() => fileInput.current?.click()}>从备份导入</button>
              <button className="data-link" type="button" onClick={exportCsv}>导出全部记录 CSV →</button>
              <input ref={fileInput} type="file" accept="application/json,.json" onChange={importBackup} hidden />
            </div>
            <p className="data-note">完整备份包含训练、专注、计划、待办、笔记、设置和知识库；不包含 DeepSeek Key、向量索引或待审批 Agent 线程。旧版应用数据备份仍可导入。</p>
          </section>

          <section className="danger-card card-surface">
            <p className="eyebrow">数据清理</p>
            <h3>清空此设备数据</h3>
            <p>将删除训练、专注、测评、待办、笔记、知识库资料和所有设置。导出的备份文件不会受到影响。</p>
            {!confirmClear ? (
              <button type="button" onClick={() => setConfirmClear(true)}>清空数据</button>
            ) : (
              <div className="clear-confirmation">
                <strong>确定要永久清空吗？</strong>
                <div>
                  <button type="button" onClick={() => setConfirmClear(false)}>取消</button>
                  <button className="confirm" type="button" onClick={() => void clearAllData()}>确认清空</button>
                </div>
              </div>
            )}
          </section>
        </aside>
      </div>
    </section>
  )
}
