import { normalizeDateKey } from '../utils/dateKey'
import { apiFetch } from './apiBase'

const CACHE_TTL_MS = 5 * 60 * 1000
const requestCache = new Map()

/**
 * Module-level snapshot — survives component unmount/remount so the page
 * can render last data immediately.
 */
let _lastDividendsSnapshot = null

export const getLastDividendsSnapshot = () => _lastDividendsSnapshot

export const setLastDividendsSnapshot = (snapshot) => {
  _lastDividendsSnapshot = snapshot
}

const emptyPayload = (from = '', to = '', generatedAt = '') => ({
  items: [],
  undated: [],
  errors: [],
  summary: {
    from,
    to,
    totalMonths: 0,
    totalTypes: 0,
    scheduledCount: 0,
    undatedCount: 0,
    errorCount: 0,
  },
  generatedAt,
})

const buildCacheKey = (from, to) => {
  const safeFrom = normalizeDateKey(from)
  const safeTo = normalizeDateKey(to)
  if (!safeFrom || !safeTo) return ''
  return `${safeFrom}|${safeTo}`
}

const parseApiError = async (response) => {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return new Error(payload?.error || payload?.message || `Falha HTTP ${response.status}`)
}

export const fetchDividendsCalendar = async ({
  from = '',
  to = '',
  force = false,
} = {}) => {
  const safeFrom = normalizeDateKey(from)
  const safeTo = normalizeDateKey(to)
  if (!safeFrom || !safeTo || safeFrom > safeTo) {
    const empty = emptyPayload(safeFrom, safeTo, new Date().toISOString())
    _lastDividendsSnapshot = empty
    return empty
  }

  const cacheKey = buildCacheKey(safeFrom, safeTo)
  const cached = cacheKey ? requestCache.get(cacheKey) : null
  if (!force && cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
    _lastDividendsSnapshot = cached.payload
    return cached.payload
  }

  const params = new URLSearchParams({
    from: safeFrom,
    to: safeTo,
  })
  const response = await apiFetch(`/api/dividends-calendar?${params.toString()}`, {}, {
    retries: 1,
    backoffMs: 500,
    timeoutMs: 30000,
  })
  if (!response.ok) {
    throw await parseApiError(response)
  }

  const payloadRaw = await response.json()
  const payload = {
    items: Array.isArray(payloadRaw?.items) ? payloadRaw.items : [],
    undated: Array.isArray(payloadRaw?.undated) ? payloadRaw.undated : [],
    errors: Array.isArray(payloadRaw?.errors) ? payloadRaw.errors : [],
    summary: payloadRaw?.summary || emptyPayload(safeFrom, safeTo).summary,
    generatedAt: String(payloadRaw?.generatedAt || ''),
  }

  if (cacheKey) {
    requestCache.set(cacheKey, {
      at: Date.now(),
      payload,
    })
  }

  _lastDividendsSnapshot = payload
  return payload
}

