const { normalizeDateKey, normalizeTicker, normalizeTickerVariants } = require('./dividends')

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

const toDateUTC = (dateKey) => {
  const key = normalizeDateKey(dateKey)
  if (!key) return null
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0))
}

const inRangeInclusive = (dateKey, from, to) => {
  const key = normalizeDateKey(dateKey)
  const start = normalizeDateKey(from)
  const end = normalizeDateKey(to)
  if (!key || !start || !end) return false
  return key >= start && key <= end
}

const normalizeHtmlText = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&#x[0-9a-f]+;/gi, ' ')
  .replace(/&#\d+;/gi, ' ')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

const parseNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
  if (!cleaned) return null
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

const normalizeBonusFactor = (factor) => {
  const parsed = Number(factor)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const parseSplitRatio = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const match = raw.match(/([\d.,]+)\s*:\s*([\d.,]+)/)
  if (!match) return null
  const numerator = parseNumber(match[1])
  const denominator = parseNumber(match[2])
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return normalizeBonusFactor(numerator / denominator)
}

const buildBonusEvent = ({
  announcementDate,
  dataCom,
  exDate,
  incorporationDate,
  baseValue,
  proportionPct,
  issuedTicker,
  factor,
  splitRatio,
  source = '',
}) => {
  const normalizedFactor = normalizeBonusFactor(
    factor != null ? factor : (
      proportionPct != null
        ? 1 + (Number(proportionPct) / 100)
        : parseSplitRatio(splitRatio)
    ),
  )
  if (!normalizedFactor || normalizedFactor <= 1) return null
  const normalizedPct = proportionPct != null
    ? Number(proportionPct)
    : ((normalizedFactor - 1) * 100)
  const normalizedBaseValue = parseNumber(baseValue)
  return {
    type: 'BONUS',
    announcementDate: normalizeDateKey(announcementDate),
    dataCom: normalizeDateKey(dataCom),
    exDate: normalizeDateKey(exDate),
    incorporationDate: normalizeDateKey(incorporationDate),
    baseValue: Number.isFinite(normalizedBaseValue) ? normalizedBaseValue : null,
    proportionPct: Number.isFinite(normalizedPct) ? normalizedPct : null,
    factor: normalizedFactor,
    splitRatio: splitRatio ? String(splitRatio).trim() : null,
    issuedTicker: issuedTicker ? normalizeTicker(issuedTicker) : null,
    source: source || null,
  }
}

const extractSectionText = (html, startLabel, endLabel = '') => {
  const normalizedText = normalizeHtmlText(html)
  const normalizedStart = normalizeHtmlText(startLabel)
  const normalizedEnd = endLabel ? normalizeHtmlText(endLabel) : ''
  const startIndex = normalizedText.indexOf(normalizedStart)
  if (startIndex < 0) return ''
  const endIndex = normalizedEnd ? normalizedText.indexOf(normalizedEnd, startIndex) : -1
  return endIndex > startIndex ? normalizedText.slice(startIndex, endIndex) : normalizedText.slice(startIndex)
}

const parseStatusInvestBonusHtml = (html) => {
  const text = extractSectionText(html, 'BONIFICAÇÃO', 'DESDOBRAMENTO/GRUPAMENTO')
  if (!text) return []
  const re = /Data do anuncio\s+(\d{2}\/\d{2}\/\d{4})\s+Data com\s+(\d{2}\/\d{2}\/\d{4})\s+Data ex\s+(\d{2}\/\d{2}\/\d{4})\s+Data de incorporacao\s+(\d{2}\/\d{2}\/\d{4})\s+Valor base\s+R\$\s*([0-9.,-]+)\s+Proporcao\s+([0-9.,-]+)%\s+Ativo emitido\s+([A-Z0-9.]+)/g
  const events = []
  let match
  while ((match = re.exec(text)) !== null) {
    const event = buildBonusEvent({
      announcementDate: match[1],
      dataCom: match[2],
      exDate: match[3],
      incorporationDate: match[4],
      baseValue: match[5],
      proportionPct: parseNumber(match[6]),
      issuedTicker: match[7],
      source: 'statusinvest',
    })
    if (event) events.push(event)
  }
  return events
}

const fetchWithTimeout = async (url, options = {}, timeoutMs = 10000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const fetchStatusInvestBonusEvents = async (variants) => {
  const cacheKey = `statusinvest-bonus:${variants.statusinvest}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const bases = ['acoes', 'bdrs', 'fundos-imobiliarios']
  for (const base of bases) {
    const url = `https://statusinvest.com.br/${base}/${variants.statusinvest}`
    const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000)
    if (!response.ok) continue
    const html = await response.text()
    const events = parseStatusInvestBonusHtml(html)
    if (events.length) {
      const value = { events, source: 'statusinvest' }
      return cacheSet(cacheKey, value)
    }
  }
  const error = new Error('StatusInvest did not return bonus events')
  error.provider = 'statusinvest'
  error.status = 404
  throw error
}

const fetchYahooSplitBonusEvents = async (variants, from, to) => {
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
  const cacheKey = `yahoo-bonus:${variants.yahoo}:${startSec}:${endSec}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(variants.yahoo)}?period1=${startSec}&period2=${endSec}&interval=1d&events=split`
  const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000)
  if (!response.ok) {
    const error = new Error('Yahoo split request failed')
    error.provider = 'yahoo'
    error.status = response.status
    throw error
  }
  const payload = await response.json()
  const splitsObj = payload?.chart?.result?.[0]?.events?.splits || {}
  const events = Object.values(splitsObj)
    .map((item) => buildBonusEvent({
      dataCom: item?.date ? new Date(item.date * 1000).toISOString().slice(0, 10) : '',
      exDate: item?.date ? new Date(item.date * 1000).toISOString().slice(0, 10) : '',
      factor: parseSplitRatio(item?.splitRatio),
      splitRatio: item?.splitRatio,
      source: 'yahoo-split',
    }))
    .filter(Boolean)
  const value = { events, source: 'yahoo-split' }
  return cacheSet(cacheKey, value)
}

const aggregateBonusEvents = (events, from, to) => {
  if (!Array.isArray(events) || !events.length) return { factor: 1, totalPct: 0, events: [] }
  const filtered = events
    .filter((event) => inRangeInclusive(event?.dataCom || event?.exDate || event?.incorporationDate, from, to))
    .sort((left, right) => String(left?.dataCom || left?.exDate || '').localeCompare(String(right?.dataCom || right?.exDate || '')))
  const factor = filtered.reduce((product, event) => {
    const eventFactor = normalizeBonusFactor(event?.factor)
    return eventFactor ? product * eventFactor : product
  }, 1)
  return {
    factor,
    totalPct: (factor - 1) * 100,
    events: filtered,
  }
}

const getBonusResult = async ({ ticker, from, to, includeEvents = false }) => {
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
      { name: 'statusinvest', fn: () => fetchStatusInvestBonusEvents(variants) },
    ]
    : []

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
      const aggregated = aggregateBonusEvents(payload.events, normalizedFrom, normalizedTo)
      return {
        ticker: variants.yahoo || variants.upper,
        from: normalizedFrom,
        to: normalizedTo,
        factor: aggregated.factor,
        totalPct: aggregated.totalPct,
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
    const aggregated = aggregateBonusEvents(emptyResult.events, normalizedFrom, normalizedTo)
    return {
      ticker: variants.yahoo || variants.upper,
      from: normalizedFrom,
      to: normalizedTo,
      factor: aggregated.factor,
      totalPct: aggregated.totalPct,
      source: emptyResult.source || providers[0]?.name || 'statusinvest',
      events: includeEvents ? aggregated.events : undefined,
    }
  }

  const error = new Error('All bonus providers failed')
  error.status = 502
  error.providers = errors
  throw error
}

module.exports = {
  normalizeTicker,
  normalizeDateKey,
  parseNumber,
  parseSplitRatio,
  parseStatusInvestBonusHtml,
  aggregateBonusEvents,
  getBonusResult,
}
