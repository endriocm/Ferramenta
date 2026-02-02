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

const normalizeOverride = (override) => {
  const base = {
    high: 'auto',
    low: 'auto',
    manualCouponBRL: null,
    manualCouponPct: null,
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
  const legacyRaw = merged.manualCouponPct ?? merged.cupomManual ?? merged.cupomManualPct
  const legacy = legacyRaw != null && String(legacyRaw).trim() !== '' ? String(legacyRaw).trim() : null

  return {
    high: normalizeBarrierValue(merged.high),
    low: normalizeBarrierValue(merged.low),
    manualCouponBRL: manualCouponBRL != null ? manualCouponBRL : null,
    manualCouponPct: legacy,
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
