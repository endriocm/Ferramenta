const CACHE_TTL = 6 * 60 * 60 * 1000
const cache = new Map()

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

const normalizeTicker = (ticker) => String(ticker || '').trim().toUpperCase()

const normalizeTickerVariants = (ticker) => {
  const raw = String(ticker || '').trim()
  const upper = raw.toUpperCase()
  const noSuffix = upper.endsWith('.SA') ? upper.slice(0, -3) : upper
  const isBrazilian = /^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(noSuffix) || upper.endsWith('.SA')
  return {
    raw,
    upper,
    brapi: noSuffix,
    yahoo: isBrazilian && !upper.endsWith('.SA') ? `${noSuffix}.SA` : upper,
    statusinvest: noSuffix.toLowerCase(),
    isBrazilian,
  }
}

const normalizeDateKey = (value) => {
  if (!value) return ''
  const raw = String(value).trim()
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

const toDateUTC = (dateKey) => {
  const key = normalizeDateKey(dateKey)
  if (!key) return null
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0))
}

const addDaysUTC = (dateKey, delta) => {
  const base = toDateUTC(dateKey)
  if (!base) return ''
  base.setUTCDate(base.getUTCDate() + delta)
  return base.toISOString().slice(0, 10)
}

const previousBusinessDay = (dateKey) => {
  let candidate = addDaysUTC(dateKey, -1)
  let guard = 0
  while (candidate && guard < 7) {
    const date = toDateUTC(candidate)
    if (!date) return ''
    const day = date.getUTCDay()
    if (day !== 0 && day !== 6) return candidate
    candidate = addDaysUTC(candidate, -1)
    guard += 1
  }
  return candidate || ''
}

const normalizeType = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return 'DIV'
  if (raw.includes('JCP') || raw.includes('JUROS') || (raw.includes('REND') && raw.includes('TRIBUT'))) return 'JCP'
  if (raw.includes('DIV') || raw.includes('PROVENT')) return 'DIV'
  return 'DIV'
}

const parseAmount = (value) => {
  if (value == null) return NaN
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const raw = String(value).trim()
  if (!raw) return NaN
  const hasComma = raw.includes(',')
  const hasDot = raw.includes('.')
  if (hasComma && hasDot) {
    return Number(raw.replace(/\./g, '').replace(',', '.'))
  }
  if (hasComma) return Number(raw.replace(',', '.'))
  return Number(raw)
}

const inRangeInclusive = (dateKey, from, to) => {
  const key = normalizeDateKey(dateKey)
  const start = normalizeDateKey(from)
  const end = normalizeDateKey(to)
  if (!key || !start || !end) return false
  return key >= start && key <= end
}

const applyNetValue = (event) => {
  if (event?.valueNet != null && Number.isFinite(Number(event.valueNet))) {
    return Number(event.valueNet)
  }
  const amount = parseAmount(event?.amount ?? event?.value ?? event?.rate ?? event?.cash_amount ?? 0)
  if (!Number.isFinite(amount)) return 0
  const type = normalizeType(event?.type)
  return type === 'JCP' ? amount * 0.85 : amount
}

const buildEvent = ({ typeRaw, dataCom, paymentDate, amount }) => {
  const normalizedType = normalizeType(typeRaw)
  const numericAmount = parseAmount(amount)
  if (!Number.isFinite(numericAmount)) return null
  const valueNet = normalizedType === 'JCP' ? numericAmount * 0.85 : numericAmount
  return {
    type: normalizedType,
    typeRaw: typeRaw ? String(typeRaw) : null,
    dataCom: normalizeDateKey(dataCom),
    paymentDate: normalizeDateKey(paymentDate),
    amount: numericAmount,
    valueNet,
  }
}

const aggregateEvents = (events, from, to) => {
  if (!Array.isArray(events) || !events.length) return { total: 0, events: [] }
  const filtered = events.filter((event) => inRangeInclusive(event?.dataCom, from, to))
  const total = filtered.reduce((sum, event) => sum + applyNetValue(event), 0)
  return { total, events: filtered }
}

const sumDividendsInRange = (events, from, to) => aggregateEvents(events, from, to).total

const fetchWithTimeout = async (url, options = {}, timeoutMs = 8000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const getBrapiToken = () => process.env.BRAPI_TOKEN || process.env.brapi_token || process.env.BRAPI_API_KEY

const fetchBrapiEvents = async (variants) => {
  const token = getBrapiToken()
  if (!token) {
    const error = new Error('BRAPI_TOKEN not configured')
    error.provider = 'brapi'
    error.status = 401
    throw error
  }
  const cacheKey = `brapi:${variants.brapi}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const headers = { Authorization: `Bearer ${token}` }
  const url = `https://brapi.dev/api/quote/${encodeURIComponent(variants.brapi)}?dividends=true`
  const response = await fetchWithTimeout(url, { headers })
  if (!response.ok) {
    const error = new Error('Brapi request failed')
    error.provider = 'brapi'
    error.status = response.status
    throw error
  }
  const payload = await response.json()
  const result = payload?.results?.[0]
  const cashDividends = result?.dividendsData?.cashDividends || []
  const events = cashDividends.map((item) => {
    const exDate = normalizeDateKey(item?.exDividendDate || item?.exDate)
    const dataCom = normalizeDateKey(item?.lastDatePrior || item?.lastDate) || (exDate ? previousBusinessDay(exDate) : '')
    return buildEvent({
      typeRaw: item?.label,
      dataCom,
      paymentDate: item?.paymentDate,
      amount: item?.rate,
    })
  }).filter((event) => event?.dataCom && Number.isFinite(event.amount))
  const value = {
    events,
    currency: result?.currency || (variants.isBrazilian ? 'BRL' : null),
    source: 'brapi',
  }
  return cacheSet(cacheKey, value)
}

const parseStatusInvestHtml = (html) => {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const re = /\b(Dividendo|Dividendos?|JCP|Rend\.\s*Tributado|Proventos?)\b\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+([0-9]+(?:[.,][0-9]+)*)/g
  const rows = []
  let match
  while ((match = re.exec(text)) !== null) {
    rows.push(buildEvent({
      typeRaw: match[1],
      dataCom: match[2],
      paymentDate: match[3],
      amount: match[4],
    }))
  }
  return rows.filter((row) => row?.dataCom && Number.isFinite(row.amount))
}

const fetchStatusInvestEvents = async (variants) => {
  const cacheKey = `statusinvest:${variants.statusinvest}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const bases = ['acoes', 'bdrs', 'fundos-imobiliarios']
  for (const base of bases) {
    const url = `https://statusinvest.com.br/${base}/${variants.statusinvest}`
    const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000)
    if (!response.ok) continue
    const html = await response.text()
    const events = parseStatusInvestHtml(html)
    if (events.length) {
      const value = { events, currency: 'BRL', source: 'statusinvest' }
      return cacheSet(cacheKey, value)
    }
  }
  const error = new Error('StatusInvest did not return events')
  error.provider = 'statusinvest'
  error.status = 404
  throw error
}

const fetchYahooEvents = async (variants, from, to) => {
  const start = toDateUTC(from)
  const end = toDateUTC(to)
  if (!start || !end) {
    const error = new Error('Invalid date range')
    error.provider = 'yahoo'
    error.status = 400
    throw error
  }
  const startSec = Math.floor(start.getTime() / 1000)
  const endSec = Math.floor(end.getTime() / 1000) + 86400
  const cacheKey = `yahoo:${variants.yahoo}:${startSec}:${endSec}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(variants.yahoo)}?period1=${startSec}&period2=${endSec}&interval=1d&events=div`
  const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000)
  if (!response.ok) {
    const error = new Error('Yahoo request failed')
    error.provider = 'yahoo'
    error.status = response.status
    throw error
  }
  const payload = await response.json()
  const result = payload?.chart?.result?.[0]
  const dividendsObj = result?.events?.dividends || {}
  const events = Object.values(dividendsObj).map((item) => buildEvent({
    typeRaw: 'DIV',
    dataCom: item?.date ? new Date(item.date * 1000).toISOString().slice(0, 10) : '',
    paymentDate: '',
    amount: item?.amount,
  })).filter((event) => event?.dataCom && Number.isFinite(event.amount))
  const value = { events, currency: result?.meta?.currency || null, source: 'yahoo' }
  return cacheSet(cacheKey, value)
}

const getDividendsResult = async ({ ticker, from, to, includeEvents = false }) => {
  const variants = normalizeTickerVariants(ticker)
  const normalizedFrom = normalizeDateKey(from)
  const normalizedTo = normalizeDateKey(to)
  if (!variants.upper || !normalizedFrom || !normalizedTo) {
    const error = new Error('Invalid params')
    error.status = 400
    throw error
  }

  const providers = variants.isBrazilian
    ? [
      { name: 'statusinvest', fn: () => fetchStatusInvestEvents(variants) },
      { name: 'brapi', fn: () => fetchBrapiEvents(variants) },
      { name: 'yahoo', fn: () => fetchYahooEvents(variants, normalizedFrom, normalizedTo) },
    ]
    : [
      { name: 'brapi', fn: () => fetchBrapiEvents(variants) },
      { name: 'yahoo', fn: () => fetchYahooEvents(variants, normalizedFrom, normalizedTo) },
    ]

  const errors = []
  let emptyResult = null
  for (const provider of providers) {
    try {
      const payload = await provider.fn()
      if (!payload || !Array.isArray(payload.events)) continue
      if (!payload.events.length && !emptyResult) {
        emptyResult = payload
        continue
      }
      const aggregated = aggregateEvents(payload.events, normalizedFrom, normalizedTo)
      return {
        ticker: variants.yahoo || variants.upper,
        from: normalizedFrom,
        to: normalizedTo,
        total: aggregated.total,
        currency: payload.currency || (variants.isBrazilian ? 'BRL' : null),
        source: payload.source || provider.name,
        events: includeEvents ? aggregated.events : undefined,
      }
    } catch (error) {
      errors.push({
        provider: provider.name,
        status: error?.status,
        message: error?.message,
      })
    }
  }

  if (emptyResult) {
    const aggregated = aggregateEvents(emptyResult.events, normalizedFrom, normalizedTo)
    return {
      ticker: variants.yahoo || variants.upper,
      from: normalizedFrom,
      to: normalizedTo,
      total: aggregated.total,
      currency: emptyResult.currency || (variants.isBrazilian ? 'BRL' : null),
      source: emptyResult.source || 'brapi',
      events: includeEvents ? aggregated.events : undefined,
    }
  }

  const error = new Error('All providers failed')
  error.status = 502
  error.providers = errors
  throw error
}

module.exports = {
  normalizeTicker,
  normalizeTickerVariants,
  normalizeDateKey,
  normalizeType,
  aggregateEvents,
  sumDividendsInRange,
  applyNetValue,
  getBrapiToken,
  getDividendsResult,
}
