const BASE_POINTS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50]
const OPTION_DRIVEN_BASE_POINTS = [-20, -10, 0, 10, 20]
const OPTION_DRIVEN_NO_BARRIER_BASE_POINTS = [-30, -20, -10, 0, 10, 20, 30]

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const round2 = (value) => Math.round(Number(value) * 100) / 100
const blank = (value) => value == null || String(value).trim() === ''

const toNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
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

const pct = (value, fallback, min = -200, max = 200) => {
  const parsed = toNumber(value)
  if (parsed == null) return fallback
  return clamp(parsed, min, max)
}

const tone = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return 'neutral'
  return n > 0 ? 'positive' : 'negative'
}

const fmtPct = (value, digits = 2) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return `${n.toFixed(digits).replace('.', ',')}%`
}

const beforeBarrierPct = (barrierPct, direction = 'high') => {
  const barrier = Number(barrierPct)
  if (!Number.isFinite(barrier)) return barrierPct
  if (direction === 'low') return round2(barrier + 0.01)
  return round2(barrier - 0.01)
}

const fmtDate = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return '--'
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw)
  if (Number.isNaN(date.getTime())) return '--'
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${date.getFullYear()}`
}

const fmtTerm = (value) => {
  const n = toNumber(value)
  if (n == null || n <= 0) return '--'
  const label = Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',')
  return `${label} meses`
}

const fmtCurrency = (value) => {
  if (blank(value)) return '--'
  const n = toNumber(value)
  if (n == null) return String(value).trim()
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const fmtFee = (value) => {
  if (blank(value)) return '--'
  const n = toNumber(value)
  if (n == null) return String(value).trim()
  return fmtPct(n)
}

const ticker = (value) => String(value || '').trim().toUpperCase() || 'ATIVO'

const lerp = (x, x0, x1, y0, y1) => {
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x0 === x1) return y1
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
}

const axis = (extras = [], basePoints = BASE_POINTS) => {
  const source = Array.isArray(basePoints) && basePoints.length ? basePoints : BASE_POINTS
  const values = new Set(source.map((v) => round2(v)))
  ;(Array.isArray(extras) ? extras : []).forEach((value) => {
    const n = toNumber(value)
    if (n != null) values.add(round2(clamp(n, -80, 140)))
  })
  return Array.from(values).sort((a, b) => a - b)
}

const uniqueNumeric = (values = []) => {
  const output = []
  const seen = new Set()
  ;(Array.isArray(values) ? values : []).forEach((value) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    const rounded = round2(parsed)
    if (seen.has(rounded)) return
    seen.add(rounded)
    output.push(rounded)
  })
  return output
}

const resolveBarrierSamplingTargets = (barrierVarPct, direction, mode = 'barrier') => {
  const barrier = Number(barrierVarPct)
  if (!Number.isFinite(barrier)) return { before: [], after: [] }
  if (direction !== 'high' && direction !== 'low') return { before: [], after: [] }

  const distance = Math.abs(barrier)
  if (distance <= 0) {
    return {
      before: [],
      after: [0],
    }
  }

  const nearMagnitude = distance >= 10 ? 5 : round2(Math.max(distance * 0.4, 0.5))
  const halfMagnitude = round2(distance / 2)
  const maxBeforeMagnitude = Math.max(distance - 0.01, 0)
  const towardSign = barrier === 0 ? (direction === 'high' ? 1 : -1) : Math.sign(barrier)

  const nearPoint = round2(towardSign * Math.min(nearMagnitude, maxBeforeMagnitude))
  const halfPoint = round2(towardSign * Math.min(halfMagnitude, maxBeforeMagnitude))
  const preBarrierPoint = round2(direction === 'high' ? barrier - 0.01 : barrier + 0.01)

  if (mode === 'post_only') {
    const postPointOne = round2(direction === 'high' ? barrier + nearMagnitude : barrier - nearMagnitude)
    const postPointTwo = round2(direction === 'high' ? barrier + (2 * nearMagnitude) : barrier - (2 * nearMagnitude))
    return {
      before: uniqueNumeric([nearPoint, halfPoint, preBarrierPoint]),
      after: uniqueNumeric([postPointOne, postPointTwo]),
    }
  }

  const postBarrierPoint = round2(direction === 'high' ? barrier + nearMagnitude : barrier - nearMagnitude)

  return {
    before: uniqueNumeric([nearPoint, halfPoint, preBarrierPoint]),
    after: uniqueNumeric([barrier, postBarrierPoint]),
  }
}

const payoffRows = (resolver, extras = [], basePoints = BASE_POINTS) => axis(extras, basePoints).map((u) => {
  const resolved = Number(resolver(u))
  const s = Number.isFinite(resolved) ? round2(clamp(resolved, -130, 220)) : 0
  return {
    underlyingVarPct: round2(u),
    strategyVarPct: s,
    underlyingTone: tone(u),
    strategyTone: tone(s),
  }
})

const injectBreakevenRows = (rows = []) => {
  const safeRows = Array.isArray(rows)
    ? rows
      .map((row) => {
        const underlying = Number(row?.underlyingVarPct)
        const strategy = Number(row?.strategyVarPct)
        if (!Number.isFinite(underlying) || !Number.isFinite(strategy)) return null
        return {
          ...row,
          underlyingVarPct: round2(underlying),
          strategyVarPct: round2(strategy),
          underlyingTone: tone(underlying),
          strategyTone: tone(strategy),
        }
      })
      .filter(Boolean)
    : []
  if (safeRows.length < 2) return safeRows

  const byUnderlying = new Map()
  safeRows.forEach((row) => {
    byUnderlying.set(round2(row.underlyingVarPct), row)
  })
  const sorted = Array.from(byUnderlying.values()).sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const left = sorted[index]
    const right = sorted[index + 1]
    const x0 = Number(left?.underlyingVarPct)
    const y0 = Number(left?.strategyVarPct)
    const x1 = Number(right?.underlyingVarPct)
    const y1 = Number(right?.strategyVarPct)
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue
    if (Math.abs(y0) < 1e-9 || Math.abs(y1) < 1e-9) continue
    if (y0 * y1 > 0) continue

    const xZero = x0 + ((0 - y0) / (y1 - y0)) * (x1 - x0)
    if (!Number.isFinite(xZero)) continue
    const underlyingVarPct = round2(clamp(xZero, -80, 140))
    if (byUnderlying.has(underlyingVarPct)) continue
    byUnderlying.set(underlyingVarPct, {
      underlyingVarPct,
      strategyVarPct: 0,
      underlyingTone: tone(underlyingVarPct),
      strategyTone: 'neutral',
      isBreakeven: true,
    })
  }

  return Array.from(byUnderlying.values()).sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)
}

const injectSpreadGuideRows = (
  rows = [],
  {
    direction = 'high',
    barrierPct = null,
  } = {},
) => {
  const barrier = Number(barrierPct)
  if (!Number.isFinite(barrier)) return rows
  if (direction !== 'high' && direction !== 'low') return rows
  const safeRows = Array.isArray(rows)
    ? rows
      .map((row) => {
        const underlying = Number(row?.underlyingVarPct)
        const strategy = Number(row?.strategyVarPct)
        if (!Number.isFinite(underlying) || !Number.isFinite(strategy)) return null
        return {
          ...row,
          underlyingVarPct: round2(underlying),
          strategyVarPct: round2(strategy),
          underlyingTone: tone(underlying),
          strategyTone: tone(strategy),
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)
    : []
  if (!safeRows.length) return rows

  const rowMap = new Map()
  safeRows.forEach((row) => {
    rowMap.set(round2(row.underlyingVarPct), row)
  })

  const breakevenCandidates = safeRows.filter((row) => {
    if (Math.abs(Number(row?.strategyVarPct) || 0) > 0.01) return false
    if (direction === 'high') return row.underlyingVarPct > 0 && row.underlyingVarPct < barrier
    return row.underlyingVarPct < 0 && row.underlyingVarPct > barrier
  })
  if (!breakevenCandidates.length) return safeRows

  const breakeven = direction === 'high'
    ? Math.min(...breakevenCandidates.map((row) => row.underlyingVarPct))
    : Math.max(...breakevenCandidates.map((row) => row.underlyingVarPct))

  const span = direction === 'high'
    ? barrier - breakeven
    : breakeven - barrier
  if (!Number.isFinite(span) || span <= 0.02) return safeRows

  let nearDelta = round2(Math.min(5, Math.max(span * 0.25, 0.5)))
  if (nearDelta >= span - 0.01) nearDelta = round2(Math.max(span * 0.4, 0.25))
  if (nearDelta >= span - 0.01) nearDelta = round2(Math.max(span - 0.02, 0.01))
  const midDelta = round2(span / 2)

  const nearTarget = round2(direction === 'high' ? breakeven + nearDelta : breakeven - nearDelta)
  const midTarget = round2(direction === 'high' ? breakeven + midDelta : breakeven - midDelta)
  const preBarrierTarget = round2(direction === 'high' ? barrier - 0.01 : barrier + 0.01)
  const guideTargets = uniqueNumeric([nearTarget, midTarget, preBarrierTarget])

  const interpolateStrategyAt = (target) => {
    const x = Number(target)
    if (!Number.isFinite(x) || safeRows.length < 2) return null
    for (let index = 0; index < safeRows.length - 1; index += 1) {
      const left = safeRows[index]
      const right = safeRows[index + 1]
      const x0 = Number(left?.underlyingVarPct)
      const y0 = Number(left?.strategyVarPct)
      const x1 = Number(right?.underlyingVarPct)
      const y1 = Number(right?.strategyVarPct)
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue
      if (x < Math.min(x0, x1) || x > Math.max(x0, x1)) continue
      return round2(lerp(x, x0, x1, y0, y1))
    }
    return null
  }

  guideTargets.forEach((target) => {
    const x = round2(target)
    if (rowMap.has(x)) return
    const y = interpolateStrategyAt(x)
    if (!Number.isFinite(y)) return
    rowMap.set(x, {
      underlyingVarPct: x,
      strategyVarPct: y,
      underlyingTone: tone(x),
      strategyTone: tone(y),
      isGuide: true,
    })
  })

  return Array.from(rowMap.values()).sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)
}

const orderPayoffRows = (rows, scenarioDirection = 'up') => {
  const safeRows = Array.isArray(rows) ? rows.slice() : []
  if (scenarioDirection === 'down') {
    return safeRows.sort((left, right) => right.underlyingVarPct - left.underlyingVarPct)
  }
  return safeRows.sort((left, right) => right.underlyingVarPct - left.underlyingVarPct)
}

const limitRowsAroundBarriers = (
  rows,
  {
    highBarrierPct = null,
    lowBarrierPct = null,
    highBarrierMode = 'barrier',
    lowBarrierMode = 'barrier',
  } = {},
) => {
  const safeRows = Array.isArray(rows) ? rows : []
  const parseBarrier = (value) => {
    if (value == null || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const highBarrier = parseBarrier(highBarrierPct)
  const lowBarrier = parseBarrier(lowBarrierPct)
  const hasHighBarrier = highBarrier != null
  const hasLowBarrier = lowBarrier != null
  if (!hasHighBarrier && !hasLowBarrier) return safeRows

  const rowMap = new Map()
  safeRows.forEach((row) => {
    const u = Number(row?.underlyingVarPct)
    if (!Number.isFinite(u)) return
    rowMap.set(round2(u), row)
  })
  const values = Array.from(rowMap.keys()).sort((a, b) => a - b)
  const keep = new Set()
  const pickNearestValues = (candidates, targets = []) => {
    const list = uniqueNumeric(candidates)
    if (!list.length) return []
    return uniqueNumeric((targets || []).map((target) => {
      const t = Number(target)
      if (!Number.isFinite(t)) return null
      let best = list[0]
      let bestDistance = Math.abs(list[0] - t)
      for (let index = 1; index < list.length; index += 1) {
        const current = list[index]
        const currentDistance = Math.abs(current - t)
        if (currentDistance < bestDistance) {
          best = current
          bestDistance = currentDistance
        }
      }
      return best
    }))
  }

  if (rowMap.has(0)) keep.add(0)
  rowMap.forEach((row, value) => {
    if (row?.isBreakeven) keep.add(value)
    if (row?.isGuide) keep.add(value)
  })

  const positives = values.filter((value) => value > 0)
  if (hasHighBarrier) {
    const targets = resolveBarrierSamplingTargets(highBarrier, 'high', highBarrierMode)
    const beforeHigh = positives.filter((value) => value < highBarrier)
    const afterHigh = positives.filter((value) => value >= highBarrier)
    pickNearestValues(beforeHigh, targets.before).forEach((value) => keep.add(value))
    pickNearestValues(afterHigh, targets.after).forEach((value) => keep.add(value))
  } else {
    positives.forEach((value) => keep.add(value))
  }

  const negatives = values.filter((value) => value < 0)
  if (hasLowBarrier) {
    const targets = resolveBarrierSamplingTargets(lowBarrier, 'low', lowBarrierMode)
    const beforeLow = negatives.filter((value) => value > lowBarrier)
    const afterLow = negatives.filter((value) => value <= lowBarrier)
    pickNearestValues(beforeLow, targets.before).forEach((value) => keep.add(value))
    pickNearestValues(afterLow, targets.after).forEach((value) => keep.add(value))
  } else {
    negatives.forEach((value) => keep.add(value))
  }

  return values
    .filter((value) => keep.has(value))
    .map((value) => rowMap.get(value))
    .filter(Boolean)
}

const unique = (list) => Array.from(new Set((list || []).filter(Boolean)))

const numberField = (key, label, section = 'Parametros', required = true) => ({ key, label, section, type: 'number', required })
const textField = (key, label, section = 'Parametros', required = true) => ({ key, label, section, type: 'text', required })
const dateField = (key, label, section = 'Identificacao', required = true) => ({ key, label, section, type: 'date', required })

const IDENT_FIELDS = [
  textField('ticker', 'Ativo', 'Identificacao', true),
  numberField('stockQuantity', 'Quantidade base (acoes)', 'Identificacao', false),
  dateField('maturityDate', 'Vencimento', 'Identificacao', true),
  numberField('termMonths', 'Prazo (meses)', 'Identificacao', false),
]

const OPTION_COST_FIELD = numberField('optionCostPct', 'Custo da opcao (%)', 'Identificacao', false)
const OPTION_COST_TEMPLATES = new Set(['call', 'call_spread', 'put', 'put_spread', 'alocacao_protegida'])

const withOptionCostField = (templateId, fields = []) => {
  if (!OPTION_COST_TEMPLATES.has(String(templateId || '').trim())) return fields
  if ((fields || []).some((field) => field?.key === OPTION_COST_FIELD.key)) return fields
  const insertAt = fields.findIndex((field) => field?.key === 'maturityDate')
  if (insertAt < 0) return [...fields, { ...OPTION_COST_FIELD }]
  return [
    ...fields.slice(0, insertAt),
    { ...OPTION_COST_FIELD },
    ...fields.slice(insertAt),
  ]
}

const COMM_FIELDS = [
  textField('ticketMin', 'Ticket minimo', 'Comercial', false),
  textField('feeAai', 'Fee AAI', 'Comercial', false),
]

const BASE_DEFAULTS = {
  ticker: 'BOVX11',
  stockQuantity: '',
  maturityDate: '2026-09-29',
  termMonths: '12',
  ticketMin: 'R$ 2.000,00',
  feeAai: '2,50%',
}

const resolveOptionCostPct = (values = {}, fallback = 0) => {
  const explicit = toNumber(values?.optionCostPct)
  if (explicit != null) return clamp(explicit, 0, 100)
  const fallbackValue = toNumber(fallback)
  if (fallbackValue != null) return clamp(fallbackValue, 0, 100)
  return 0
}

const normalizeOptionType = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (raw === 'STOCK') return 'STOCK'
  return raw === 'PUT' ? 'PUT' : 'CALL'
}

const normalizeOptionSide = (value) => {
  const raw = String(value || '').trim().toLowerCase()
  return raw === 'short' ? 'short' : 'long'
}

const normalizeBarrierType = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (raw === 'UI' || raw === 'UO' || raw === 'KI' || raw === 'KO') return raw
  if (raw === 'DI') return 'KI'
  if (raw === 'DO') return 'KO'
  if (raw === 'NONE') return 'NONE'
  return ''
}

const isExplicitBarrierType = (value) => {
  const raw = normalizeBarrierType(value)
  return raw === 'UI' || raw === 'UO' || raw === 'KI' || raw === 'KO'
}

const normalizeOptionPercentValue = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return { raw: '', percent: null, relativePct: null }
  }
  const parsed = toNumber(raw)
  if (parsed == null) {
    return { raw, percent: null, relativePct: null }
  }
  const rounded = round2(parsed)
  return {
    raw,
    percent: rounded,
    relativePct: round2(rounded - 100),
  }
}

const hasOptionStrikeInput = (entries = []) => (
  (Array.isArray(entries) ? entries : []).some((entry) => !blank(entry?.strike ?? entry?.strikePercent))
)

const resolveBarrierDirection = (barrierType) => {
  const normalized = normalizeBarrierType(barrierType)
  if (normalized === 'UI' || normalized === 'UO') return 'high'
  if (normalized === 'KI' || normalized === 'KO') return 'low'
  return null
}

const buildBarrierGuidePoints = (barrierVarPct, direction) => {
  const targets = resolveBarrierSamplingTargets(barrierVarPct, direction)
  return uniqueNumeric([...targets.before, ...targets.after])
}

const isBarrierHitAtSpot = (spotPct, barrierType, barrierValuePct) => {
  const direction = resolveBarrierDirection(barrierType)
  if (!direction || barrierValuePct == null) return false
  if (direction === 'high') return spotPct >= barrierValuePct
  return spotPct <= barrierValuePct
}

const isOptionLegActiveAtSpot = (leg, spotPct) => {
  const barrierType = normalizeBarrierType(leg?.barrierType)
  const barrierValuePct = toNumber(leg?.barrierValuePct ?? leg?.barrierValue ?? leg?.barrierPercent)
  if (!isExplicitBarrierType(barrierType) || barrierValuePct == null) return true
  const hit = isBarrierHitAtSpot(spotPct, barrierType, barrierValuePct)
  if (barrierType === 'UO' || barrierType === 'KO') return !hit
  if (barrierType === 'UI' || barrierType === 'KI') return hit
  return true
}

const buildOptionLegSpecs = (entries = [], { baseQuantity } = {}) => {
  const rawSpecs = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const optionType = normalizeOptionType(entry?.optionType)
      const side = normalizeOptionSide(entry?.side)
      const strikePct = toNumber(entry?.strike ?? entry?.strikePercent)
      if (optionType !== 'STOCK' && strikePct == null) return null
      const barrierType = normalizeBarrierType(entry?.barrierType)
      const barrierValuePct = isExplicitBarrierType(barrierType)
        ? toNumber(entry?.barrierValue ?? entry?.barrierPercent)
        : null
      const couponPct = toNumber(entry?.coupon ?? entry?.couponPct)
      const parsedQuantity = toNumber(entry?.quantity)
      const quantityAbs = parsedQuantity != null && parsedQuantity > 0 ? Math.abs(parsedQuantity) : null
      return {
        id: entry?.id || `leg-${index + 1}`,
        optionType,
        side,
        strikePct: optionType === 'STOCK' || strikePct == null ? null : round2(strikePct),
        barrierType,
        barrierValuePct: barrierValuePct == null ? null : round2(barrierValuePct),
        couponPct: couponPct == null ? null : round2(couponPct),
        quantityAbs,
      }
    })
    .filter(Boolean)

  const explicitQty = rawSpecs
    .map((spec) => Number(spec?.quantityAbs))
    .filter((value) => Number.isFinite(value) && value > 0)
  const explicitBaseQty = toNumber(baseQuantity)
  const normalizedBaseQty = explicitBaseQty != null && explicitBaseQty > 0 ? Math.abs(explicitBaseQty) : null
  const stockQtyList = rawSpecs
    .filter((spec) => spec.optionType === 'STOCK')
    .map((spec) => Number(spec?.quantityAbs))
    .filter((value) => Number.isFinite(value) && value > 0)
  const referenceQty = normalizedBaseQty != null
    ? normalizedBaseQty
    : stockQtyList.length
    ? Math.max(...stockQtyList)
    : (explicitQty.length ? Math.max(...explicitQty) : 1)

  return rawSpecs.map((spec) => {
    const qty = Number(spec?.quantityAbs)
    const normalizedQty = Number.isFinite(qty) && qty > 0 ? qty : referenceQty
    return {
      ...spec,
      quantityAbs: normalizedQty,
      quantityFactor: round2(normalizedQty / referenceQty),
    }
  })
}

const resolveHighBarrierFromOptionSpecs = (specs = []) => {
  const thresholds = (Array.isArray(specs) ? specs : [])
    .filter((leg) => isExplicitBarrierType(leg?.barrierType))
    .filter((leg) => resolveBarrierDirection(leg?.barrierType) === 'high')
    .map((leg) => toNumber(leg?.barrierValuePct))
    .filter((value) => value != null)
    .map((value) => round2(value - 100))
  if (!thresholds.length) return null
  return Math.min(...thresholds)
}

const resolveLowBarrierFromOptionSpecs = (specs = []) => {
  const thresholds = (Array.isArray(specs) ? specs : [])
    .filter((leg) => isExplicitBarrierType(leg?.barrierType))
    .filter((leg) => resolveBarrierDirection(leg?.barrierType) === 'low')
    .map((leg) => toNumber(leg?.barrierValuePct))
    .filter((value) => value != null)
    .map((value) => round2(value - 100))
  if (!thresholds.length) return null
  return Math.max(...thresholds)
}

const resolveHighCapFromOptionEntries = (entries = []) => {
  const caps = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const optionType = normalizeOptionType(entry?.optionType)
      const side = normalizeOptionSide(entry?.side)
      if (optionType !== 'CALL' || side !== 'short') return null
      const strike = toNumber(entry?.strike ?? entry?.strikePercent)
      if (strike == null) return null
      return round2(strike - 100)
    })
    .filter((value) => value != null)
  if (!caps.length) return null
  return Math.min(...caps)
}

const resolveLowCapFromOptionEntries = (entries = []) => {
  const caps = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const optionType = normalizeOptionType(entry?.optionType)
      const side = normalizeOptionSide(entry?.side)
      if (optionType !== 'PUT' || side !== 'short') return null
      const strike = toNumber(entry?.strike ?? entry?.strikePercent)
      if (strike == null) return null
      return round2(strike - 100)
    })
    .filter((value) => value != null)
  if (!caps.length) return null
  return Math.max(...caps)
}

const computeOptionLegReturnPct = (leg, spotPct) => {
  if (leg?.optionType === 'STOCK') return 0
  if (!isOptionLegActiveAtSpot(leg, spotPct)) return 0
  const strike = Number(leg?.strikePct)
  if (!Number.isFinite(strike)) return 0
  let intrinsic = 0
  if (leg.optionType === 'CALL') intrinsic = Math.max(spotPct - strike, 0)
  if (leg.optionType === 'PUT') intrinsic = Math.max(strike - spotPct, 0)
  const signal = leg.side === 'short' ? -1 : 1
  const qtyFactor = Number(leg?.quantityFactor)
  const quantity = Number.isFinite(qtyFactor) && qtyFactor > 0 ? qtyFactor : 1
  const couponPct = Number(leg?.couponPct)
  const couponReturn = Number.isFinite(couponPct) ? couponPct : 0
  return quantity * (signal * intrinsic + couponReturn)
}

const resolveCouponConfigFromOptions = (entries = [], fallbackCouponPct = 0, fallbackDownBarrierAbsPct = 0, baseQuantity = null) => {
  const rawEntries = Array.isArray(entries) ? entries : []
  const specs = buildOptionLegSpecs(rawEntries, { baseQuantity })
  let couponPct = round2(fallbackCouponPct)
  let downBarrierAbsPct = Math.abs(round2(fallbackDownBarrierAbsPct))
  const warnings = []

  if (!specs.length) {
    if (rawEntries.length) warnings.push('Preencha strike, barreira D.O e cupom (%) na opcao.')
    return { specs, couponPct, downBarrierAbsPct, warnings }
  }

  const putDo = specs.find((leg) => (
    leg.optionType === 'PUT'
    && leg.side === 'long'
    && leg.barrierType === 'KO'
    && leg.barrierValuePct != null
  ))
  const couponLeg = specs.find((leg) => Number.isFinite(Number(leg?.couponPct)))

  if (putDo) {
    downBarrierAbsPct = Math.abs(round2(100 - Number(putDo.barrierValuePct)))
  } else {
    warnings.push('Inclua uma put comprada com barreira D.O.')
  }

  if (couponLeg) {
    couponPct = round2(Number(couponLeg.couponPct))
  } else {
    warnings.push('Informe o cupom (%) na opcao da estrutura.')
  }

  return { specs, couponPct, downBarrierAbsPct, warnings }
}

const buildOptionDrivenRows = (
  entries = [],
  {
    includeUnderlying = true,
    baseQuantity = null,
    highSamplingGuidePct = null,
    highSamplingGuideMode = 'barrier',
    lowSamplingGuidePct = null,
    lowSamplingGuideMode = 'barrier',
  } = {},
) => {
  const specs = buildOptionLegSpecs(entries, { baseQuantity })
  const derivativeSpecs = specs.filter((leg) => leg.optionType === 'CALL' || leg.optionType === 'PUT')
  const extras = []
  const highBarriers = []
  const lowBarriers = []
  derivativeSpecs.forEach((leg) => {
    if (Number.isFinite(Number(leg.strikePct))) extras.push(leg.strikePct - 100)
    if (isExplicitBarrierType(leg.barrierType) && leg.barrierValuePct != null) {
      const barrierVarPct = round2(leg.barrierValuePct - 100)
      const direction = resolveBarrierDirection(leg.barrierType)
      extras.push(...buildBarrierGuidePoints(barrierVarPct, direction))
      if (direction === 'high') highBarriers.push(barrierVarPct)
      if (direction === 'low') lowBarriers.push(barrierVarPct)
    }
  })

  const highGuide = toNumber(highSamplingGuidePct)
  if (highGuide != null) {
    const guideTargets = resolveBarrierSamplingTargets(highGuide, 'high', highSamplingGuideMode)
    extras.push(...guideTargets.before, round2(highGuide), ...guideTargets.after)
  }
  const lowGuide = toNumber(lowSamplingGuidePct)
  if (lowGuide != null) {
    const guideTargets = resolveBarrierSamplingTargets(lowGuide, 'low', lowSamplingGuideMode)
    extras.push(...guideTargets.before, round2(lowGuide), ...guideTargets.after)
  }

  const hasAnyBarrier = highBarriers.length > 0 || lowBarriers.length > 0
  let contextualBase = hasAnyBarrier
    ? OPTION_DRIVEN_BASE_POINTS.slice()
    : OPTION_DRIVEN_NO_BARRIER_BASE_POINTS.slice()
  if (highBarriers.length) {
    const nearestHighBarrier = Math.min(...highBarriers)
    contextualBase = contextualBase.filter((point) => point <= nearestHighBarrier - 0.01)
  }
  if (lowBarriers.length) {
    const nearestLowBarrier = Math.max(...lowBarriers)
    contextualBase = contextualBase.filter((point) => point >= nearestLowBarrier + 0.01)
  }
  if (!contextualBase.includes(0)) contextualBase.push(0)

  const rows = payoffRows((u) => {
    const spotPct = 100 + u
    const optionsReturn = derivativeSpecs.reduce((sum, leg) => sum + computeOptionLegReturnPct(leg, spotPct), 0)
    return (includeUnderlying ? u : 0) + optionsReturn
  }, extras, contextualBase)

  return { rows, specs, hasDerivativeLegs: derivativeSpecs.length > 0 }
}

const buildOptionSettlementReturnRows = (
  entries = [],
  {
    baseQuantity = null,
    optionCostPct = null,
    includeUnderlying = false,
    includeUnderlyingInEntry = false,
    highSamplingGuidePct = null,
    highSamplingGuideMode = 'barrier',
    lowSamplingGuidePct = null,
    lowSamplingGuideMode = 'barrier',
  } = {},
) => {
  const optionPayoff = buildOptionDrivenRows(entries, {
    includeUnderlying,
    baseQuantity,
    highSamplingGuidePct,
    highSamplingGuideMode,
    lowSamplingGuidePct,
    lowSamplingGuideMode,
  })
  const cost = toNumber(optionCostPct)
  const hasValidCost = cost != null && cost > 0
  const entryBase = (includeUnderlyingInEntry ? 100 : 0) + (hasValidCost ? cost : 0)

  if (!optionPayoff.hasDerivativeLegs || !hasValidCost || entryBase <= 0) {
    return {
      ...optionPayoff,
      hasValidCost,
      leveraged: false,
    }
  }

  const rows = (optionPayoff.rows || []).map((row) => {
    const grossPnlPct = Number(row?.strategyVarPct)
    const gainPct = (Number.isFinite(grossPnlPct) ? grossPnlPct : 0) - cost
    const strategyReturnPct = (gainPct / entryBase) * 100
    const normalized = round2(clamp(strategyReturnPct, -999, 999))
    return {
      ...row,
      strategyVarPct: normalized,
      strategyTone: tone(normalized),
    }
  })

  return {
    ...optionPayoff,
    rows,
    hasValidCost: true,
    leveraged: true,
    entryBasePct: round2(entryBase),
  }
}

let optionEntrySeq = 0
const nextOptionEntryId = () => {
  optionEntrySeq += 1
  return `opt-${optionEntrySeq}`
}

const OPTION_FORM_MAP = {
  call: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'CALL', side: 'long', label: 'Call comprada' },
    ],
  },
  put: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'PUT', side: 'long', label: 'Put comprada' },
    ],
  },
  put_spread: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'PUT', side: 'long', label: 'Put comprada' },
      { optionType: 'PUT', side: 'short', label: 'Put vendida' },
    ],
  },
  collar_ui: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'CALL', side: 'short', label: 'Call vendida (UI)', barrierType: 'UI' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada' },
    ],
  },
  call_spread: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'CALL', side: 'long', label: 'Call comprada' },
      { optionType: 'CALL', side: 'short', label: 'Call vendida' },
    ],
  },
  collar: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'CALL', side: 'short', label: 'Call vendida' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada' },
    ],
  },
  fence_ui: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'CALL', side: 'short', label: 'Call vendida (UI)', barrierType: 'UI' },
      { optionType: 'PUT', side: 'short', label: 'Put vendida' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada' },
    ],
  },
  collar_ui_bidirecional: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'PUT', side: 'long', label: 'Put comprada de protecao', strike: '100' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada com desativacao na queda', strike: '100', barrierType: 'KO', barrierValue: '85' },
      { optionType: 'CALL', side: 'short', label: 'Call vendida com ativacao na alta', strike: '114', barrierType: 'UI', barrierValue: '150' },
    ],
  },
  booster_ko: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'CALL', side: 'long', label: 'Call comprada' },
      { optionType: 'CALL', side: 'short', label: 'Call vendida (KO)', barrierType: 'KO' },
    ],
  },
  doc_bidirecional: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'PUT', side: 'long', label: 'Put de protecao com KO de baixa', strike: '100', barrierType: 'KO', barrierValue: '70' },
      { optionType: 'PUT', side: 'long', label: 'Put de ativacao na alta', strike: '107', barrierType: 'UI', barrierValue: '125' },
      { optionType: 'CALL', side: 'long', label: 'Call comprada com desativacao na alta', strike: '100', barrierType: 'UO', barrierValue: '125' },
      { optionType: 'CALL', side: 'short', label: 'Call vendida com ativacao na alta', strike: '107', barrierType: 'UI', barrierValue: '125' },
    ],
  },
  alocacao_protegida: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'PUT', side: 'long', label: 'Put de protecao' },
      { optionType: 'CALL', side: 'short', label: 'Call vendida' },
    ],
  },
  pop: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'CALL', side: 'long', label: 'Call comprada' },
      { optionType: 'CALL', side: 'short', label: 'Call vendida parcial' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada' },
    ],
  },
  rubi: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'CALL', side: 'short', label: 'Call vendida', barrierType: 'KO' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada' },
    ],
  },
  rubi_black: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'CALL', side: 'short', label: 'Call vendida', barrierType: 'KO' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada' },
    ],
  },
  smart_coupon: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    showCoupon: true,
    defaultEntries: [
      { optionType: 'PUT', side: 'long', label: 'Put com barreira D.O', strike: '100', barrierType: 'KO', barrierValue: '90', coupon: '6' },
    ],
  },
  cupom_recorrente: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    showCoupon: true,
    defaultEntries: [
      { optionType: 'PUT', side: 'long', label: 'Put com barreira D.O', strike: '100', barrierType: 'KO', barrierValue: '83.35', coupon: '8' },
    ],
  },
}

const normalizeOptionEntry = (entry = {}, optionForm = {}) => {
  const barrierType = optionForm.showBarrier ? normalizeBarrierType(entry.barrierType) : ''
  const strikeInput = optionForm.showStrike ? (entry.strike ?? entry.strikePercent ?? '') : ''
  const strike = normalizeOptionPercentValue(strikeInput)
  const couponInput = optionForm.showCoupon ? (entry.coupon ?? entry.couponPct ?? '') : ''
  const coupon = normalizeOptionPercentValue(couponInput)
  const useCustomQuantity = entry?.useCustomQuantity === true || !blank(entry?.quantity)
  const quantityRaw = useCustomQuantity && entry?.quantity != null ? String(entry.quantity) : ''
  const barrierInput = optionForm.showBarrier && isExplicitBarrierType(barrierType)
    ? (entry.barrierValue ?? entry.barrierPercent ?? '')
    : ''
  const barrier = normalizeOptionPercentValue(barrierInput)
  return {
    id: entry.id || nextOptionEntryId(),
    label: String(entry.label || '').trim(),
    optionType: normalizeOptionType(entry.optionType),
    side: normalizeOptionSide(entry.side),
    useCustomQuantity,
    quantity: quantityRaw,
    strike: optionForm.showStrike ? strike.raw : '',
    strikePercent: optionForm.showStrike ? strike.percent : null,
    strikeRelativePct: optionForm.showStrike ? strike.relativePct : null,
    barrierType,
    barrierValue: optionForm.showBarrier && isExplicitBarrierType(barrierType) ? barrier.raw : '',
    barrierPercent: optionForm.showBarrier && isExplicitBarrierType(barrierType) ? barrier.percent : null,
    barrierRelativePct: optionForm.showBarrier && isExplicitBarrierType(barrierType) ? barrier.relativePct : null,
    coupon: optionForm.showCoupon ? coupon.raw : '',
    couponPct: optionForm.showCoupon ? coupon.percent : null,
  }
}

const buildDefaultOptionEntries = (optionForm = {}) => {
  const defaults = Array.isArray(optionForm.defaultEntries) ? optionForm.defaultEntries : []
  return defaults.map((entry) => normalizeOptionEntry(entry, optionForm))
}

const normalizeOptionEntries = (entries, optionForm = {}) => {
  if (!optionForm?.enabled) return []
  const safeList = Array.isArray(entries) ? entries : []
  if (!safeList.length) return buildDefaultOptionEntries(optionForm)
  return safeList.map((entry) => normalizeOptionEntry(entry, optionForm))
}

const validateOptionEntries = (entries, optionForm = {}) => {
  if (!optionForm?.enabled) return []
  const issues = []
  ;(entries || []).forEach((entry, index) => {
    if (!entry) return
    if (entry.useCustomQuantity && !blank(entry.quantity) && toNumber(entry.quantity) == null) {
      issues.push(`Quantidade invalida na opcao ${index + 1}.`)
    } else if (entry.useCustomQuantity && !blank(entry.quantity) && Number(toNumber(entry.quantity)) <= 0) {
      issues.push(`Quantidade deve ser maior que zero na opcao ${index + 1}.`)
    }
    if (optionForm.showStrike && !blank(entry.strike) && toNumber(entry.strike) == null) {
      issues.push(`Strike (%) invalido na opcao ${index + 1}.`)
    }
    if (optionForm.showBarrier && isExplicitBarrierType(entry.barrierType) && !blank(entry.barrierValue) && toNumber(entry.barrierValue) == null) {
      issues.push(`Barreira (%) invalida na opcao ${index + 1}.`)
    }
    if (optionForm.showCoupon && !blank(entry.coupon) && toNumber(entry.coupon) == null) {
      issues.push(`Cupom (%) invalido na opcao ${index + 1}.`)
    }
  })
  return unique(issues)
}

const validateFields = (fields, values) => {
  const issues = []
  ;(fields || []).forEach((field) => {
    const value = values[field.key]
    if (field.required && blank(value)) {
      issues.push(`Preencha "${field.label}".`)
      return
    }
    if (blank(value)) return
    if (field.type === 'number' && toNumber(value) == null) issues.push(`Valor invalido em "${field.label}".`)
    if (field.type === 'date' && fmtDate(value) === '--') issues.push(`Data invalida em "${field.label}".`)
  })
  return unique(issues)
}

const toCommercialSectionText = (value) => {
  let text = String(value || '')
  text = text.replace(/UI\/UO\/KI\/KO/gi, 'gatilhos de ativacao e desativacao')
  text = text.replace(/barreira\s+KO\s+de\s+baixa/gi, 'nivel de desativacao na queda')
  text = text.replace(/barreira\s+KO\s+de\s+alta/gi, 'nivel de desativacao na alta')
  text = text.replace(/barreira\s+KI\s+de\s+baixa/gi, 'nivel de ativacao na queda')
  text = text.replace(/barreira\s+UI\s+de\s+alta/gi, 'nivel de ativacao na alta')
  text = text.replace(/barreira\s+UO\s+de\s+alta/gi, 'nivel de desativacao na alta')
  return text.replace(/\s{2,}/g, ' ').trim()
}

const buildMessage = ({ label, tickerLabel, maturityLabel, sections }) => ([
  `*${label} em ${tickerLabel}*`,
  '',
  ...(sections || []).filter(Boolean).map((section) => toCommercialSectionText(section)),
  '',
  `*Vencimento da estrategia:* ${maturityLabel}`,
  '_(Possivel saida antecipada mediante cotacao)._',
].join('\n'))

const buildModel = ({
  template,
  values,
  subtitle,
  sections,
  metrics,
  highlights,
  rows,
  validations = [],
  scenarioDirection = 'up',
  maxGainBarrierPct = null,
  highBarrierSamplingPct = null,
  lowBarrierSamplingPct = null,
  highBarrierSamplingMode = 'barrier',
  lowBarrierSamplingMode = 'barrier',
}) => {
  const tk = ticker(values.ticker)
  const maturityLabel = fmtDate(values.maturityDate)
  const rowsWithBreakeven = injectBreakevenRows(rows)
  const sampledRows = limitRowsAroundBarriers(rowsWithBreakeven, {
    highBarrierPct: highBarrierSamplingPct,
    lowBarrierPct: lowBarrierSamplingPct,
    highBarrierMode: highBarrierSamplingMode,
    lowBarrierMode: lowBarrierSamplingMode,
  })
  const orderedRows = orderPayoffRows(sampledRows, scenarioDirection)
  return {
    templateId: template.id,
    templateLabel: template.label,
    title: `${template.label} (${tk})`,
    subtitle: subtitle || 'Payoff no vencimento.',
    metrics: metrics || [],
    highlights: highlights || [],
    footer: {
      ticketMin: fmtCurrency(values.ticketMin),
      feeAai: fmtFee(values.feeAai),
    },
    payoffRows: orderedRows,
    maxGainBarrierPct: Number.isFinite(Number(maxGainBarrierPct)) ? Number(maxGainBarrierPct) : null,
    generatedMessage: buildMessage({ label: template.label, tickerLabel: tk, maturityLabel, sections }),
    validations: unique([...(validateFields(template.fields, values) || []), ...(validations || [])]),
    tableHeadLeft: 'Variacao do ativo',
    tableHeadRight: 'Variacao da estrutura',
  }
}

const templates = [
  {
    id: 'put_spread',
    label: 'Put Spread',
    scenarioDirection: 'down',
    defaults: { ...BASE_DEFAULTS, ticker: 'PETR4', termMonths: '6', optionCostPct: '3', startDownPct: '-5', limitDownPct: '-25', maxGainPct: '18', premiumPct: '3', ticketMin: 'R$ 3.700,00', feeAai: '1,25%' },
    fields: [...IDENT_FIELDS, numberField('startDownPct', 'Inicio do ganho na queda (%)'), numberField('limitDownPct', 'Limite da queda (%)'), numberField('maxGainPct', 'Ganho maximo (%)'), numberField('premiumPct', 'Premio pago (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const optionCost = resolveOptionCostPct(values, values.premiumPct)
      const startFromCost = -Math.abs(optionCost)
      const startRaw = blank(values.optionCostPct)
        ? pct(values.startDownPct, startFromCost)
        : startFromCost
      const limitRaw = pct(values.limitDownPct, -25)
      const maxGain = pct(values.maxGainPct, 18, 0, 250)
      const premium = optionCost
      const start = Math.max(startRaw, limitRaw)
      const limit = Math.min(startRaw, limitRaw)
      const floorFromOptions = resolveLowCapFromOptionEntries(values.options)
      const effectiveFloor = floorFromOptions != null ? floorFromOptions : limit
      const floorGuideTargets = resolveBarrierSamplingTargets(effectiveFloor, 'low', 'post_only')
      const floorGuideExtras = [...floorGuideTargets.before, effectiveFloor, ...floorGuideTargets.after]
      const fallbackRows = payoffRows(
        (u) => (u >= 0 ? -premium : (u > start ? lerp(u, 0, start, -premium, 0) : (u > limit ? lerp(u, start, limit, 0, maxGain) : maxGain))),
        [start, limit, ...floorGuideExtras],
      )
      const optionSettlement = buildOptionSettlementReturnRows(values.options, {
        includeUnderlying: false,
        includeUnderlyingInEntry: false,
        optionCostPct: optionCost,
        baseQuantity: values.stockQuantity,
        lowSamplingGuidePct: effectiveFloor,
        lowSamplingGuideMode: 'post_only',
      })
      const rows = optionSettlement.leveraged
        ? injectSpreadGuideRows(injectBreakevenRows(optionSettlement.rows), {
          direction: 'low',
          barrierPct: effectiveFloor,
        })
        : fallbackRows
      const warnings = startRaw <= limitRaw ? ['O inicio do ganho deve ser maior que o limite da queda.'] : []
      const hasStrikeInput = hasOptionStrikeInput(values.options)
      if (hasStrikeInput && !optionSettlement.hasDerivativeLegs) warnings.push('Configure strike nas opcoes para calculo de vencimento.')
      if (hasStrikeInput && !optionSettlement.hasValidCost) warnings.push('Informe o custo da opcao (%) para calcular o retorno alavancado.')
      return buildModel({
        template, values, rows, validations: warnings,
        scenarioDirection: template.scenarioDirection || 'up',
        lowBarrierSamplingPct: effectiveFloor,
        lowBarrierSamplingMode: 'post_only',
        subtitle: 'Ganho na queda com perda limitada ao premio.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Ganho maximo', value: fmtPct(maxGain), tone: 'positive' }, { label: 'Premio', value: `-${fmtPct(premium)}`, tone: 'negative' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highlights: [`Inicio na queda: ${fmtPct(start)}`, `Limitador: ${fmtPct(limit)}`, `Perda maxima: ${fmtPct(premium)}`],
        sections: [
          `*Objetivo:* Buscar ganho com a queda de ${tk}, com risco limitado ao custo da estrutura de ${fmtPct(premium)}.`,
          `*Cenario de ganho:* Se ${tk} cair entre ${fmtPct(start)} e ${fmtPct(limit)}, o retorno cresce de forma gradual ate ${fmtPct(maxGain)}; abaixo de ${fmtPct(limit)}, o ganho permanece em ${fmtPct(maxGain)}.`,
          `*Cenario de perda:* Se ${tk} ficar estavel ou subir, a perda maxima fica limitada a ${fmtPct(premium)}.`,
        ],
      })
    },
  },
  {
    id: 'collar_ui',
    label: 'Collar UI',
    defaults: { ...BASE_DEFAULTS, ticker: 'BCPX39', termMonths: '12', protectionPct: '90', barrierUpPct: '36,99', capAfterPct: '7', ticketMin: 'R$ 13.500,00', feeAai: '2,50%' },
    fields: [...IDENT_FIELDS, numberField('protectionPct', 'Protecao de capital (%)'), numberField('barrierUpPct', 'Barreira de alta (%)'), numberField('capAfterPct', 'Limitador apos barreira (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const protection = pct(values.protectionPct, 90, 0, 100)
      const barrier = pct(values.barrierUpPct, 36.99, 0, 200)
      const capAfter = pct(values.capAfterPct, 7, -50, 200)
      const floor = -(100 - protection)
      const preBarrier = beforeBarrierPct(barrier, 'high')
      const rows = payoffRows((u) => (u <= floor ? floor : (u <= barrier ? u : Math.min(u, capAfter))), [floor, barrier, capAfter])
      return buildModel({
        template, values, rows,
        subtitle: 'Protecao de capital com limite de alta apos ativacao da barreira.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Barreira alta', value: fmtPct(barrier) }, { label: 'Limitador', value: fmtPct(capAfter), tone: 'positive' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        maxGainBarrierPct: barrier,
        highBarrierSamplingPct: barrier,
        highlights: [`Protecao: ${fmtPct(protection)} do capital`, `Barreira de alta: ${fmtPct(barrier)}`, `Limitador de alta: ${fmtPct(capAfter)}`],
        sections: [
          `*Objetivo:* Participar da valorizacao de ${tk} ate ${fmtPct(preBarrier)}. Caso a alta seja igual ou superior a ${fmtPct(barrier)}, o retorno final fica limitado a ${fmtPct(capAfter)} no periodo.`,
          `*Cenario de ganho:* Em alta, o investidor acompanha o ativo ate ${fmtPct(preBarrier)}; ao atingir ${fmtPct(barrier)}, o ganho fica travado em ${fmtPct(capAfter)}.`,
          `*Cenario de perda:* Em queda, o resultado minimo da estrategia fica limitado em ${fmtPct(floor)}.`,
        ],
      })
    },
  },
  {
    id: 'call_spread',
    label: 'Call Spread',
    defaults: { ...BASE_DEFAULTS, ticker: 'B3SA3', termMonths: '6', optionCostPct: '3', startUpPct: '5', limitUpPct: '25', maxGainPct: '20', premiumPct: '3', ticketMin: 'R$ 1.700,00', feeAai: '1,33%' },
    fields: [...IDENT_FIELDS, numberField('startUpPct', 'Inicio do ganho na alta (%)'), numberField('limitUpPct', 'Limite da alta (%)'), numberField('maxGainPct', 'Ganho maximo (%)'), numberField('premiumPct', 'Premio pago (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const optionCost = resolveOptionCostPct(values, values.premiumPct)
      const startFromCost = Math.abs(optionCost)
      const startRaw = blank(values.optionCostPct)
        ? pct(values.startUpPct, startFromCost)
        : startFromCost
      const limitRaw = pct(values.limitUpPct, 25)
      const maxGain = pct(values.maxGainPct, 20, 0, 250)
      const premium = optionCost
      const start = Math.min(startRaw, limitRaw)
      const limit = Math.max(startRaw, limitRaw)
      const capFromOptions = resolveHighCapFromOptionEntries(values.options)
      const effectiveCap = capFromOptions != null ? capFromOptions : limit
      const capGuideTargets = resolveBarrierSamplingTargets(effectiveCap, 'high', 'post_only')
      const capGuideExtras = [...capGuideTargets.before, effectiveCap, ...capGuideTargets.after]
      const fallbackRows = payoffRows(
        (u) => (u <= 0 ? -premium : (u < start ? lerp(u, 0, start, -premium, 0) : (u < limit ? lerp(u, start, limit, 0, maxGain) : maxGain))),
        [start, limit, ...capGuideExtras],
      )
      const optionSettlement = buildOptionSettlementReturnRows(values.options, {
        includeUnderlying: false,
        includeUnderlyingInEntry: false,
        optionCostPct: optionCost,
        baseQuantity: values.stockQuantity,
        highSamplingGuidePct: effectiveCap,
        highSamplingGuideMode: 'post_only',
      })
      const rows = optionSettlement.leveraged
        ? injectSpreadGuideRows(injectBreakevenRows(optionSettlement.rows), {
          direction: 'high',
          barrierPct: effectiveCap,
        })
        : fallbackRows
      const warnings = startRaw >= limitRaw ? ['O inicio do ganho deve ser menor que o limite da alta.'] : []
      const hasStrikeInput = hasOptionStrikeInput(values.options)
      if (hasStrikeInput && !optionSettlement.hasDerivativeLegs) warnings.push('Configure strike nas opcoes para calculo de vencimento.')
      if (hasStrikeInput && !optionSettlement.hasValidCost) warnings.push('Informe o custo da opcao (%) para calcular o retorno alavancado.')
      return buildModel({
        template, values, rows, validations: warnings,
        subtitle: 'Alta alavancada com perda limitada ao premio.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Ganho maximo', value: fmtPct(maxGain), tone: 'positive' }, { label: 'Premio', value: `-${fmtPct(premium)}`, tone: 'negative' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highBarrierSamplingPct: effectiveCap,
        highBarrierSamplingMode: 'post_only',
        highlights: [`Inicio da alta: ${fmtPct(start)}`, `Limitador da alta: ${fmtPct(limit)}`, `Perda maxima: ${fmtPct(premium)}`],
        sections: [
          `*Objetivo:* Buscar ganho com a alta de ${tk} entre ${fmtPct(start)} e ${fmtPct(limit)}, com risco limitado ao custo da estrutura de ${fmtPct(premium)}.`,
          `*Cenario de ganho:* Se ${tk} subir entre ${fmtPct(start)} e ${fmtPct(limit)}, o retorno cresce de forma gradual ate ${fmtPct(maxGain)}; acima de ${fmtPct(limit)}, o ganho permanece em ${fmtPct(maxGain)}.`,
          `*Cenario de perda:* Em estabilidade ou queda, a perda maxima fica limitada a ${fmtPct(premium)}.`,
        ],
      })
    },
  },
  {
    id: 'call',
    label: 'Call',
    defaults: { ...BASE_DEFAULTS, ticker: 'B3SA3', termMonths: '6', optionCostPct: '4', ticketMin: 'R$ 1.700,00', feeAai: '1,33%' },
    fields: [...IDENT_FIELDS, ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const optionCost = resolveOptionCostPct(values, 4)
      const fallbackRows = payoffRows(
        (u) => {
          if (u <= 0) return -100
          const base = optionCost > 0 ? optionCost : 0.01
          return ((u - optionCost) / base) * 100
        },
        [5, 10, 20, 30],
        OPTION_DRIVEN_NO_BARRIER_BASE_POINTS,
      )
      const optionSettlement = buildOptionSettlementReturnRows(values.options, {
        includeUnderlying: false,
        includeUnderlyingInEntry: false,
        optionCostPct: optionCost,
        baseQuantity: values.stockQuantity,
      })
      const rows = optionSettlement.leveraged ? optionSettlement.rows : fallbackRows
      const candidates = (rows || [])
        .map((row) => Number(row?.strategyVarPct))
        .filter((value) => Number.isFinite(value))
      const maxGain = candidates.length ? Math.max(...candidates) : 0
      const warnings = []
      const hasStrikeInput = hasOptionStrikeInput(values.options)
      if (hasStrikeInput && !optionSettlement.hasDerivativeLegs) warnings.push('Configure strike nas opcoes para calculo de vencimento.')
      if (hasStrikeInput && !optionSettlement.hasValidCost) warnings.push('Informe o custo da opcao (%) para calcular o retorno alavancado.')
      return buildModel({
        template, values, rows, validations: warnings,
        subtitle: 'Exposicao de alta com risco limitado ao valor investido.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Ganho maximo', value: fmtPct(maxGain), tone: maxGain > 0 ? 'positive' : 'neutral' }, { label: 'Risco maximo', value: '-100,00%', tone: 'negative' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highlights: [`Custo da opcao: ${fmtPct(optionCost)}`, 'Perda maxima limitada ao valor investido', 'Retorno cresce com a alta acima do ponto de equilibrio'],
        sections: [
          `*Objetivo:* Buscar ganho alavancado na alta de ${tk}, com risco maximo limitado ao valor pago na estrutura.`,
          `*Cenario de ganho:* Acima do ponto de equilibrio, o retorno cresce conforme a alta do ativo, sem teto de ganho no vencimento.`,
          `*Cenario de perda:* Em estabilidade ou queda, a perda maxima fica limitada a 100,00% do valor investido na opcao.`,
        ],
      })
    },
  },
  {
    id: 'put',
    label: 'Put',
    scenarioDirection: 'down',
    defaults: { ...BASE_DEFAULTS, ticker: 'PETR4', termMonths: '6', optionCostPct: '4', ticketMin: 'R$ 1.700,00', feeAai: '1,33%' },
    fields: [...IDENT_FIELDS, ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const optionCost = resolveOptionCostPct(values, 4)
      const fallbackRows = payoffRows(
        (u) => {
          if (u >= 0) return -100
          const base = optionCost > 0 ? optionCost : 0.01
          return (((-u) - optionCost) / base) * 100
        },
        [-5, -10, -20, -30],
        OPTION_DRIVEN_NO_BARRIER_BASE_POINTS,
      )
      const optionSettlement = buildOptionSettlementReturnRows(values.options, {
        includeUnderlying: false,
        includeUnderlyingInEntry: false,
        optionCostPct: optionCost,
        baseQuantity: values.stockQuantity,
      })
      const rows = optionSettlement.leveraged ? optionSettlement.rows : fallbackRows
      const candidates = (rows || [])
        .map((row) => Number(row?.strategyVarPct))
        .filter((value) => Number.isFinite(value))
      const maxGain = candidates.length ? Math.max(...candidates) : 0
      const warnings = []
      const hasStrikeInput = hasOptionStrikeInput(values.options)
      if (hasStrikeInput && !optionSettlement.hasDerivativeLegs) warnings.push('Configure strike nas opcoes para calculo de vencimento.')
      if (hasStrikeInput && !optionSettlement.hasValidCost) warnings.push('Informe o custo da opcao (%) para calcular o retorno alavancado.')
      return buildModel({
        template, values, rows, validations: warnings,
        scenarioDirection: template.scenarioDirection || 'up',
        subtitle: 'Exposicao de queda com risco limitado ao valor investido.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Ganho maximo', value: fmtPct(maxGain), tone: maxGain > 0 ? 'positive' : 'neutral' }, { label: 'Risco maximo', value: '-100,00%', tone: 'negative' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highlights: [`Custo da opcao: ${fmtPct(optionCost)}`, 'Perda maxima limitada ao valor investido', 'Retorno cresce com a queda abaixo do ponto de equilibrio'],
        sections: [
          `*Objetivo:* Buscar ganho alavancado na queda de ${tk}, com risco maximo limitado ao valor pago na estrutura.`,
          `*Cenario de ganho:* Abaixo do ponto de equilibrio, o retorno cresce conforme a desvalorizacao do ativo, sem teto de ganho no vencimento.`,
          `*Cenario de perda:* Em estabilidade ou alta, a perda maxima fica limitada a 100,00% do valor investido na opcao.`,
        ],
      })
    },
  },
  {
    id: 'collar',
    label: 'Collar',
    defaults: { ...BASE_DEFAULTS, ticker: 'LREN3', termMonths: '12', protectionPct: '90', highCapPct: '20', ticketMin: 'R$ 1.500,00', feeAai: '2,50%' },
    fields: [...IDENT_FIELDS, numberField('protectionPct', 'Protecao de capital (%)'), numberField('highCapPct', 'Limitador de alta (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const protection = pct(values.protectionPct, 90, 0, 100)
      const cap = pct(values.highCapPct, 20, -20, 200)
      const floor = -(100 - protection)
      const rows = payoffRows((u) => (u <= floor ? floor : (u >= cap ? cap : u)), [floor, cap])
      return buildModel({
        template, values, rows,
        subtitle: 'Protecao na queda com limite de alta.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Protecao', value: fmtPct(protection) }, { label: 'Limitador', value: fmtPct(cap), tone: 'positive' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highlights: [`Protecao: ${fmtPct(protection)}`, `Limitador de alta: ${fmtPct(cap)}`, 'Estrutura sem premio adicional'],
        sections: [
          `*Objetivo:* Participar da alta de ${tk} ate ${fmtPct(cap)}, com resultado minimo limitado em ${fmtPct(floor)}.`,
          `*Cenario de ganho:* Em alta, o retorno acompanha o ativo ate ${fmtPct(cap)}; acima desse ponto, o ganho fica limitado em ${fmtPct(cap)}.`,
          `*Cenario de perda:* Em queda, a perda maxima no vencimento fica travada em ${fmtPct(floor)}.`,
        ],
      })
    },
  },
  {
    id: 'fence_ui',
    label: 'Fence UI',
    defaults: { ...BASE_DEFAULTS, ticker: 'WEGE3', termMonths: '6', partialProtectionPct: '15', barrierUpPct: '21', capAfterPct: '7', ticketMin: 'R$ 5.200,00', feeAai: '1,27%' },
    fields: [...IDENT_FIELDS, numberField('partialProtectionPct', 'Protecao parcial na queda (%)'), numberField('barrierUpPct', 'Barreira de alta (%)'), numberField('capAfterPct', 'Limitador apos barreira (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const partial = pct(values.partialProtectionPct, 15, 0, 80)
      const barrier = pct(values.barrierUpPct, 21, 0, 150)
      const capAfter = pct(values.capAfterPct, 7, -20, 200)
      const preBarrier = beforeBarrierPct(barrier, 'high')
      const rows = payoffRows((u) => (u >= 0 ? (u <= barrier ? u : Math.min(u, capAfter)) : (u >= -partial ? 0 : u + partial)), [barrier, capAfter, -partial])
      return buildModel({
        template, values, rows,
        subtitle: 'Protecao parcial na queda e limite de alta apos barreira.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Protecao parcial', value: fmtPct(partial) }, { label: 'Barreira alta', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        maxGainBarrierPct: barrier,
        highBarrierSamplingPct: barrier,
        highlights: [`Protecao parcial: ${fmtPct(partial)}`, `Barreira de alta: ${fmtPct(barrier)}`, `Limitador apos barreira: ${fmtPct(capAfter)}`],
        sections: [
          `*Objetivo:* Combinar participacao na alta de ${tk} ate ${fmtPct(preBarrier)} com colchao de ${fmtPct(partial)} na queda. Se a alta atingir ${fmtPct(barrier)}, o retorno passa a ${fmtPct(capAfter)}.`,
          `*Cenario de ganho:* Em alta ate ${fmtPct(preBarrier)}, o retorno acompanha o ativo; ao atingir ${fmtPct(barrier)}, o ganho fica limitado em ${fmtPct(capAfter)}.`,
          `*Cenario de perda:* Quedas ate ${fmtPct(-partial)} ficam neutralizadas; abaixo desse nivel, a estrategia volta a acompanhar a desvalorizacao.`,
        ],
      })
    },
  },
  {
    id: 'collar_ui_bidirecional',
    label: 'Collar UI Bidirecional',
    defaults: { ...BASE_DEFAULTS, ticker: 'B3SA3', termMonths: '6', protectionPct: '90', barrierUpPct: '25', capAfterPct: '10', downKoPct: '30', downGainPct: '12', ticketMin: 'R$ 1.700,00', feeAai: '1,36%' },
    fields: [...IDENT_FIELDS, numberField('protectionPct', 'Protecao de capital (%)'), numberField('barrierUpPct', 'Barreira de alta (%)'), numberField('capAfterPct', 'Limitador apos barreira (%)'), numberField('downKoPct', 'Barreira KO de baixa (%)'), numberField('downGainPct', 'Ganho adicional na queda (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const protection = pct(values.protectionPct, 90, 0, 100)
      const barrier = pct(values.barrierUpPct, 25, 0, 200)
      const capAfter = pct(values.capAfterPct, 10, -20, 200)
      const downKoAbs = pct(values.downKoPct, 30, 0, 95)
      const downKo = -Math.abs(downKoAbs)
      const downGain = pct(values.downGainPct, 12, 0, 100)
      const floor = -(100 - protection)
      const preHighBarrier = beforeBarrierPct(barrier, 'high')
      const fallbackRows = payoffRows((u) => {
        if (u >= 0) return u <= barrier ? u : Math.min(u, capAfter)
        if (u > floor) return u
        if (u > downKo) return floor + ((floor - u) / ((floor - downKo) || 1)) * downGain
        return floor
      }, [floor, barrier, capAfter, downKo])
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const highBarrierFromOptions = resolveHighBarrierFromOptionSpecs(optionPayoff.specs)
      const lowBarrierFromOptions = resolveLowBarrierFromOptionSpecs(optionPayoff.specs)
      const effectiveDownKo = lowBarrierFromOptions != null ? lowBarrierFromOptions : downKo
      const effectivePreDownBarrier = beforeBarrierPct(effectiveDownKo, 'low')
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const warnings = downKoAbs <= Math.abs(floor) ? ['A barreira KO de baixa deve ser maior que o patamar de protecao.'] : []
      if (!optionPayoff.hasDerivativeLegs) {
        warnings.push('Configure strikes nas opcoes para o payoff por pernas.')
      } else {
        const hasProtectionPut = optionPayoff.specs.some((leg) => leg.optionType === 'PUT' && leg.side === 'long' && !isExplicitBarrierType(leg.barrierType))
        const hasDownKoPut = optionPayoff.specs.some((leg) => leg.optionType === 'PUT' && leg.side === 'long' && leg.barrierType === 'KO')
        const hasHighUiCall = optionPayoff.specs.some((leg) => leg.optionType === 'CALL' && leg.side === 'short' && leg.barrierType === 'UI')
        if (!hasProtectionPut) warnings.push('Inclua uma put comprada sem barreira para manter protecao base.')
        if (!hasDownKoPut) warnings.push('Inclua uma put comprada com nivel de desativacao na queda.')
        if (!hasHighUiCall) warnings.push('Inclua uma call vendida com ativacao na alta.')
      }
      return buildModel({
        template, values, rows, validations: warnings,
        subtitle: 'Alta com limite e faixa de ganho na queda antes da barreira KO.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'KO baixa', value: fmtPct(effectiveDownKo) }, { label: 'Limitador alta', value: fmtPct(capAfter) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        maxGainBarrierPct: highBarrierFromOptions != null ? highBarrierFromOptions : barrier,
        highBarrierSamplingPct: highBarrierFromOptions != null ? highBarrierFromOptions : barrier,
        lowBarrierSamplingPct: effectiveDownKo,
        highlights: ['Protecao e ganho em faixas de preco pre-definidas', 'Payoff calculado pelos niveis configurados de strike e barreira', `Protecao: ${fmtPct(protection)}`, `Barreira de alta: ${fmtPct(barrier)}`],
        sections: [
          `*Objetivo:* Participar da alta de ${tk} ate ${fmtPct(preHighBarrier)} e manter protecao na queda ate o nivel de ${fmtPct(effectivePreDownBarrier)} no periodo.`,
          `*Cenario de ganho:* Em alta, o retorno acompanha o ativo ate ${fmtPct(preHighBarrier)}; se a alta atingir ${fmtPct(barrier)}, o ganho final passa a ${fmtPct(capAfter)}.`,
          `*Cenario de perda:* Em queda, a estrutura protege ou compensa movimentos ate ${fmtPct(effectivePreDownBarrier)}. Se a desvalorizacao atingir ${fmtPct(effectiveDownKo)}, o resultado volta a acompanhar a variacao do ativo.`,
        ],
      })
    },
  },
  {
    id: 'booster_ko',
    label: 'Booster KO',
    defaults: { ...BASE_DEFAULTS, ticker: 'B3SA3', termMonths: '6', triggerUpPct: '0', barrierUpPct: '25', capAfterPct: '10', ticketMin: 'R$ 1.700,00', feeAai: '1,36%' },
    fields: [...IDENT_FIELDS, numberField('triggerUpPct', 'Gatilho para ganho dobrado (%)'), numberField('barrierUpPct', 'Barreira KO de alta (%)'), numberField('capAfterPct', 'Limitador apos KO (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const trigger = pct(values.triggerUpPct, 0, -20, 100)
      const barrierRaw = pct(values.barrierUpPct, 25, -10, 180)
      const barrier = Math.max(barrierRaw, trigger)
      const capAfter = pct(values.capAfterPct, 10, -30, 200)
      const preBarrier = beforeBarrierPct(barrier, 'high')
      const rows = payoffRows((u) => (u < 0 ? u : (u <= trigger ? u : (u <= barrier ? trigger + 2 * (u - trigger) : capAfter))), [trigger, barrier, capAfter])
      const warnings = barrierRaw < trigger ? ['A barreira KO de alta deve ser maior ou igual ao gatilho.'] : []
      return buildModel({
        template, values, rows, validations: warnings,
        subtitle: 'Ganho dobrado na alta ate o KO, com limitador apos ativacao.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'KO alta', value: fmtPct(barrier) }, { label: 'Pos KO', value: fmtPct(capAfter) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        maxGainBarrierPct: barrier,
        highBarrierSamplingPct: barrier,
        highlights: [`Ganho dobrado acima de ${fmtPct(trigger)}`, `Barreira KO: ${fmtPct(barrier)}`, `Limitador apos KO: ${fmtPct(capAfter)}`],
        sections: [
          `*Objetivo:* Buscar ganho acelerado na alta de ${tk} a partir de ${fmtPct(trigger)} ate ${fmtPct(preBarrier)}.`,
          `*Cenario de ganho:* Entre ${fmtPct(trigger)} e ${fmtPct(preBarrier)}, a estrategia amplia o retorno da alta. Se ${tk} atingir ${fmtPct(barrier)}, o resultado final passa para ${fmtPct(capAfter)}.`,
          `*Cenario de perda:* Em movimentos de queda, o investidor acompanha a desvalorizacao do ativo.`,
        ],
      })
    },
  },
  {
    id: 'doc_bidirecional',
    label: 'DOC Bidirecional',
    defaults: { ...BASE_DEFAULTS, ticker: 'RENT3', termMonths: '9', highKoPct: '25', couponPct: '10', downProtectionPct: '15', downKoPct: '30', ticketMin: 'R$ 5.000,00', feeAai: '1,64%' },
    fields: [...IDENT_FIELDS, numberField('highKoPct', 'Barreira UI de alta (%)'), numberField('couponPct', 'Cupom apos ativacao de alta (%)'), numberField('downProtectionPct', 'Colchao de protecao na queda (%)'), numberField('downKoPct', 'Barreira KO de baixa (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const highKo = pct(values.highKoPct, 25, 0, 180)
      const coupon = pct(values.couponPct, 10, -100, 300)
      const downProtection = pct(values.downProtectionPct, 15, 0, 80)
      const downKoAbs = pct(values.downKoPct, 30, 0, 95)
      const downKo = -Math.abs(downKoAbs)
      const preHighBarrier = beforeBarrierPct(highKo, 'high')
      const fallbackRows = payoffRows((u) => (u >= 0 ? (u <= highKo ? 2 * u : coupon) : (u >= -downProtection ? u : (u > downKo ? -downProtection : u))), [highKo, coupon, -downProtection, downKo])
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const highBarrierFromOptions = resolveHighBarrierFromOptionSpecs(optionPayoff.specs)
      const lowBarrierFromOptions = resolveLowBarrierFromOptionSpecs(optionPayoff.specs)
      const effectiveDownKo = lowBarrierFromOptions != null ? lowBarrierFromOptions : downKo
      const effectivePreDownBarrier = beforeBarrierPct(effectiveDownKo, 'low')
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const warnings = downKoAbs <= downProtection ? ['A barreira KO de baixa deve ser maior que o colchao de protecao.'] : []
      if (!optionPayoff.hasDerivativeLegs) {
        warnings.push('Configure strikes nas opcoes para o payoff por pernas.')
      } else {
        const hasProtectionKo = optionPayoff.specs.some((leg) => leg.optionType === 'PUT' && leg.side === 'long' && leg.barrierType === 'KO')
        const hasHighUiPut = optionPayoff.specs.some((leg) => leg.optionType === 'PUT' && leg.side === 'long' && leg.barrierType === 'UI')
        const hasHighUoCall = optionPayoff.specs.some((leg) => leg.optionType === 'CALL' && leg.side === 'long' && leg.barrierType === 'UO')
        const hasHighUiCall = optionPayoff.specs.some((leg) => leg.optionType === 'CALL' && leg.side === 'short' && leg.barrierType === 'UI')
        if (!hasProtectionKo) warnings.push('Inclua uma put comprada com KO de baixa para protecao ate desativacao.')
        if (!hasHighUiPut) warnings.push('Inclua uma put comprada com UI para ativacao na alta.')
        if (!hasHighUoCall) warnings.push('Inclua uma call comprada com UO para desativacao na alta.')
        if (!hasHighUiCall) warnings.push('Inclua uma call vendida com UI para ativacao na alta.')
      }
      return buildModel({
        template, values, rows, validations: warnings,
        subtitle: 'Protecao na queda ate KO; apos desativacao participa da queda normalmente.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'UI alta', value: fmtPct(highKo) }, { label: 'KO baixa', value: fmtPct(effectiveDownKo) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        maxGainBarrierPct: highBarrierFromOptions != null ? highBarrierFromOptions : highKo,
        highBarrierSamplingPct: highBarrierFromOptions != null ? highBarrierFromOptions : highKo,
        lowBarrierSamplingPct: effectiveDownKo,
        highlights: ['Protecao e ganho em faixas de preco pre-definidas', 'Payoff calculado pelos niveis configurados de strike e barreira', `Protecao na queda: ${fmtPct(downProtection)}`, `Ativacao alta: ${fmtPct(highKo)}`],
        sections: [
          `*Objetivo:* Proteger quedas de ${tk} ate ${fmtPct(effectivePreDownBarrier)} e participar da alta ate ${fmtPct(preHighBarrier)} no periodo.`,
          `*Cenario de ganho:* Se ${tk} subir ate ${fmtPct(preHighBarrier)}, o retorno acompanha a valorizacao. Se atingir ${fmtPct(highKo)}, o resultado passa para o retorno-alvo de ${fmtPct(coupon)}.`,
          `*Cenario de perda:* Em queda, ha protecao ate ${fmtPct(effectivePreDownBarrier)}. Se a desvalorizacao atingir ${fmtPct(effectiveDownKo)}, a estrategia volta a acompanhar a variacao do ativo.`,
        ],
      })
    },
  },
  {
    id: 'alocacao_protegida',
    label: 'Alocacao Protegida',
    defaults: { ...BASE_DEFAULTS, ticker: 'XB5011', termMonths: '24', optionCostPct: '0', upTriggerPct: '0', downProtectionPct: '10', ticketMin: 'R$ 5.000,00', feeAai: '1,00%' },
    fields: [...IDENT_FIELDS, numberField('upTriggerPct', 'Inicio da participacao na alta (%)'), numberField('downProtectionPct', 'Patamar de protecao na queda (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const optionCost = resolveOptionCostPct(values, 0)
      const upTrigger = pct(values.upTriggerPct, 0, -20, 120)
      const downProtection = pct(values.downProtectionPct, 10, 0, 95)
      const fallbackRows = payoffRows((u) => {
        const base = u >= upTrigger
          ? u - upTrigger
          : (u >= -downProtection ? 0 : u + downProtection)
        const gainPct = base - optionCost
        const entryPct = 100 + optionCost
        return entryPct > 0 ? (gainPct / entryPct) * 100 : 0
      }, [upTrigger, -downProtection])
      const optionSettlement = buildOptionSettlementReturnRows(values.options, {
        includeUnderlying: true,
        includeUnderlyingInEntry: true,
        optionCostPct: optionCost,
        baseQuantity: values.stockQuantity,
      })
      const rows = optionSettlement.leveraged ? optionSettlement.rows : fallbackRows
      return buildModel({
        template, values, rows,
        subtitle: 'Participacao de alta com perda apenas abaixo do patamar protegido.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Gatilho alta', value: fmtPct(upTrigger) }, { label: 'Protecao', value: fmtPct(downProtection) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highlights: [`Participacao na alta acima de ${fmtPct(upTrigger)}`, `Patamar protegido: ${fmtPct(-downProtection)}`, 'Perda apenas abaixo do patamar protegido'],
        sections: [
          `*Objetivo:* Participar da alta de ${tk} acima de ${fmtPct(upTrigger)} com protecao nas quedas ate ${fmtPct(-downProtection)}.`,
          `*Cenario de ganho:* Acima de ${fmtPct(upTrigger)}, o retorno cresce de forma linear com cada alta adicional do ativo.`,
          `*Cenario de perda:* Entre 0% e ${fmtPct(-downProtection)}, a estrategia busca preservar capital; abaixo desse nivel, volta a acompanhar a queda.`,
        ],
      })
    },
  },
  {
    id: 'pop',
    label: 'POP',
    defaults: { ...BASE_DEFAULTS, ticker: 'LREN3', termMonths: '30', upPartPct: '50', downProtectionPct: '10', ticketMin: 'R$ 1.500,00', feeAai: '2,50%' },
    fields: [...IDENT_FIELDS, numberField('upPartPct', 'Participacao na alta (%)'), numberField('downProtectionPct', 'Protecao na queda (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const upPart = pct(values.upPartPct, 50, 0, 200)
      const downProtection = pct(values.downProtectionPct, 10, 0, 95)
      const factor = upPart / 100
      const fallbackRows = payoffRows((u) => (u >= 0 ? u * factor : (u <= -downProtection ? -downProtection : u)), [-downProtection])
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const warnings = []
      if (!optionPayoff.hasDerivativeLegs) {
        warnings.push('Configure strikes e quantidades nas opcoes para o payoff por pernas.')
      }
      return buildModel({
        template, values, rows, validations: warnings,
        subtitle: 'Participacao parcial na alta com protecao em quedas mais profundas.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Part. alta', value: fmtPct(upPart) }, { label: 'Protecao', value: fmtPct(downProtection) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highlights: [`Participacao de ${fmtPct(upPart)} da alta`, `Protecao de queda em ${fmtPct(downProtection)}`, 'Alta ilimitada com fator de participacao'],
        sections: [
          `*Objetivo:* Capturar ${fmtPct(upPart)} da alta de ${tk} com limite de perda em ${fmtPct(-downProtection)}.`,
          `*Cenario de ganho:* Em alta, o investidor recebe ${fmtPct(upPart)} da variacao positiva do ativo.`,
          `*Cenario de perda:* Em queda, o resultado minimo fica travado em ${fmtPct(-downProtection)}.`,
        ],
      })
    },
  },
  {
    id: 'rubi',
    label: 'RUBI',
    defaults: { ...BASE_DEFAULTS, ticker: 'RENT3', termMonths: '4', couponPct: '8', downBarrierPct: '20', ticketMin: 'R$ 5.000,00', feeAai: '1,23%' },
    fields: [...IDENT_FIELDS, numberField('couponPct', 'Cupom nominal (%)'), numberField('downBarrierPct', 'Barreira KO de baixa (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const coupon = pct(values.couponPct, 8, -100, 300)
      const barrier = -Math.abs(pct(values.downBarrierPct, 20, 0, 95))
      const preBarrier = beforeBarrierPct(barrier, 'low')
      const rows = payoffRows((u) => (u >= barrier ? coupon : u), [barrier, coupon])
      return buildModel({
        template, values, rows,
        subtitle: 'Cupom pre-acordado condicionado ao nao atingimento de KO durante a vida.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Cupom', value: fmtPct(coupon), tone: 'positive' }, { label: 'KO baixa', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        lowBarrierSamplingPct: barrier,
        highlights: [`Cupom nominal: ${fmtPct(coupon)}`, `KO de baixa: ${fmtPct(barrier)}`, 'Barreira monitorada durante toda a operacao'],
        sections: [
          `*Objetivo:* Buscar retorno pre-acordado de ${fmtPct(coupon)} desde que ${tk} nao tenha desvalorizacao igual ou superior a ${fmtPct(barrier)}.`,
          `*Cenario de ganho:* Em alta ou em queda ate ${fmtPct(preBarrier)}, o retorno permanece em ${fmtPct(coupon)} no periodo.`,
          `*Cenario de perda:* Se ${tk} atingir ${fmtPct(barrier)} ou abaixo, o cupom deixa de ser pago e o investidor passa a acompanhar a variacao do ativo.`,
        ],
      })
    },
  },
  {
    id: 'rubi_black',
    label: 'RUBI Black',
    defaults: { ...BASE_DEFAULTS, ticker: 'RENT3', termMonths: '4', couponPct: '8', downBarrierPct: '20', ticketMin: 'R$ 5.000,00', feeAai: '1,23%' },
    fields: [...IDENT_FIELDS, numberField('couponPct', 'Cupom nominal (%)'), numberField('downBarrierPct', 'Barreira KO de baixa (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const coupon = pct(values.couponPct, 8, -100, 300)
      const barrier = -Math.abs(pct(values.downBarrierPct, 20, 0, 95))
      const preBarrier = beforeBarrierPct(barrier, 'low')
      const rows = payoffRows((u) => (u >= barrier ? coupon : u), [barrier, coupon])
      return buildModel({
        template, values, rows,
        subtitle: 'Cupom pre-acordado condicionado ao nao atingimento de KO durante a vida.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Cupom', value: fmtPct(coupon), tone: 'positive' }, { label: 'KO baixa', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        lowBarrierSamplingPct: barrier,
        highlights: [`Cupom nominal: ${fmtPct(coupon)}`, `KO de baixa: ${fmtPct(barrier)}`, 'Barreira monitorada durante toda a operacao'],
        sections: [
          `*Objetivo:* Buscar retorno pre-acordado de ${fmtPct(coupon)} desde que ${tk} nao tenha desvalorizacao igual ou superior a ${fmtPct(barrier)}.`,
          `*Cenario de ganho:* Em alta ou em queda ate ${fmtPct(preBarrier)}, o retorno permanece em ${fmtPct(coupon)} no periodo.`,
          `*Cenario de perda:* Se ${tk} atingir ${fmtPct(barrier)} ou abaixo, o cupom deixa de ser pago e o investidor passa a acompanhar a variacao do ativo.`,
        ],
      })
    },
  },
  {
    id: 'smart_coupon',
    label: 'Cupom Recorrente Europeia',
    defaults: { ...BASE_DEFAULTS, ticker: 'MELI34', termMonths: '3', couponPct: '6', downBarrierPct: '10', ticketMin: 'R$ 9.500,00', feeAai: '1,25%' },
    fields: [...IDENT_FIELDS, ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const fallbackCoupon = pct(values.couponPct, 6, -100, 300)
      const fallbackBarrierAbs = pct(values.downBarrierPct, 10, 0, 95)
      const optionConfig = resolveCouponConfigFromOptions(values.options, fallbackCoupon, fallbackBarrierAbs, values.stockQuantity)
      const coupon = optionConfig.couponPct
      const barrier = -Math.abs(optionConfig.downBarrierAbsPct)
      const rows = payoffRows((u) => (u >= barrier ? coupon : u), [barrier, coupon])
      return buildModel({
        template, values, rows, validations: optionConfig.warnings,
        subtitle: 'Cupom nominal condicionado ao ativo acima da barreira na data final.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Cupom', value: fmtPct(coupon), tone: 'positive' }, { label: 'Barreira baixa', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        lowBarrierSamplingPct: barrier,
        highlights: [`Cupom nominal: ${fmtPct(coupon)}`, `Barreira de baixa: ${fmtPct(barrier)}`, 'Validacao da barreira no vencimento'],
        sections: [
          `*Objetivo:* Receber cupom de ${fmtPct(coupon)} no vencimento, desde que ${tk} feche acima de ${fmtPct(barrier)}.`,
          `*Cenario de ganho:* Na data final, se ${tk} estiver acima de ${fmtPct(barrier)}, o cupom de ${fmtPct(coupon)} e pago.`,
          `*Cenario de perda:* Na data final, se ${tk} estiver em ${fmtPct(barrier)} ou abaixo, o cupom nao e pago e o resultado acompanha a variacao do ativo.`,
        ],
      })
    },
  },
  {
    id: 'cupom_recorrente',
    label: 'Cupom Recorrente',
    defaults: { ...BASE_DEFAULTS, ticker: 'LREN3', termMonths: '4', couponPct: '8', downBarrierPct: '16,65', ticketMin: 'R$ 1.500,00', feeAai: '1,25%' },
    fields: [...IDENT_FIELDS, ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const fallbackCoupon = pct(values.couponPct, 8, -100, 300)
      const fallbackBarrierAbs = pct(values.downBarrierPct, 16.65, 0, 95)
      const optionConfig = resolveCouponConfigFromOptions(values.options, fallbackCoupon, fallbackBarrierAbs, values.stockQuantity)
      const coupon = optionConfig.couponPct
      const barrier = -Math.abs(optionConfig.downBarrierAbsPct)
      const rows = payoffRows((u) => (u >= barrier ? coupon : u), [barrier, coupon])
      return buildModel({
        template, values, rows, validations: optionConfig.warnings,
        subtitle: 'Estrutura orientada a cupom com condicao de barreira na data final.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Cupom', value: fmtPct(coupon), tone: 'positive' }, { label: 'Barreira baixa', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        lowBarrierSamplingPct: barrier,
        highlights: [`Cupom acordado: ${fmtPct(coupon)}`, `Barreira de baixa: ${fmtPct(barrier)}`, 'Foco em retorno nominal no periodo'],
        sections: [
          `*Objetivo:* Receber cupom de ${fmtPct(coupon)} em cada vencimento, desde que ${tk} feche acima de ${fmtPct(barrier)} no respectivo periodo.`,
          `*Cenario de ganho:* Em cada data, se o ativo terminar acima de ${fmtPct(barrier)}, o cupom daquele mes e pago.`,
          `*Cenario de perda:* Se em algum vencimento o ativo fechar em ${fmtPct(barrier)} ou abaixo, nao ha cupom naquele periodo e o investidor permanece posicionado no ativo.`,
        ],
      })
    },
  },
]

const templateMap = templates.reduce((acc, item) => {
  acc[item.id] = item
  return acc
}, {})

const defaultTemplateId = templates[0]?.id || 'put_spread'
const getTemplate = (id) => templateMap[id] || templateMap[defaultTemplateId]

export const strategyTemplateOptions = templates.map((item) => ({ value: item.id, label: item.label }))

export const getStrategyOptionForm = (templateId) => {
  const raw = OPTION_FORM_MAP[templateId]
  if (!raw?.enabled) {
    return {
      enabled: false,
      showStrike: false,
      showBarrier: false,
      showCoupon: false,
      defaultEntries: [],
    }
  }
  return {
    enabled: true,
    showStrike: Boolean(raw.showStrike),
    showBarrier: Boolean(raw.showBarrier),
    showCoupon: Boolean(raw.showCoupon),
    defaultEntries: Array.isArray(raw.defaultEntries) ? raw.defaultEntries.map((entry) => ({ ...entry })) : [],
  }
}

export const createStrategyOptionEntry = (templateId, input = {}) => {
  const optionForm = getStrategyOptionForm(templateId)
  return normalizeOptionEntry(input, optionForm)
}

export const getStrategyDefaults = (templateId) => {
  const defaults = { ...(getTemplate(templateId)?.defaults || {}) }
  const optionForm = getStrategyOptionForm(templateId)
  defaults.options = normalizeOptionEntries(defaults.options, optionForm)
  return defaults
}
export const getStrategyFields = (templateId) => {
  const fields = (getTemplate(templateId)?.fields || []).map((field) => ({ ...field }))
  return withOptionCostField(templateId, fields)
}

export const buildStrategyModel = (templateId, values = {}) => {
  const template = getTemplate(templateId)
  const optionForm = getStrategyOptionForm(templateId)
  if (!template) {
    return {
      templateId: defaultTemplateId,
      templateLabel: 'Estrutura',
      title: 'Estrutura',
      subtitle: '',
      metrics: [],
      highlights: [],
      footer: { ticketMin: '--', feeAai: '--' },
      payoffRows: [],
      generatedMessage: '',
      validations: ['Template de estrutura nao encontrado.'],
      tableHeadLeft: 'Variacao do ativo',
      tableHeadRight: 'Variacao da estrutura',
      optionForm,
      optionEntries: [],
    }
  }
  const merged = { ...template.defaults, ...(values || {}) }
  merged.options = normalizeOptionEntries(merged.options, optionForm)
  const model = template.build(merged, template)
  const optionValidations = validateOptionEntries(merged.options, optionForm)
  return {
    ...model,
    optionForm,
    optionEntries: merged.options,
    validations: unique([...(model.validations || []), ...optionValidations]),
  }
}

