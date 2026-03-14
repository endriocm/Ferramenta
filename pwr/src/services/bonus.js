import { normalizeDateKey } from '../utils/dateKey.js'
import { apiFetch } from './apiBase.js'

const CACHE_TTL = 30 * 60 * 1000
const cache = new Map()
const inflight = new Map()

const normalizeTicker = (ticker) => String(ticker || '').trim().toUpperCase()

const cacheGet = (key) => {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return entry.value
}

const cacheSet = (key, value) => {
  cache.set(key, { value, timestamp: Date.now() })
  return value
}

const normalizeRequest = (request) => {
  const ticker = normalizeTicker(request?.ticker)
  const from = normalizeDateKey(request?.from)
  const to = normalizeDateKey(request?.to)
  if (!ticker || !from || !to) return null
  return { ticker, from, to }
}

const resolveEventFactor = (event) => {
  const factor = Number(event?.factor)
  if (Number.isFinite(factor) && factor > 0) return factor
  const proportionPct = Number(event?.proportionPct)
  if (Number.isFinite(proportionPct)) return 1 + (proportionPct / 100)
  return 1
}

export const buildBonusKey = (ticker, from, to) => {
  const keyTicker = normalizeTicker(ticker)
  const keyFrom = normalizeDateKey(from)
  const keyTo = normalizeDateKey(to)
  if (!keyTicker || !keyFrom || !keyTo) return ''
  return `${keyTicker}|${keyFrom}|${keyTo}`
}

export const computeBonusFactor = (events) => {
  if (!Array.isArray(events) || !events.length) return 1
  return events.reduce((product, event) => product * resolveEventFactor(event), 1)
}

export const inferBonusQuantities = (currentQty, events) => {
  const current = Number(currentQty)
  const factor = computeBonusFactor(events)
  if (!Number.isFinite(current) || current <= 0 || factor <= 1) {
    return {
      canInfer: false,
      currentQty: Number.isFinite(current) ? current : 0,
      qtyBase: null,
      qtyBonus: 0,
      factor,
      totalPct: (factor - 1) * 100,
    }
  }
  const rawBase = current / factor
  const roundedBase = Math.round(rawBase)
  if (!Number.isFinite(roundedBase) || roundedBase <= 0 || Math.abs(rawBase - roundedBase) > 0.000001) {
    return {
      canInfer: false,
      currentQty: current,
      qtyBase: null,
      qtyBonus: 0,
      factor,
      totalPct: (factor - 1) * 100,
    }
  }
  const qtyBonus = Math.max(0, current - roundedBase)
  return {
    canInfer: qtyBonus > 0,
    currentQty: current,
    qtyBase: roundedBase,
    qtyBonus,
    factor,
    totalPct: (factor - 1) * 100,
  }
}

export const fetchBonusesBatch = async (requests) => {
  if (!Array.isArray(requests) || !requests.length) return []
  const normalized = requests.map(normalizeRequest).filter(Boolean)
  if (!normalized.length) return []
  const uniqueMap = new Map()
  normalized.forEach((req) => {
    const key = buildBonusKey(req.ticker, req.from, req.to)
    if (!uniqueMap.has(key)) uniqueMap.set(key, { key, ...req })
  })
  const cachedResults = []
  const pending = []
  for (const entry of uniqueMap.values()) {
    const cached = cacheGet(entry.key)
    if (cached) cachedResults.push(cached)
    else pending.push(entry)
  }
  if (!pending.length) return cachedResults
  const response = await apiFetch('/api/bonus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: pending.map(({ ticker, from, to }) => ({ ticker, from, to })), includeEvents: true }),
  }, { retries: 1, backoffMs: 500, timeoutMs: 12000 })
  if (!response.ok) throw new Error('bonus-batch-failed')
  const payload = await response.json()
  const results = Array.isArray(payload?.results) ? payload.results : []
  results.forEach((item) => {
    if (item?.key) cacheSet(item.key, item)
  })
  return [...cachedResults, ...results]
}

export const fetchBonus = async ({ ticker, from, to }) => {
  const normalized = normalizeRequest({ ticker, from, to })
  if (!normalized) return null
  const key = buildBonusKey(normalized.ticker, normalized.from, normalized.to)
  const cached = cacheGet(key)
  if (cached) return cached
  if (inflight.has(key)) return inflight.get(key)
  const params = new URLSearchParams({
    ticker: normalized.ticker,
    from: normalized.from,
    to: normalized.to,
    includeEvents: '1',
  })
  const promise = apiFetch(`/api/bonus?${params.toString()}`, {}, { retries: 2, backoffMs: 400, timeoutMs: 8000 })
    .then((response) => {
      if (!response.ok) throw new Error('bonus-fetch-failed')
      return response.json()
    })
    .then((payload) => {
      if (payload?.key) cacheSet(payload.key, payload)
      return payload
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

export const clearBonusCache = () => {
  cache.clear()
  inflight.clear()
}
