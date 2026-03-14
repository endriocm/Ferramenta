import { memo, useMemo, useState } from 'react'

const groupOrder = ['PREMIO', 'CUPOM', 'GANHO COM A ALTA', 'CARTEIRAS', 'OUTRAS']

const normalizeGroup = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return 'OUTRAS'
  return raw
}

const toSignedNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  let cleaned = String(value).trim().replace(/[^\d,.-]/g, '')
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    cleaned = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(/,/g, '.')
      : cleaned.replace(/,/g, '')
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const fmtPct = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return `${number.toFixed(2).replace('.', ',')}%`
}

const toneClass = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number === 0) return 'is-neutral'
  return number > 0 ? 'is-positive' : 'is-negative'
}

const buildLogoUrl = (tickerValue) => {
  const symbol = String(tickerValue || '').trim().toUpperCase()
  if (!symbol) return ''
  return `https://icons.brapi.dev/icons/${encodeURIComponent(symbol)}.svg`
}

const buildLogoCandidates = (tickerValue) => {
  const raw = String(tickerValue || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '')
  if (!raw) return []
  const candidates = []
  const add = (symbol) => {
    const clean = String(symbol || '').trim().toUpperCase()
    if (!clean) return
    const url = buildLogoUrl(clean)
    if (!url) return
    if (!candidates.includes(url)) candidates.push(url)
  }

  add(raw)

  const withoutSuffix = raw.endsWith('.SA') ? raw.slice(0, -3) : raw
  add(withoutSuffix)

  const baseMatch = withoutSuffix.match(/^([A-Z]{4,6})\d{1,2}[A-Z]?$/)
  if (baseMatch?.[1]) add(baseMatch[1])

  return candidates
}

const buildBadge = (tickerValue, labelValue) => {
  const ticker = String(tickerValue || '').trim().toUpperCase()
  if (ticker) return ticker.slice(0, 4)
  const label = String(labelValue || '').trim().toUpperCase()
  return label.slice(0, 2) || 'OP'
}

const LogoBadge = ({
  ticker,
  fallback,
  showCompanyLogo = true,
}) => {
  const logoCandidates = useMemo(() => buildLogoCandidates(ticker), [ticker])
  const [candidateIndex, setCandidateIndex] = useState(0)

  const logoUrl = showCompanyLogo ? (logoCandidates[candidateIndex] || '') : ''
  const canShowImage = Boolean(logoUrl) && showCompanyLogo

  return (
    <span className="ops-logo">
      {canShowImage ? (
        <img
          src={logoUrl}
          alt={`Logo ${String(ticker || '').toUpperCase()}`}
          className="ops-logo-img"
          crossOrigin="anonymous"
          loading="eager"
          decoding="async"
          onError={() => {
            setCandidateIndex((current) => {
              const next = current + 1
              return next < logoCandidates.length ? next : logoCandidates.length
            })
          }}
        />
      ) : (
        <span className="ops-logo-fallback">{fallback}</span>
      )}
    </span>
  )
}

const OperationsConsolidatorPreview = ({
  entries = [],
  paletteStyle,
  showCompanyLogo = true,
}) => {
  const normalizedEntries = useMemo(() => (
    (Array.isArray(entries) ? entries : []).map((entry) => {
      const label = String(entry?.operationLabel || '').trim() || 'Operacao'
      const ticker = String(entry?.ticker || '').trim().toUpperCase()
      const summary = String(entry?.summary || '').trim()
      const maturityLabel = String(entry?.maturityLabel || '--').trim() || '--'
      const roaNumber = toSignedNumber(entry?.roaInput)
      return {
        id: entry?.id || `${label}-${maturityLabel}`,
        group: normalizeGroup(entry?.group),
        label,
        ticker,
        summary,
        maturityLabel,
        roaNumber,
      }
    })
  ), [entries])

  const grouped = useMemo(() => {
    const groups = new Map()
    normalizedEntries.forEach((entry) => {
      const key = normalizeGroup(entry.group)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(entry)
    })

    const orderedKeys = [
      ...groupOrder.filter((key) => groups.has(key)),
      ...Array.from(groups.keys()).filter((key) => !groupOrder.includes(key)),
    ]

    return orderedKeys.map((key) => ({
      key,
      label: key,
      rows: groups.get(key) || [],
    }))
  }, [normalizedEntries])

  return (
    <section className="ops-consolidated-card" style={paletteStyle}>
      <header className="ops-consolidated-head">
        <span className="ops-col-opportunity">OPORTUNIDADE</span>
        <span className="ops-col-maturity">VENCIMENTO</span>
        <span className="ops-col-roa">ROA</span>
      </header>

      <div className="ops-consolidated-body">
        {grouped.length ? (
          grouped.map((group) => (
            <article key={group.key} className="ops-consolidated-group">
              <div className="ops-consolidated-group-label">{group.label}</div>
              <div className="ops-consolidated-group-content">
                {group.rows.map((row) => (
                  <div key={row.id} className="ops-consolidated-row">
                    <div className="ops-consolidated-main">
                      <LogoBadge
                        ticker={row.ticker}
                        fallback={buildBadge(row.ticker, row.label)}
                        showCompanyLogo={showCompanyLogo}
                      />
                      <div className="ops-consolidated-copy">
                        <strong>{row.label}</strong>
                        <p>{row.summary || 'Retorno conforme parametros configurados.'}</p>
                      </div>
                    </div>
                    <div className="ops-consolidated-maturity">{row.maturityLabel}</div>
                    <div className={`ops-consolidated-roa ${toneClass(row.roaNumber)}`}>{fmtPct(row.roaNumber)}</div>
                  </div>
                ))}
              </div>
            </article>
          ))
        ) : (
          <div className="ops-consolidated-empty">
            Adicione operacoes no botao "Adicionar ao consolidador" para montar o card consolidado.
          </div>
        )}
      </div>
    </section>
  )
}

export default memo(OperationsConsolidatorPreview)
