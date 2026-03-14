import { toNumber } from '../utils/number.js'

const BASE_POINTS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50]
const OPTION_DRIVEN_BASE_POINTS = [-20, -10, 0, 10, 20]
const OPTION_DRIVEN_NO_BARRIER_BASE_POINTS = [-30, -20, -10, 0, 10, 20, 30]

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const round2 = (value) => Math.round(Number(value) * 100) / 100
const blank = (value) => value == null || String(value).trim() === ''
const BARRIER_EDGE_STEP = 0.01

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
  if (direction === 'low') return round2(barrier + BARRIER_EDGE_STEP)
  return round2(barrier - BARRIER_EDGE_STEP)
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

const resolveRecurringCouponPerPeriodPct = (couponPct, termMonths) => {
  const coupon = Number(couponPct)
  const months = toNumber(termMonths)
  if (!Number.isFinite(coupon)) return 0
  if (months == null || months <= 0) return round2(coupon)
  return round2(coupon / months)
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
  const maxBeforeMagnitude = Math.max(distance - BARRIER_EDGE_STEP, 0)
  const towardSign = barrier === 0 ? (direction === 'high' ? 1 : -1) : Math.sign(barrier)

  const nearPoint = round2(towardSign * Math.min(nearMagnitude, maxBeforeMagnitude))
  const halfPoint = round2(towardSign * Math.min(halfMagnitude, maxBeforeMagnitude))
  const preBarrierPoint = beforeBarrierPct(barrier, direction === 'high' ? 'high' : 'low')
  const postPointOne = round2(direction === 'high' ? barrier + nearMagnitude : barrier - nearMagnitude)
  const postPointTwo = round2(direction === 'high' ? barrier + (2 * nearMagnitude) : barrier - (2 * nearMagnitude))

  if (mode === 'post_only') {
    return {
      before: uniqueNumeric([nearPoint, halfPoint, preBarrierPoint]),
      after: uniqueNumeric([barrier, postPointOne, postPointTwo]),
    }
  }

  return {
    before: uniqueNumeric([nearPoint, halfPoint, preBarrierPoint]),
    after: uniqueNumeric([barrier, postPointOne, postPointTwo]),
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
  const preBarrierTarget = round2(direction === 'high' ? barrier - BARRIER_EDGE_STEP : barrier + BARRIER_EDGE_STEP)
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

const injectBarrierEdgeRows = (
  rows,
  {
    highBarrierPct = null,
    lowBarrierPct = null,
    highBarrierMode = 'barrier',
    lowBarrierMode = 'barrier',
  } = {},
) => {
  const safeRows = Array.isArray(rows) ? rows : []
  if (!safeRows.length) return safeRows

  const parseBarrier = (value) => {
    if (value == null || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? round2(parsed) : null
  }

  const highBarrier = parseBarrier(highBarrierPct)
  const lowBarrier = parseBarrier(lowBarrierPct)
  if (highBarrier == null && lowBarrier == null) return safeRows

  const rowMap = new Map()
  safeRows.forEach((row) => {
    const underlying = Number(row?.underlyingVarPct)
    const strategy = Number(row?.strategyVarPct)
    if (!Number.isFinite(underlying) || !Number.isFinite(strategy)) return
    const x = round2(underlying)
    const y = round2(strategy)
    rowMap.set(x, {
      ...row,
      underlyingVarPct: x,
      strategyVarPct: y,
      underlyingTone: tone(x),
      strategyTone: tone(y),
    })
  })

  const sortedRows = () => Array.from(rowMap.values()).sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)

  const sideRows = (barrier, direction, phase = 'before') => sortedRows().filter((row) => {
    if (direction === 'high') {
      return phase === 'before'
        ? row.underlyingVarPct < barrier
        : row.underlyingVarPct >= barrier
    }
    return phase === 'before'
      ? row.underlyingVarPct > barrier
      : row.underlyingVarPct <= barrier
  })

  const interpolateWithCandidates = (target, candidates = []) => {
    if (!candidates.length) return null
    const ordered = candidates.slice().sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)

    for (let index = 0; index < ordered.length - 1; index += 1) {
      const left = ordered[index]
      const right = ordered[index + 1]
      const x0 = Number(left?.underlyingVarPct)
      const y0 = Number(left?.strategyVarPct)
      const x1 = Number(right?.underlyingVarPct)
      const y1 = Number(right?.strategyVarPct)
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue
      if (target < Math.min(x0, x1) || target > Math.max(x0, x1)) continue
      return round2(lerp(target, x0, x1, y0, y1))
    }

    if (ordered.length === 1) return round2(Number(ordered[0]?.strategyVarPct) || 0)

    const nearest = ordered
      .slice()
      .sort((left, right) => Math.abs(left.underlyingVarPct - target) - Math.abs(right.underlyingVarPct - target))
      .slice(0, 2)
      .sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)

    if (nearest.length < 2) return round2(Number(nearest[0]?.strategyVarPct) || 0)

    const [left, right] = nearest
    const x0 = Number(left?.underlyingVarPct)
    const y0 = Number(left?.strategyVarPct)
    const x1 = Number(right?.underlyingVarPct)
    const y1 = Number(right?.strategyVarPct)
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null
    if (x0 === x1) return round2(y0)
    return round2(lerp(target, x0, x1, y0, y1))
  }

  const interpolateWithinSide = (target, barrier, direction, phase = 'before') => {
    const candidates = sideRows(barrier, direction, phase)
    const sideValue = interpolateWithCandidates(target, candidates)
    if (Number.isFinite(sideValue)) return sideValue
    return interpolateWithCandidates(target, sortedRows())
  }

  const addGuideRows = (barrier, direction, mode) => {
    if (barrier == null) return
    const targets = resolveBarrierSamplingTargets(barrier, direction, mode)
    const beforeTargets = Array.isArray(targets.before) ? targets.before : []
    const afterTargets = Array.isArray(targets.after) ? targets.after : []

    beforeTargets.forEach((target) => {
      const x = round2(target)
      if (rowMap.has(x)) return
      const y = interpolateWithinSide(x, barrier, direction, 'before')
      if (!Number.isFinite(y)) return
      rowMap.set(x, {
        underlyingVarPct: x,
        strategyVarPct: y,
        underlyingTone: tone(x),
        strategyTone: tone(y),
        isGuide: true,
      })
    })

    afterTargets.forEach((target) => {
      const x = round2(target)
      if (rowMap.has(x)) return
      const y = interpolateWithinSide(x, barrier, direction, 'after')
      if (!Number.isFinite(y)) return
      rowMap.set(x, {
        underlyingVarPct: x,
        strategyVarPct: y,
        underlyingTone: tone(x),
        strategyTone: tone(y),
        isGuide: true,
      })
    })
  }

  addGuideRows(highBarrier, 'high', highBarrierMode)
  addGuideRows(lowBarrier, 'low', lowBarrierMode)

  return Array.from(rowMap.values()).sort((left, right) => left.underlyingVarPct - right.underlyingVarPct)
}

const buildRubiGuidePoints = (barrierPct) => {
  const barrier = Number(barrierPct)
  const safeBarrier = Number.isFinite(barrier) && barrier < 0 ? round2(barrier) : -20
  const distance = Math.abs(safeBarrier)
  const nearMagnitude = round2(Math.max(Math.min(5, distance * 0.35), 1))
  const halfMagnitude = round2(Math.max(distance / 2, nearMagnitude + 0.5))
  const topMagnitude = round2(Math.max(distance, halfMagnitude + 0.5))
  const postStep = round2(Math.max(nearMagnitude, 1))
  const preBarrierPoint = beforeBarrierPct(safeBarrier, 'low')

  const positive = [nearMagnitude, halfMagnitude, topMagnitude]
  const negative = [
    round2(-nearMagnitude),
    round2(-halfMagnitude),
    preBarrierPoint,
    safeBarrier,
    round2(safeBarrier - postStep),
    round2(safeBarrier - (2 * postStep)),
  ]

  return uniqueNumeric([...positive, 0, ...negative])
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
const OPTION_COST_TEMPLATES = new Set(['call', 'call_spread', 'put', 'put_spread', 'alocacao_protegida', 'alocacao_protegida_sob_custodia', 'financiamento', 'financiamento_sob_custodia'])

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

const resolveOptionCreditPct = (values = {}, fallback = 0) => {
  const explicit = toNumber(values?.optionCostPct)
  if (explicit != null) return clamp(Math.abs(explicit), 0, 100)
  const fallbackValue = toNumber(fallback)
  if (fallbackValue != null) return clamp(Math.abs(fallbackValue), 0, 100)
  return 0
}

const resolveFeeAaiRealPct = (templateId, values = {}) => {
  const normalizedTemplateId = String(templateId || '').trim()
  if (!OPTION_COST_TEMPLATES.has(normalizedTemplateId)) return null
  const feeAaiPct = toNumber(values?.feeAai)
  if (feeAaiPct == null) return null
  const optionCostPct = resolveOptionCostPct(values, values?.premiumPct)
  if (optionCostPct <= 0) return null
  return (feeAaiPct / optionCostPct) * 100
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

const resolveRubiConfigFromOptions = (entries = [], fallbackCouponPct = 0, fallbackDownBarrierAbsPct = 0, baseQuantity = null) => {
  const rawEntries = Array.isArray(entries) ? entries : []
  const specs = buildOptionLegSpecs(rawEntries, { baseQuantity })
  let couponPct = round2(fallbackCouponPct)
  let downBarrierAbsPct = Math.abs(round2(fallbackDownBarrierAbsPct))
  const warnings = []

  if (!specs.length) {
    if (rawEntries.length) warnings.push('Preencha strike e barreira D.O/KO nas opcoes.')
    return { specs, couponPct, downBarrierAbsPct, warnings }
  }

  const callShortStrike = specs.find((leg) => (
    leg.optionType === 'CALL'
    && leg.side === 'short'
    && Number.isFinite(Number(leg?.strikePct))
  ))
  const putLongStrike = specs.find((leg) => (
    leg.optionType === 'PUT'
    && leg.side === 'long'
    && Number.isFinite(Number(leg?.strikePct))
  ))
  const strikeRef = callShortStrike?.strikePct ?? putLongStrike?.strikePct
  if (Number.isFinite(Number(strikeRef))) {
    couponPct = round2(Number(strikeRef) - 100)
  } else {
    warnings.push('Informe strike da call vendida (ou put comprada) para derivar o cupom.')
  }

  const lowBarrierLeg = specs.find((leg) => (
    isExplicitBarrierType(leg?.barrierType)
    && resolveBarrierDirection(leg?.barrierType) === 'low'
    && leg?.barrierValuePct != null
  ))
  if (lowBarrierLeg) {
    downBarrierAbsPct = Math.abs(round2(100 - Number(lowBarrierLeg.barrierValuePct)))
  } else {
    warnings.push('Inclua barreira de baixa (D.O/KO) nas opcoes.')
  }

  return { specs, couponPct, downBarrierAbsPct, warnings }
}

const toInputPercent = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  const rounded = round2(number)
  if (Number.isInteger(rounded)) return String(rounded)
  return rounded.toFixed(2).replace('.', ',')
}

const resolveStrikePctFromOptionEntries = (entries = [], optionType, side) => {
  const safeEntries = Array.isArray(entries) ? entries : []
  const match = safeEntries.find((entry) => (
    normalizeOptionType(entry?.optionType) === normalizeOptionType(optionType)
    && normalizeOptionSide(entry?.side) === normalizeOptionSide(side)
    && toNumber(entry?.strike ?? entry?.strikePercent) != null
  ))
  return toNumber(match?.strike ?? match?.strikePercent)
}

const hasMeaningfulOptionInput = (entries = []) => (
  (Array.isArray(entries) ? entries : []).some((entry) => (
    !blank(entry?.strike ?? entry?.strikePercent)
    || !blank(entry?.barrierValue ?? entry?.barrierPercent)
    || !blank(entry?.coupon ?? entry?.couponPct)
    || (entry?.useCustomQuantity && !blank(entry?.quantity))
  ))
)

const buildPayoffFallbackMessage = ({ templateLabel, tickerLabel, maturityLabel, highlights }) => {
  const safeTicker = tickerLabel || 'ATIVO'
  const safeHighlights = (Array.isArray(highlights) ? highlights : []).filter(Boolean).slice(0, 3)
  const objective = safeHighlights.length
    ? `*Objetivo:* Estrutura calibrada pelas opcoes aplicadas, com retorno conforme payoff estimado no preview.`
    : '*Objetivo:* Estrutura calibrada pelas opcoes aplicadas, com retorno conforme payoff estimado.'

  return [
    `*${templateLabel || 'Estrutura'} em ${safeTicker}*`,
    '',
    objective,
    ...safeHighlights.map((item) => `- ${item}`),
    '',
    `*Vencimento da estrategia:* ${maturityLabel || '--'}`,
    '_(Possivel saida antecipada mediante cotacao)._',
  ].join('\n')
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
    contextualBase = contextualBase.filter((point) => point <= nearestHighBarrier - BARRIER_EDGE_STEP)
  }
  if (lowBarriers.length) {
    const nearestLowBarrier = Math.max(...lowBarriers)
    contextualBase = contextualBase.filter((point) => point >= nearestLowBarrier + BARRIER_EDGE_STEP)
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
  alocacao_protegida_sob_custodia: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'PUT', side: 'long', label: 'Put de protecao' },
      { optionType: 'CALL', side: 'short', label: 'Call vendida' },
    ],
  },
  financiamento: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
      { optionType: 'CALL', side: 'short', label: 'Call vendida' },
    ],
  },
  financiamento_sob_custodia: {
    enabled: true,
    showStrike: true,
    showBarrier: false,
    defaultEntries: [
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
      { optionType: 'CALL', side: 'short', label: 'Call vendida', strike: '108', barrierType: 'KO', barrierValue: '80' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada', strike: '108', barrierType: 'KO', barrierValue: '80' },
    ],
  },
  rubi_black: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'CALL', side: 'short', label: 'Call vendida', strike: '108', barrierType: 'KO', barrierValue: '80' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada', strike: '108', barrierType: 'KO', barrierValue: '80' },
    ],
  },
  smart_coupon: {
    enabled: true,
    showStrike: true,
    showBarrier: true,
    defaultEntries: [
      { optionType: 'CALL', side: 'short', label: 'Call vendida', strike: '108', barrierType: 'KO', barrierValue: '80' },
      { optionType: 'PUT', side: 'long', label: 'Put comprada', strike: '108', barrierType: 'KO', barrierValue: '80' },
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

const resolveRowsMaxGainPct = (rows = [], fallback = null) => {
  const candidates = (Array.isArray(rows) ? rows : [])
    .map((row) => Number(row?.strategyVarPct))
    .filter((value) => Number.isFinite(value))
  if (candidates.length) return Math.max(...candidates)
  const parsedFallback = Number(fallback)
  return Number.isFinite(parsedFallback) ? parsedFallback : 0
}

const buildSpreadCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  direction = 'up',
  startPct,
  limitPct,
  maxGainPct,
  investmentValue,
}) => {
  const isDown = direction === 'down'
  const strategyLabel = isDown ? 'Trava de baixa' : 'Trava de alta'
  const movementLabel = isDown ? 'queda' : 'ALTA'
  const objective = isDown
    ? `🎯 Objetivo: Obter ganho alavancado com a desvalorização de ${tickerLabel} com risco máximo limitado ao valor pago pela estrutura.`
    : `🎯 Objetivo: Obter ganho alavancado com a variação de ${tickerLabel} com risco máximo limitado ao valor pago pela estrutura.`

  const investedAmount = toNumber(investmentValue)
  const investedLabel = investedAmount != null ? fmtCurrency(investedAmount) : '--'
  const safeMaxGain = Math.max(0, Number(maxGainPct) || 0)
  const maxProfitValue = investedAmount != null
    ? round2((investedAmount * safeMaxGain) / 100)
    : null
  const maxProfitLabel = maxProfitValue != null ? fmtCurrency(maxProfitValue) : '--'

  return [
    `${strategyLabel} em ${tickerLabel}.`,
    '',
    objective,
    '',
    'Exemplo de desempenho no vencimento:',
    ` - Considerando aporte de ${investedLabel}.`,
    '',
    `${tickerLabel} com ${movementLabel} de ${fmtPct(startPct)}= Recebe o Capital Investido (0X0).`,
    `${tickerLabel} com ${movementLabel} a partir de ${fmtPct(limitPct)}= Capital Investido + ${maxProfitLabel}.`,
    '',
    '❗ Risco máximo: Valor investido.',
    `📈 Lucro máximo: ${fmtPct(safeMaxGain)} sobre o valor investido.`,
    '',
    `⏱ Vencimento: ${maturityLabel || '--'}`,
    'Possível saida antecipada mediante cotação',
  ].join('\n')
}

const buildFenceUiCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  preBarrierPct,
  partialProtectionPct,
  barrierPct,
  capAfterPct,
}) => {
  const safePartial = Math.abs(Number(partialProtectionPct) || 0)
  const downPartial = -safePartial
  const preBarrier = fmtPct(preBarrierPct)
  const barrier = fmtPct(barrierPct)
  const capAfter = fmtPct(capAfterPct)
  const partial = fmtPct(downPartial)

  return [
    `Fence UI em ${tickerLabel}`,
    '',
    `🎯 Objetivo: Ganhar com a alta moderada de ${tickerLabel} em até ${preBarrier}, com proteção parcial na queda de até ${partial}. Se a alta de ${barrier} for superada, o ganho máximo fica limitado a ${capAfter} no período.`,
    '',
    `Cenário de alta (sem atingir ${barrier}):`,
    `Se ${tickerLabel} subir, sem nunca tocar ${barrier} do preço inicial, o investidor ganha 1% para cada 1% de alta, até o limite de ${preBarrier}.`,
    '',
    `Cenário de alta (atingiu ${barrier}):`,
    `Se ${tickerLabel} a qualquer momento atingir ${barrier} do preço inicial, o investidor segue com ganho na alta, porém com ganho máximo limitado a ${capAfter} no período.`,
    '',
    'Cenário neutro:',
    `Se ${tickerLabel} ficar entre 0% e ${partial} do preço inicial, o investidor não ganha e nem perde (faixa de proteção parcial).`,
    '',
    'Cenário de perda:',
    `Se ${tickerLabel} cair abaixo de ${partial} do preço inicial, o investidor perde 1% para cada 1% de queda abaixo desse nível, de forma ilimitada.`,
    '',
    `⏰ Vencimento: ${maturityLabel || '--'}`,
  ].join('\n')
}

const buildCollarCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  capPct,
  protectionPct,
}) => {
  const cap = fmtPct(capPct)
  const protection = fmtPct(protectionPct)
  return [
    `Operação Collar em ${tickerLabel}`,
    '',
    `🎯 Objetivo: Ganho limitado com a alta de ${tickerLabel} de até ${cap} com proteção de ${protection} na queda do ativo.`,
    '',
    `Cenário de alta: ${tickerLabel} com valorização de até ${cap} investidor ganha de forma linear conforme variação do ativo.`,
    '',
    `Cenário de queda: Investidor possui ${protection} do capital protegido em qualquer cenário de desvalorização.`,
    '',
    `⏰ Vencimento: ${maturityLabel || '--'}`,
    '(possível saída antecipada mediante cotação).',
  ].join('\n')
}

const buildCollarUiCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  preBarrierPct,
  capAfterPct,
  protectionPct,
}) => {
  const preBarrier = fmtPct(preBarrierPct)
  const capAfter = fmtPct(capAfterPct)
  const protection = fmtPct(protectionPct)
  return [
    `Operação Collar UI em ${tickerLabel}`,
    '',
    `🎯 Objetivo: Ganho limitado com a alta de ${tickerLabel} de até ${preBarrier} com proteção de ${protection} na queda do ativo.`,
    '',
    `Cenário de alta: ${tickerLabel} com valorização de até ${preBarrier} investidor ganha de forma linear conforme variação do ativo.`,
    '',
    `Caso ${tickerLabel} apresente uma valorização superior a ${preBarrier}: Investidor tem ganho limitado a ${capAfter}`,
    '',
    `Cenário de queda: Investidor possui ${protection} do capital protegido em qualquer cenário de desvalorização.`,
    '',
    `⏰ Vencimento: ${maturityLabel || '--'}`,
    '(possível saída antecipada mediante cotação).',
  ].join('\n')
}

const buildDocBidirecionalCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  preHighBarrierPct,
  maxGainPct,
  couponPct,
  preDownKoPct,
}) => {
  const preHigh = fmtPct(preHighBarrierPct)
  const maxGain = fmtPct(maxGainPct)
  const coupon = fmtPct(couponPct)
  const preDown = fmtPct(preDownKoPct)
  return [
    `DOC Bidirecional em ${tickerLabel}`,
    '',
    `🎯 Objetivo: Obter ganho dobrado com alta de ${tickerLabel} até ${preHigh} com possibilidade de ganho máximo de ${maxGain} e capital protegido até uma desvalorização de ${preDown}.`,
    '',
    `- ${tickerLabel} com valorização de até ${preHigh}: Investidor tem ganho dobrado.`,
    `- ${tickerLabel} com valorização superior a ${preHigh}: Investidor terá ganho limitado a ${coupon}.`,
    `- ${tickerLabel} com desvalorização de até ${preDown}: Investidor tem capital protegido.`,
    `- ${tickerLabel} com desvalorização superior a ${preDown}: Investidor participa integralmente da queda do ativo.`,
    '',
    `⏰ Vencimento: ${maturityLabel || '--'}`,
    '(possível saída antecipada mediante cotação)',
  ].join('\n')
}

const buildRubiCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  couponPct,
  barrierPct,
  preBarrierPct,
  cdiEquivPct = null,
}) => {
  const coupon = fmtPct(couponPct)
  const barrier = fmtPct(barrierPct)
  const preBarrier = fmtPct(preBarrierPct)
  const cdiText = cdiEquivPct != null && Number.isFinite(Number(cdiEquivPct))
    ? `, equivalente a ${fmtPct(cdiEquivPct)} do CDI`
    : ''
  return [
    `Rubi ${tickerLabel}`,
    '',
    `🎯 Objetivo: Retorno pré-acordado de ${coupon}${cdiText}, desde que a ação não tenha uma desvalorização superior a ${preBarrier} do preço inicial.`,
    '',
    'Cenário de Ganho:',
    `Na queda ou na alta em relação ao preço de entrada, sem atingir a barreira de ${barrier}.`,
    '',
    'Cenário de perda:',
    ` Se ${tickerLabel} atingir queda de ${barrier}, o investidor fica somente posicionado na ação, deixando de ganhar o cupom.`,
    '',
    `Vencimento da estratégia: ${maturityLabel || '--'}`,
  ].join('\n')
}

const buildRubiBlackCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  couponPct,
  barrierPct,
  upCapPct = null,
}) => {
  const coupon = fmtPct(couponPct)
  const barrier = fmtPct(barrierPct)
  const safeUpCap = upCapPct != null && Number.isFinite(Number(upCapPct)) ? Number(upCapPct) : null
  const upCapLabel = safeUpCap != null ? fmtPct(safeUpCap) : null
  const totalGainLabel = safeUpCap != null ? fmtPct(round2(Number(couponPct) + safeUpCap)) : null
  const extraLines = safeUpCap != null ? [
    '',
    'Exemplo de ganho adicional:',
    `Ação com valorização de ${upCapLabel} investidor ganha ${totalGainLabel} (${upCapLabel} da ação + o cupom da estratégia)`,
  ] : []
  return [
    `Rubi Black em ${tickerLabel}`,
    '',
    `🎯 Objetivo: Retorno pré-acordado de ${coupon}, desde que a ação não tenha uma desvalorização igual ou superior a  ${barrier} do preço inicial${safeUpCap != null ? ` e ganho adicional limitado a uma alta de ${upCapLabel} do papel` : ''}.`,
    ...extraLines,
    '',
    'Cenário de Ganho',
    `Na queda ou na alta em relação ao preço de entrada, sem atingir a barreira de ${barrier}`,
    '',
    'Cenário de perda',
    `Se ${tickerLabel} atingir queda de ${barrier}, o investidor fica somente posicionado na ação, deixando de ganhar o cupom.`,
    '',
    `Vencimento da estratégia: ${maturityLabel || '--'}`,
    'possível saida antecipada mediante cotação',
  ].join('\n')
}

const buildSmartCouponCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  couponPct,
  barrierPct,
  preBarrierPct,
  cdiEquivPct = null,
}) => {
  const coupon = fmtPct(couponPct)
  const barrier = fmtPct(barrierPct)
  const preBarrier = fmtPct(preBarrierPct)
  const cdiText = cdiEquivPct != null && Number.isFinite(Number(cdiEquivPct))
    ? ` equivalente a aproximadamente ${fmtPct(cdiEquivPct)} do CDI`
    : ''
  return [
    `Smart Coupon em ${tickerLabel}`,
    '',
    `Objetivo: Retorno pré-acordado de ${coupon}${cdiText}.`,
    '',
    `Cenário de Ganho: Na queda ou na alta em relação ao preço de entrada, estando acima da barreira de ${barrier} no vencimento.`,
    '',
    `Cenário de perda: Se, no vencimento, a ação apresentar uma desvalorização superior a ${preBarrier}, investidor deixa de ganhar o cupom, ficando somente posicionado na ação.`,
    '',
    `⏱ Vencimento: ${maturityLabel || '--'}`,
  ].join('\n')
}

const buildPopCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  upPartPct,
  downProtectionPct,
}) => {
  const upPart = fmtPct(upPartPct)
  const protection = fmtPct(downProtectionPct)
  return [
    `POP ${tickerLabel}`,
    '',
    `🎯 Objetivo: Obter ganho equivalente a ${upPart} da alta do ativo, com ${protection} do capital principal protegido.`,
    '',
    'Cenário de Ganho:',
    `Investidor participa de ${upPart} da alta do ativo-objeto de maneira ilimitada.`,
    '',
    'Cenário de perda:',
    `Investidor tem ${protection} do capital principal protegido no caso de queda do ativo objeto.`,
    '',
    `Vencimento: ${maturityLabel || '--'}`,
  ].join('\n')
}

const buildCupomRecorrenteCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  couponPerPeriod,
  barrierPct,
  termMonths,
}) => {
  const coupon = fmtPct(couponPerPeriod)
  const barrier = fmtPct(barrierPct)
  const safeBarrierAbs = Math.abs(Number(barrierPct) || 0)
  const preBarrier = fmtPct(beforeBarrierPct(-safeBarrierAbs, 'low'))
  return [
    `Cupom Recorrente em ${tickerLabel}`,
    '',
    'Objetivo',
    `Ganho de cupom mensal de ${coupon} desde que a ação não apresente uma desvalorização de ${barrier} no mês.`,
    '',
    `Caso a ação tenha uma desvalorização igual ou superior a ${barrier} na data do vencimento, o investidor deixa de ganhar o cupom naquele mês`,
    '',
    'É importante salientar que o pagamento dos cupons de cada vencimento são independentes entre si, ou seja, ao longo da vida da operação o cliente poderá receber o cupom de um vencimento e posteriormente não receber o cupom do mês subsequente.',
    '',
    `Vencimento: ${maturityLabel || '--'}.`,
  ].join('\n')
}

const buildAlocacaoProtegidaCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  investmentValue,
  termMonths,
}) => {
  const investedLabel = toNumber(investmentValue) != null ? fmtCurrency(toNumber(investmentValue)) : '--'
  const termLabel = fmtTerm(termMonths)
  return [
    `Alocação Protegida ${tickerLabel}`,
    `Em um cenário de juros reais ainda elevados no Brasil, essa estratégia busca capturar o potencial de valorização de um ETF atrelado a uma carteira de títulos públicos indexados à inflação com vencimento em 2050, com proteção do capital no vencimento.`,
    '',
    'Vantagens do ETF x Tesouro:',
    '- 15% de IR e isenção de IOF, sem DARF;',
    '- Reinvestimento de Cupom sem IR;',
    '',
    '💲 Ganho máximo ILIMITADO',
    '🛟 Capital 100% protegido no vencimento.',
    `⏱ Vencimento: ${maturityLabel || '--'} (${termLabel})`,
    `💰 Aplicação mínima: ${investedLabel}`,
    'Possibilidade de saída antecipada mediante cotação',
    '',
    'OBS: Informações meramente informativas com valores aproximados. Favor verificar perfil de risco e o push da operação.',
  ].join('\n')
}

const buildFinanciamentoCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  creditPct,
  underlyingBreakevenPct,
  capPct,
}) => {
  const credit = fmtPct(creditPct)
  const breakeven = fmtPct(underlyingBreakevenPct)
  const cap = fmtPct(capPct)
  const capRaw = Number(capPct) || 0
  const creditRaw = Number(creditPct) || 0
  const capPlusCredit = fmtPct(round2(capRaw + creditRaw))
  return [
    `Financiamento ${tickerLabel}`,
    '',
    'Objetivo',
    `Ganhar taxa mediante a venda da call referente ao prêmio recebido na montagem da operação de ${credit} sobre a posição comprada no ativo ${tickerLabel}.`,
    '',
    'Cenário de Perda',
    `Investidor perde 1% a cada 1% que a ação estiver abaixo de ${breakeven} do preço de referência de forma ilimitada.`,
    '',
    'Cenário de Ganho',
    `Ganho de 1% a cada 1% acima de ${breakeven} do preço inicial, com ganho máximo limitado a ${capPlusCredit} (prêmio recebido na montagem + alta de até ${cap}).`,
    '',
    'Vencimento',
    `${maturityLabel || '--'}`,
  ].join('\n')
}

const findBreakevenPctFromRows = (rows, direction = 'up') => {
  const withBreakeven = injectBreakevenRows(rows || [])
  const breakevenRow = withBreakeven.find((r) => r.isBreakeven)
  if (breakevenRow && Number.isFinite(Number(breakevenRow.underlyingVarPct))) {
    return round2(Math.abs(Number(breakevenRow.underlyingVarPct)))
  }
  const ordered = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => a.underlyingVarPct - b.underlyingVarPct)
  if (direction === 'up') {
    const firstNonLoss = ordered.find((r) => Number(r.strategyVarPct) >= 0 && Number(r.underlyingVarPct) > 0)
    if (firstNonLoss) return round2(Math.abs(Number(firstNonLoss.underlyingVarPct)))
  } else {
    const firstNonLoss = [...ordered].reverse().find((r) => Number(r.strategyVarPct) >= 0 && Number(r.underlyingVarPct) < 0)
    if (firstNonLoss) return round2(Math.abs(Number(firstNonLoss.underlyingVarPct)))
  }
  return null
}

const buildOptionCommercialMessage = ({
  tickerLabel,
  maturityLabel,
  direction = 'up',
  optionCostPct,
  breakevenPct = null,
  investmentValue,
}) => {
  const isDown = direction === 'down'
  const movementLabel = isDown ? 'queda' : 'alta'
  const cost = Math.abs(Number(optionCostPct) || 0.01)
  const rawBreakeven = breakevenPct != null && Number.isFinite(Number(breakevenPct))
    ? Math.abs(Number(breakevenPct))
    : cost
  const pt0 = isDown ? -rawBreakeven : rawBreakeven
  const pt1 = isDown ? -(rawBreakeven + cost) : rawBreakeven + cost
  const pt2 = isDown ? -(rawBreakeven + 2 * cost) : rawBreakeven + 2 * cost
  const investedAmount = toNumber(investmentValue)
  const investedLabel = investedAmount != null ? fmtCurrency(investedAmount) : '--'
  const profit1Label = investedAmount != null ? fmtCurrency(investedAmount) : '--'
  const profit2Label = investedAmount != null ? fmtCurrency(investedAmount * 2) : '--'
  return [
    `${tickerLabel}`,
    '',
    `🎯 Objetivo: Obter ganho ilimitado com a ${isDown ? 'desvalorizacao' : 'valorizacao'} de ${tickerLabel} com risco maximo limitado ao valor pago pela estrutura.`,
    '',
    'Exemplo de desempenho no vencimento:',
    `- Considerando aporte de ${investedLabel}.`,
    '',
    `${tickerLabel} com ${movementLabel} de ${fmtPct(pt0)} = Recebe o Capital Investido (0X0).`,
    `${tickerLabel} com ${movementLabel} de ${fmtPct(pt1)} = Capital Investido + ${profit1Label}.`,
    `${tickerLabel} com ${movementLabel} de ${fmtPct(pt2)} = Capital Investido + ${profit2Label}.`,
    '',
    '❗ Risco maximo: Valor investido.',
    '📈 Lucro maximo: Lucro ilimitado.',
    '',
    `⏱ Vencimento: ${maturityLabel || '--'}`,
    '(possibilidade de saida antecipada).',
  ].join('\n')
}

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
  includeBreakeven = true,
}) => {
  const tk = ticker(values.ticker)
  const maturityLabel = fmtDate(values.maturityDate)
  const feeAaiRealPct = resolveFeeAaiRealPct(template?.id, values)
  const rowsWithBarrierEdge = injectBarrierEdgeRows(rows, {
    highBarrierPct: highBarrierSamplingPct,
    lowBarrierPct: lowBarrierSamplingPct,
    highBarrierMode: highBarrierSamplingMode,
    lowBarrierMode: lowBarrierSamplingMode,
  })
  const rowsWithBreakeven = includeBreakeven
    ? injectBreakevenRows(rowsWithBarrierEdge)
    : rowsWithBarrierEdge
  const sampledRows = limitRowsAroundBarriers(rowsWithBreakeven, {
    highBarrierPct: highBarrierSamplingPct,
    lowBarrierPct: lowBarrierSamplingPct,
    highBarrierMode: highBarrierSamplingMode,
    lowBarrierMode: lowBarrierSamplingMode,
  })
  const orderedRows = orderPayoffRows(sampledRows, scenarioDirection)
  const parsedMaxGainBarrierPct = maxGainBarrierPct == null || maxGainBarrierPct === ''
    ? null
    : Number(maxGainBarrierPct)
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
      feeAaiReal: feeAaiRealPct == null ? '--' : fmtPct(feeAaiRealPct, 3),
    },
    feeAaiRealPct: feeAaiRealPct == null ? null : round2(feeAaiRealPct),
    payoffRows: orderedRows,
    maxGainBarrierPct: Number.isFinite(parsedMaxGainBarrierPct) ? parsedMaxGainBarrierPct : null,
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
      const effectiveMaxGain = resolveRowsMaxGainPct(rows, maxGain)
      const breakevenFromRows = optionSettlement.leveraged ? findBreakevenPctFromRows(rows, 'down') : null
      const startForMessage = breakevenFromRows != null ? -breakevenFromRows : start
      const spreadMessage = buildSpreadCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        direction: 'down',
        startPct: startForMessage,
        limitPct: effectiveFloor,
        maxGainPct: effectiveMaxGain,
        investmentValue: values.ticketMin,
      })
      const warnings = startRaw <= limitRaw ? ['O inicio do ganho deve ser maior que o limite da queda.'] : []
      const hasStrikeInput = hasOptionStrikeInput(values.options)
      if (hasStrikeInput && !optionSettlement.hasDerivativeLegs) warnings.push('Configure strike nas opcoes para calculo de vencimento.')
      if (hasStrikeInput && !optionSettlement.hasValidCost) warnings.push('Informe o custo da opcao (%) para calcular o retorno alavancado.')
      const model = buildModel({
        template, values, rows, validations: warnings,
        scenarioDirection: template.scenarioDirection || 'up',
        lowBarrierSamplingPct: effectiveFloor,
        lowBarrierSamplingMode: 'post_only',
        subtitle: 'Ganho na queda com perda limitada ao premio.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Ganho maximo', value: fmtPct(effectiveMaxGain), tone: 'positive' }, { label: 'Premio', value: `-${fmtPct(premium)}`, tone: 'negative' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highlights: [`Inicio na queda: ${fmtPct(start)}`, `Limitador: ${fmtPct(effectiveFloor)}`, `Perda maxima: ${fmtPct(premium)}`],
        sections: [
          `*Objetivo:* Buscar ganho com a queda de ${tk}, com risco limitado ao custo da estrutura de ${fmtPct(premium)}.`,
          `*Cenario de ganho:* Se ${tk} cair entre ${fmtPct(start)} e ${fmtPct(limit)}, o retorno cresce de forma gradual ate ${fmtPct(maxGain)}; abaixo de ${fmtPct(limit)}, o ganho permanece em ${fmtPct(maxGain)}.`,
          `*Cenario de perda:* Se ${tk} ficar estavel ou subir, a perda maxima fica limitada a ${fmtPct(premium)}.`,
        ],
      })
      return {
        ...model,
        generatedMessage: spreadMessage,
      }
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
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const highBarrierFromOptions = resolveHighBarrierFromOptionSpecs(optionPayoff.specs)
      const highCapFromOptions = resolveHighCapFromOptionEntries(values.options)
      const effectiveBarrier = highBarrierFromOptions != null ? highBarrierFromOptions : barrier
      const effectiveCapAfter = highCapFromOptions != null ? highCapFromOptions : capAfter
      const preBarrier = beforeBarrierPct(effectiveBarrier, 'high')
      const fallbackRows = payoffRows(
        (u) => (u <= floor ? floor : (u <= effectiveBarrier ? u : Math.min(u, effectiveCapAfter))),
        [floor, effectiveBarrier, effectiveCapAfter],
      )
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const collarUiMessage = buildCollarUiCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        preBarrierPct: preBarrier,
        capAfterPct: effectiveCapAfter,
        protectionPct: protection,
      })
      const collarUiModel = buildModel({
        template, values, rows,
        subtitle: 'Protecao de capital com limite de alta apos ativacao da barreira.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Barreira alta', value: fmtPct(effectiveBarrier) }, { label: 'Limitador', value: fmtPct(effectiveCapAfter), tone: 'positive' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        maxGainBarrierPct: effectiveBarrier,
        highBarrierSamplingPct: effectiveBarrier,
        highlights: [`Protecao: ${fmtPct(protection)} do capital`, `Barreira de alta: ${fmtPct(effectiveBarrier)}`, `Limitador de alta: ${fmtPct(effectiveCapAfter)}`],
        sections: [
          `*Objetivo:* Participar da valorizacao de ${tk} ate ${fmtPct(preBarrier)}. Caso a alta seja igual ou superior a ${fmtPct(effectiveBarrier)}, o retorno final fica limitado a ${fmtPct(effectiveCapAfter)} no periodo.`,
          `*Cenario de ganho:* Em alta, o investidor acompanha o ativo ate ${fmtPct(preBarrier)}; ao atingir ${fmtPct(effectiveBarrier)}, o ganho fica travado em ${fmtPct(effectiveCapAfter)}.`,
          `*Cenario de perda:* Em queda, o resultado minimo da estrategia fica limitado em ${fmtPct(floor)}.`,
        ],
      })
      return { ...collarUiModel, generatedMessage: collarUiMessage }
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
      const effectiveMaxGain = resolveRowsMaxGainPct(rows, maxGain)
      const breakevenFromRows = optionSettlement.leveraged ? findBreakevenPctFromRows(rows, 'up') : null
      const startForMessage = breakevenFromRows != null ? breakevenFromRows : start
      const spreadMessage = buildSpreadCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        direction: 'up',
        startPct: startForMessage,
        limitPct: effectiveCap,
        maxGainPct: effectiveMaxGain,
        investmentValue: values.ticketMin,
      })
      const warnings = startRaw >= limitRaw ? ['O inicio do ganho deve ser menor que o limite da alta.'] : []
      const hasStrikeInput = hasOptionStrikeInput(values.options)
      if (hasStrikeInput && !optionSettlement.hasDerivativeLegs) warnings.push('Configure strike nas opcoes para calculo de vencimento.')
      if (hasStrikeInput && !optionSettlement.hasValidCost) warnings.push('Informe o custo da opcao (%) para calcular o retorno alavancado.')
      const model = buildModel({
        template, values, rows, validations: warnings,
        subtitle: 'Alta alavancada com perda limitada ao premio.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Ganho maximo', value: fmtPct(effectiveMaxGain), tone: 'positive' }, { label: 'Premio', value: `-${fmtPct(premium)}`, tone: 'negative' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highBarrierSamplingPct: effectiveCap,
        highBarrierSamplingMode: 'post_only',
        highlights: [`Inicio da alta: ${fmtPct(start)}`, `Limitador da alta: ${fmtPct(effectiveCap)}`, `Perda maxima: ${fmtPct(premium)}`],
        sections: [
          `*Objetivo:* Buscar ganho com a alta de ${tk} entre ${fmtPct(start)} e ${fmtPct(limit)}, com risco limitado ao custo da estrutura de ${fmtPct(premium)}.`,
          `*Cenario de ganho:* Se ${tk} subir entre ${fmtPct(start)} e ${fmtPct(limit)}, o retorno cresce de forma gradual ate ${fmtPct(maxGain)}; acima de ${fmtPct(limit)}, o ganho permanece em ${fmtPct(maxGain)}.`,
          `*Cenario de perda:* Em estabilidade ou queda, a perda maxima fica limitada a ${fmtPct(premium)}.`,
        ],
      })
      return {
        ...model,
        generatedMessage: spreadMessage,
      }
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
      const breakevenPctCall = findBreakevenPctFromRows(rows, 'up')
      const callMessage = buildOptionCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        direction: 'up',
        optionCostPct: optionCost,
        breakevenPct: breakevenPctCall,
        investmentValue: values.ticketMin,
      })
      const callModel = buildModel({
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
      return { ...callModel, generatedMessage: callMessage }
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
      const breakevenPctPut = findBreakevenPctFromRows(rows, 'down')
      const putMessage = buildOptionCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        direction: 'down',
        optionCostPct: optionCost,
        breakevenPct: breakevenPctPut,
        investmentValue: values.ticketMin,
      })
      const putModel = buildModel({
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
      return { ...putModel, generatedMessage: putMessage }
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
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const highCapFromOptions = resolveHighCapFromOptionEntries(values.options)
      const effectiveCap = highCapFromOptions != null ? highCapFromOptions : cap
      const fallbackRows = payoffRows((u) => (u <= floor ? floor : (u >= effectiveCap ? effectiveCap : u)), [floor, effectiveCap])
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const collarMessage = buildCollarCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        capPct: effectiveCap,
        protectionPct: protection,
      })
      const collarModel = buildModel({
        template, values, rows,
        subtitle: 'Protecao na queda com limite de alta.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Protecao', value: fmtPct(protection) }, { label: 'Limitador', value: fmtPct(effectiveCap), tone: 'positive' }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highBarrierSamplingPct: effectiveCap,
        highBarrierSamplingMode: 'post_only',
        highlights: [`Protecao: ${fmtPct(protection)}`, `Limitador de alta: ${fmtPct(effectiveCap)}`, 'Estrutura sem premio adicional'],
        sections: [
          `*Objetivo:* Participar da alta de ${tk} ate ${fmtPct(effectiveCap)}, com resultado minimo limitado em ${fmtPct(floor)}.`,
          `*Cenario de ganho:* Em alta, o retorno acompanha o ativo ate ${fmtPct(effectiveCap)}; acima desse ponto, o ganho fica limitado em ${fmtPct(effectiveCap)}.`,
          `*Cenario de perda:* Em queda, a perda maxima no vencimento fica travada em ${fmtPct(floor)}.`,
        ],
      })
      return { ...collarModel, generatedMessage: collarMessage }
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
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const highBarrierFromOptions = resolveHighBarrierFromOptionSpecs(optionPayoff.specs)
      const highCapFromOptions = resolveHighCapFromOptionEntries(values.options)
      const lowCapFromOptions = resolveLowCapFromOptionEntries(values.options)
      const effectiveBarrier = highBarrierFromOptions != null ? highBarrierFromOptions : barrier
      const effectiveCapAfter = highCapFromOptions != null ? highCapFromOptions : capAfter
      const effectivePartial = lowCapFromOptions == null ? partial : Math.abs(Math.min(lowCapFromOptions, 0))
      const preBarrier = beforeBarrierPct(effectiveBarrier, 'high')
      const fallbackRows = payoffRows(
        (u) => (u >= 0 ? (u <= effectiveBarrier ? u : Math.min(u, effectiveCapAfter)) : (u >= -effectivePartial ? 0 : u + effectivePartial)),
        [effectiveBarrier, effectiveCapAfter, -effectivePartial],
      )
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const fenceMessage = buildFenceUiCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        preBarrierPct: preBarrier,
        partialProtectionPct: effectivePartial,
        barrierPct: effectiveBarrier,
        capAfterPct: effectiveCapAfter,
      })
      const model = buildModel({
        template, values, rows,
        subtitle: 'Protecao parcial na queda e limite de alta apos barreira.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Protecao parcial', value: fmtPct(effectivePartial) }, { label: 'Barreira alta', value: fmtPct(effectiveBarrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        maxGainBarrierPct: effectiveBarrier,
        highBarrierSamplingPct: effectiveBarrier,
        highlights: [`Protecao parcial: ${fmtPct(effectivePartial)}`, `Barreira de alta: ${fmtPct(effectiveBarrier)}`, `Limitador apos barreira: ${fmtPct(effectiveCapAfter)}`],
        sections: [
          `*Objetivo:* Ganhar com a alta moderada de ${tk} em ate ${fmtPct(preBarrier)}, com protecao parcial na queda de ate ${fmtPct(-effectivePartial)}. Se a alta de ${fmtPct(effectiveBarrier)} for superada, o ganho maximo fica limitado a ${fmtPct(effectiveCapAfter)} no periodo.`,
          `*Cenario de alta (sem atingir ${fmtPct(effectiveBarrier)}):* Se ${tk} subir, sem nunca tocar ${fmtPct(effectiveBarrier)} do preco inicial, o investidor ganha 1% para cada 1% de alta, ate o limite de ${fmtPct(preBarrier)}.`,
          `*Cenario de alta (atingiu ${fmtPct(effectiveBarrier)}):* Se ${tk} a qualquer momento atingir ${fmtPct(effectiveBarrier)} do preco inicial, o investidor segue com ganho na alta, porem com ganho maximo limitado a ${fmtPct(effectiveCapAfter)} no periodo.`,
          `*Cenario neutro:* Se ${tk} ficar entre 0% e ${fmtPct(-effectivePartial)} do preco inicial, o investidor nao ganha e nem perde (faixa de protecao parcial).`,
          `*Cenario de perda:* Se ${tk} cair abaixo de ${fmtPct(-effectivePartial)} do preco inicial, o investidor perde 1% para cada 1% de queda abaixo desse nivel, de forma ilimitada.`,
        ],
      })
      return {
        ...model,
        generatedMessage: fenceMessage,
      }
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
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const highBarrierFromOptions = resolveHighBarrierFromOptionSpecs(optionPayoff.specs)
      const highCapFromOptions = resolveHighCapFromOptionEntries(values.options)
      const effectiveBarrier = highBarrierFromOptions != null ? Math.max(highBarrierFromOptions, trigger) : barrier
      const effectiveCapAfter = highCapFromOptions != null ? highCapFromOptions : capAfter
      const preBarrier = beforeBarrierPct(effectiveBarrier, 'high')
      const fallbackRows = payoffRows(
        (u) => (u < 0 ? u : (u <= trigger ? u : (u <= effectiveBarrier ? trigger + 2 * (u - trigger) : effectiveCapAfter))),
        [trigger, effectiveBarrier, effectiveCapAfter],
      )
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const warnings = barrierRaw < trigger ? ['A barreira KO de alta deve ser maior ou igual ao gatilho.'] : []
      return buildModel({
        template, values, rows, validations: warnings,
        subtitle: 'Ganho dobrado na alta ate o KO, com limitador apos ativacao.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'KO alta', value: fmtPct(effectiveBarrier) }, { label: 'Pos KO', value: fmtPct(effectiveCapAfter) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        maxGainBarrierPct: effectiveBarrier,
        highBarrierSamplingPct: effectiveBarrier,
        highlights: [`Ganho dobrado acima de ${fmtPct(trigger)}`, `Barreira KO: ${fmtPct(effectiveBarrier)}`, `Limitador apos KO: ${fmtPct(effectiveCapAfter)}`],
        sections: [
          `*Objetivo:* Buscar ganho acelerado na alta de ${tk} a partir de ${fmtPct(trigger)} ate ${fmtPct(preBarrier)}.`,
          `*Cenario de ganho:* Entre ${fmtPct(trigger)} e ${fmtPct(preBarrier)}, a estrategia amplia o retorno da alta. Se ${tk} atingir ${fmtPct(effectiveBarrier)}, o resultado final passa para ${fmtPct(effectiveCapAfter)}.`,
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
      const maxGainAtBarrier = round2(2 * (highBarrierFromOptions != null ? highBarrierFromOptions : highKo))
      const docMessage = buildDocBidirecionalCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        preHighBarrierPct: preHighBarrier,
        maxGainPct: maxGainAtBarrier,
        couponPct: coupon,
        preDownKoPct: effectivePreDownBarrier,
      })
      const docModel = buildModel({
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
      return { ...docModel, generatedMessage: docMessage }
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
      const alocMessage = buildAlocacaoProtegidaCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        investmentValue: values.ticketMin,
        termMonths: values.termMonths,
      })
      const alocModel = buildModel({
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
      return { ...alocModel, generatedMessage: alocMessage }
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
      const popMessage = buildPopCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        upPartPct: upPart,
        downProtectionPct: downProtection,
      })
      const popModel = buildModel({
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
      return { ...popModel, generatedMessage: popMessage }
    },
  },
  {
    id: 'rubi',
    label: 'RUBI',
    defaults: { ...BASE_DEFAULTS, ticker: 'RENT3', termMonths: '4', couponPct: '8', downBarrierPct: '20', cdiEquivPct: '', ticketMin: 'R$ 5.000,00', feeAai: '1,23%' },
    fields: [...IDENT_FIELDS, numberField('couponPct', 'Cupom nominal (%)'), numberField('downBarrierPct', 'Barreira KO de baixa (%)'), numberField('cdiEquivPct', 'Equivalência CDI (%) opcional'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const fallbackCoupon = pct(values.couponPct, 8, -100, 300)
      const fallbackBarrierAbs = pct(values.downBarrierPct, 20, 0, 95)
      const optionConfig = resolveRubiConfigFromOptions(values.options, fallbackCoupon, fallbackBarrierAbs, values.stockQuantity)
      const coupon = optionConfig.couponPct
      const barrier = -Math.abs(optionConfig.downBarrierAbsPct)
      const preBarrier = beforeBarrierPct(barrier, 'low')
      const guidePoints = buildRubiGuidePoints(barrier)
      const rows = payoffRows((u) => (u > barrier ? coupon : u), [], guidePoints)
      const cdiEquiv = toNumber(values.cdiEquivPct)
      const rubiMessage = buildRubiCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        couponPct: coupon,
        barrierPct: barrier,
        preBarrierPct: preBarrier,
        cdiEquivPct: cdiEquiv,
      })
      const rubiModel = buildModel({
        template, values, rows, validations: optionConfig.warnings,
        subtitle: 'Cupom pre-acordado condicionado ao nao atingimento de KO durante a vida.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Cupom', value: fmtPct(coupon), tone: 'positive' }, { label: 'KO baixa', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        lowBarrierSamplingPct: barrier,
        includeBreakeven: false,
        highlights: [`Cupom nominal: ${fmtPct(coupon)}`, `KO de baixa: ${fmtPct(barrier)}`, 'Barreira monitorada durante toda a operacao'],
        sections: [
          `*Objetivo:* Buscar retorno pre-acordado de ${fmtPct(coupon)} desde que ${tk} nao tenha desvalorizacao igual ou superior a ${fmtPct(barrier)}.`,
          `*Cenario de ganho:* Em alta ou em queda ate ${fmtPct(preBarrier)}, o retorno permanece em ${fmtPct(coupon)} no periodo.`,
          `*Cenario de perda:* Se ${tk} atingir ${fmtPct(barrier)} ou abaixo, o cupom deixa de ser pago e o investidor passa a acompanhar a variacao do ativo.`,
        ],
      })
      return { ...rubiModel, generatedMessage: rubiMessage }
    },
  },
  {
    id: 'rubi_black',
    label: 'RUBI Black',
    defaults: { ...BASE_DEFAULTS, ticker: 'RENT3', termMonths: '4', couponPct: '8', downBarrierPct: '20', highCapPct: '', ticketMin: 'R$ 5.000,00', feeAai: '1,23%' },
    fields: [...IDENT_FIELDS, numberField('couponPct', 'Cupom nominal (%)'), numberField('downBarrierPct', 'Barreira KO de baixa (%)'), numberField('highCapPct', 'Ganho adicional de alta (%) opcional'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const fallbackCoupon = pct(values.couponPct, 8, -100, 300)
      const fallbackBarrierAbs = pct(values.downBarrierPct, 20, 0, 95)
      const optionConfig = resolveRubiConfigFromOptions(values.options, fallbackCoupon, fallbackBarrierAbs, values.stockQuantity)
      const coupon = optionConfig.couponPct
      const barrier = -Math.abs(optionConfig.downBarrierAbsPct)
      const preBarrier = beforeBarrierPct(barrier, 'low')
      const guidePoints = buildRubiGuidePoints(barrier)
      const rows = payoffRows((u) => (u > barrier ? coupon : u), [], guidePoints)
      const upCap = toNumber(values.highCapPct)
      const rubiBlackMessage = buildRubiBlackCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        couponPct: coupon,
        barrierPct: barrier,
        upCapPct: upCap,
      })
      const rubiBlackModel = buildModel({
        template, values, rows, validations: optionConfig.warnings,
        subtitle: 'Cupom pre-acordado condicionado ao nao atingimento de KO durante a vida.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Cupom', value: fmtPct(coupon), tone: 'positive' }, { label: 'KO baixa', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        lowBarrierSamplingPct: barrier,
        includeBreakeven: false,
        highlights: [`Cupom nominal: ${fmtPct(coupon)}`, `KO de baixa: ${fmtPct(barrier)}`, 'Barreira monitorada durante toda a operacao'],
        sections: [
          `*Objetivo:* Buscar retorno pre-acordado de ${fmtPct(coupon)} desde que ${tk} nao tenha desvalorizacao igual ou superior a ${fmtPct(barrier)}.`,
          `*Cenario de ganho:* Em alta ou em queda ate ${fmtPct(preBarrier)}, o retorno permanece em ${fmtPct(coupon)} no periodo.`,
          `*Cenario de perda:* Se ${tk} atingir ${fmtPct(barrier)} ou abaixo, o cupom deixa de ser pago e o investidor passa a acompanhar a variacao do ativo.`,
        ],
      })
      return { ...rubiBlackModel, generatedMessage: rubiBlackMessage }
    },
  },
  {
    id: 'smart_coupon',
    label: 'Smart Coupon',
    defaults: { ...BASE_DEFAULTS, ticker: 'MELI34', termMonths: '3', couponPct: '6', downBarrierPct: '10', cdiEquivPct: '', ticketMin: 'R$ 9.500,00', feeAai: '1,25%' },
    fields: [...IDENT_FIELDS, numberField('couponPct', 'Cupom nominal (%)'), numberField('downBarrierPct', 'Barreira KO de baixa (%)'), numberField('cdiEquivPct', 'Equivalência CDI (%) opcional'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const fallbackCoupon = pct(values.couponPct, 6, -100, 300)
      const fallbackBarrierAbs = pct(values.downBarrierPct, 10, 0, 95)
      const optionConfig = resolveRubiConfigFromOptions(values.options, fallbackCoupon, fallbackBarrierAbs, values.stockQuantity)
      const coupon = optionConfig.couponPct
      const barrier = -Math.abs(optionConfig.downBarrierAbsPct)
      const preBarrier = beforeBarrierPct(barrier, 'low')
      const guidePoints = buildRubiGuidePoints(barrier)
      const rows = payoffRows((u) => (u > barrier ? coupon : u), [], guidePoints)
      const cdiEquiv = toNumber(values.cdiEquivPct)
      const smartMessage = buildSmartCouponCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        couponPct: coupon,
        barrierPct: barrier,
        preBarrierPct: preBarrier,
        cdiEquivPct: cdiEquiv,
      })
      const smartModel = buildModel({
        template, values, rows, validations: optionConfig.warnings,
        subtitle: 'Cupom pre-acordado com validacao da barreira apenas no vencimento.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Cupom', value: fmtPct(coupon), tone: 'positive' }, { label: 'KO baixa', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        lowBarrierSamplingPct: barrier,
        includeBreakeven: false,
        highlights: [`Cupom nominal: ${fmtPct(coupon)}`, `KO de baixa: ${fmtPct(barrier)}`, 'Barreira validada apenas no vencimento'],
        sections: [
          `*Objetivo:* Buscar retorno pre-acordado de ${fmtPct(coupon)} desde que ${tk} nao encerre o periodo com desvalorizacao igual ou superior a ${fmtPct(barrier)}.`,
          `*Cenario de ganho:* Em alta ou em queda ate ${fmtPct(preBarrier)}, o retorno permanece em ${fmtPct(coupon)} no periodo.`,
          `*Cenario de perda:* Apenas no vencimento, se ${tk} estiver em ${fmtPct(barrier)} ou abaixo, o cupom deixa de ser pago e o investidor passa a acompanhar a variacao do ativo.`,
        ],
      })
      return { ...smartModel, generatedMessage: smartMessage }
    },
  },
  {
    id: 'financiamento',
    label: 'Financiamento',
    defaults: { ...BASE_DEFAULTS, ticker: 'PETR4', termMonths: '6', optionCostPct: '3', highCapPct: '15', ticketMin: 'R$ 1.700,00', feeAai: '1,33%' },
    fields: [...IDENT_FIELDS, numberField('highCapPct', 'Limitador de alta (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const optionCredit = resolveOptionCreditPct(values, 3)
      const cap = pct(values.highCapPct, 15, -20, 200)
      const highCapFromOptions = resolveHighCapFromOptionEntries(values.options)
      const effectiveCap = highCapFromOptions != null ? highCapFromOptions : cap
      const fallbackRows = payoffRows((u) => {
        const capped = u >= effectiveCap ? effectiveCap : u
        return capped + optionCredit
      }, [effectiveCap])
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const underlyingBreakeven = -Math.abs(optionCredit)
      const finMessage = buildFinanciamentoCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        creditPct: optionCredit,
        underlyingBreakevenPct: round2(100 + underlyingBreakeven),
        capPct: effectiveCap,
      })
      const finModel = buildModel({
        template, values, rows,
        subtitle: 'Compra do ativo com venda de call — recebe premio que reduz o custo de entrada.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Premio recebido', value: fmtPct(optionCredit), tone: 'positive' }, { label: 'Limitador', value: fmtPct(effectiveCap) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highBarrierSamplingPct: effectiveCap,
        highBarrierSamplingMode: 'post_only',
        highlights: [`Premio recebido: ${fmtPct(optionCredit)}`, `Limitador de alta: ${fmtPct(effectiveCap)}`, 'Custo de entrada reduzido pelo premio da venda de call'],
        sections: [
          `*Objetivo:* Comprar ${tk} e vender uma call para receber premio de ${fmtPct(optionCredit)}, reduzindo o custo de entrada.`,
          `*Cenario de ganho:* Em alta ate ${fmtPct(effectiveCap)}, o retorno acompanha o ativo somado ao premio recebido; acima de ${fmtPct(effectiveCap)} o ganho fica limitado.`,
          `*Cenario de perda:* Em queda, o investidor acompanha a desvalorizacao do ativo, porem com o colchao do premio de ${fmtPct(optionCredit)} ja creditado.`,
        ],
      })
      return { ...finModel, generatedMessage: finMessage }
    },
  },
  {
    id: 'financiamento_sob_custodia',
    label: 'Financiamento sob Custodia',
    defaults: { ...BASE_DEFAULTS, ticker: 'PETR4', termMonths: '6', optionCostPct: '3', highCapPct: '15', ticketMin: 'R$ 1.700,00', feeAai: '1,33%' },
    fields: [...IDENT_FIELDS, numberField('highCapPct', 'Limitador de alta (%)'), ...COMM_FIELDS],
    build(values, template) {
      const tk = ticker(values.ticker)
      const optionCredit = resolveOptionCreditPct(values, 3)
      const cap = pct(values.highCapPct, 15, -20, 200)
      const highCapFromOptions = resolveHighCapFromOptionEntries(values.options)
      const effectiveCap = highCapFromOptions != null ? highCapFromOptions : cap
      const fallbackRows = payoffRows((u) => {
        const capped = u >= effectiveCap ? effectiveCap : u
        return capped + optionCredit
      }, [effectiveCap])
      const optionPayoff = buildOptionDrivenRows(values.options, {
        includeUnderlying: true,
        baseQuantity: values.stockQuantity,
      })
      const rows = optionPayoff.hasDerivativeLegs ? optionPayoff.rows : fallbackRows
      const underlyingBreakevenSc = -Math.abs(optionCredit)
      const finScMessage = buildFinanciamentoCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        creditPct: optionCredit,
        underlyingBreakevenPct: round2(100 + underlyingBreakevenSc),
        capPct: effectiveCap,
      })
      const finScModel = buildModel({
        template, values, rows,
        subtitle: 'Compra do ativo sob custodia com venda de call — recebe premio que reduz o custo de entrada.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Premio recebido', value: fmtPct(optionCredit), tone: 'positive' }, { label: 'Limitador', value: fmtPct(effectiveCap) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highBarrierSamplingPct: effectiveCap,
        highBarrierSamplingMode: 'post_only',
        highlights: [`Premio recebido: ${fmtPct(optionCredit)}`, `Limitador de alta: ${fmtPct(effectiveCap)}`, 'Ativo sob custodia com premio da venda de call creditado'],
        sections: [
          `*Objetivo:* Comprar ${tk} sob custodia e vender call para receber premio de ${fmtPct(optionCredit)}, reduzindo o custo de entrada.`,
          `*Cenario de ganho:* Em alta ate ${fmtPct(effectiveCap)}, o retorno acompanha o ativo somado ao premio recebido; acima de ${fmtPct(effectiveCap)} o ganho fica limitado.`,
          `*Cenario de perda:* Em queda, o investidor acompanha a desvalorizacao do ativo, porem com o colchao do premio de ${fmtPct(optionCredit)} ja creditado.`,
        ],
      })
      return { ...finScModel, generatedMessage: finScMessage }
    },
  },
  {
    id: 'alocacao_protegida_sob_custodia',
    label: 'Alocacao Protegida sob Custodia',
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
        subtitle: 'Participacao de alta com perda apenas abaixo do patamar protegido (ativo sob custodia).',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Gatilho alta', value: fmtPct(upTrigger) }, { label: 'Protecao', value: fmtPct(downProtection) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        highlights: [`Participacao na alta acima de ${fmtPct(upTrigger)}`, `Patamar protegido: ${fmtPct(-downProtection)}`, 'Perda apenas abaixo do patamar protegido'],
        sections: [
          `*Objetivo:* Participar da alta de ${tk} acima de ${fmtPct(upTrigger)} com protecao nas quedas ate ${fmtPct(-downProtection)}, ativo sob custodia.`,
          `*Cenario de ganho:* Acima de ${fmtPct(upTrigger)}, o retorno cresce de forma linear com cada alta adicional do ativo.`,
          `*Cenario de perda:* Entre 0% e ${fmtPct(-downProtection)}, a estrategia busca preservar capital; abaixo desse nivel, volta a acompanhar a queda.`,
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
      const termMonths = toNumber(values.termMonths) || 1
      const fallbackCoupon = pct(values.couponPct, 8, -100, 300)
      const fallbackBarrierAbs = pct(values.downBarrierPct, 16.65, 0, 95)
      const optionConfig = resolveCouponConfigFromOptions(values.options, fallbackCoupon, fallbackBarrierAbs, values.stockQuantity)
      const couponTotal = optionConfig.couponPct
      const couponPerPeriod = resolveRecurringCouponPerPeriodPct(couponTotal, termMonths)
      const barrier = -Math.abs(optionConfig.downBarrierAbsPct)
      const recurringCouponHighlight = `Cupons recorrentes de ${fmtPct(couponPerPeriod)} ao mes`
      const rows = payoffRows((u) => (u >= barrier ? couponPerPeriod : u), [barrier, couponPerPeriod])
      const crMessage = buildCupomRecorrenteCommercialMessage({
        tickerLabel: tk,
        maturityLabel: fmtDate(values.maturityDate),
        couponPerPeriod,
        barrierPct: barrier,
        termMonths,
      })
      const crModel = buildModel({
        template, values, rows, validations: optionConfig.warnings,
        subtitle: 'Cupom nominal distribuido em pagamentos recorrentes com condicao de barreira em cada observacao.',
        metrics: [{ label: 'Prazo', value: fmtTerm(values.termMonths) }, { label: 'Cupom nominal', value: fmtPct(couponTotal), tone: 'positive' }, { label: 'Barreira baixa', value: fmtPct(barrier) }, { label: 'Vencimento', value: fmtDate(values.maturityDate) }],
        lowBarrierSamplingPct: barrier,
        highlights: [`Cupom nominal: ${fmtPct(couponTotal)}`, recurringCouponHighlight, `Barreira de baixa: ${fmtPct(barrier)}`],
        sections: [
          `*Objetivo:* Receber cupom nominal de ${fmtPct(couponTotal)} ao longo de ${fmtTerm(termMonths)}, em cupons recorrentes de ${fmtPct(couponPerPeriod)} ao mes, desde que ${tk} feche acima de ${fmtPct(barrier)} em cada observacao.`,
          `*Cenario de ganho:* Em cada data de observacao, se o ativo terminar acima de ${fmtPct(barrier)}, o cupom recorrente daquele periodo e pago em ${fmtPct(couponPerPeriod)}.`,
          `*Cenario de perda:* Se em algum vencimento o ativo fechar em ${fmtPct(barrier)} ou abaixo, nao ha pagamento do cupom recorrente daquele periodo e o investidor permanece posicionado no ativo.`,
        ],
      })
      return { ...crModel, generatedMessage: crMessage }
    },
  },
]

const templateMap = templates.reduce((acc, item) => {
  acc[item.id] = item
  return acc
}, {})

const defaultTemplateId = templates[0]?.id || 'put_spread'
const getTemplate = (id) => templateMap[id] || templateMap[defaultTemplateId]

export const strategyTemplateOptions = templates
  .map((item) => ({ value: item.id, label: item.label }))
  .sort((left, right) => left.label.localeCompare(right.label, 'pt-BR', { sensitivity: 'base' }))

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

export const inferOptionSyncForTemplate = (templateId, values = {}) => {
  const optionForm = getStrategyOptionForm(templateId)
  const options = normalizeOptionEntries(values?.options, optionForm)
  const hasOptionEditor = Boolean(optionForm?.enabled)
  const hasOptionInput = hasMeaningfulOptionInput(options)
  const specs = buildOptionLegSpecs(options, { baseQuantity: values?.stockQuantity })
  const hasDerivativeLegs = specs.some((leg) => leg.optionType === 'CALL' || leg.optionType === 'PUT')

  const patch = {}
  const warnings = []
  const patchPercent = (key, value) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return
    patch[key] = toInputPercent(numeric)
  }

  if (!hasOptionEditor) {
    return {
      templateId,
      mode: 'template',
      narrativeMode: 'template',
      warnings: [],
      appliedPatch: {},
      hasOptionEditor: false,
      hasOptionInput: false,
      hasDerivativeLegs: false,
    }
  }

  if (!hasOptionInput) {
    return {
      templateId,
      mode: 'template',
      narrativeMode: 'template',
      warnings: [],
      appliedPatch: {},
      hasOptionEditor: true,
      hasOptionInput: false,
      hasDerivativeLegs,
    }
  }

  const highBarrierFromOptions = resolveHighBarrierFromOptionSpecs(specs)
  const lowBarrierFromOptions = resolveLowBarrierFromOptionSpecs(specs)
  const highCapFromOptions = resolveHighCapFromOptionEntries(options)
  const lowCapFromOptions = resolveLowCapFromOptionEntries(options)
  const callLongStrikePct = resolveStrikePctFromOptionEntries(options, 'CALL', 'long')
  const callShortStrikePct = resolveStrikePctFromOptionEntries(options, 'CALL', 'short')
  const putLongStrikePct = resolveStrikePctFromOptionEntries(options, 'PUT', 'long')
  const putLongStrikeVar = putLongStrikePct == null ? null : round2(putLongStrikePct - 100)
  const callLongStrikeVar = callLongStrikePct == null ? null : round2(callLongStrikePct - 100)
  const callShortStrikeVar = callShortStrikePct == null ? null : round2(callShortStrikePct - 100)
  const partialFromLowCap = lowCapFromOptions == null ? null : Math.abs(Math.min(lowCapFromOptions, 0))

  switch (templateId) {
    case 'put_spread':
      patchPercent('startDownPct', putLongStrikeVar)
      patchPercent('limitDownPct', lowCapFromOptions)
      if (putLongStrikeVar != null && lowCapFromOptions != null && putLongStrikeVar <= lowCapFromOptions) {
        warnings.push('Opcao de put spread com strikes invertidos; texto em modo payoff.')
      }
      break
    case 'call_spread':
      patchPercent('startUpPct', callLongStrikeVar)
      patchPercent('limitUpPct', highCapFromOptions)
      if (callLongStrikeVar != null && highCapFromOptions != null && callLongStrikeVar >= highCapFromOptions) {
        warnings.push('Opcao de call spread com strikes invertidos; texto em modo payoff.')
      }
      break
    case 'collar_ui':
      patchPercent('protectionPct', putLongStrikePct == null ? null : clamp(putLongStrikePct, 0, 100))
      patchPercent('barrierUpPct', highBarrierFromOptions)
      patchPercent('capAfterPct', highCapFromOptions)
      if (highBarrierFromOptions == null) warnings.push('Nao foi possivel inferir barreira de alta nas opcoes.')
      break
    case 'collar':
      patchPercent('protectionPct', putLongStrikePct == null ? null : clamp(putLongStrikePct, 0, 100))
      patchPercent('highCapPct', highCapFromOptions)
      if (highCapFromOptions == null) warnings.push('Nao foi possivel inferir limitador de alta nas opcoes.')
      break
    case 'fence_ui':
      patchPercent('partialProtectionPct', partialFromLowCap)
      patchPercent('barrierUpPct', highBarrierFromOptions)
      patchPercent('capAfterPct', highCapFromOptions)
      if (highBarrierFromOptions == null) warnings.push('Nao foi possivel inferir barreira de alta nas opcoes.')
      break
    case 'booster_ko':
      patchPercent('triggerUpPct', callLongStrikeVar)
      patchPercent('barrierUpPct', highBarrierFromOptions)
      patchPercent('capAfterPct', highCapFromOptions)
      if (highBarrierFromOptions == null) warnings.push('Nao foi possivel inferir KO de alta nas opcoes.')
      break
    case 'collar_ui_bidirecional':
      patchPercent('protectionPct', putLongStrikePct == null ? null : clamp(putLongStrikePct, 0, 100))
      patchPercent('barrierUpPct', highBarrierFromOptions)
      patchPercent('capAfterPct', highCapFromOptions)
      patchPercent('downKoPct', lowBarrierFromOptions == null ? null : Math.abs(lowBarrierFromOptions))
      if (highBarrierFromOptions == null || lowBarrierFromOptions == null) {
        warnings.push('Nao foi possivel inferir todas as barreiras da estrutura pelas opcoes.')
      }
      break
    case 'doc_bidirecional':
      patchPercent('highKoPct', highBarrierFromOptions)
      patchPercent('couponPct', callShortStrikeVar)
      patchPercent('downKoPct', lowBarrierFromOptions == null ? null : Math.abs(lowBarrierFromOptions))
      if (highBarrierFromOptions == null || lowBarrierFromOptions == null) {
        warnings.push('Nao foi possivel inferir todas as barreiras do DOC pelas opcoes.')
      }
      break
    case 'rubi':
    case 'rubi_black': {
      const fallbackCoupon = pct(values?.couponPct, 8, -100, 300)
      const fallbackBarrierAbs = pct(values?.downBarrierPct, 20, 0, 95)
      const optionConfig = resolveRubiConfigFromOptions(options, fallbackCoupon, fallbackBarrierAbs, values?.stockQuantity)
      patchPercent('couponPct', optionConfig.couponPct)
      patchPercent('downBarrierPct', optionConfig.downBarrierAbsPct)
      warnings.push(...(optionConfig.warnings || []))
      break
    }
    case 'smart_coupon': {
      const fallbackCoupon = pct(values?.couponPct, 6, -100, 300)
      const fallbackBarrierAbs = pct(values?.downBarrierPct, 10, 0, 95)
      const optionConfig = resolveRubiConfigFromOptions(options, fallbackCoupon, fallbackBarrierAbs, values?.stockQuantity)
      patchPercent('couponPct', optionConfig.couponPct)
      patchPercent('downBarrierPct', optionConfig.downBarrierAbsPct)
      warnings.push(...(optionConfig.warnings || []))
      break
    }
    case 'cupom_recorrente': {
      const fallbackCoupon = pct(values?.couponPct, 8, -100, 300)
      const fallbackBarrierAbs = pct(values?.downBarrierPct, 16.65, 0, 95)
      const optionConfig = resolveCouponConfigFromOptions(options, fallbackCoupon, fallbackBarrierAbs, values?.stockQuantity)
      patchPercent('couponPct', optionConfig.couponPct)
      patchPercent('downBarrierPct', optionConfig.downBarrierAbsPct)
      warnings.push(...(optionConfig.warnings || []))
      break
    }
    case 'alocacao_protegida':
    case 'alocacao_protegida_sob_custodia':
      patchPercent('upTriggerPct', callLongStrikeVar)
      patchPercent('downProtectionPct', putLongStrikeVar == null ? null : Math.abs(Math.min(putLongStrikeVar, 0)))
      break
    case 'financiamento':
    case 'financiamento_sob_custodia':
      patchPercent('highCapPct', highCapFromOptions)
      if (highCapFromOptions == null) warnings.push('Nao foi possivel inferir limitador de alta nas opcoes.')
      break
    default:
      break
  }

  let narrativeMode = 'template'
  if ((templateId === 'alocacao_protegida' || templateId === 'alocacao_protegida_sob_custodia' || templateId === 'pop') && hasDerivativeLegs) {
    narrativeMode = 'payoff'
  }
  const uniqueWarnings = unique(warnings)
  if (uniqueWarnings.length) {
    narrativeMode = 'payoff'
  }

  return {
    templateId,
    mode: narrativeMode,
    narrativeMode,
    warnings: uniqueWarnings,
    appliedPatch: { ...patch },
    hasOptionEditor: true,
    hasOptionInput: true,
    hasDerivativeLegs,
  }
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
      optionSync: {
        templateId,
        mode: 'template',
        narrativeMode: 'template',
        warnings: [],
        appliedPatch: {},
      },
    }
  }
  const merged = { ...template.defaults, ...(values || {}) }
  merged.options = normalizeOptionEntries(merged.options, optionForm)
  const optionSync = inferOptionSyncForTemplate(templateId, merged)
  const patchedValues = {
    ...merged,
    ...(optionSync?.appliedPatch || {}),
  }
  const model = template.build(patchedValues, template)
  const optionValidations = validateOptionEntries(patchedValues.options, optionForm)
  const syncWarnings = Array.isArray(optionSync?.warnings) ? optionSync.warnings : []
  const validations = unique([...(model.validations || []), ...optionValidations, ...syncWarnings])
  const maturityMetric = (Array.isArray(model?.metrics) ? model.metrics : [])
    .find((metric) => String(metric?.label || '').toLowerCase().includes('vencimento'))?.value
  const generatedMessage = optionSync?.narrativeMode === 'payoff'
    ? buildPayoffFallbackMessage({
      templateLabel: model.templateLabel,
      tickerLabel: ticker(patchedValues?.ticker),
      maturityLabel: maturityMetric || fmtDate(patchedValues?.maturityDate),
      highlights: model.highlights,
    })
    : model.generatedMessage
  return {
    ...model,
    generatedMessage,
    optionForm,
    optionEntries: patchedValues.options,
    validations,
    optionSync,
  }
}
