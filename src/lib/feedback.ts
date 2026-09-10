let audioContext: AudioContext | null = null

export function prepareFeedbackAudio() {
  try {
    audioContext ??= new AudioContext()
    if (audioContext.state === 'suspended') void audioContext.resume()
  } catch {
    audioContext = null
  }
}

export function playCompletionSound() {
  try {
    prepareFeedbackAudio()
    if (!audioContext) return
    const start = audioContext.currentTime
    const gain = audioContext.createGain()
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55)
    gain.connect(audioContext.destination)

    ;[523.25, 659.25].forEach((frequency, index) => {
      const oscillator = audioContext!.createOscillator()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      oscillator.connect(gain)
      oscillator.start(start + index * 0.13)
      oscillator.stop(start + 0.42 + index * 0.13)
    })
  } catch {
    // Audio feedback is optional and should never interrupt a session.
  }
}

export function notificationCapability() {
  if (!('Notification' in window)) return 'unsupported' as const
  return Notification.permission
}

export async function requestDesktopNotificationPermission() {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    return await Notification.requestPermission() === 'granted'
  } catch {
    return false
  }
}

export function showFocusCompleteNotification(taskName: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    const notification = new Notification('本次专注时间到了', {
      body: taskName ? `“${taskName}”可以进入复盘了。` : '回来记录一下刚才的完成情况。',
      tag: 'xirang-focus-complete',
      silent: true,
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  } catch {
    // Notifications depend on browser and operating-system support.
  }
}

export function showBreakCompleteNotification() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    const notification = new Notification('休息结束', {
      body: '如果状态合适，可以开始下一轮专注。',
      tag: 'xirang-break-complete',
      silent: true,
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  } catch {
    // Notifications depend on browser and operating-system support.
  }
}
