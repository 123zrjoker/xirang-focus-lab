import type { FocusBreakKind, FocusEndReason, FocusMode } from '../types'

export interface NextFocusStep {
  breakMinutes: number
  breakKind: FocusBreakKind
  nextPomodoroCycle: number
}

export function getNextFocusStep(
  focusMode: FocusMode,
  pomodoroCycle: number,
  endReason: FocusEndReason,
): NextFocusStep {
  if (focusMode !== 'pomodoro') {
    return { breakMinutes: 5, breakKind: 'short', nextPomodoroCycle: 1 }
  }

  if (endReason !== 'completed') {
    return { breakMinutes: 5, breakKind: 'short', nextPomodoroCycle: pomodoroCycle }
  }

  if (pomodoroCycle >= 4) {
    return { breakMinutes: 15, breakKind: 'long', nextPomodoroCycle: 1 }
  }

  return { breakMinutes: 5, breakKind: 'short', nextPomodoroCycle: pomodoroCycle + 1 }
}
