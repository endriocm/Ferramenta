import { useMemo, useState } from 'react'

const COLORS = [
  '#6366f1', // indigo
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#f97316', // orange
  '#14b8a6', // teal
  '#64748b', // slate
]

const toRadians = (deg) => (deg * Math.PI) / 180

const describeArc = (cx, cy, r, startAngle, endAngle) => {
  if (endAngle - startAngle >= 359.99) {
    return [
      `M ${cx} ${cy - r}`,
      `A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r}`,
      'Z',
    ].join(' ')
  }

  const start = {
    x: cx + r * Math.cos(toRadians(startAngle - 90)),
    y: cy + r * Math.sin(toRadians(startAngle - 90)),
  }
  const end = {
    x: cx + r * Math.cos(toRadians(endAngle - 90)),
    y: cy + r * Math.sin(toRadians(endAngle - 90)),
  }
  const largeArc = endAngle - startAngle > 180 ? 1 : 0

  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`,
    'Z',
  ].join(' ')
}

const formatCurrency = (value) => {
  if (!Number.isFinite(value)) return 'R$ 0,00'
  return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const PieChart = ({
  data = [],
  title = '',
  size = 220,
  showLegend = true,
  valuePrefix = '',
  onSliceClick,
  activeSliceLabel = '',
}) => {
  const [hoveredIndex, setHoveredIndex] = useState(null)

  const total = useMemo(() => data.reduce((sum, d) => sum + (d.value || 0), 0), [data])

  const slices = useMemo(() => {
    if (!total) return []
    let currentAngle = 0
    return data.map((d, i) => {
      const angle = (d.value / total) * 360
      const slice = {
        ...d,
        startAngle: currentAngle,
        endAngle: currentAngle + angle,
        percent: ((d.value / total) * 100).toFixed(1),
        color: d.color || COLORS[i % COLORS.length],
      }
      currentAngle += angle
      return slice
    })
  }, [data, total])

  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 4
  const hasClickHandler = typeof onSliceClick === 'function'

  if (!data.length || !total) {
    return (
      <div className="pie-chart-container">
        {title ? <h4 className="pie-chart-title">{title}</h4> : null}
        <p className="muted" style={{ textAlign: 'center', padding: '1rem' }}>Sem dados para exibir.</p>
      </div>
    )
  }

  return (
    <div className="pie-chart-container">
      {title ? <h4 className="pie-chart-title">{title}</h4> : null}
      <div className="pie-chart-body">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="pie-chart-svg"
        >
          {slices.map((slice, i) => (
            <path
              key={slice.label}
              d={describeArc(cx, cy, hoveredIndex === i ? r + 4 : r, slice.startAngle, slice.endAngle)}
              fill={slice.color}
              stroke="var(--bg-base, #0d0d1a)"
              strokeWidth="2"
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              onClick={() => onSliceClick?.(slice)}
              style={{ transition: 'all 0.2s ease', cursor: hasClickHandler ? 'pointer' : 'default' }}
            />
          ))}
        </svg>

        {showLegend ? (
          <div className="pie-chart-legend">
            {slices.map((slice, i) => (
              <div
                key={slice.label}
                className={`pie-chart-legend-item ${(hoveredIndex === i || activeSliceLabel === slice.label) ? 'active' : ''}`}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                onClick={() => onSliceClick?.(slice)}
                style={{ cursor: hasClickHandler ? 'pointer' : 'default' }}
              >
                <span className="pie-chart-legend-color" style={{ backgroundColor: slice.color }} />
                <div className="pie-chart-legend-info">
                  <span className="pie-chart-legend-label">{slice.label}</span>
                  <span className="pie-chart-legend-value">
                    {slice.count != null ? `${slice.count} ordens` : ''} 
                    {' · '}
                    {slice.percent}%
                  </span>
                  {slice.revenue != null ? (
                    <span className="pie-chart-legend-revenue">
                      {valuePrefix}{formatCurrency(slice.revenue)}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
            <div className="pie-chart-legend-item pie-chart-total">
              <span className="pie-chart-legend-label"><strong>Total</strong></span>
              <span className="pie-chart-legend-value">
                {data.reduce((s, d) => s + (d.count || 0), 0)} ordens
              </span>
              {data.some((d) => d.revenue != null) ? (
                <span className="pie-chart-legend-revenue">
                  <strong>{valuePrefix}{formatCurrency(data.reduce((s, d) => s + (d.revenue || 0), 0))}</strong>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default PieChart
