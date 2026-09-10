import { evaluateAdaptiveDifficulty } from './adaptiveDifficulty'
import type { TaskAdaptationState, TaskResult, TaskType, TrainingSession } from '../types'

export type InsightTone = 'positive' | 'caution' | 'neutral'

export interface ResultComparison {
  label: string
  value: string
  detail: string
  tone: InsightTone
}

export interface ResultInsights {
  historyCount: number
  summary: string
  comparisons: ResultComparison[]
  errorTitle: string
  errorExplanation: string
  difficultyReason: string
  difficultyDirection: 'up' | 'down' | 'same'
  recommendation: string
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function signed(value: number, digits = 1) {
  if (Math.abs(value) < 0.05) return '0'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

function taskAdvice(taskType: TaskType, issue: 'omission' | 'commission' | 'tradeoff' | 'stable' | 'general') {
  const advice: Record<TaskType, Record<typeof issue, string>> = {
    schulte: {
      omission: '下一次让视线覆盖整个方格，找到目标后再点击。',
      commission: '下一次先确认数字是否为当前目标，再追求点击速度。',
      tradeoff: '下一次把误点控制住，再逐步缩短寻找时间。',
      stable: '下一次继续保持准确，并尝试减少逐行扫描。',
      general: '下一次先稳定搜索节奏，再观察速度是否自然提高。',
    },
    'go-no-go': {
      omission: '下一次把视线留在刺激区域中央，避免错过应该响应的目标。',
      commission: '下一次看到刺激后留出半拍确认，方块出现时要停住。',
      tradeoff: '下一次不要抢答，先把误按降下来再追求反应速度。',
      stable: '下一次保持当前节奏，继续区分“及时反应”和“及时停住”。',
      general: '下一次优先减少漏答与误按，再观察反应时间。',
    },
    vigilance: {
      omission: '下一次保持中心视野，并在等待阶段定期把注意带回信号区域。',
      commission: '下一次确认看到双环后再响应，单环只是干扰项。',
      tradeoff: '下一次降低抢答倾向，以识别正确的双环目标为先。',
      stable: '下一次继续保持等待节奏，不必为了更快而提前判断。',
      general: '下一次把重点放在稳定捕获目标，而不是单次最快反应。',
    },
    stroop: {
      omission: '下一次保持作答节奏，避免在冲突刺激上停留过久。',
      commission: '下一次先辨认字体颜色，再选择答案，暂时忽略文字含义。',
      tradeoff: '下一次放慢第一眼判断，先守住颜色识别的准确率。',
      stable: '下一次保持当前准确率，再逐渐缩短冲突刺激的判断时间。',
      general: '下一次优先执行“看颜色、不读字”的规则。',
    },
  }
  return advice[taskType][issue]
}

export function buildResultInsights(result: TaskResult, history: TrainingSession[], adaptation?: TaskAdaptationState): ResultInsights {
  const recent = [...history]
    .filter((item) => item.taskType === result.taskType)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .slice(-5)
  const level = evaluateAdaptiveDifficulty(result.taskType, result.level, history, result, adaptation)

  if (!recent.length) {
    const issue = result.errors === 0 ? 'stable' : result.omissions > result.commissions ? 'omission' : 'general'
    return {
      historyCount: 0,
      summary: '这是这项训练的第一条个人记录，之后的结果会从这里开始比较。',
      comparisons: [
        { label: '正确率', value: `${Math.round(result.accuracy * 100)}%`, detail: '建立个人起点', tone: 'neutral' },
        { label: '中位反应', value: result.medianReactionMs ? `${Math.round(result.medianReactionMs)}ms` : '暂无', detail: '建立个人起点', tone: 'neutral' },
      ],
      errorTitle: result.errors === 0 ? '本次没有记录到失误' : '先积累更多记录再判断错误模式',
      errorExplanation: result.errors === 0 ? '准确完成是继续提高速度的基础。' : '一次训练容易受状态影响，暂不把它解释成稳定特点。',
      difficultyReason: level.reason,
      difficultyDirection: level.direction,
      recommendation: taskAdvice(result.taskType, issue),
    }
  }

  const averageAccuracy = average(recent.map((item) => item.accuracy))
  const accuracyDelta = (result.accuracy - averageAccuracy) * 100
  const reactionHistory = recent.map((item) => item.medianReactionMs).filter((value) => value > 0)
  const averageReaction = average(reactionHistory)
  const reactionDeltaPercent = averageReaction && result.medianReactionMs
    ? ((averageReaction - result.medianReactionMs) / averageReaction) * 100
    : 0
  const averageErrors = average(recent.map((item) => item.errors))
  const faster = reactionDeltaPercent >= 5
  const moreErrors = result.errors >= Math.max(3, averageErrors + 1)

  let issue: 'omission' | 'commission' | 'tradeoff' | 'stable' | 'general' = 'general'
  let errorTitle = '错误数量接近近期水平'
  let errorExplanation = '当前没有明显偏向某一种错误，继续观察连续几次表现更可靠。'
  if (faster && moreErrors) {
    issue = 'tradeoff'
    errorTitle = '可能出现速度—准确率权衡'
    errorExplanation = '这次反应更快，但失误也高于近期平均；速度提升可能部分来自提前作答。'
  } else if (result.omissions >= 2 && result.omissions > result.commissions) {
    issue = 'omission'
    errorTitle = '漏答相对较多'
    errorExplanation = '可能是在等待过程中注意短暂离开，也可能只是本次状态波动。'
  } else if (result.commissions >= 2 && result.commissions > result.omissions) {
    issue = 'commission'
    errorTitle = result.taskType === 'schulte' ? '误点相对较多' : '误按相对较多'
    errorExplanation = '可能是反应节奏偏快，在确认目标或规则之前已经作答。'
  } else if (result.errors === 0) {
    issue = 'stable'
    errorTitle = '本次没有记录到失误'
    errorExplanation = '准确率保持稳定，可以在不牺牲正确率的前提下逐步提高速度。'
  }

  const accuracyImproved = accuracyDelta >= 1
  const speedImproved = reactionDeltaPercent >= 3
  const summary = accuracyImproved && speedImproved
    ? '这次正确率和反应速度都高于近期个人平均。'
    : accuracyImproved
      ? '这次主要进步来自正确率，速度变化不明显。'
      : speedImproved
        ? '这次主要进步来自反应速度，请同时留意失误是否增加。'
        : Math.abs(accuracyDelta) < 1 && Math.abs(reactionDeltaPercent) < 3
          ? '这次表现与近期个人平均接近。'
          : '这次部分指标低于近期平均，先把它视为一次状态记录。'

  return {
    historyCount: recent.length,
    summary,
    comparisons: [
      {
        label: '正确率变化',
        value: `${signed(accuracyDelta)} 个百分点`,
        detail: `本次 ${Math.round(result.accuracy * 100)}% · 近期 ${Math.round(averageAccuracy * 100)}%`,
        tone: accuracyDelta >= 1 ? 'positive' : accuracyDelta <= -1 ? 'caution' : 'neutral',
      },
      {
        label: '反应速度变化',
        value: !averageReaction || !result.medianReactionMs
          ? '暂无可比数据'
          : `${reactionDeltaPercent >= 0 ? '快' : '慢'} ${Math.abs(reactionDeltaPercent).toFixed(0)}%`,
        detail: !averageReaction || !result.medianReactionMs
          ? '该任务没有足够反应时记录'
          : `本次 ${Math.round(result.medianReactionMs)}ms · 近期 ${Math.round(averageReaction)}ms`,
        tone: reactionDeltaPercent >= 3 ? 'positive' : reactionDeltaPercent <= -3 ? 'caution' : 'neutral',
      },
    ],
    errorTitle,
    errorExplanation,
    difficultyReason: level.reason,
    difficultyDirection: level.direction,
    recommendation: taskAdvice(result.taskType, issue),
  }
}
