import { memo, useMemo, useState } from 'react'
import PayoffTable from './PayoffTable'

const toneClass = (tone) => {
  if (tone === 'positive') return 'metric-value positive'
  if (tone === 'negative') return 'metric-value negative'
  return 'metric-value'
}

const fmtPct = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '--'
  return `${num.toFixed(2).replace('.', ',')}%`
}

const DASH_ONLY_MINIMUM_VALUE_TEMPLATES = new Set([
  'call',
  'call_spread',
  'put',
  'put_spread',
  'alocacao_protegida',
])

const resolvePayoffMetrics = (model, minimumValue) => {
  const metrics = Array.isArray(model?.metrics) ? model.metrics : []
  const maturityValue = metrics.find((metric) => String(metric?.label || '').toLowerCase().includes('vencimento'))?.value || '--'
  const rows = Array.isArray(model?.payoffRows) ? model.payoffRows : []
  const rawBarrier = model?.maxGainBarrierPct
  const barrier = rawBarrier == null || rawBarrier === '' ? null : Number(rawBarrier)
  const barrierRows = Number.isFinite(barrier)
    ? rows.filter((row) => Number(row?.underlyingVarPct) < barrier)
    : rows
  const gainRows = barrierRows.length ? barrierRows : rows

  const gainCandidates = gainRows
    .map((row) => Number(row?.strategyVarPct))
    .filter((value) => Number.isFinite(value))
  const lossCandidates = rows
    .map((row) => Number(row?.strategyVarPct))
    .filter((value) => Number.isFinite(value))

  const maxGain = gainCandidates.length ? Math.max(...gainCandidates) : null
  const maxLoss = lossCandidates.length ? Math.min(...lossCandidates) : null

  const maxGainValue = maxGain == null ? '--' : fmtPct(maxGain)
  const maxLossValue = maxLoss == null ? '--' : (maxLoss <= -100 ? '-' : fmtPct(maxLoss))
  const minimumValueResolved = String(minimumValue || '').trim() || '--'

  return [
    { label: 'Valor minimo', value: minimumValueResolved },
    { label: 'Ganho maximo', value: maxGainValue, tone: maxGain != null && maxGain > 0 ? 'positive' : 'neutral' },
    { label: 'Perda maxima', value: maxLossValue, tone: maxLossValue === '-' ? 'neutral' : (maxLoss != null && maxLoss < 0 ? 'negative' : 'neutral') },
    { label: 'Vencimento', value: maturityValue },
  ]
}

const sanitizeHighlightText = (value) => String(value || '')
  .replace(/payoff/gi, 'retorno')
  .replace(/\s{2,}/g, ' ')
  .trim()

const normalizeRows = (rows) => (Array.isArray(rows) ? rows : [])
  .map((row) => ({
    underlyingVarPct: Number(row?.underlyingVarPct),
    strategyVarPct: Number(row?.strategyVarPct),
  }))
  .filter((row) => Number.isFinite(row.underlyingVarPct) && Number.isFinite(row.strategyVarPct))
  .sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)

const detectBarrierEvent = (rows, direction) => {
  const safeRows = normalizeRows(rows)
  let best = null
  for (let index = 0; index < safeRows.length - 1; index += 1) {
    const current = safeRows[index]
    const next = safeRows[index + 1]
    const xGap = Math.abs(next.underlyingVarPct - current.underlyingVarPct)
    if (xGap > 0.02) continue
    const yGap = Math.abs(next.strategyVarPct - current.strategyVarPct)
    if (yGap < 0.25) continue
    const sameHighSide = direction === 'high' && current.underlyingVarPct > 0 && next.underlyingVarPct > 0
    const sameLowSide = direction === 'low' && current.underlyingVarPct < 0 && next.underlyingVarPct < 0
    if (!sameHighSide && !sameLowSide) continue

    const barrierRow = direction === 'high'
      ? (next.underlyingVarPct >= current.underlyingVarPct ? next : current)
      : (next.underlyingVarPct <= current.underlyingVarPct ? next : current)
    const preBarrierRow = barrierRow === current ? next : current
    const score = yGap

    if (!best || score > best.score) {
      best = {
        score,
        barrierRow,
        preBarrierRow,
      }
    }
  }
  return best
}

const resolveOfferHighlights = (model) => {
  const rows = normalizeRows(model?.payoffRows)
  const fallback = (Array.isArray(model?.highlights) ? model.highlights : [])
    .map(sanitizeHighlightText)
    .filter(Boolean)
  if (!rows.length) return fallback

  const positives = rows.filter((row) => row.underlyingVarPct > 0)
  const negatives = rows.filter((row) => row.underlyingVarPct < 0)
  const highEvent = detectBarrierEvent(rows, 'high')
  const lowEvent = detectBarrierEvent(rows, 'low')
  const maxGain = rows.reduce((best, row) => (row.strategyVarPct > best ? row.strategyVarPct : best), -Infinity)
  const maxLoss = rows.reduce((best, row) => (row.strategyVarPct < best ? row.strategyVarPct : best), Infinity)

  const lines = []

  if (highEvent) {
    lines.push(`Cenario de ganho: na alta ate ${fmtPct(highEvent.preBarrierRow.underlyingVarPct)}, a estrutura pode chegar a ${fmtPct(highEvent.preBarrierRow.strategyVarPct)}.`)
    lines.push(`Barreira de alta: ao atingir ${fmtPct(highEvent.barrierRow.underlyingVarPct)}, o retorno fica em ${fmtPct(highEvent.barrierRow.strategyVarPct)}.`)
  } else if (positives.length) {
    const positiveTop = positives.reduce((best, row) => (row.strategyVarPct > best.strategyVarPct ? row : best), positives[0])
    lines.push(`Cenario de ganho: em alta, o retorno pode chegar a ${fmtPct(positiveTop.strategyVarPct)}.`)
  }

  if (lowEvent) {
    lines.push(`Cenario de queda: ate ${fmtPct(Math.abs(lowEvent.preBarrierRow.underlyingVarPct))} de queda, retorno em ${fmtPct(lowEvent.preBarrierRow.strategyVarPct)}.`)
    const tailRows = negatives.filter((row) => row.underlyingVarPct <= lowEvent.barrierRow.underlyingVarPct)
    if (tailRows.length) {
      const barrierReturn = lowEvent.barrierRow.strategyVarPct
      const tailMin = tailRows.reduce((best, row) => (row.strategyVarPct < best ? row.strategyVarPct : best), tailRows[0].strategyVarPct)
      const flatTail = tailRows.every((row) => Math.abs(row.strategyVarPct - barrierReturn) < 0.01)
      if (flatTail && Math.abs(barrierReturn) < 0.01) {
        lines.push(`Queda acima de ${fmtPct(Math.abs(lowEvent.barrierRow.underlyingVarPct))}: capital protegido em 0,00%.`)
      } else if (flatTail) {
        lines.push(`Queda acima de ${fmtPct(Math.abs(lowEvent.barrierRow.underlyingVarPct))}: retorno travado em ${fmtPct(barrierReturn)}.`)
      } else {
        lines.push(`Queda acima de ${fmtPct(Math.abs(lowEvent.barrierRow.underlyingVarPct))}: o retorno passa a acompanhar a desvalorizacao, podendo chegar a ${fmtPct(tailMin)}.`)
      }
    }
  } else if (negatives.length) {
    const negativeBottom = negatives.reduce((best, row) => (row.strategyVarPct < best.strategyVarPct ? row : best), negatives[0])
    lines.push(`Cenario de queda: no pior cenario estimado, o retorno pode ir a ${fmtPct(negativeBottom.strategyVarPct)}.`)
  }

  if (lines.length < 3 && Number.isFinite(maxGain)) {
    lines.push(`Ganho maximo estimado: ${fmtPct(maxGain)}.`)
  }
  if (lines.length < 4 && Number.isFinite(maxLoss)) {
    lines.push(`Perda maxima estimada: ${maxLoss <= -100 ? '-' : fmtPct(maxLoss)}.`)
  }

  const deduped = []
  const seen = new Set()
  ;[...lines, ...fallback].forEach((line) => {
    const normalized = sanitizeHighlightText(line)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    deduped.push(normalized)
  })
  return deduped.slice(0, 4)
}

const extractTicker = (title) => {
  const match = String(title || '').match(/\(([^)]+)\)/)
  return match?.[1] || ''
}

const buildBadge = (title) => {
  const ticker = extractTicker(title)
  if (ticker) return ticker.slice(0, 5).toUpperCase()
  const source = String(title || 'AT').trim()
  return source.slice(0, 2).toUpperCase()
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

const LogoBadge = ({
  ticker,
  fallback,
  containerClassName,
  imageClassName,
  textClassName,
  showCompanyLogo = true,
}) => {
  const logoCandidates = useMemo(() => buildLogoCandidates(ticker), [ticker])
  const [candidateIndex, setCandidateIndex] = useState(0)

  const logoUrl = showCompanyLogo ? (logoCandidates[candidateIndex] || '') : ''
  const canShowImage = Boolean(logoUrl) && showCompanyLogo

  return (
    <span className={containerClassName}>
      {canShowImage ? (
        <img
          src={logoUrl}
          alt={`Logo ${String(ticker || '').toUpperCase()}`}
          className={imageClassName}
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
        <span className={textClassName}>{fallback}</span>
      )}
    </span>
  )
}

const StrategyCardPreview = ({
  model,
  leftLabel,
  rightLabel,
  layoutMode = 'payoff',
  showCompanyLogo = true,
  paletteStyle,
  minimumValue = '--',
  companyName = '',
}) => {
  const safeModel = useMemo(() => (model || {}), [model])
  const templateId = String(safeModel?.templateId || '').trim().toLowerCase()
  const resolvedMinimumValue = useMemo(() => (
    DASH_ONLY_MINIMUM_VALUE_TEMPLATES.has(templateId)
      ? '-'
      : (String(minimumValue || '').trim() || '--')
  ), [minimumValue, templateId])
  const previewMetrics = useMemo(
    () => resolvePayoffMetrics(safeModel, resolvedMinimumValue),
    [safeModel, resolvedMinimumValue],
  )
  const offerHighlights = useMemo(() => resolveOfferHighlights(safeModel), [safeModel])
  const badge = buildBadge(safeModel.title)
  const ticker = extractTicker(safeModel.title)
  const safeCompanyName = String(companyName || '').trim()
  if (!model) return null

  if (layoutMode === 'destaque') {
    return (
      <section className="offers-preview" style={paletteStyle}>
        <header className="offers-preview-header">OFERTAS DESTAQUE</header>
        <article className="offer-highlight-card">
          <div className="offer-top-row">
            <div className="offer-id">
              <LogoBadge
                key={`offer-${ticker}-${showCompanyLogo ? 'logo' : 'text'}`}
                ticker={ticker}
                fallback={badge}
                containerClassName="offer-logo"
                imageClassName="offer-logo-img"
                textClassName="offer-logo-fallback"
                showCompanyLogo={showCompanyLogo}
              />
              <div className="offer-id-copy">
                <h3>{safeModel.subtitle}</h3>
                <p>{[ticker || safeModel.title, safeCompanyName].filter(Boolean).join(' • ')}</p>
              </div>
            </div>
            <div className="offer-time">
              <span>Valor minimo</span>
              <strong>{resolvedMinimumValue}</strong>
            </div>
          </div>

          <div className="offer-highlight-list">
            {offerHighlights.map((highlight) => (
              <div key={highlight} className="offer-highlight-item">
                <span className="offer-highlight-dot" />
                <p>{highlight}</p>
              </div>
            ))}
          </div>

          <footer className="offer-footer">
            <div>
              <small>Ticket minimo</small>
              <strong>{model.footer?.ticketMin || '--'}</strong>
            </div>
            <div>
              <small>Fee AAI</small>
              <strong>{model.footer?.feeAai || '--'}</strong>
            </div>
          </footer>
        </article>
      </section>
    )
  }

  return (
    <article className="xp-payoff-card" style={paletteStyle}>
      <header className="xp-payoff-card-head">
        <div className="xp-payoff-id">
          <LogoBadge
            key={`payoff-${ticker}-${showCompanyLogo ? 'logo' : 'text'}`}
            ticker={ticker}
            fallback={badge}
            containerClassName="xp-payoff-logo"
            imageClassName="xp-payoff-logo-img"
            textClassName="xp-payoff-logo-fallback"
            showCompanyLogo={showCompanyLogo}
          />
          <div>
            <h3>
              {safeModel.title}
              {safeCompanyName ? <span className="xp-company-name"> • {safeCompanyName}</span> : null}
            </h3>
          </div>
        </div>
      </header>

      <section className="xp-payoff-metrics">
        {previewMetrics.map((metric) => (
          <div key={metric.label} className="xp-payoff-metric">
            <small>{metric.label}</small>
            <strong className={toneClass(metric.tone)}>{metric.value}</strong>
          </div>
        ))}
      </section>

      <PayoffTable
        leftLabel={leftLabel}
        rightLabel={rightLabel}
        rows={model.payoffRows}
      />
    </article>
  )
}

export default memo(StrategyCardPreview)
