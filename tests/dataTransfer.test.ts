import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBackupText, createCsvText, parseBackupData, parseBackupText } from '../src/lib/dataTransfer'
import { createDefaultState } from '../src/lib/storage'

describe('v11 data transfer', () => {
  it('round-trips launch and action-slip collections through JSON backup', () => {
    const state = createDefaultState()
    state.focusLaunches.push({
      id: 'launch-1', mode: 'known-task', status: 'completed', createdAt: '2026-08-29T01:00:00.000Z', updatedAt: '2026-08-29T01:30:00.000Z',
      completedAt: '2026-08-29T01:30:00.000Z', candidates: [], taskName: '写报告', taskCategory: 'writing', firstAction: '打开文档',
      completionDefinition: '完成第一段', plannedDurationMin: 25, energyBefore: 2, resistanceBefore: 3, warmupType: 'inhibition', focusSessionId: 'focus-1',
    })
    state.actionSlips.push({
      id: 'slip-1', title: '写报告', status: 'current', createdAt: '2026-08-29T01:00:00.000Z',
      updatedAt: '2026-08-29T01:30:00.000Z', nextStep: '检查第一段', focusSessionIds: ['focus-1'],
    })
    state.personalNotes.push({
      id: 'note-1', title: '今日复盘', content: '先完成最小的一步。',
      createdAt: '2026-09-03T01:00:00.000Z', updatedAt: '2026-09-03T01:10:00.000Z',
    })

    const restored = parseBackupText(createBackupText(state))
    expect(restored.focusLaunches[0].firstAction).toBe('打开文档')
    expect(restored.focusLaunches[0].focusSessionId).toBe('focus-1')
    expect(restored.actionSlips[0].nextStep).toBe('检查第一段')
    expect(restored.personalNotes[0].content).toBe('先完成最小的一步。')
  })

  it('includes launch context columns and rows in CSV', () => {
    const state = createDefaultState()
    state.focusLaunches.push({
      id: 'launch-1', mode: 'known-task', status: 'focusing', createdAt: '2026-08-29T01:00:00.000Z', updatedAt: '2026-08-29T01:01:00.000Z',
      candidates: [], taskName: '写报告', taskCategory: 'writing', firstAction: '打开文档', completionDefinition: '完成第一段', plannedDurationMin: 25,
      energyBefore: 2, resistanceBefore: 3, warmupType: 'none',
    })
    state.actionSlips.push({
      id: 'slip-1', title: '写报告', status: 'inbox', createdAt: '2026-08-29T01:00:00.000Z',
      updatedAt: '2026-08-29T01:00:00.000Z', focusSessionIds: [],
    })
    const csv = createCsvText(state)
    expect(csv).toContain('启动回合ID')
    expect(csv).toContain('专注启动')
    expect(csv).toContain('打开文档')
    expect(csv).toContain('行动便签ID')
    expect(csv).toContain('行动便签')
    expect(csv).toContain('笔记正文')
    const rows = csv.replace(/^\uFEFF/, '').split('\r\n').map((row) => row.split(','))
    rows.slice(1).forEach((row) => expect(row).toHaveLength(rows[0].length))
  })

  it('keeps a versioned knowledge-base snapshot in the full backup envelope', () => {
    const state = createDefaultState()
    const knowledgeBase = {
      schemaVersion: 2,
      sources: [],
      permissions: [],
      chunks: [],
      retrievals: [],
      metadata: [],
    }
    const restored = parseBackupData(createBackupText(state, knowledgeBase))
    expect(restored.state.schemaVersion).toBe(state.schemaVersion)
    expect(restored.knowledgeBase).toEqual(knowledgeBase)
  })

  it('imports the public synthetic portfolio backup with current migration rules', () => {
    const source = readFileSync(
      new URL('../docs/portfolio/demo-data/xirang-demo-backup.json', import.meta.url),
      'utf8',
    )
    const restored = parseBackupData(source).state

    expect(restored.schemaVersion).toBe(11)
    expect(restored.profile.onboardingComplete).toBe(true)
    expect(restored.actionSlips).toHaveLength(3)
    expect(restored.actionSlips.filter((item) => item.status === 'current')).toHaveLength(1)
    expect(restored.focusSessions).toHaveLength(3)
    expect(restored.agentPlans[0]?.title).toContain('合成演示')
  })
})
