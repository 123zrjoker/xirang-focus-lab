import { useEffect, useMemo, useRef, useState } from 'react'
import type { LaunchWarmupResult } from '../types'

interface LaunchWarmupProps {
  type: LaunchWarmupResult['type']
  onComplete: (result: LaunchWarmupResult) => void
  onSkip: () => void
}

function shuffledNumbers() {
  const values = Array.from({ length: 9 }, (_, index) => index + 1)
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1))
    ;[values[index], values[target]] = [values[target], values[index]]
  }
  return values
}

export function LaunchWarmup({ type, onComplete, onSkip }: LaunchWarmupProps) {
  const [remaining, setRemaining] = useState(60)
  const [correctCount, setCorrectCount] = useState(0)
  const [errorCount, setErrorCount] = useState(0)
  const [target, setTarget] = useState(1)
  const [board, setBoard] = useState(() => shuffledNumbers())
  const [stimulus, setStimulus] = useState<'go' | 'stop'>('go')
  const startedAt = useMemo(() => Date.now(), [])
  const completedRef = useRef(false)

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = Math.max(0, 60 - Math.floor((Date.now() - startedAt) / 1000))
      setRemaining(next)
      if (next === 0) window.clearInterval(timer)
    }, 200)
    return () => window.clearInterval(timer)
  }, [startedAt])

  useEffect(() => {
    if (type !== 'inhibition') return
    const timer = window.setInterval(() => setStimulus(Math.random() < 0.28 ? 'stop' : 'go'), 850)
    return () => window.clearInterval(timer)
  }, [type])

  useEffect(() => {
    if (remaining !== 0 || completedRef.current) return
    completedRef.current = true
    onComplete({
      type,
      durationSec: Math.min(60, Math.max(1, Math.round((Date.now() - startedAt) / 1000))),
      correctCount,
      errorCount,
      completedAt: new Date().toISOString(),
    })
  }, [correctCount, errorCount, onComplete, remaining, startedAt, type])

  function selectNumber(value: number) {
    if (value !== target) {
      setErrorCount((count) => count + 1)
      return
    }
    setCorrectCount((count) => count + 1)
    if (target === 9) {
      setTarget(1)
      setBoard(shuffledNumbers())
    } else {
      setTarget((current) => current + 1)
    }
  }

  function respondToStimulus() {
    if (stimulus === 'go') setCorrectCount((count) => count + 1)
    else setErrorCount((count) => count + 1)
  }

  return (
    <section className="launch-warmup page-width">
      <div className="launch-warmup-copy">
        <p className="eyebrow">60 秒启动热身 · 不计入正式训练</p>
        <h1>{type === 'visual' ? '把视线带回眼前。' : '先停住自动反应。'}</h1>
        <p>{type === 'visual' ? `从 1 开始依次点击，当前寻找 ${target}。` : '绿色时点击，红色“停”出现时不要点击。'}</p>
        <strong>{remaining}</strong>
        <small>完成后会自动进入现实专注</small>
      </div>
      <div className="launch-warmup-card card-surface">
        {type === 'visual' ? (
          <div className="launch-mini-grid">
            {board.map((value) => <button key={value} type="button" onClick={() => selectNumber(value)}>{value}</button>)}
          </div>
        ) : (
          <button className={`launch-inhibition-stimulus ${stimulus}`} type="button" onClick={respondToStimulus}>
            <span>{stimulus === 'go' ? '点' : '停'}</span>
            <small>{stimulus === 'go' ? '现在点击' : '不要点击'}</small>
          </button>
        )}
        <div className="launch-warmup-stats"><span>正确 <strong>{correctCount}</strong></span><span>误触 <strong>{errorCount}</strong></span></div>
        <button className="button text-button" type="button" onClick={onSkip}>结束热身，立即开始专注 →</button>
      </div>
    </section>
  )
}
