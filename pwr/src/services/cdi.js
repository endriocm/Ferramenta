import { apiFetch } from './apiBase'
import { hydrateLocalStorage, persistLocalStorage } from './nativeStorage'

const CACHE_KEY = 'pwr.cdi.cache'
const CACHE_TTL = 30 * 60 * 1000
const DEFAULT_ANNUAL_CDI_PCT = 12

let memoryCache = null
let persistentLoaded = false
let persistentCache = null

const now = () => Date.now()

const toFiniteNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const normalizeSnapshot = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const annualPct = toFiniteNumber(raw.annualPct)
  if (!Number.isFinite(annualPct)) return null
  const monthlyFromPayload = toFiniteNumber(raw.monthlyPct)
  const monthlyPct = Number.isFinite(monthlyFromPayload)
    ? monthlyFromPayload
    : annualPct / 12
  return {
    annualPct: round(annualPct, 4),
    monthlyPct: round(monthlyPct, 4),
    source: raw.source ? String(raw.source) : 'manual',
    asOf: raw.asOf ? String(raw.asOf) : null,
  }
}

const normalizeCacheEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null
  const snapshot = normalizeSnapshot(entry.snapshot || entry)
  if (!snapshot) return null
  const timestamp = Number(entry.timestamp || 0)
  return {
    snapshot,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : now(),
  }
}

const isFresh = (entry) => {
  if (!entry) return false
  return now() - entry.timestamp <= CACHE_TTL
}

const readBrowserCache = () => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return normalizeCacheEntry(JSON.parse(raw))
  } catch {
    return null
  }
}

const writeBrowserCache = (entry) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // noop
  }
}

const loadPersistentCache = async () => {
  if (persistentLoaded) return persistentCache
  persistentLoaded = true
  try {
    const loaded = await hydrateLocalStorage([CACHE_KEY])
    persistentCache = normalizeCacheEntry(loaded?.[CACHE_KEY]) || readBrowserCache()
  } catch {
    persistentCache = readBrowserCache()
  }
  return persistentCache
}

const persistCache = (entry) => {
  memoryCache = entry
  persistentCache = entry
  writeBrowserCache(entry)
  void persistLocalStorage(CACHE_KEY, entry)
}

const parseApiError = async (response) => {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const status = payload?.status || response.status
  const detail = payload?.error || payload?.message || 'Falha ao buscar CDI'
  const error = new Error(detail)
  error.status = status
  error.payload = payload
  return error
}

const getCachedSnapshot = async ({ allowStale = false } = {}) => {
  if (memoryCache) {
    if (isFresh(memoryCache)) {
      return { ...memoryCache.snapshot, cached: true, stale: false }
    }
    if (allowStale) {
      return { ...memoryCache.snapshot, cached: true, stale: true }
    }
  }

  const persisted = await loadPersistentCache()
  if (!persisted) return null
  if (isFresh(persisted)) {
    memoryCache = persisted
    return { ...persisted.snapshot, cached: true, stale: false }
  }
  if (allowStale) {
    memoryCache = persisted
    return { ...persisted.snapshot, cached: true, stale: true }
  }
  return null
}

export const fetchCdiSnapshot = async ({ force = false } = {}) => {
  if (!force) {
    const cached = await getCachedSnapshot()
    if (cached) return cached
  }

  try {
    const response = await apiFetch('/api/cdi', {}, { retries: 2, backoffMs: 500, timeoutMs: 8000 })
    if (!response.ok) {
      throw await parseApiError(response)
    }
    const payload = await response.json()
    const snapshot = normalizeSnapshot(payload)
    if (!snapshot) throw new Error('Resposta invalida de CDI')

    const entry = { snapshot, timestamp: now() }
    persistCache(entry)
    return { ...snapshot, cached: false, stale: false }
  } catch (error) {
    const stale = await getCachedSnapshot({ allowStale: true })
    if (stale) {
      return { ...stale, offline: true, stale: true }
    }
    throw error
  }
}

export const getDefaultCdiAnnualPct = () => DEFAULT_ANNUAL_CDI_PCT
