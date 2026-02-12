import { memo, useMemo } from 'react'

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const round2 = (value) => Math.round(Number(value) * 100) / 100

const fmtAxisPct = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  const abs = Math.abs(n)
  const digits = abs >= 100 ? 0 : (abs >= 10 ? 1 : 2)
  return `${n.toFixed(digits).replace('.', ',')}%`
}

const resolveBounds = (rows) => {
  const safeRows = Array.isArray(rows) ? rows : []
  if (!safeRows.length) {
    return { xMin: -20, xMax: 20, yMin: -100, yMax: 100 }
  }
  const xValues = safeRows.map((row) => Number(row.underlyingVarPct) || 0)
  const yValues = safeRows.map((row) => Number(row.strategyVarPct) || 0)
  const xMin = Math.min(...xValues)
  const xMax = Math.max(...xValues)
  const yMin = Math.min(...yValues)
  const yMax = Math.max(...yValues)
  const padX = Math.max(5, Math.abs(xMax - xMin) * 0.1)
  const padY = Math.max(10, Math.abs(yMax - yMin) * 0.15)
  return {
    xMin: xMin - padX,
    xMax: xMax + padX,
    yMin: yMin - padY,
    yMax: yMax + padY,
  }
}

const resolveAxisTicks = (rows, key, fallback = []) => {
  const values = (Array.isArray(rows) ? rows : [])
    .map((row) => Number(row?.[key]))
    .filter((value) => Number.isFinite(value))
    .map((value) => round2(value))

  const unique = Array.from(new Set(values)).sort((left, right) => left - right)
  if (!unique.length) return fallback

  const min = unique[0]
  const max = unique[unique.length - 1]
  const span = max - min
  const targets = span === 0
    ? [min]
    : [min, min + (span * 0.25), min + (span * 0.5), min + (span * 0.75), max]

  const pickNearest = (target) => unique.reduce((best, current) => (
    Math.abs(current - target) < Math.abs(best - target) ? current : best
  ), unique[0])

  const ticks = targets.map(pickNearest)
  if (min < 0 && max > 0) ticks.push(0)

  return Array.from(new Set(ticks.map((value) => round2(value)))).sort((left, right) => left - right)
}

const PayoffChart = ({ rows }) => {
  const normalizedRows = useMemo(() => (Array.isArray(rows) ? rows : []), [rows])

  const { pointsPath, zeroX, zeroY, xTicks, yTicks, plot } = useMemo(() => {
    const bounds = resolveBounds(normalizedRows)
    const width = 560
    const height = 200
    const padLeft = 44
    const padRight = 14
    const padTop = 12
    const padBottom = 28
    const drawWidth = width - padLeft - padRight
    const drawHeight = height - padTop - padBottom

    const scaleX = (value) => {
      const ratio = (value - bounds.xMin) / (bounds.xMax - bounds.xMin || 1)
      return padLeft + (ratio * drawWidth)
    }
    const scaleY = (value) => {
      const ratio = (value - bounds.yMin) / (bounds.yMax - bounds.yMin || 1)
      return padTop + (drawHeight - (ratio * drawHeight))
    }

    const path = normalizedRows
      .slice()
      .sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)
      .map((row, index) => {
        const x = scaleX(Number(row.underlyingVarPct) || 0)
        const y = scaleY(Number(row.strategyVarPct) || 0)
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ')

    const resolvedXTicks = resolveAxisTicks(normalizedRows, 'underlyingVarPct', [-20, 0, 20])
    const resolvedYTicks = resolveAxisTicks(normalizedRows, 'strategyVarPct', [-100, 0, 100])

    return {
      pointsPath: path || 'M 0 0',
      zeroX: clamp(scaleX(0), padLeft, width - padRight),
      zeroY: clamp(scaleY(0), padTop, height - padBottom),
      xTicks: resolvedXTicks.map((tick) => ({ value: tick, x: scaleX(tick) })),
      yTicks: resolvedYTicks.map((tick) => ({ value: tick, y: scaleY(tick) })),
      plot: {
        left: padLeft,
        right: width - padRight,
        top: padTop,
        bottom: height - padBottom,
      },
    }
  }, [normalizedRows])

  return (
    <div className="payoff-chart">
      <svg viewBox="0 0 560 200" aria-label="Grafico de payoff">
        <line x1={plot.left} y1={zeroY} x2={plot.right} y2={zeroY} className="payoff-axis" />
        <line x1={zeroX} y1={plot.top} x2={zeroX} y2={plot.bottom} className="payoff-axis" />
        {xTicks.map((tick) => (
          <g key={`x-${tick.value}`}>
            <line
              x1={tick.x}
              y1={plot.bottom}
              x2={tick.x}
              y2={plot.bottom + 4}
              className="payoff-axis-tick"
            />
            <text
              x={tick.x}
              y={plot.bottom + 16}
              className="payoff-axis-label"
              textAnchor="middle"
            >
              {fmtAxisPct(tick.value)}
            </text>
          </g>
        ))}
        {yTicks.map((tick) => (
          <g key={`y-${tick.value}`}>
            <line
              x1={plot.left}
              y1={tick.y}
              x2={plot.left + 5}
              y2={tick.y}
              className="payoff-axis-tick"
            />
            <text
              x={plot.left - 4}
              y={tick.y + 3}
              className="payoff-axis-label"
              textAnchor="end"
            >
              {fmtAxisPct(tick.value)}
            </text>
          </g>
        ))}
        <path d={pointsPath} className="payoff-path" />
      </svg>
    </div>
  )
}

export default memo(PayoffChart)
