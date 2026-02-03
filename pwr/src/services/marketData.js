import { fetchWithRetry } from './network'
import { persistLocalStorage, hydrateLocalStorage } from './nativeStorage'

const CACHE_TTL = 5 * 60 * 1000
const marketCache = new Map()
let persistentLoaded = false
let persistentCache = {}

const cacheKey = (symbol, start, end) => `${symbol}:${start}:${end}`

const getCached = async (key, { allowStale = false } = {}) => {
  const item = marketCache.get(key)
  if (item) {
    if (Date.now() - item.timestamp > CACHE_TTL) {
      marketCache.delete(key)
    } else {
      return { ...item.data, cached: true }
    }
  }

  if (!persistentLoaded) {
    try {
      const data = await hydrateLocalStorage(['pwr.market.cache'])
      if (data['pwr.market.cache']) persistentCache = data['pwr.market.cache']
    } catch {
      // noop
    }
    persistentLoaded = true
  }

  const persisted = persistentCache[key]
  if (!persisted) return null
  if (!allowStale && Date.now() - persisted.timestamp > CACHE_TTL) return null
  return { ...persisted.data, cached: true, stale: allowStale }
}

const setCached = (key, data) => {
  marketCache.set(key, { data, timestamp: Date.now() })
  persistentCache[key] = { data, timestamp: Date.now() }
  void persistLocalStorage('pwr.market.cache', persistentCache)
  return data
}

const parseApiError = async (response) => {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const status = payload?.status || response.status
  const provider = payload?.source || payload?.provider || 'desconhecido'
  const detail = payload?.error || payload?.message || 'Falha ao buscar cotacao'
  const error = new Error(detail)
  error.status = status
  error.provider = provider
  error.detail = detail
  error.payload = payload
  return error
}

export const normalizeYahooSymbol = (ticker) => {
  if (!ticker) return ''
  const raw = String(ticker).trim().toUpperCase()
  if (raw.includes('.')) return raw
  if (/^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw)) return `${raw}.SA`
  return raw
}

const fetchYahooViaApi = async ({ symbol, startDate, endDate, start, end }) => {
  const params = new URLSearchParams({
    symbol,
  })
  if (startDate) params.set('startDate', startDate)
  if (endDate) params.set('endDate', endDate)
  if (start != null) params.set('start', String(start))
  if (end != null) params.set('end', String(end))

  const response = await fetchWithRetry(`/api/quotes?${params.toString()}`, {}, { retries: 2, backoffMs: 500, timeoutMs: 8000 })
  if (!response.ok) {
    throw await parseApiError(response)
  }
  return response.json()
}

export const fetchYahooMarketData = async ({ symbol, startDate, endDate }) => {
  const normalized = normalizeYahooSymbol(symbol)
  const start = Math.floor(new Date(startDate).getTime() / 1000)
  const end = Math.floor(new Date(endDate).getTime() / 1000) + 86400
  const key = cacheKey(normalized, start, end)
  const cached = await getCached(key)
  if (cached) return { ...cached, cached: true }

  try {
    const data = await fetchYahooViaApi({
      symbol: normalized,
      startDate,
      endDate,
      start,
      end,
    })
    return setCached(key, { ...data, cached: false })
  } catch (error) {
    const stale = await getCached(key, { allowStale: true })
    if (stale) return { ...stale, cached: true, offline: true }
    throw error
  }
}
