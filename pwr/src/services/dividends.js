import { normalizeDateKey } from '../utils/dateKey'

const normalizeTicker = (ticker) => String(ticker || '').trim().toUpperCase()
const CACHE_TTL = 30 * 60 * 1000
const cache = new Map()
const inflight = new Map()

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

export const buildDividendKey = (ticker, from, to) => {
  const keyTicker = normalizeTicker(ticker)
  const keyFrom = normalizeDateKey(from)
  const keyTo = normalizeDateKey(to)
  if (!keyTicker || !keyFrom || !keyTo) return ''
  return `${keyTicker}|${keyFrom}|${keyTo}`
}

export const fetchDividendsBatch = async (requests) => {
  if (!Array.isArray(requests) || !requests.length) return []
  const normalized = requests.map(normalizeRequest).filter(Boolean)
  if (!normalized.length) return []
  const uniqueMap = new Map()
  normalized.forEach((req) => {
    const key = buildDividendKey(req.ticker, req.from, req.to)
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
  const response = await fetch('/api/dividends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: pending.map(({ ticker, from, to }) => ({ ticker, from, to })) }),
  })
  if (!response.ok) {
    throw new Error('dividends-batch-failed')
  }
  const payload = await response.json()
  const results = Array.isArray(payload?.results) ? payload.results : []
  results.forEach((item) => {
    if (item?.key) cacheSet(item.key, item)
  })
  return [...cachedResults, ...results]
}

export const fetchDividend = async ({ ticker, from, to }) => {
  const normalized = normalizeRequest({ ticker, from, to })
  if (!normalized) return null
  const key = buildDividendKey(normalized.ticker, normalized.from, normalized.to)
  const cached = cacheGet(key)
  if (cached) return cached
  if (inflight.has(key)) return inflight.get(key)
  const params = new URLSearchParams({
    ticker: normalized.ticker,
    from: normalized.from,
    to: normalized.to,
  })
  const promise = fetch(`/api/dividends?${params.toString()}`)
    .then((response) => {
      if (!response.ok) throw new Error('dividends-fetch-failed')
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
