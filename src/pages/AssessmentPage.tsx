import { useState } from 'react'
import { AssessmentComparison } from '../components/AssessmentComparison'
import { ProfileRadar } from '../components/ProfileRadar'
import {
  assessmentKindLabel,
  getFormalAssessments,
} from '../lib/assessment'
import { clamp } from '../lib/metrics'
import { GoNoGoTask } from '../tasks/GoNoGoTask'
import { SchulteTask } from '../tasks/SchulteTask'
import { StroopTask } from '../tasks/StroopTask'
import type {
  AssessmentContext,
  AssessmentKind,
  AssessmentRecord,
  AttentionProfile,
  GoalType,
  TaskResult,
} from '../types'

interface AssessmentPageProps {
  mode?: 'baseline' | 'retest'
  retestKind?: Exclude<AssessmentKind, 'baseline'>
  assessments?: AssessmentRecord[]
  initialGoal?: GoalType
  onExit: () => void
  onFinish: (
    profile: AttentionProfile,
    results: TaskResult[],
    goal: GoalType,
    context: AssessmentContext,
    kind: AssessmentKind,
  ) => void
}

function initialContext(): AssessmentContext {
  const device = window.innerWidth <= 720 ? 'mobile' : window.innerWidth <= 1024 ? 'tablet' : 'desktop'
  return {
    device,
    inputMethod: navigator.maxTouchPoints > 0 && device !== 'desktop' ? 'touch' : 'mouse',
    sleepQuality: 2,
    fatigueLevel: 2,
    environment: 'quiet',
    interrupted: false,
  }
}

export function AssessmentPage({
  mode = 'baseline',
  retestKind = 'retest',
  assessments = [],
  initialGoal = 'study',
  onExit,
  onFinish,
}: AssessmentPageProps) {
  const [step, setStep] = useState(0)
  const [goal, setGoal] = useState<GoalType>(initialGoal)
  const [context, setContext] = useState<AssessmentContext>(initialContext)
  const [results, setResults] = useState<TaskResult[]>([])
  const [profile, setProfile] = useState<AttentionProfile | null>(null)
  const previousFormal = getFormalAssessments(assessments).at(-1)

  function acceptResult(result: TaskResult) {
    const next = [...results, result]
    setResults(next)
    if (step < 3) setStep((current) => current + 1)
  }

  function finishStroop(result: TaskResult) {
    const next = [...results, result]
    setResults(next)
    const schulte = next.find((item) => item.taskType === 'schulte')!
    const goNoGo = next.find((item) => item.taskType === 'go-no-go')!
    const nextProfile: AttentionProfile = {
      completedAt: new Date().toISOString(),
      visualSearch: clamp(schulte.score),
      sustainedAttention: clamp(Math.round(100 - goNoGo.omissions * 10 - goNoGo.commissions * 5)),
      interferenceControl: clamp(result.score),
      responseInhibition: clamp(Math.round(goNoGo.accuracy * 100)),
    }
    setProfile(nextProfile)
    setStep(4)
  }

  function restart() {
    setStep(0)
    setResults([])
    setProfile(null)
    setContext((current) => ({ ...current, interrupted: false }))
  }

  if (step === 1) return <div className="page-width task-page"><SchulteTask size={4} assessment onComplete={acceptResult} onExit={onExit} /></div>
  if (step === 2) return <div className="page-width task-page"><GoNoGoTask assessment onComplete={acceptResult} onExit={onExit} /></div>
  if (step === 3) return <div className="page-width task-page"><StroopTask assessment onComplete={finishStroop} onExit={onExit} /></div>

  if (step === 4 && profile) {
    const strongest = [
      ['视觉搜索', profile.visualSearch],
      ['持续稳定', profile.sustainedAttention],
      ['抗干扰', profile.interferenceControl],
      ['反应抑制', profile.responseInhibition],
    ].sort((a, b) => Number(b[1]) - Number(a[1]))

    if (mode === 'retest' && previousFormal) {
      return (
        <section className="assessment-retest-result page-width">
          <div className="retest-result-heading">
            <div><p className="eyebrow">{assessmentKindLabel(retestKind)}完成</p><h1>把这次变化，放回时间里看。</h1><p>变化量只描述任务表现。训练熟悉度、设备和当天状态都可能影响结果。</p></div>
            <span>{retestKind === 'quick-check' ? '不替代正式复测' : '单独保存为阶段记录'}</span>
          </div>
          <AssessmentComparison
            previous={previousFormal.profile}
            current={profile}
            previousContext={previousFormal.context}
            currentContext={context}
            previousLabel="上次正式测评"
            currentLabel={assessmentKindLabel(retestKind)}
            showPracticeEffect={retestKind === 'quick-check' || assessments.filter((item) => item.kind === 'retest').length < 3}
          />
          <div className="retest-result-actions card-surface">
            <button type="button" className={`interruption-toggle ${context.interrupted ? 'active' : ''}`} onClick={() => setContext((current) => ({ ...current, interrupted: !current.interrupted }))}>
              <i>{context.interrupted ? '✓' : ''}</i><span><strong>测评过程中受到明显打断</strong><small>勾选后，本次会标记为可比性较低。</small></span>
            </button>
            <div className="button-row"><button className="button secondary" type="button" onClick={restart}>重新测评</button><button className="button primary" type="button" onClick={() => onFinish(profile, results, goal, context, retestKind)}>保存本次记录 →</button></div>
          </div>
        </section>
      )
    }

    return (
      <section className="assessment-result page-width">
        <div className="result-copy">
          <p className="eyebrow">初始测评完成</p>
          <h1>这是你的第一张<br />注意表现快照</h1>
          <p>当前相对优势是<strong>{strongest[0][0]}</strong>，建议优先练习<strong>{strongest[3][0]}</strong>。这些是任务指数，不是医学结论或人群排名。</p>
          <div className="button-row"><button className="button secondary" type="button" onClick={restart}>重新测评</button><button className="button primary" type="button" onClick={() => onFinish(profile, results, goal, context, 'baseline')}>生成我的计划 →</button></div>
        </div>
        <div className="profile-card">
          <ProfileRadar profile={profile} />
          <div className="profile-values"><span>视觉搜索<strong>{profile.visualSearch}</strong></span><span>持续稳定<strong>{profile.sustainedAttention}</strong></span><span>抗干扰<strong>{profile.interferenceControl}</strong></span><span>反应抑制<strong>{profile.responseInhibition}</strong></span></div>
        </div>
      </section>
    )
  }

  return (
    <section className="assessment-intro page-width">
      <button className="back-link" type="button" onClick={onExit}>← {mode === 'retest' ? '返回进度页' : '返回首页'}</button>
      <div className="assessment-layout">
        <div>
          <p className="eyebrow">{mode === 'retest' ? assessmentKindLabel(retestKind) : '5 分钟初始测评'}</p>
          <h1>{mode === 'retest' ? <>用相近的条件，<br />比较不同阶段。</> : <>先了解现在的你，<br />再决定怎么练。</>}</h1>
          <p className="lead">{mode === 'retest' ? '三项任务会重新随机刺激，但仍可能受到练习熟悉效应影响。开始前请记录这次环境。' : '三项短任务会建立你的个人基线。结果只用于今后和自己比较。'}</p>
          {mode === 'baseline' && <><h3>你最想改善什么？</h3><div className="goal-options"><button className={goal === 'study' ? 'active' : ''} onClick={() => setGoal('study')}><i>01</i><span><strong>学习更专注</strong><small>阅读、课程与备考</small></span></button><button className={goal === 'work' ? 'active' : ''} onClick={() => setGoal('work')}><i>02</i><span><strong>工作更高效</strong><small>深度工作与任务完成</small></span></button><button className={goal === 'phone' ? 'active' : ''} onClick={() => setGoal('phone')}><i>03</i><span><strong>减少手机分心</strong><small>找回对使用节奏的掌控</small></span></button></div></>}

          <div className="assessment-context-form">
            <div><strong>本次设备</strong><span>{([['desktop', '电脑'], ['tablet', '平板'], ['mobile', '手机']] as const).map(([value, label]) => <button type="button" key={value} className={context.device === value ? 'active' : ''} onClick={() => setContext((current) => ({ ...current, device: value }))}>{label}</button>)}</span></div>
            <div><strong>输入方式</strong><span>{([['mouse', '鼠标'], ['trackpad', '触控板'], ['touch', '触屏'], ['keyboard', '键盘']] as const).map(([value, label]) => <button type="button" key={value} className={context.inputMethod === value ? 'active' : ''} onClick={() => setContext((current) => ({ ...current, inputMethod: value }))}>{label}</button>)}</span></div>
            <div><strong>昨晚睡眠</strong><span>{([[3, '充足'], [2, '一般'], [1, '不足']] as const).map(([value, label]) => <button type="button" key={value} className={context.sleepQuality === value ? 'active' : ''} onClick={() => setContext((current) => ({ ...current, sleepQuality: value }))}>{label}</button>)}</span></div>
            <div><strong>当前疲劳</strong><span>{([[1, '轻微'], [2, '一般'], [3, '明显']] as const).map(([value, label]) => <button type="button" key={value} className={context.fatigueLevel === value ? 'active' : ''} onClick={() => setContext((current) => ({ ...current, fatigueLevel: value }))}>{label}</button>)}</span></div>
            <div><strong>周围环境</strong><span>{([['quiet', '安静'], ['some-noise', '少量干扰'], ['disrupted', '干扰明显']] as const).map(([value, label]) => <button type="button" key={value} className={context.environment === value ? 'active' : ''} onClick={() => setContext((current) => ({ ...current, environment: value }))}>{label}</button>)}</span></div>
          </div>
          <button className="button primary large" type="button" onClick={() => setStep(1)}>开始三项测评 →</button>
        </div>
        <aside className="assessment-roadmap">
          <p>{mode === 'retest' ? '本次阶段对照' : '本次测评'}</p>
          <ol><li><span>1</span><div><strong>视觉搜索</strong><small>舒尔特方格 · 约 1 分钟</small></div></li><li><span>2</span><div><strong>反应抑制</strong><small>Go / No-Go · 约 2 分钟</small></div></li><li><span>3</span><div><strong>抗干扰</strong><small>色词判断 · 约 2 分钟</small></div></li></ol>
          <div className="privacy-note"><i>✓</i><p><strong>{mode === 'retest' ? '与日常训练分开保存' : '你的数据留在此设备'}</strong><small>{mode === 'retest' ? '不会计入训练次数或自适应难度。' : '清除浏览器数据会同时清除记录。'}</small></p></div>
        </aside>
      </div>
    </section>
  )
}
