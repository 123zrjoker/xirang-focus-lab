import type { LaunchCandidate } from '../types'

export interface TaskRecommendation {
  candidate: LaunchCandidate
  score: number
  reason: string
}

export function taskSelectionScore(candidate: LaunchCandidate) {
  return candidate.importance * 2 + candidate.urgency * 2 + candidate.startability
}

export function rankLaunchCandidates(candidates: LaunchCandidate[]) {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: taskSelectionScore(candidate) }))
    .sort((a, b) => b.score - a.score
      || b.candidate.urgency - a.candidate.urgency
      || b.candidate.startability - a.candidate.startability
      || a.index - b.index)
}

export function recommendLaunchCandidate(candidates: LaunchCandidate[]): TaskRecommendation | null {
  const ranked = rankLaunchCandidates(candidates.filter((candidate) => candidate.title.trim()))
  const top = ranked[0]
  if (!top) return null

  const strengths: string[] = []
  if (top.candidate.importance === 3) strengths.push('它对当前目标很重要')
  if (top.candidate.urgency === 3) strengths.push('今天继续拖延的代价较高')
  if (top.candidate.startability === 3) strengths.push('现在比较容易迈出第一步')
  if (!strengths.length) strengths.push('它在重要性、紧迫性和可启动性之间更平衡')

  return {
    candidate: top.candidate,
    score: top.score,
    reason: `${strengths.slice(0, 2).join('，')}。推荐只用于缩小选择，你仍然可以改选其他任务。`,
  }
}

