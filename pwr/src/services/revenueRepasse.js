import { normalizeDateKey } from '../utils/dateKey'
import { persistLocalStorage } from './nativeStorage'

const STORAGE_KEY = 'pwr.receita.repasse.v1'

const DEFAULT_RATES = {
  bovespa: Number((0.9335 * 0.8285).toFixed(6)),
  bmf: Number((0.9435 * 0.8285).toFixed(6)),
  estruturadas: 1,
}

const createEmptyConfig = () => ({
  bovespa: {},
  bmf: {},
  estruturadas: {},
})

let rawCache = null
let parsedCache = createEmptyConfig()

const toRounded = (value, digits = 6) => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const normalizeModuleKey = (value) => {
  const key = String(value || '').trim().toLowerCase()
  if (key === 'bovespa' || key === 'bmf' || key === 'estruturadas') return key
  if (key === 'estruturada') return 'estruturadas'
  return ''
}

const normalizeMonthKey = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}$/.test(raw)) return raw
  const normalizedDate = normalizeDateKey(raw)
  return normalizedDate ? normalizedDate.slice(0, 7) : ''
}

const parseRate = (value) => {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  let text = String(value).trim()
  if (!text) return null
  text = text.replace(/\s+/g, '')
  const hasComma = text.includes(',')
  const hasDot = text.includes('.')
  if (hasComma && hasDot) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.')
    } else {
      text = text.replace(/,/g, '')
    }
  } else if (hasComma) {
    text = text.replace(/\./g, '').replace(',', '.')
  } else {
    text = text.replace(/,/g, '')
  }
  text = text.replace(/[^0-9.-]/g, '')
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

const sanitizeRate = (value) => {
  const parsed = parseRate(value)
  if (!(parsed > 0)) return null
  return toRounded(parsed, 6)
}

const sanitizeConfig = (value) => {
  const next = createEmptyConfig()
  const source = value && typeof value === 'object' ? value : {}
  ;['bovespa', 'bmf', 'estruturadas'].forEach((moduleKey) => {
    const bucket = source[moduleKey]
    if (!bucket || typeof bucket !== 'object') return
    Object.entries(bucket).forEach(([month, rate]) => {
      const monthKey = normalizeMonthKey(month)
      const parsed = sanitizeRate(rate)
      if (!monthKey || parsed == null) return
      next[moduleKey][monthKey] = parsed
    })
  })
  return next
}

const loadRawConfig = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      rawCache = null
      parsedCache = createEmptyConfig()
      return parsedCache
    }
    if (raw === rawCache) return parsedCache
    const parsed = JSON.parse(raw)
    const sanitized = sanitizeConfig(parsed)
    rawCache = raw
    parsedCache = sanitized
    return sanitized
  } catch {
    rawCache = null
    parsedCache = createEmptyConfig()
    return parsedCache
  }
}

const saveConfig = (config) => {
  const sanitized = sanitizeConfig(config)
  try {
    const raw = JSON.stringify(sanitized)
    localStorage.setItem(STORAGE_KEY, raw)
    rawCache = raw
    parsedCache = sanitized
  } catch {
    // noop
  }
  void persistLocalStorage(STORAGE_KEY, sanitized)
  window.dispatchEvent(new CustomEvent('pwr:repasse-updated', { detail: { config: sanitized } }))
}

const resolveEntryMonth = (entry) => {
  const date = normalizeDateKey(entry?.data || entry?.dataEntrada || entry?.vencimento)
  return date ? date.slice(0, 7) : ''
}

const toSafeNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const inferRateFromEntry = (moduleKey, entry, base) => {
  if (!(base > 0)) return null
  const explicit = sanitizeRate(entry?.repasse)
  if (explicit != null) return explicit
  if (moduleKey === 'estruturadas') {
    const liquid = toSafeNumber(entry?.comissao ?? entry?.receita ?? entry?.valor)
    if (Number.isFinite(liquid)) {
      const inferred = sanitizeRate(liquid / base)
      if (inferred != null) return inferred
    }
    return null
  }
  const liquid = toSafeNumber(entry?.receita ?? entry?.valor)
  if (Number.isFinite(liquid)) {
    const inferred = sanitizeRate(liquid / base)
    if (inferred != null) return inferred
  }
  return null
}

const resolveRateForEntry = (moduleKey, entry, base) => {
  const monthKey = resolveEntryMonth(entry)
  const configured = monthKey ? getRepasseRate(moduleKey, monthKey, null) : null
  if (configured != null) return configured
  const inferred = inferRateFromEntry(moduleKey, entry, base)
  if (inferred != null) return inferred
  return DEFAULT_RATES[moduleKey] || 1
}

export const getRepasseConfig = () => loadRawConfig()

export const getRepasseConfigSignature = (moduleKey = '') => {
  const config = loadRawConfig()
  const key = normalizeModuleKey(moduleKey)
  if (!key) return JSON.stringify(config)
  return JSON.stringify(config[key] || {})
}

export const getRepasseRate = (moduleKey, monthKey, fallback = null) => {
  const normalizedModule = normalizeModuleKey(moduleKey)
  const normalizedMonth = normalizeMonthKey(monthKey)
  if (!normalizedModule || !normalizedMonth) {
    const parsedFallback = sanitizeRate(fallback)
    if (parsedFallback != null) return parsedFallback
    return fallback == null ? null : DEFAULT_RATES[normalizedModule] || 1
  }
  const config = loadRawConfig()
  const configured = sanitizeRate(config?.[normalizedModule]?.[normalizedMonth])
  if (configured != null) return configured
  const parsedFallback = sanitizeRate(fallback)
  if (parsedFallback != null) return parsedFallback
  return fallback == null ? null : DEFAULT_RATES[normalizedModule] || 1
}

export const setRepasseRate = (moduleKey, monthKey, rate) => {
  const normalizedModule = normalizeModuleKey(moduleKey)
  const normalizedMonth = normalizeMonthKey(monthKey)
  const normalizedRate = sanitizeRate(rate)
  if (!normalizedModule || !normalizedMonth || normalizedRate == null) return false
  const config = loadRawConfig()
  const next = sanitizeConfig(config)
  next[normalizedModule][normalizedMonth] = normalizedRate
  saveConfig(next)
  return true
}

export const parseRepasseInput = (value) => sanitizeRate(value)

export const applyRepasseToRevenueEntries = (entries, moduleKey) => {
  const normalizedModule = normalizeModuleKey(moduleKey)
  if (normalizedModule !== 'bovespa' && normalizedModule !== 'bmf') return Array.isArray(entries) ? entries : []
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const base = toSafeNumber(entry?.receitaBrutaBase ?? entry?.corretagem ?? entry?.receita ?? 0)
    const rate = resolveRateForEntry(normalizedModule, entry, base)
    const receita = toRounded(base * rate, 6)
    return {
      ...entry,
      receitaBrutaBase: toRounded(base, 6),
      repasse: toRounded(rate, 6),
      receita,
    }
  })
}

export const applyRepasseToStructuredEntries = (entries) => {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const base = toSafeNumber(entry?.comissaoBaseBruta ?? entry?.comissao ?? entry?.receita ?? entry?.valor ?? 0)
    const rate = resolveRateForEntry('estruturadas', entry, base)
    const comissao = toRounded(base * rate, 6)
    return {
      ...entry,
      comissaoBaseBruta: toRounded(base, 6),
      repasse: toRounded(rate, 6),
      comissao,
    }
  })
}

export const listRepasseMonths = (entries) => {
  const months = new Set()
  ;(Array.isArray(entries) ? entries : []).forEach((entry) => {
    const monthKey = resolveEntryMonth(entry)
    if (monthKey) months.add(monthKey)
  })
  return Array.from(months).sort()
}
