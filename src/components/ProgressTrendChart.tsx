export interface TrendPoint {
  label: string
  value: number
}

interface ProgressTrendChartProps {
  title: string
  points: TrendPoint[]
  headline: string
  description: string
  formatValue: (value: number) => string
  domain?: [number, number]
  tone?: 'green' | 'blue' | 'coral' | 'gold'
}

export function ProgressTrendChart({
  title,
  points,
  headline,
  description,
  formatValue,
  domain,
  tone = 'green',
}: ProgressTrendChartProps) {
  if (!points.length) {
    return (
      <article className="trend-chart-card empty">
        <span>{title}</span>
        <strong>暂无数据</strong>
        <p>完成相关记录后生成曲线。</p>
      </article>
    )
  }

  const width = 360
  const height = 132
  const paddingX = 16
  const paddingY = 17
  let minimum = domain?.[0] ?? Math.min(...points.map((point) => point.value))
  let maximum = domain?.[1] ?? Math.max(...points.map((point) => point.value))
  if (minimum === maximum) {
    minimum -= Math.max(1, Math.abs(minimum) * 0.08)
    maximum += Math.max(1, Math.abs(maximum) * 0.08)
  } else if (!domain) {
    const margin = (maximum - minimum) * 0.12
    minimum -= margin
    maximum += margin
  }
  const coordinates = points.map((point, index) => {
    const x = points.length === 1
      ? width / 2
      : paddingX + (index / (points.length - 1)) * (width - paddingX * 2)
    const y = paddingY + ((maximum - point.value) / (maximum - minimum)) * (height - paddingY * 2)
    return { x, y }
  })
  const polyline = coordinates.map(({ x, y }) => `${x},${y}`).join(' ')
  const visibleDots = points.length <= 18 ? coordinates : [coordinates[coordinates.length - 1]]

  return (
    <article className={`trend-chart-card ${tone}`}>
      <div className="trend-chart-heading"><span>{title}</span><strong>{headline}</strong><small>{description}</small></div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}变化曲线`} preserveAspectRatio="none">
        <line x1={paddingX} y1={paddingY} x2={width - paddingX} y2={paddingY} />
        <line x1={paddingX} y1={height / 2} x2={width - paddingX} y2={height / 2} />
        <line x1={paddingX} y1={height - paddingY} x2={width - paddingX} y2={height - paddingY} />
        {points.length > 1 && <polyline points={polyline} />}
        {visibleDots.map(({ x, y }, index) => <circle key={`${x}-${y}-${index}`} cx={x} cy={y} r="3.5" />)}
      </svg>
      <div className="trend-chart-footer">
        <span>{points[0].label}<strong>{formatValue(points[0].value)}</strong></span>
        <span>{points[points.length - 1].label}<strong>{formatValue(points[points.length - 1].value)}</strong></span>
      </div>
    </article>
  )
}
