import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearActiveLaunch,
  clearStoredState,
  CURRENT_SCHEMA_VERSION,
  createDefaultState,
  getStorageCompatibilityIssue,
  loadActiveLaunch,
  loadState,
  migrateState,
  resetStorageCompatibilityBlock,
  saveActiveLaunch,
  saveState,
} from '../src/lib/storage'

afterEach(() => {
  resetStorageCompatibilityBlock()
  vi.unstubAllGlobals()
})

describe('storage migration through v11', () => {
  it.each([1, 8, 9, 10, 11])('keeps supported schema v%s readable', (schemaVersion) => {
    const migrated = migrateState({ ...createDefaultState(), schemaVersion })
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.profile.goal).toBe('study')
  })

  it('fails closed for a future local schema without overwriting its raw data', () => {
    const values = new Map<string, string>([[
      'xirang-state',
      JSON.stringify({ ...createDefaultState(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    ]])
    const setItem = vi.fn((key: string, value: string) => values.set(key, value))
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem,
        removeItem: (key: string) => values.delete(key),
      },
    })

    const protectedRaw = values.get('xirang-state')
    const state = loadState()
    expect(state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(getStorageCompatibilityIssue()).toContain(`v${CURRENT_SCHEMA_VERSION + 1}`)
    saveState(state)
    expect(setItem).not.toHaveBeenCalled()
    expect(values.get('xirang-state')).toBe(protectedRaw)

    clearStoredState()
    expect(getStorageCompatibilityIssue()).toBeNull()
    expect(values.has('xirang-state')).toBe(false)
  })

  it('rejects a future schema passed directly to the migration boundary', () => {
    expect(() => migrateState({
      ...createDefaultState(),
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
    })).toThrow('来自更新版本')
  })

  it.each([0, 'unknown'])('fails closed for unsupported local schema %s', (schemaVersion) => {
    const raw = JSON.stringify({ schemaVersion, profile: { goal: 'work' }, sessions: [] })
    const values = new Map<string, string>([['xirang-state', raw]])
    const setItem = vi.fn((key: string, value: string) => values.set(key, value))
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem,
        removeItem: (key: string) => values.delete(key),
      },
    })

    const state = loadState()
    expect(state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(getStorageCompatibilityIssue()).toContain('不受支持')
    saveState(state)
    expect(setItem).not.toHaveBeenCalled()
    expect(values.get('xirang-state')).toBe(raw)
  })

  it('adds action slips without losing v8 focus data', () => {
    const migrated = migrateState({
      schemaVersion: 8,
      profile: { goal: 'study', dailyTargetMinutes: 10, preferredFocusMinutes: 25, onboardingComplete: true },
      settings: {},
      sessions: [],
      focusSessions: [{
        id: 'focus-1', taskName: '阅读论文', plannedDurationMin: 25, actualDurationSec: 1200,
        completionRate: 75, distractionCount: 0, pageLeaveCount: 0, subjectiveFocus: 4,
        endReason: 'completed', distractions: [], round: 1, focusMode: 'free', pomodoroCycle: 1,
        completedAt: '2026-08-28T10:00:00.000Z',
      }],
      dailyPlans: [], focusLaunches: [],
    })

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.focusSessions[0].taskName).toBe('阅读论文')
    expect(migrated.actionSlips).toEqual([])
    expect(migrated.personalNotes).toEqual([])
  })

  it('migrates and cleans personal notes in v10', () => {
    const base = createDefaultState()
    const migrated = migrateState({
      ...base,
      schemaVersion: 9,
      personalNotes: [{
        id: 'note-1', title: '  复盘   想法  ', content: '第一行\r\n第二行',
        createdAt: '2026-09-03T01:00:00.000Z', updatedAt: '2026-09-03T02:00:00.000Z',
      }],
    })

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.personalNotes[0]).toMatchObject({ title: '复盘 想法', content: '第一行\n第二行' })
  })

  it('adds a safe font-size preference to older settings', () => {
    const defaults = migrateState({ ...createDefaultState(), settings: {} })
    const large = migrateState({ ...createDefaultState(), settings: { fontSize: 'large' } })
    const invalid = migrateState({ ...createDefaultState(), settings: { fontSize: 'giant' } })

    expect(defaults.settings.fontSize).toBe('standard')
    expect(large.settings.fontSize).toBe('large')
    expect(invalid.settings.fontSize).toBe('standard')
  })

  it('migrates and bounds approved agent plans in v11', () => {
    const base = createDefaultState()
    const migrated = migrateState({
      ...base,
      schemaVersion: 10,
      agentPlans: [{
        id: 'save-action-1', threadId: 'thread-1', runId: 'run-1',
        createdAt: '2026-09-13T08:00:00.000Z', baseStateRevision: 'A'.repeat(64),
        title: '  已批准计划  ', summary: '执行摘要', assumptions: ['本机可用'], evidenceRefs: [],
        items: [{
          title: '第一项', firstStep: '打开文件', completionCriteria: '测试通过',
          estimatedMinutes: 999, rationale: '验证保存', sourceActionSlipIds: [], evidenceRefs: [],
        }],
      }],
    })

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.agentPlans).toHaveLength(1)
    expect(migrated.agentPlans[0]).toMatchObject({
      id: 'save-action-1', threadId: 'thread-1', title: '  已批准计划  ',
    })
    expect(migrated.agentPlans[0].items[0].estimatedMinutes).toBe(240)
  })

  it('migrates legacy later tasks into the unified action inbox', () => {
    const base = createDefaultState()
    const migrated = migrateState({
      ...base,
      schemaVersion: 8,
      actionSlips: undefined,
      laterTasks: [{ id: 'later-1', title: '  修改报告  ', createdAt: '2026-08-29T00:00:00.000Z', sourceLaunchId: 'launch-1' }],
    })

    expect(migrated.actionSlips).toHaveLength(1)
    expect(migrated.actionSlips[0]).toMatchObject({ id: 'later-1', title: '修改报告', status: 'inbox', sourceLaunchId: 'launch-1' })
  })

  it('cleans launch and action-slip fields and keeps only one current item', () => {
    const base = createDefaultState()
    const migrated = migrateState({
      ...base,
      focusLaunches: [{
        id: 'launch-1', mode: 'choose-task', status: 'completed', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:10:00.000Z',
        candidates: [1, 2, 3, 4].map((value) => ({ id: String(value), title: `任务${value}`, importance: 8, urgency: 0, startability: 2 })),
        taskName: '任务1', taskCategory: 'coding', firstAction: '打开编辑器', completionDefinition: '完成一个函数', plannedDurationMin: 25,
        energyBefore: 5, resistanceBefore: 0, warmupType: 'visual', actionSlipId: 'slip-2',
      }],
      actionSlips: [
        { id: 'slip-1', title: '第一件', status: 'current', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:01:00.000Z' },
        { id: 'slip-2', title: '第二件', status: 'current', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:02:00.000Z', focusSessionIds: ['focus-1'] },
      ],
    })

    expect(migrated.focusLaunches[0].candidates).toHaveLength(3)
    expect(migrated.focusLaunches[0].energyBefore).toBe(3)
    expect(migrated.focusLaunches[0].resistanceBefore).toBe(1)
    expect(migrated.focusLaunches[0].actionSlipId).toBe('slip-2')
    expect(migrated.actionSlips.filter((item) => item.status === 'current')).toHaveLength(1)
    expect(migrated.actionSlips.find((item) => item.id === 'slip-2')?.status).toBe('current')
  })

  it('saves, loads and clears an active launch draft with its action slip', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    })
    const launch = {
      id: 'draft-1', mode: 'known-task' as const, status: 'draft' as const, createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
      candidates: [], taskName: '阅读论文', taskCategory: 'reading' as const, firstAction: '打开第三节', completionDefinition: '写三条笔记',
      plannedDurationMin: 25, energyBefore: 2 as const, resistanceBefore: 2 as const, warmupType: 'none' as const, actionSlipId: 'slip-1',
    }
    saveActiveLaunch(launch)
    expect(loadActiveLaunch()?.actionSlipId).toBe('slip-1')
    clearActiveLaunch()
    expect(loadActiveLaunch()).toBeNull()
  })
})
