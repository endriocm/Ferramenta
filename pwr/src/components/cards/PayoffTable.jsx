import { memo } from 'react'

const toneClassMap = {
  positive: 'payoff-dot positive',
  negative: 'payoff-dot negative',
  neutral: 'payoff-dot neutral',
}

const formatPct = (value) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '--'
  return `${numeric.toFixed(2).replace('.', ',')}%`
}

const resolveToneClass = (tone) => toneClassMap[tone] || toneClassMap.neutral

const PayoffTable = ({
  leftLabel,
  rightLabel,
  rows,
}) => {
  const safeRows = Array.isArray(rows) ? rows : []

  return (
    <div className="payoff-table-wrap">
      <table className="payoff-table">
        <thead>
          <tr>
            <th>{leftLabel}</th>
            <th>{rightLabel}</th>
          </tr>
        </thead>
        <tbody>
          {safeRows.map((row, index) => (
            <tr key={`${row.underlyingVarPct}-${row.strategyVarPct}-${index}`}>
              <td>
                <span className={resolveToneClass(row.underlyingTone)} />
                {formatPct(row.underlyingVarPct)}
              </td>
              <td>
                <span className={resolveToneClass(row.strategyTone)} />
                {formatPct(row.strategyVarPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default memo(PayoffTable)
