import { useState } from 'react'
import type { TaskAdaptationState, TaskResult, TaskType, TrainingSession } from '../types'
import { GoNoGoTask } from '../tasks/GoNoGoTask'
import { SchulteTask } from '../tasks/SchulteTask'
import { StroopTask } from '../tasks/StroopTask'
import { VigilanceTask } from '../tasks/VigilanceTask'
import { MixedTrainingTask } from '../tasks/MixedTrainingTask'

type TrainingEntry = TaskType | 'mixed'

const taskCards: { type: TrainingEntry; number: string; title: string; skill: string; description: string; tone: string }[] = [
  { type: 'schulte', number: '01', title: '舒尔特方格', skill: '视觉搜索', description: '在随机数字中快速定位目标，同时保持准确。', tone: 'mint' },
  { type: 'vigilance', number: '02', title: '信号监测', skill: '持续注意', description: '在重复刺激中等待稀少目标，观察注意波动。', tone: 'blue' },
  { type: 'go-no-go', number: '03', title: '停得住', skill: '反应抑制', description: '形成反应惯性后，在关键刺激出现时及时停住。', tone: 'coral' },
  { type: 'stroop', number: '04', title: '冲突判断', skill: '抗干扰', description: '在颜色、方向和大小冲突中，抑制自动反应。', tone: 'gold' },
  { type: 'mixed', number: '05', title: '5分钟训练包', skill: '混合训练', description: '把两种短任务串联起来，练习后再分别记录正式结果。', tone: 'violet' },
]

interface TrainingPageProps {
  initialTask?: TaskType | null
  levels: Record<TaskType, number>
  sessions: TrainingSession[]
  adaptation: Record<TaskType, TaskAdaptationState>
  onSave: (result: TaskResult) => void
  onSaveMany: (results: TaskResult[]) => void
  onSelectConsumed: () => void
}

export function TrainingPage({ initialTask, levels, sessions, adaptation, onSave, onSaveMany, onSelectConsumed }: TrainingPageProps) {
  const [selected, setSelected] = useState<TrainingEntry | null>(initialTask ?? null)

  function finish(result: TaskResult) {
    onSave(result)
    setSelected(null)
    onSelectConsumed()
  }

  function exit() {
    setSelected(null)
    onSelectConsumed()
  }

  function finishMixed(results: TaskResult[]) {
    onSaveMany(results)
    setSelected(null)
    onSelectConsumed()
  }

  if (selected === 'schulte') return <div className="page-width task-page"><SchulteTask size={5} level={levels.schulte} history={sessions} adaptation={adaptation.schulte} onComplete={finish} onExit={exit} /></div>
  if (selected === 'go-no-go') return <div className="page-width task-page"><GoNoGoTask level={levels['go-no-go']} history={sessions} adaptation={adaptation['go-no-go']} onComplete={finish} onExit={exit} /></div>
  if (selected === 'vigilance') return <div className="page-width task-page"><VigilanceTask level={levels.vigilance} history={sessions} adaptation={adaptation.vigilance} onComplete={finish} onExit={exit} /></div>
  if (selected === 'stroop') return <div className="page-width task-page"><StroopTask level={levels.stroop} history={sessions} adaptation={adaptation.stroop} onComplete={finish} onExit={exit} /></div>
  if (selected === 'mixed') return <div className="page-width task-page"><MixedTrainingTask levels={levels} history={sessions} adaptation={adaptation} onComplete={finishMixed} onExit={exit} /></div>

  return (
    <section className="page-width inner-page">
      <div className="page-title-row">
        <div><p className="eyebrow">训练中心</p><h1>一次只练一种能力</h1><p>选择一项短训练。系统会综合最近表现，稳定地调整下一次训练参数。</p></div>
        <div className="level-legend"><i /> 当前难度会自动保存</div>
      </div>
      <div className="training-grid">
        {taskCards.map((task) => (
          <article key={task.type} className={`training-card ${task.tone}`}>
            <div className="training-card-top"><span>{task.number}</span><small>{task.type === 'mixed' ? '约 5 分钟' : `等级 ${levels[task.type]}`}</small></div>
            <div className={`training-art ${task.type}`}><i /><i /><i /><i /></div>
            <p>{task.skill}</p>
            <h2>{task.title}</h2>
            <div className="card-description">{task.description}</div>
            <button type="button" onClick={() => setSelected(task.type)}>开始训练 <span>→</span></button>
          </article>
        ))}
      </div>
      <div className="boundary-note"><strong>为什么没有“脑年龄”？</strong><p>当前版本只展示个人变化。没有可靠常模时，用一个好看的数字评价一个人的大脑并不诚实。</p></div>
    </section>
  )
}
