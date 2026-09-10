import { useEffect, useState } from 'react'
import { AppShell } from './components/AppShell'
import { AssessmentPage } from './pages/AssessmentPage'
import { FocusPage } from './pages/FocusPage'
import { HomePage } from './pages/HomePage'
import { LaunchPage } from './pages/LaunchPage'
import { NotesPage } from './pages/NotesPage'
import { ProgressPage } from './pages/ProgressPage'
import { SettingsPage } from './pages/SettingsPage'
import { TodayPage } from './pages/TodayPage'
import { TrainingPage } from './pages/TrainingPage'
import { clearActiveFocus, clearActiveLaunch, clearStoredState, createDefaultState, loadActiveFocus, loadActiveLaunch, loadState, saveActiveLaunch, saveState, toTrainingSession } from './lib/storage'
import { playCompletionSound } from './lib/feedback'
import { buildDailyPlan, getTodayPlan } from './lib/planner'
import { evaluateAdaptiveDifficulty } from './lib/adaptiveDifficulty'
import { getRetestStatus } from './lib/assessment'
import { createLaunchDraft, toFocusLaunchContext } from './lib/launchFlow'
import { attachFocusToActionSlips, completeActionSlip, createActionSlip, MAX_ACTION_SLIPS, reopenActionSlip, setCurrentActionSlip, updateActionSlipTitle } from './lib/actionSlips'
import { createPersonalNote, MAX_PERSONAL_NOTES, updatePersonalNote } from './lib/personalNotes'
import { clearKnowledgeBase, deleteKnowledgeSourcesForNote } from './lib/knowledgeBase'
import type {
  ActionSlip,
  AppSettings,
  AppState,
  AssessmentContext,
  AssessmentKind,
  AssessmentRecord,
  AttentionProfile,
  DailyPlanMode,
  FocusSession,
  FocusLaunchSession,
  GoalType,
  LaunchMode,
  Page,
  TaskResult,
  TaskType,
  UserProfile,
} from './types'

function pageFromHash(): Page {
  const value = window.location.hash.replace('#/', '') as Page
  return ['home', 'today', 'notes', 'launch', 'training', 'focus', 'progress', 'settings', 'assessment'].includes(value) ? value : 'home'
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [page, setPage] = useState<Page>(() => pageFromHash())
  const [selectedTask, setSelectedTask] = useState<TaskType | null>(null)
  const [selectedFocusMinutes, setSelectedFocusMinutes] = useState<number | null>(null)
  const [selectedFocusTask, setSelectedFocusTask] = useState<string | null>(null)
  const [selectedActionSlipId, setSelectedActionSlipId] = useState<string | null>(null)
  const [activeLaunch, setActiveLaunch] = useState<FocusLaunchSession | null>(() => loadActiveLaunch())
  const [assessmentMode, setAssessmentMode] = useState<'baseline' | 'retest'>(() => state.profile.onboardingComplete ? 'retest' : 'baseline')

  useEffect(() => saveState(state), [state])

  useEffect(() => {
    if (activeLaunch) saveActiveLaunch(activeLaunch)
    else clearActiveLaunch()
  }, [activeLaunch])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('motion-off', !state.settings.animationsEnabled)
    root.classList.toggle('training-tips-off', !state.settings.trainingTipsEnabled)
  }, [state.settings.animationsEnabled, state.settings.trainingTipsEnabled])

  useEffect(() => {
    if (page !== 'today') return
    setState((current) => {
      if (getTodayPlan(current)) return current
      return { ...current, dailyPlans: [...current.dailyPlans, buildDailyPlan(current)] }
    })
  }, [page])

  useEffect(() => {
    const handleHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  function navigate(nextPage: Page) {
    setSelectedFocusMinutes(null)
    setSelectedFocusTask(null)
    setSelectedActionSlipId(null)
    if (nextPage === 'launch' && loadActiveFocus()) nextPage = 'focus'
    if (nextPage === 'assessment') setAssessmentMode(state.profile.onboardingComplete ? 'retest' : 'baseline')
    window.location.hash = `/${nextPage}`
    setPage(nextPage)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function startRetest() {
    setAssessmentMode('retest')
    window.location.hash = '/assessment'
    setPage('assessment')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function startTask(task: TaskType) {
    setSelectedTask(task)
    navigate('training')
  }

  function startSuggestedFocus(minutes: number) {
    setSelectedFocusMinutes(minutes)
    setSelectedFocusTask(null)
    setSelectedActionSlipId(null)
    window.location.hash = '/focus'
    setPage('focus')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function openActionSlipFocus(slip: ActionSlip, assisted: boolean) {
    if (loadActiveFocus()) {
      navigate('focus')
      return
    }
    const now = new Date().toISOString()
    setState((current) => ({ ...current, actionSlips: setCurrentActionSlip(current.actionSlips, slip.id, now) }))
    if (assisted) {
      createLaunch('known-task', slip.title, slip.id)
      return
    }
    setSelectedFocusMinutes(state.profile.preferredFocusMinutes)
    setSelectedFocusTask(slip.title)
    setSelectedActionSlipId(slip.id)
    window.location.hash = '/focus'
    setPage('focus')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function addActionSlip(title: string, startNow = false) {
    const slip = createActionSlip(title)
    if (!slip.title) return
    setState((current) => ({
      ...current,
      actionSlips: startNow
        ? setCurrentActionSlip([...current.actionSlips, slip].slice(-MAX_ACTION_SLIPS), slip.id)
        : [...current.actionSlips, slip].slice(-MAX_ACTION_SLIPS),
    }))
    if (startNow) {
      setSelectedFocusMinutes(state.profile.preferredFocusMinutes)
      setSelectedFocusTask(slip.title)
      setSelectedActionSlipId(slip.id)
      window.location.hash = '/focus'
      setPage('focus')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  function createLaunch(mode: LaunchMode, taskName = '', actionSlipId?: string) {
    if (loadActiveFocus()) {
      navigate('focus')
      return
    }
    const launch = createLaunchDraft(mode, state.profile.preferredFocusMinutes, actionSlipId)
    setActiveLaunch(taskName ? { ...launch, taskName } : launch)
    if (actionSlipId) setState((current) => ({ ...current, actionSlips: setCurrentActionSlip(current.actionSlips, actionSlipId) }))
    navigate('launch')
  }

  function cancelLaunch() {
    setActiveLaunch(null)
    navigate(state.profile.onboardingComplete ? 'today' : 'home')
  }

  function beginLaunchFocus(launch: FocusLaunchSession) {
    const now = new Date().toISOString()
    const createdSlip = launch.actionSlipId ? null : { ...createActionSlip(launch.taskName, now), sourceLaunchId: launch.id }
    const actionSlipId = launch.actionSlipId ?? createdSlip!.id
    const focusingLaunch: FocusLaunchSession = { ...launch, status: 'focusing', updatedAt: now, actionSlipId }
    setActiveLaunch(focusingLaunch)
    setState((current) => {
      const otherCandidates = launch.candidates
        .filter((candidate) => candidate.title.trim() && candidate.id !== launch.selectedCandidateId)
        .map((candidate) => ({ ...createActionSlip(candidate.title.trim(), now), sourceLaunchId: launch.id }))
      const existingTitles = new Set(current.actionSlips.filter((slip) => slip.status !== 'completed').map((slip) => slip.title.toLocaleLowerCase()))
      const uniqueCandidates = otherCandidates.filter((slip) => {
        const key = slip.title.toLocaleLowerCase()
        if (existingTitles.has(key)) return false
        existingTitles.add(key)
        return true
      })
      const focusLaunches = [...current.focusLaunches.filter((item) => item.id !== launch.id), focusingLaunch].slice(-500)
      const withCandidates = [...current.actionSlips, ...(createdSlip ? [createdSlip] : []), ...uniqueCandidates].slice(-MAX_ACTION_SLIPS)
      const actionSlips = setCurrentActionSlip(withCandidates, actionSlipId, now)
      return { ...current, focusLaunches, actionSlips }
    })
    setSelectedFocusMinutes(launch.plannedDurationMin)
    window.location.hash = '/focus'
    setPage('focus')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function addTraining(result: TaskResult) {
    addTrainingResults([result])
  }

  function addTrainingResults(results: TaskResult[]) {
    if (state.settings.soundEnabled) playCompletionSound()
    setState((current) => {
      let sessions = [...current.sessions]
      const levels = { ...current.profile.levels }
      const adaptation = { ...current.profile.adaptation }
      results.forEach((result) => {
        const currentLevel = levels[result.taskType]
        const decision = evaluateAdaptiveDifficulty(result.taskType, currentLevel, sessions, result, adaptation[result.taskType])
        sessions = [...sessions, toTrainingSession(result)]
        levels[result.taskType] = decision.nextLevel
        adaptation[result.taskType] = decision.nextState
      })
      return {
        ...current,
        sessions,
        profile: {
          ...current.profile,
          levels,
          adaptation,
        },
      }
    })
  }

  function finishAssessment(
    profile: AttentionProfile,
    results: TaskResult[],
    goal: GoalType,
    context: AssessmentContext,
    kind: AssessmentKind,
  ) {
    const record: AssessmentRecord = {
      id: crypto.randomUUID(),
      kind,
      completedAt: profile.completedAt,
      profile,
      results,
      context,
    }
    setState((current) => ({
      ...current,
      attentionProfile: kind === 'baseline' ? profile : current.attentionProfile,
      assessments: [...(current.assessments ?? []), record],
      profile: { ...current.profile, goal, onboardingComplete: true },
    }))
    navigate(kind === 'baseline' ? 'today' : 'progress')
  }

  function addFocus(session: FocusSession) {
    setState((current) => ({
      ...current,
      focusSessions: [...current.focusSessions, session],
      actionSlips: attachFocusToActionSlips(current.actionSlips, session),
      focusLaunches: session.launchId
        ? current.focusLaunches.map((launch) => launch.id === session.launchId
          ? { ...launch, status: 'completed', focusSessionId: launch.focusSessionId ?? session.id, completedAt: launch.completedAt ?? session.completedAt, updatedAt: session.completedAt }
          : launch)
        : current.focusLaunches,
    }))
    if (session.launchId && activeLaunch?.id === session.launchId) setActiveLaunch(null)
  }

  function updateProfile(patch: Partial<UserProfile>) {
    setState((current) => ({ ...current, profile: { ...current.profile, ...patch } }))
  }

  function updateSettings(patch: Partial<AppSettings>) {
    setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }))
  }

  async function clearAllData() {
    clearStoredState()
    setActiveLaunch(null)
    setState(createDefaultState())
    await clearKnowledgeBase()
  }

  function replaceState(nextState: AppState) {
    clearActiveFocus()
    clearActiveLaunch()
    setActiveLaunch(null)
    setState(nextState)
  }

  function changeTodayPlan(mode: DailyPlanMode) {
    setState((current) => {
      const plan = buildDailyPlan(current, mode)
      const plans = [...current.dailyPlans.filter((item) => item.dateKey !== plan.dateKey), plan]
        .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
        .slice(-90)
      return { ...current, dailyPlans: plans }
    })
  }

  const todayPlan = getTodayPlan(state) ?? buildDailyPlan(state)
  const retestStatus = getRetestStatus(state.assessments ?? [], state.sessions)
  const todayFocusMinutes = Math.round(state.focusSessions
    .filter((item) => new Date(item.completedAt).toDateString() === new Date().toDateString())
    .reduce((sum, item) => sum + item.actualDurationSec, 0) / 60)
  const currentActionSlip = [...state.actionSlips].reverse().find((slip) => slip.status === 'current')

  let content
  if (page === 'assessment') content = (
    <AssessmentPage
      mode={assessmentMode}
      retestKind={retestStatus.nextKind}
      assessments={state.assessments ?? []}
      initialGoal={state.profile.goal}
      onExit={() => navigate(assessmentMode === 'retest' ? 'progress' : 'home')}
      onFinish={finishAssessment}
    />
  )
  else if (page === 'today') content = (
    <TodayPage
      state={state}
      plan={todayPlan}
      onNavigate={navigate}
      onStartTask={startTask}
      onStartFocus={startSuggestedFocus}
      onStartLaunch={createLaunch}
      onChangePlanMode={changeTodayPlan}
    />
  )
  else if (page === 'notes') content = (
    <NotesPage
      actionSlips={state.actionSlips}
      personalNotes={state.personalNotes}
      focusSessions={state.focusSessions}
      onAdd={addActionSlip}
      onStart={openActionSlipFocus}
      onComplete={(id) => setState((current) => ({ ...current, actionSlips: completeActionSlip(current.actionSlips, id) }))}
      onReopen={(id) => setState((current) => ({ ...current, actionSlips: reopenActionSlip(current.actionSlips, id) }))}
      onUpdate={(id, title) => setState((current) => ({ ...current, actionSlips: updateActionSlipTitle(current.actionSlips, id, title) }))}
      onRemove={(id) => setState((current) => ({ ...current, actionSlips: current.actionSlips.filter((slip) => slip.id !== id) }))}
      onAddNote={(title, content) => setState((current) => {
        const note = createPersonalNote(title, content)
        return note ? { ...current, personalNotes: [...current.personalNotes, note].slice(-MAX_PERSONAL_NOTES) } : current
      })}
      onUpdateNote={(id, title, content) => setState((current) => ({
        ...current,
        personalNotes: updatePersonalNote(current.personalNotes, id, title, content),
      }))}
      onRemoveNote={(id) => {
        setState((current) => ({
          ...current,
          personalNotes: current.personalNotes.filter((note) => note.id !== id),
        }))
        void deleteKnowledgeSourcesForNote(id).catch((error) => console.error('移除笔记知识快照失败', error))
      }}
    />
  )
  else if (page === 'launch') content = (
    <LaunchPage
      launch={activeLaunch}
      actionSlips={state.actionSlips.filter((slip) => slip.status === 'inbox').slice(-20).reverse()}
      onChange={setActiveLaunch}
      onCreate={createLaunch}
      onCancel={cancelLaunch}
      onStartFocus={beginLaunchFocus}
      onRemoveActionSlip={(id) => setState((current) => ({ ...current, actionSlips: current.actionSlips.filter((slip) => slip.id !== id) }))}
    />
  )
  else if (page === 'training') content = <TrainingPage initialTask={selectedTask} levels={state.profile.levels} adaptation={state.profile.adaptation} sessions={state.sessions} onSave={addTraining} onSaveMany={addTrainingResults} onSelectConsumed={() => setSelectedTask(null)} />
  else if (page === 'focus') content = (
    <FocusPage
      preferredMinutes={state.profile.preferredFocusMinutes}
      initialMinutes={selectedFocusMinutes ?? undefined}
      initialTaskName={selectedFocusTask ?? currentActionSlip?.title}
      actionSlipId={selectedActionSlipId ?? currentActionSlip?.id}
      dailyTargetMinutes={state.profile.dailyTargetMinutes}
      todayFocusMinutes={todayFocusMinutes}
      soundEnabled={state.settings.soundEnabled}
      desktopNotificationsEnabled={state.settings.desktopNotificationsEnabled}
      launchContext={activeLaunch?.status === 'focusing' ? toFocusLaunchContext(activeLaunch) : undefined}
      onSave={addFocus}
      onAddActionSlip={(title) => addActionSlip(title)}
      onReturnToday={() => navigate('today')}
    />
  )
  else if (page === 'progress') content = <ProgressPage state={state} onStartRetest={startRetest} />
  else if (page === 'settings') content = (
    <SettingsPage
      state={state}
      onUpdateProfile={updateProfile}
      onUpdateSettings={updateSettings}
      onReplaceState={replaceState}
      onClear={clearAllData}
    />
  )
  else content = <HomePage hasProfile={state.profile.onboardingComplete} onNavigate={navigate} onQuickTask={() => startTask('schulte')} />

  return <AppShell page={page} onNavigate={navigate}>{content}</AppShell>
}
