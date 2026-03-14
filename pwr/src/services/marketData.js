import { apiFetch } from './apiBase'
import { persistLocalStorage, hydrateLocalStorage } from './nativeStorage'

const CACHE_TTL = 5 * 60 * 1000
const marketCache = new Map()
let persistentLoadPromise = null
let persistTimer = null

const cacheKey = (symbol, start, end, provider = 'yahoo', includeSeries = false) => `${symbol}:${start}:${end}:${provider}:${includeSeries ? 'series' : 'spot'}`

const normalizeDateKey = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
  const brMatch = raw.match(/(\d{2})[/-](\d{2})[/-](\d{4})/)
  if (brMatch) {
    const [, day, month, year] = brMatch
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return ''
}

const getTodayKey = () => {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const shouldBypassCache = ({ includeSeries = false, endDate = '' } = {}) => {
  const endKey = normalizeDateKey(endDate)
  if (!includeSeries || !endKey) return false
  return endKey >= getTodayKey()
}

const schedulePersist = () => {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const obj = {}
    for (const [k, v] of marketCache) obj[k] = v
    void persistLocalStorage('pwr.market.cache', obj)
  }, 2_000)
}

const ensurePersistentLoaded = () => {
  if (persistentLoadPromise) return persistentLoadPromise
  persistentLoadPromise = hydrateLocalStorage(['pwr.market.cache'])
    .then((data) => {
      const cached = data['pwr.market.cache']
      if (cached && typeof cached === 'object') {
        for (const [k, v] of Object.entries(cached)) {
          if (!marketCache.has(k)) marketCache.set(k, v)
        }
      }
    })
    .catch(() => {})
  return persistentLoadPromise
}

const getCached = async (key, { allowStale = false } = {}) => {
  await ensurePersistentLoaded()
  const item = marketCache.get(key)
  if (!item) return null
  const age = Date.now() - item.timestamp
  if (!allowStale && age > CACHE_TTL) {
    marketCache.delete(key)
    return null
  }
  return { ...item.data, cached: true, stale: allowStale && age > CACHE_TTL }
}

const setCached = (key, data) => {
  marketCache.set(key, { data, timestamp: Date.now() })
  schedulePersist()
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

const fetchYahooViaApi = async ({ symbol, startDate, endDate, start, end, provider, includeSeries = false }) => {
  const params = new URLSearchParams({
    symbol,
  })
  if (startDate) params.set('startDate', startDate)
  if (endDate) params.set('endDate', endDate)
  if (start != null) params.set('start', String(start))
  if (end != null) params.set('end', String(end))
  if (provider) params.set('provider', provider)
  if (includeSeries) params.set('includeSeries', '1')

  const response = await apiFetch(`/api/quotes?${params.toString()}`, {}, { retries: 2, backoffMs: 500, timeoutMs: 8000 })
  if (!response.ok) {
    throw await parseApiError(response)
  }
  return response.json()
}

export const fetchYahooMarketData = async ({ symbol, startDate, endDate, provider = 'yahoo', includeSeries = false }) => {
  const normalized = normalizeYahooSymbol(symbol)
  const start = Math.floor(new Date(startDate).getTime() / 1000)
  const end = Math.floor(new Date(endDate).getTime() / 1000) + 86400
  const key = cacheKey(normalized, start, end, provider, includeSeries)
  const bypassCache = shouldBypassCache({ includeSeries, endDate })
  const cached = bypassCache ? null : await getCached(key)
  if (cached) return { ...cached, cached: true }

  try {
    const data = await fetchYahooViaApi({
      symbol: normalized,
      startDate,
      endDate,
      start,
      end,
      provider,
      includeSeries,
    })
    return setCached(key, { ...data, cached: false })
  } catch (error) {
    const stale = await getCached(key, { allowStale: true })
    if (stale) return { ...stale, cached: true, offline: true }
    throw error
  }
}
