import type { AttentionProfile } from '../types'

interface ProfileRadarProps {
  profile: AttentionProfile
  compact?: boolean
}

export function ProfileRadar({ profile, compact = false }: ProfileRadarProps) {
  const values = [
    profile.visualSearch,
    profile.sustainedAttention,
    profile.interferenceControl,
    profile.responseInhibition,
  ]
  const points = values.map((value, index) => {
    const angle = (-90 + index * 90) * (Math.PI / 180)
    const radius = (value / 100) * 78
    return `${100 + Math.cos(angle) * radius},${100 + Math.sin(angle) * radius}`
  }).join(' ')

  return (
    <div className={`profile-radar ${compact ? 'compact' : ''}`}>
      <svg viewBox="0 0 200 200" role="img" aria-label="注意表现四维图">
        <polygon className="radar-grid outer" points="100,18 182,100 100,182 18,100" />
        <polygon className="radar-grid" points="100,59 141,100 100,141 59,100" />
        <line x1="100" y1="18" x2="100" y2="182" />
        <line x1="18" y1="100" x2="182" y2="100" />
        <polygon className="radar-value" points={points} />
        {points.split(' ').map((point, index) => {
          const [cx, cy] = point.split(',')
          return <circle key={index} cx={cx} cy={cy} r="4" />
        })}
      </svg>
      <span className="radar-label top">视觉搜索</span>
      <span className="radar-label right">持续稳定</span>
      <span className="radar-label bottom">抗干扰</span>
      <span className="radar-label left">反应抑制</span>
    </div>
  )
}
