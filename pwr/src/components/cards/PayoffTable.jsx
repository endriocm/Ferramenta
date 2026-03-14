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
            <th className="payoff-col-header">{leftLabel}</th>
            <th className="payoff-col-header">{rightLabel}</th>
          </tr>
        </thead>
        <tbody>
          {safeRows.map((row, index) => (
            <tr key={`${row.underlyingVarPct}-${row.strategyVarPct}-${index}`}>
              <td className="payoff-col-value">
                <span className="payoff-cell-content">
                  <span className={resolveToneClass(row.underlyingTone)} />
                  {formatPct(row.underlyingVarPct)}
                </span>
              </td>
              <td className="payoff-col-value">
                <span className={`payoff-structure-value ${row.strategyTone || 'neutral'} payoff-cell-content`}>
                  <span className={resolveToneClass(row.strategyTone)} />
                  <span>{formatPct(row.strategyVarPct)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default memo(PayoffTable)
