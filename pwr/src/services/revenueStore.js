import { persistLocalStorage } from './nativeStorage'
import { normalizeAssessorName } from '../utils/assessor'

const STORAGE_KEYS = {
  bovespa: 'pwr.receita.bovespa',
  bmf: 'pwr.receita.bmf',
  manual: 'pwr.receita.manual',
}
const rawCache = new Map()

const normalizeTypeKey = (type) => {
  const key = String(type || '').trim().toLowerCase()
  if (key === 'bovespa') return 'bovespa'
  if (key === 'bmf') return 'bmf'
  if (key === 'estruturadas' || key === 'estruturada') return 'estruturadas'
  return key
}

const safeParse = (raw) => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const normalizeRevenueEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return entry
  const current = String(entry.assessor || '').trim()
  const normalized = normalizeAssessorName(current)
  if (normalized === current) return entry
  return {
    ...entry,
    assessor: normalized,
  }
}

const normalizeRevenueEntries = (entries) => {
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => normalizeRevenueEntry(entry))
}

const readCachedEntries = (key) => {
  if (!key) return []
  const raw = localStorage.getItem(key)
  if (!raw) {
    rawCache.delete(key)
    return []
  }
  const cached = rawCache.get(key)
  if (cached?.raw === raw) return cached.entries
  const entries = normalizeRevenueEntries(safeParse(raw))
  rawCache.set(key, { raw, entries })
  return entries
}

export const loadRevenueList = (type) => {
  const key = STORAGE_KEYS[normalizeTypeKey(type)]
  if (!key) return []
  return readCachedEntries(key)
}

export const saveRevenueList = (type, entries) => {
  const key = STORAGE_KEYS[normalizeTypeKey(type)]
  if (!key) return
  const normalizedEntries = normalizeRevenueEntries(entries || [])
  try {
    const raw = JSON.stringify(normalizedEntries)
    localStorage.setItem(key, raw)
    rawCache.set(key, { raw, entries: normalizedEntries })
    window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
  } catch {
    // noop
  }
  void persistLocalStorage(key, normalizedEntries)
}

export const loadManualRevenue = () => loadRevenueList('manual')

export const appendManualRevenue = (entry) => {
  const current = loadManualRevenue()
  const next = [entry, ...current]
  saveRevenueList('manual', next)
  return next
}

export const removeManualRevenue = (id) => {
  if (!id) return loadManualRevenue()
  const current = loadManualRevenue()
  const next = current.filter((item) => item.id !== id)
  saveRevenueList('manual', next)
  return next
}

export const loadRevenueByType = (type) => {
  const normalized = normalizeTypeKey(type)
  if (normalized === 'estruturadas') return []
  const entries = loadRevenueList(normalized)
  const manual = loadManualRevenue().filter((item) => normalizeTypeKey(item.origem) === normalized)
  return [...entries, ...manual]
}

export const loadAllRevenues = () => {
  const manual = loadManualRevenue()
  return {
    bovespa: loadRevenueList('bovespa'),
    bmf: loadRevenueList('bmf'),
    manual,
  }
}
