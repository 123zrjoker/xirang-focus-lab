import type { ActionSlip, FocusSession } from '../types'

export const MAX_ACTION_SLIPS = 500

export function normalizeActionSlipText(value: string, maxLength = 240) {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

export function createActionSlip(title: string, now = new Date().toISOString()): ActionSlip {
  return {
    id: crypto.randomUUID(),
    title: normalizeActionSlipText(title),
    status: 'inbox',
    createdAt: now,
    updatedAt: now,
    focusSessionIds: [],
  }
}

export function setCurrentActionSlip(items: ActionSlip[], id: string, now = new Date().toISOString()) {
  return items.map((item) => {
    if (item.id === id) return { ...item, status: 'current' as const, updatedAt: now, completedAt: undefined }
    if (item.status === 'current') return { ...item, status: 'inbox' as const, updatedAt: now }
    return item
  })
}

export function completeActionSlip(items: ActionSlip[], id: string, now = new Date().toISOString()) {
  return items.map((item) => item.id === id
    ? { ...item, status: 'completed' as const, updatedAt: now, completedAt: now }
    : item)
}

export function reopenActionSlip(items: ActionSlip[], id: string, now = new Date().toISOString()) {
  return items.map((item) => item.id === id
    ? { ...item, status: 'inbox' as const, updatedAt: now, completedAt: undefined }
    : item)
}

export function updateActionSlipTitle(items: ActionSlip[], id: string, title: string, now = new Date().toISOString()) {
  const cleanTitle = normalizeActionSlipText(title)
  if (!cleanTitle) return items
  return items.map((item) => item.id === id ? { ...item, title: cleanTitle, updatedAt: now } : item)
}

export function attachFocusToActionSlips(items: ActionSlip[], session: FocusSession) {
  if (!session.actionSlipId) return items
  return items.map((item) => {
    if (item.id !== session.actionSlipId) return item
    const focusSessionIds = item.focusSessionIds.includes(session.id)
      ? item.focusSessionIds
      : [...item.focusSessionIds, session.id].slice(-100)
    const completed = session.endReason === 'completed' && session.completionRate >= 100
    return {
      ...item,
      status: completed ? 'completed' as const : 'current' as const,
      updatedAt: session.completedAt,
      completedAt: completed ? session.completedAt : undefined,
      nextStep: normalizeActionSlipText(session.nextStep ?? '', 300) || item.nextStep,
      focusSessionIds,
    }
  })
}
