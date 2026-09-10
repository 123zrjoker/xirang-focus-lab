import { describe, expect, it } from 'vitest'
import { createLaunchDraft, recommendLaunchWarmup, validateLaunchDetails } from '../src/lib/launchFlow'
import { rankLaunchCandidates, recommendLaunchCandidate, taskSelectionScore } from '../src/lib/taskSelection'
import type { LaunchCandidate } from '../src/types'

function candidate(id: string, title: string, importance: 1 | 2 | 3, urgency: 1 | 2 | 3, startability: 1 | 2 | 3): LaunchCandidate {
  return { id, title, importance, urgency, startability }
}

describe('task selection', () => {
  it('uses the documented transparent score', () => {
    expect(taskSelectionScore(candidate('a', '报告', 3, 2, 1))).toBe(11)
  })

  it('breaks equal scores by urgency, then startability', () => {
    const ranked = rankLaunchCandidates([
      candidate('a', '长期阅读', 3, 1, 3),
      candidate('b', '今天交付', 2, 3, 1),
      candidate('c', '容易开始', 2, 2, 3),
    ])
    expect(ranked.map((item) => item.candidate.id)).toEqual(['b', 'c', 'a'])
  })

  it('ignores blank candidates and explains the recommendation', () => {
    const recommendation = recommendLaunchCandidate([
      candidate('blank', '   ', 3, 3, 3),
      candidate('report', '修改报告', 3, 3, 2),
    ])
    expect(recommendation?.candidate.id).toBe('report')
    expect(recommendation?.reason).toContain('推荐只用于缩小选择')
  })
})

describe('launch flow rules', () => {
  it('creates at most three candidates for choose-task mode', () => {
    expect(createLaunchDraft('choose-task', 25).candidates).toHaveLength(3)
    expect(createLaunchDraft('known-task', 25).candidates).toHaveLength(0)
  })

  it('requires a task, first action and completion definition', () => {
    const launch = createLaunchDraft('known-task', 25)
    expect(validateLaunchDetails(launch)).toHaveLength(3)
    expect(validateLaunchDetails({ ...launch, taskName: '写报告', firstAction: '打开文档', completionDefinition: '改完第一段' })).toEqual([])
  })

  it('keeps low-energy sessions frictionless', () => {
    const launch = { ...createLaunchDraft('known-task', 25), taskCategory: 'reading' as const, energyBefore: 1 as const, resistanceBefore: 3 as const }
    expect(recommendLaunchWarmup(launch)).toBe('none')
  })
})
