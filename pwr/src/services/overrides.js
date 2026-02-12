import { normalizeDateKey } from '../utils/dateKey.js'

const STORAGE_PREFIX = 'pwr.vencimento.overrides.'
const LEGACY_KEY = 'pwr.vencimento.overrides'

const buildKey = (userKey) => `${STORAGE_PREFIX}${userKey}`

const parseNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeOptionSide = (value) => {
  if (value == null) return null
  const raw = String(value).trim().toUpperCase()
  if (!raw) return null
  if (raw === 'CALL' || raw === 'PUT') return raw
  return null
}

const normalizeDateOverride = (value) => {
  if (value == null) return null
  const normalized = normalizeDateKey(String(value).trim())
  return normalized || null
}

const normalizeBarrierType = (value, directionHint = null) => {
  if (value == null) return null
  const raw = String(value).trim().toUpperCase()
  if (!raw || raw === 'AUTO') return null
  if (raw === 'NONE' || raw === 'SEM BARREIRA' || raw === 'SEM_BARRERA' || raw === 'NO_BARRIER') return 'NONE'

  if (raw === 'UI' || raw === 'UO' || raw === 'KI' || raw === 'KO') return raw
  if (raw === 'DI') return 'KI'
  if (raw === 'DO') return 'KO'

  const isUp = raw.includes('UP') || raw.startsWith('U')
  const isDown = raw.includes('DOWN') || raw.startsWith('D')
  const isOut = raw.includes('OUT') || raw.includes('KNOCK-OUT') || raw.includes('KNOCKOUT') || raw.endsWith('O')
  const isIn = raw.includes('IN') || raw.includes('KNOCK-IN') || raw.includes('KNOCKIN') || raw.endsWith('I')

  if (isUp && isOut) return 'UO'
  if (isUp && isIn) return 'UI'
  if (isDown && isOut) return 'KO'
  if (isDown && isIn) return 'KI'

  if (raw === 'OUT' || isOut) return directionHint === 'high' ? 'UO' : 'KO'
  if (raw === 'IN' || isIn) return directionHint === 'high' ? 'UI' : 'KI'
  return null
}

const normalizeLegsOverride = (legs) => {
  if (!legs || typeof legs !== 'object') return null
  const next = Object.keys(legs).reduce((acc, key) => {
    const value = legs[key]
    if (!value || typeof value !== 'object') return acc
    const structure = value.structure && typeof value.structure === 'object' ? value.structure : null
    const strikeOverride = parseNumber(value.strikeOverride ?? value.strike ?? structure?.strike)
    const optionQtyOverride = parseNumber(value.optionQtyOverride ?? value.optionQty ?? value.quantidadeOpcaoOverride ?? structure?.optionQty ?? structure?.qty)
    const optionExpiryDateOverride = normalizeDateOverride(
      value.optionExpiryDateOverride
      ?? value.optionExpiryDate
      ?? value.vencimentoOpcaoOverride
      ?? value.vencimentoOpcao
      ?? structure?.optionExpiryDate
      ?? structure?.vencimentoOpcao,
    )
    const barrierValueOverride = parseNumber(
      value.barrierValueOverride ?? value.barreiraValorOverride ?? structure?.barrierValue ?? structure?.barreiraValor,
    )
    const barrierTypeOverride = normalizeBarrierType(
      value.barrierTypeOverride ?? value.barreiraTipoOverride ?? structure?.barrierType ?? structure?.tipoBarreira,
    )
    const optionSide = normalizeOptionSide(value.optionSide ?? value.tipo ?? value.optionType ?? structure?.target?.side ?? structure?.side)
    const legKeyRaw = value.legKey ?? structure?.target?.legKey
    const legKey = legKeyRaw != null && String(legKeyRaw).trim() !== '' ? String(legKeyRaw).trim() : String(key)
    if (
      strikeOverride == null
      && optionQtyOverride == null
      && optionExpiryDateOverride == null
      && barrierValueOverride == null
      && barrierTypeOverride == null
      && optionSide == null
    ) return acc
    acc[key] = {
      optionQtyOverride: optionQtyOverride != null ? optionQtyOverride : null,
      optionExpiryDateOverride,
      strikeOverride: strikeOverride != null ? strikeOverride : null,
      barrierValueOverride: barrierValueOverride != null ? barrierValueOverride : null,
      barrierTypeOverride: barrierTypeOverride != null ? barrierTypeOverride : null,
      optionSide,
      legKey,
      structure: {
        target: {
          side: optionSide || null,
          legKey,
        },
        optionQty: optionQtyOverride != null ? optionQtyOverride : null,
        optionExpiryDate: optionExpiryDateOverride || null,
        strike: strikeOverride != null ? strikeOverride : null,
        barrierType: barrierTypeOverride || 'auto',
        barrierValue: barrierValueOverride != null ? barrierValueOverride : null,
      },
    }
    return acc
  }, {})
  return Object.keys(next).length ? next : null
}

const normalizeOverride = (override) => {
  const rawOverride = override && typeof override === 'object' ? override : {}
  const hasSchemaVersion = Object.prototype.hasOwnProperty.call(rawOverride, 'schemaVersion')
  const base = {
    schemaVersion: 2,
    high: 'auto',
    low: 'auto',
    manualCouponBRL: null,
    manualCouponPct: null,
    manualOptionsGainBRL: null,
    optionQtyOverride: null,
    optionExpiryDateOverride: null,
    strikeOverride: null,
    barrierValueOverride: null,
    barrierTypeOverride: null,
    optionSide: null,
    legKey: null,
    legacyBarrierType: false,
    structure: null,
    structureByLeg: null,
    legs: null,
    qtyBonus: 0,
    bonusDate: '',
    bonusNote: '',
  }
  const merged = { ...base, ...(override || {}) }
  const normalizeBarrierValue = (value) => {
    const raw = String(value || '').trim().toLowerCase()
    if (!raw || raw === 'auto') return 'auto'
    if (raw === 'force_hit' || raw === 'forcar_bateu' || raw === 'hit') return 'hit'
    if (raw === 'force_miss' || raw === 'forcar_nao_bateu' || raw === 'nohit' || raw === 'miss') return 'nohit'
    return value
  }
  const manualCouponBRL = parseNumber(merged.manualCouponBRL ?? merged.manualCouponBrl)
  const manualOptionsGainBRL = parseNumber(merged.manualOptionsGainBRL ?? merged.manualOptionsGainBrl)
  const structureInput = merged.structure && typeof merged.structure === 'object' ? merged.structure : null
  const structureSide = normalizeOptionSide(structureInput?.target?.side ?? structureInput?.side ?? structureInput?.optionSide)
  const structureLegKeyRaw = structureInput?.target?.legKey ?? structureInput?.legKey
  const structureLegKey = structureLegKeyRaw != null && String(structureLegKeyRaw).trim() !== ''
    ? String(structureLegKeyRaw).trim()
    : null
  const optionQtyOverride = parseNumber(
    merged.optionQtyOverride ?? merged.optionQty ?? merged.quantidadeOpcaoOverride ?? structureInput?.optionQty ?? structureInput?.qty,
  )
  const optionExpiryDateOverride = normalizeDateOverride(
    merged.optionExpiryDateOverride
    ?? merged.optionExpiryDate
    ?? merged.vencimentoOpcaoOverride
    ?? merged.vencimentoOpcao
    ?? structureInput?.optionExpiryDate
    ?? structureInput?.vencimentoOpcao,
  )
  const strikeOverride = parseNumber(merged.strikeOverride ?? merged.strike ?? structureInput?.strike)
  const barrierValueOverride = parseNumber(
    merged.barrierValueOverride ?? merged.barreiraValorOverride ?? structureInput?.barrierValue ?? structureInput?.barreiraValor,
  )
  const barrierTypeOverride = normalizeBarrierType(
    merged.barrierTypeOverride ?? merged.barreiraTipoOverride ?? structureInput?.barrierType ?? structureInput?.tipoBarreira,
  )
  const optionSide = normalizeOptionSide(merged.optionSide ?? merged.optionType ?? structureSide)
  const legKeyRaw = merged.legKey ?? structureLegKey
  const legKey = legKeyRaw != null && String(legKeyRaw).trim() !== '' ? String(legKeyRaw).trim() : null
  const legs = normalizeLegsOverride(merged.legs ?? merged.structureByLeg)
  const structureByLeg = legs
    ? Object.keys(legs).reduce((acc, key) => {
      acc[key] = legs[key].structure
      return acc
    }, {})
    : null
  const legacyRaw = merged.manualCouponPct ?? merged.cupomManual ?? merged.cupomManualPct
  const legacy = legacyRaw != null && String(legacyRaw).trim() !== '' ? String(legacyRaw).trim() : null
  const legacyBarrierType = merged.legacyBarrierType === true
    || (
      !hasSchemaVersion
      && barrierTypeOverride != null
      && optionSide == null
      && legKey == null
      && !legs
    )
  const structure = (
    optionQtyOverride != null
    || optionExpiryDateOverride != null
    || strikeOverride != null
    || barrierValueOverride != null
    || barrierTypeOverride != null
    || optionSide != null
    || legKey != null
  )
    ? {
      target: {
        side: optionSide || null,
        legKey: legKey || null,
      },
      optionQty: optionQtyOverride != null ? optionQtyOverride : null,
      optionExpiryDate: optionExpiryDateOverride || null,
      strike: strikeOverride != null ? strikeOverride : null,
      barrierType: barrierTypeOverride || 'auto',
      barrierValue: barrierValueOverride != null ? barrierValueOverride : null,
    }
    : null

  return {
    schemaVersion: 2,
    high: normalizeBarrierValue(merged.high),
    low: normalizeBarrierValue(merged.low),
    manualCouponBRL: manualCouponBRL != null ? manualCouponBRL : null,
    manualCouponPct: legacy,
    manualOptionsGainBRL: manualOptionsGainBRL != null ? manualOptionsGainBRL : null,
    optionQtyOverride: optionQtyOverride != null ? optionQtyOverride : null,
    optionExpiryDateOverride,
    strikeOverride: strikeOverride != null ? strikeOverride : null,
    barrierValueOverride: barrierValueOverride != null ? barrierValueOverride : null,
    barrierTypeOverride: barrierTypeOverride != null ? barrierTypeOverride : null,
    optionSide,
    legKey,
    legacyBarrierType,
    structure,
    structureByLeg,
    legs,
    qtyBonus: Math.max(0, parseNumber(merged.qtyBonus) || 0),
    bonusDate: merged.bonusDate || '',
    bonusNote: merged.bonusNote || '',
  }
}

const normalizeOverridesMap = (overrides) => {
  if (!overrides || typeof overrides !== 'object') return {}
  return Object.keys(overrides).reduce((acc, key) => {
    acc[key] = normalizeOverride(overrides[key])
    return acc
  }, {})
}

export const loadOverrides = (userKey) => {
  if (!userKey) return {}
  let raw = null
  try {
    raw = localStorage.getItem(buildKey(userKey))
  } catch {
    raw = null
  }
  if (!raw) {
    try {
      raw = localStorage.getItem(LEGACY_KEY)
    } catch {
      raw = null
    }
    if (!raw) return {}
    try {
      const legacy = normalizeOverridesMap(JSON.parse(raw))
      localStorage.setItem(buildKey(userKey), JSON.stringify(legacy))
      localStorage.removeItem(LEGACY_KEY)
      return legacy
    } catch {
      return {}
    }
  }
  try {
    return normalizeOverridesMap(JSON.parse(raw))
  } catch {
    return {}
  }
}

export const saveOverrides = (userKey, overrides) => {
  if (!userKey) return
  const normalized = normalizeOverridesMap(overrides)
  localStorage.setItem(buildKey(userKey), JSON.stringify(normalized))
}

export const updateOverride = (overrides, id, next) => {
  return {
    ...overrides,
    [id]: normalizeOverride({ ...(overrides[id] || {}), ...next }),
  }
}

export const clearOverride = (overrides, id) => {
  const next = { ...overrides }
  delete next[id]
  return next
}
