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

const minimumCurrencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const parseMinimumCurrencyNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  let cleaned = String(value).trim().replace(/[^\d,.-]/g, '')
  if (!cleaned) return null
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.')
  }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, '')
  }
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const formatMinimumValue = (value) => {
  const raw = String(value || '').trim()
  if (!raw || raw === '--' || raw === '-') return raw || '--'
  const parsed = parseMinimumCurrencyNumber(raw)
  if (parsed == null) return raw
  return minimumCurrencyFormatter.format(parsed)
}

const normalizeSearchText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()

const DOWNSIDE_BARRIER_RISK_TOKENS = [
  'ko baixa',
  'barreira baixa',
  'barreira de baixa',
  'barreira ko de baixa',
  'gatilho de baixa',
  'ativacao baixa',
]

const hasDownsideBarrierRisk = (model) => {
  const sources = [
    ...(Array.isArray(model?.metrics) ? model.metrics.flatMap((metric) => [metric?.label, metric?.value]) : []),
    ...(Array.isArray(model?.highlights) ? model.highlights : []),
    model?.subtitle,
  ]

  return sources.some((source) => {
    const normalized = normalizeSearchText(source)
    return DOWNSIDE_BARRIER_RISK_TOKENS.some((token) => normalized.includes(token))
  })
}

const resolveMaxLossDisplayValue = (maxLoss, downsideBarrierRisk) => {
  if (downsideBarrierRisk) return '-'
  if (maxLoss == null) return '--'
  return maxLoss <= -100 ? '-' : fmtPct(maxLoss)
}

const DASH_ONLY_MINIMUM_VALUE_TEMPLATES = new Set([
  'call',
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
  const downsideBarrierRisk = hasDownsideBarrierRisk(model)

  const maxGainValue = maxGain == null ? '--' : fmtPct(maxGain)
  const maxLossValue = resolveMaxLossDisplayValue(maxLoss, downsideBarrierRisk)
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

const interpolateZeroCrossing = (left, right) => {
  const x0 = Number(left?.underlyingVarPct)
  const y0 = Number(left?.strategyVarPct)
  const x1 = Number(right?.underlyingVarPct)
  const y1 = Number(right?.strategyVarPct)
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null
  if (y0 === y1) return null
  if (y0 * y1 > 0) return null
  const x = x0 + ((0 - y0) * (x1 - x0)) / (y1 - y0)
  if (!Number.isFinite(x)) return null
  return {
    underlyingVarPct: Number(x.toFixed(2)),
    strategyVarPct: 0,
  }
}

const resolveSpreadHighlights = (rows, direction = 'up') => {
  const safeRows = normalizeRows(rows)
  if (!safeRows.length) return []

  const maxGain = Math.max(...safeRows.map((row) => row.strategyVarPct))
  const maxLoss = Math.min(...safeRows.map((row) => row.strategyVarPct))
  const tolerance = 0.2

  const maxGainRows = safeRows.filter((row) => Math.abs(row.strategyVarPct - maxGain) <= tolerance)
  const limitRow = maxGainRows.length
    ? (direction === 'down'
      ? maxGainRows.reduce((best, row) => (row.underlyingVarPct > best.underlyingVarPct ? row : best), maxGainRows[0])
      : maxGainRows.reduce((best, row) => (row.underlyingVarPct < best.underlyingVarPct ? row : best), maxGainRows[0]))
    : safeRows.reduce((best, row) => (row.strategyVarPct > best.strategyVarPct ? row : best), safeRows[0])

  const zeroRows = safeRows.filter((row) => Math.abs(row.strategyVarPct) <= tolerance)
  let startRow = null
  if (zeroRows.length) {
    startRow = direction === 'down'
      ? zeroRows
        .filter((row) => row.underlyingVarPct <= 0)
        .reduce((best, row) => (!best || row.underlyingVarPct > best.underlyingVarPct ? row : best), null)
      : zeroRows
        .filter((row) => row.underlyingVarPct >= 0)
        .reduce((best, row) => (!best || row.underlyingVarPct < best.underlyingVarPct ? row : best), null)
  }

  if (!startRow) {
    for (let index = 0; index < safeRows.length - 1; index += 1) {
      const crossing = interpolateZeroCrossing(safeRows[index], safeRows[index + 1])
      if (!crossing) continue
      if (direction === 'down' && crossing.underlyingVarPct <= 0) {
        if (!startRow || crossing.underlyingVarPct > startRow.underlyingVarPct) startRow = crossing
      }
      if (direction === 'up' && crossing.underlyingVarPct >= 0) {
        if (!startRow || crossing.underlyingVarPct < startRow.underlyingVarPct) startRow = crossing
      }
    }
  }

  const startValue = startRow?.underlyingVarPct
  const limitValue = limitRow?.underlyingVarPct
  const hasRange = Number.isFinite(startValue)
    && Number.isFinite(limitValue)
    && Math.abs(limitValue - startValue) >= 0.25

  if (direction === 'down') {
    const lines = [
      `Cenario de alta/estabilidade: retorno em ${fmtPct(maxLoss)}.`,
    ]
    if (Number.isFinite(startValue)) {
      lines.push(`Ponto de equilibrio: queda de ${fmtPct(startValue)} gera retorno de 0,00%.`)
    }
    if (hasRange) {
      lines.push(`Entre ${fmtPct(startValue)} e ${fmtPct(limitValue)}, o retorno cresce ate ${fmtPct(maxGain)}.`)
      lines.push(`A partir de ${fmtPct(limitValue)}, retorno travado em ${fmtPct(maxGain)}.`)
    } else {
      lines.push(`Retorno maximo estimado em ${fmtPct(maxGain)}.`)
    }
    return lines
  }

  const lines = [
    `Cenario de queda/estabilidade: retorno em ${fmtPct(maxLoss)}.`,
  ]
  if (Number.isFinite(startValue)) {
    lines.push(`Ponto de equilibrio: alta de ${fmtPct(startValue)} gera retorno de 0,00%.`)
  }
  if (hasRange) {
    lines.push(`Entre ${fmtPct(startValue)} e ${fmtPct(limitValue)}, o retorno cresce ate ${fmtPct(maxGain)}.`)
    lines.push(`A partir de ${fmtPct(limitValue)}, retorno travado em ${fmtPct(maxGain)}.`)
  } else {
    lines.push(`Retorno maximo estimado em ${fmtPct(maxGain)}.`)
  }
  return lines
}

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

const extractBarrierHint = (highlights, direction) => {
  const safeHighlights = Array.isArray(highlights) ? highlights : []
  const directionTokens = direction === 'high'
    ? ['barreira de alta', 'ativacao alta', 'trigger de alta']
    : ['barreira de baixa', 'ativacao baixa', 'gatilho de baixa']
  const match = safeHighlights
    .map((line) => String(line || ''))
    .find((line) => {
      const lower = line.toLowerCase()
      return directionTokens.some((token) => lower.includes(token))
    })
  if (!match) return ''
  const afterColon = match.includes(':') ? match.split(':').slice(1).join(':').trim() : ''
  if (afterColon) return afterColon
  const pctMatch = match.match(/-?\d+(?:[.,]\d+)?%/)
  return pctMatch?.[0] || ''
}

const resolvePayoffSummaryHighlights = (model) => {
  const templateId = String(model?.templateId || '').trim().toLowerCase()
  const rows = normalizeRows(model?.payoffRows)
  const fallback = (Array.isArray(model?.highlights) ? model.highlights : [])
    .map(sanitizeHighlightText)
    .filter(Boolean)
  if (!rows.length) return fallback

  const positives = rows.filter((row) => row.underlyingVarPct > 0)
  const negatives = rows.filter((row) => row.underlyingVarPct < 0)
  const highEvent = detectBarrierEvent(rows, 'high')
  const lowEvent = detectBarrierEvent(rows, 'low')
  const highBarrierHint = extractBarrierHint(model?.highlights, 'high')
  const lowBarrierHint = extractBarrierHint(model?.highlights, 'low')
  const maxGainRow = rows.reduce((best, row) => (row.strategyVarPct > best.strategyVarPct ? row : best), rows[0])
  const maxLossRow = rows.reduce((best, row) => (row.strategyVarPct < best.strategyVarPct ? row : best), rows[0])
  const maxGain = maxGainRow?.strategyVarPct
  const maxLoss = maxLossRow?.strategyVarPct
  const hasCapitalProtection = Number.isFinite(maxLoss) && maxLoss >= -0.01
  const downsideBarrierRisk = hasDownsideBarrierRisk(model)
  const downBiasedTemplate = templateId === 'put' || templateId === 'put_spread'

  let objectiveCore = 'buscar retorno em cenarios de oscilacao do ativo'
  if (downBiasedTemplate || (Number.isFinite(maxGainRow?.underlyingVarPct) && maxGainRow.underlyingVarPct < -1)) {
    objectiveCore = 'buscar ganho com cenario de baixa do ativo'
  } else if (Number.isFinite(maxGainRow?.underlyingVarPct) && maxGainRow.underlyingVarPct > 1) {
    objectiveCore = 'buscar ganho com cenario de alta do ativo'
  }

  const objectiveSuffix = hasCapitalProtection
    ? ' com capital protegido no vencimento'
    : (!downsideBarrierRisk && Number.isFinite(maxLoss) && maxLoss > -100 ? ` com perda estimada limitada a ${fmtPct(maxLoss)}` : '')

  const objectiveLine = `Objetivo: ${objectiveCore}${objectiveSuffix}.`

  let highLine = 'Cenario de alta: retorno conforme payoff projetado para movimentos de valorizacao.'
  if (highEvent) {
    highLine = `Cenario de alta: ate ${fmtPct(highEvent.preBarrierRow.underlyingVarPct)} de alta, o retorno pode chegar a ${fmtPct(highEvent.preBarrierRow.strategyVarPct)}; ao atingir ${fmtPct(highEvent.barrierRow.underlyingVarPct)}, o retorno fica em ${fmtPct(highEvent.barrierRow.strategyVarPct)}.`
  } else if (positives.length) {
    const positiveTop = positives.reduce((best, row) => (row.strategyVarPct > best.strategyVarPct ? row : best), positives[0])
    const barrierTail = highBarrierHint ? `, considerando barreira de alta em ${highBarrierHint}` : ''
    highLine = `Cenario de alta: em valorizacao do ativo, o retorno pode chegar a ${fmtPct(positiveTop.strategyVarPct)}${barrierTail}.`
  }

  let lowLine = 'Cenario de baixa: retorno conforme payoff projetado para movimentos de queda.'
  if (lowEvent) {
    const barrierDrop = fmtPct(Math.abs(lowEvent.barrierRow.underlyingVarPct))
    const preDrop = fmtPct(Math.abs(lowEvent.preBarrierRow.underlyingVarPct))
    const tailRows = negatives.filter((row) => row.underlyingVarPct <= lowEvent.barrierRow.underlyingVarPct)
    if (tailRows.length) {
      const barrierReturn = lowEvent.barrierRow.strategyVarPct
      const tailMin = tailRows.reduce((best, row) => (row.strategyVarPct < best ? row.strategyVarPct : best), tailRows[0].strategyVarPct)
      const flatTail = tailRows.every((row) => Math.abs(row.strategyVarPct - barrierReturn) < 0.01)
      const tailText = flatTail
        ? (Math.abs(barrierReturn) < 0.01
          ? `se atingir ${barrierDrop} de queda, preserva capital em 0,00%`
          : `se atingir ${barrierDrop} de queda, o retorno fica travado em ${fmtPct(barrierReturn)}`)
        : `se atingir ${barrierDrop} de queda, o retorno passa a acompanhar a desvalorizacao, podendo chegar a ${fmtPct(tailMin)}`
      lowLine = `Cenario de baixa: ate ${preDrop} de queda, retorno em ${fmtPct(lowEvent.preBarrierRow.strategyVarPct)}; ${tailText}.`
    } else {
      lowLine = `Cenario de baixa: ao atingir ${barrierDrop} de queda, o retorno passa para ${fmtPct(lowEvent.barrierRow.strategyVarPct)}.`
    }
  } else if (hasCapitalProtection) {
    lowLine = 'Cenario de baixa: capital protegido no vencimento, com retorno minimo de 0,00%.'
  } else if (negatives.length) {
    const negativeBottom = negatives.reduce((best, row) => (row.strategyVarPct < best.strategyVarPct ? row : best), negatives[0])
    const barrierTail = lowBarrierHint ? `, considerando barreira de baixa em ${lowBarrierHint}` : ''
    lowLine = `Cenario de baixa: no pior cenario estimado, o retorno pode ir a ${fmtPct(negativeBottom.strategyVarPct)}${barrierTail}.`
  }

  const riskLine = downsideBarrierRisk
    ? 'Risco maximo: perda de ate 100,00% do valor investido.'
    : (Number.isFinite(maxLoss)
    ? (maxLoss >= -0.01
      ? 'Risco maximo: 0,00% no vencimento (capital protegido).'
      : (maxLoss <= -100
        ? 'Risco maximo: perda de ate 100,00% do valor investido.'
        : `Risco maximo: perda estimada de ${fmtPct(maxLoss)}.`))
    : 'Risco maximo: --.')

  const profitLine = Number.isFinite(maxGain)
    ? (maxGain > 0
      ? `Lucro maximo: ${fmtPct(maxGain)} no melhor cenario estimado.`
      : 'Lucro maximo: sem ganho positivo estimado no payoff atual.')
    : 'Lucro maximo: --.'

  return [objectiveLine, highLine, lowLine, riskLine, profitLine]
    .map(sanitizeHighlightText)
}

const resolveOfferHighlights = (model) => {
  const templateId = String(model?.templateId || '').trim().toLowerCase()
  if (templateId === 'put_spread') {
    return resolveSpreadHighlights(model?.payoffRows, 'down')
  }
  if (templateId === 'call_spread') {
    return resolveSpreadHighlights(model?.payoffRows, 'up')
  }

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
  const downsideBarrierRisk = hasDownsideBarrierRisk(model)

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
  if (lines.length < 4 && (downsideBarrierRisk || Number.isFinite(maxLoss))) {
    lines.push(`Perda maxima estimada: ${resolveMaxLossDisplayValue(maxLoss, downsideBarrierRisk)}.`)
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
  summaryHighlights = [],
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
      : formatMinimumValue(minimumValue)
  ), [minimumValue, templateId])
  const previewMetrics = useMemo(
    () => resolvePayoffMetrics(safeModel, resolvedMinimumValue),
    [safeModel, resolvedMinimumValue],
  )
  const offerHighlights = useMemo(() => resolveOfferHighlights(safeModel), [safeModel])
  const payoffHighlights = useMemo(() => resolvePayoffSummaryHighlights(safeModel), [safeModel])
  const customSummaryHighlights = useMemo(
    () => (Array.isArray(summaryHighlights) ? summaryHighlights : [])
      .map((item) => sanitizeHighlightText(item))
      .filter(Boolean),
    [summaryHighlights],
  )
  const resolvedPayoffHighlights = customSummaryHighlights.length
    ? customSummaryHighlights
    : (payoffHighlights.length
      ? payoffHighlights
      : ['Sem resumo disponivel para esta operacao.'])
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
        </article>
      </section>
    )
  }

  return (
    <article className="xp-payoff-card xp-payoff-card--hybrid" style={paletteStyle}>
      <header className="xp-payoff-card-head">
        <div className="xp-payoff-brand">
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
            <h3>{safeModel.title}</h3>
            {safeCompanyName ? <p className="xp-company-name">{safeCompanyName}</p> : null}
          </div>
          </div>
        </div>
      </header>

      <section className="xp-payoff-hybrid-body">
        <div className="xp-payoff-main">
          <section className="xp-payoff-metrics">
            {previewMetrics.map((metric) => (
              <div key={metric.label} className="xp-payoff-metric">
                <small>{metric.label}</small>
                <strong
                  className={`${toneClass(metric.tone)}${String(metric?.value || '').length >= 10 ? ' compact' : ''}`}
                >
                  {metric.value}
                </strong>
              </div>
            ))}
          </section>

          <PayoffTable
            leftLabel={leftLabel}
            rightLabel={rightLabel}
            rows={model.payoffRows}
          />
        </div>

        <aside className="xp-payoff-aside">
          <section className="xp-payoff-summary-card">
            <h4>Resumo da operacao</h4>
            <div className="xp-payoff-highlight-list">
              {resolvedPayoffHighlights.map((highlight) => (
                <div key={highlight} className="xp-payoff-highlight-item">
                  <span className="xp-payoff-highlight-dot" />
                  <p>{highlight}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </article>
  )
}

export default memo(StrategyCardPreview)
