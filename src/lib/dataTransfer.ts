import { CURRENT_SCHEMA_VERSION, migrateState } from './storage'
import type { AppState } from '../types'
import type { KnowledgeBaseBackup } from './knowledgeBase'

interface XirangBackup {
  product: 'xirang'
  backupVersion: 2
  schemaVersion: number
  exportedAt: string
  state: AppState
  knowledgeBase?: KnowledgeBaseBackup
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function csvCell(value: string | number) {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function exportDateStamp(date = new Date()) {
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0'))
  return parts.join('-')
}

export function createBackupText(state: AppState, knowledgeBase?: KnowledgeBaseBackup) {
  const backup: XirangBackup = {
    product: 'xirang',
    backupVersion: 2,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    state: { ...state, schemaVersion: CURRENT_SCHEMA_VERSION },
    ...(knowledgeBase ? { knowledgeBase } : {}),
  }
  return JSON.stringify(backup, null, 2)
}

export function parseBackupData(text: string): { state: AppState; knowledgeBase?: KnowledgeBaseBackup } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('文件不是有效的 JSON 格式。')
  }

  if (!isRecord(parsed)) throw new Error('备份内容不完整。')
  const source = isRecord(parsed.state) ? parsed.state : parsed
  const version = Number(parsed.schemaVersion ?? source.schemaVersion ?? 1)
  if (Number.isFinite(version) && version > CURRENT_SCHEMA_VERSION) {
    throw new Error('这份备份来自更新版本的息壤，请先升级应用。')
  }
  if (!('profile' in source) && !('sessions' in source) && !('focusSessions' in source)) {
    throw new Error('没有在文件中找到息壤数据。')
  }
  return {
    state: migrateState(source),
    ...(isRecord(parsed.knowledgeBase) ? { knowledgeBase: parsed.knowledgeBase as unknown as KnowledgeBaseBackup } : {}),
  }
}

export function parseBackupText(text: string) {
  return parseBackupData(text).state
}

export function createCsvText(state: AppState) {
  const headers = [
    '记录类型', '完成时间', '任务名称', '训练类型', '专注模式', '番茄周期', '实际时长秒', '计划时长分钟', '正确率%',
    '中位反应毫秒', '错误', '漏答', '误按', '得分', '等级', '完成度%', '结束原因', '分心次数',
    '分心分类', '分心停车场', '离开页面次数', '主观专注', '连续轮次',
    '启动回合ID', '任务分类', '第一个动作', '本轮完成标准', '开始前精力', '开始前抗拒', '启动路径', '启动热身', '候选任务数',
    '行动便签ID', '下一步', '便签状态', '关联专注ID', '笔记ID', '笔记标题', '笔记正文',
  ]
  type CsvValue = string | number
  function row(values: Partial<Record<(typeof headers)[number], CsvValue>>) {
    return headers.map((header) => values[header] ?? '')
  }
  const trainingRows = state.sessions.map((session) => row({
    记录类型: '认知训练', 完成时间: session.completedAt, 训练类型: session.taskType,
    实际时长秒: session.durationSec.toFixed(1), '正确率%': Math.round(session.accuracy * 100),
    中位反应毫秒: Math.round(session.medianReactionMs), 错误: session.errors, 漏答: session.omissions,
    误按: session.commissions, 得分: session.score, 等级: session.level,
  }))
  const focusRows = state.focusSessions.map((session) => row({
    记录类型: '现实专注', 完成时间: session.completedAt, 任务名称: session.taskName, 专注模式: session.focusMode,
    番茄周期: session.pomodoroCycle, 实际时长秒: session.actualDurationSec.toFixed(1), 计划时长分钟: session.plannedDurationMin,
    '完成度%': session.completionRate, 结束原因: session.endReason, 分心次数: session.distractionCount,
    分心分类: session.distractions.map((item) => item.reason).join(' | '),
    分心停车场: session.distractions.map((item) => item.note).join(' | '),
    离开页面次数: session.pageLeaveCount, 主观专注: session.subjectiveFocus, 连续轮次: session.round,
    启动回合ID: session.launchId ?? '', 任务分类: session.taskCategory ?? '', 第一个动作: session.firstAction ?? '',
    本轮完成标准: session.completionDefinition ?? '', 开始前精力: session.energyBefore ?? '',
    开始前抗拒: session.resistanceBefore ?? '', 行动便签ID: session.actionSlipId ?? '', 下一步: session.nextStep ?? '',
  }))
  const launchRows = state.focusLaunches.map((launch) => row({
    记录类型: '专注启动', 完成时间: launch.completedAt ?? launch.updatedAt, 任务名称: launch.taskName,
    计划时长分钟: launch.plannedDurationMin, 结束原因: launch.status, 启动回合ID: launch.id,
    任务分类: launch.taskCategory, 第一个动作: launch.firstAction, 本轮完成标准: launch.completionDefinition,
    开始前精力: launch.energyBefore, 开始前抗拒: launch.resistanceBefore, 启动路径: launch.mode,
    启动热身: launch.warmupType, 候选任务数: launch.candidates.length, 行动便签ID: launch.actionSlipId ?? '',
    关联专注ID: launch.focusSessionId ?? '',
  }))
  const actionSlipRows = state.actionSlips.map((slip) => row({
    记录类型: '行动便签', 完成时间: slip.completedAt ?? slip.updatedAt, 任务名称: slip.title,
    启动回合ID: slip.sourceLaunchId ?? '', 行动便签ID: slip.id, 下一步: slip.nextStep ?? '',
    便签状态: slip.status, 关联专注ID: slip.focusSessionIds.join(' | '),
  }))
  const personalNoteRows = state.personalNotes.map((note) => row({
    记录类型: '笔记', 完成时间: note.updatedAt, 笔记ID: note.id, 笔记标题: note.title, 笔记正文: note.content,
  }))
  const rows = [headers, ...trainingRows, ...focusRows, ...launchRows, ...actionSlipRows, ...personalNoteRows]
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
}

export function downloadTextFile(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
