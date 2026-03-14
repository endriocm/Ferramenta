const { scrapeAllEarningsSources, findScrapedDate, getScrapedSources, getLastScrapeResult } = require('./earningsScraper')

const DEFAULT_MAX_SYMBOLS = 80
const DEFAULT_CONCURRENCY = 6
const USER_AGENT = 'Mozilla/5.0'
const YAHOO_AUTH_TTL_MS = 20 * 60 * 1000
const YAHOO_MODULES = [
  'calendarEvents',
  'price',
  'summaryProfile',
  'defaultKeyStatistics',
  'financialData',
].join(',')
const YAHOO_CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb'
const YAHOO_COOKIE_PRIMER_URL = 'https://fc.yahoo.com'

let yahooAuthCache = {
  crumb: '',
  cookieHeader: '',
  expiresAt: 0,
}

const normalizeInputSymbol = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return ''
  return raw.replace(/[^A-Z0-9.-]/g, '')
}

const normalizeYahooSymbol = (symbol) => {
  const raw = normalizeInputSymbol(symbol)
  if (!raw) return ''
  if (raw.includes('.')) return raw
  if (/^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw)) return `${raw}.SA`
  return raw
}

const parseSymbolsParam = (value, maxSymbols = DEFAULT_MAX_SYMBOLS) => {
  const source = Array.isArray(value) ? value.join(',') : String(value || '')
  const unique = Array.from(new Set(
    source
      .split(/[\s,;|]+/g)
      .map((item) => normalizeInputSymbol(item))
      .filter(Boolean),
  ))
  return unique.slice(0, maxSymbols)
}

const parseIsoDate = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return ''
  const dt = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(dt.getTime())) return ''
  return raw
}

const readBodySnippet = async (response) => {
  try {
    const text = await response.text()
    if (!text) return ''
    return text.length > 300 ? `${text.slice(0, 300)}...` : text
  } catch {
    return ''
  }
}

const extractCookieHeader = (response) => {
  if (!response?.headers) return ''

  let setCookieLines = []
  if (typeof response.headers.getSetCookie === 'function') {
    setCookieLines = response.headers.getSetCookie()
  } else {
    const fallback = response.headers.get('set-cookie')
    if (fallback) setCookieLines = [fallback]
  }

  const pairs = setCookieLines
    .map((line) => String(line || '').split(';')[0].trim())
    .filter(Boolean)

  return Array.from(new Set(pairs)).join('; ')
}

const joinCookies = (...cookies) => {
  const merged = cookies
    .flatMap((chunk) => String(chunk || '').split(';'))
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
  return Array.from(new Set(merged)).join('; ')
}

const isValidCrumb = (crumb) => {
  const raw = String(crumb || '').trim()
  if (!raw) return false
  if (raw.length > 128) return false
  if (raw.includes('<') || raw.includes('{') || raw.includes('}')) return false
  return true
}

const getYahooAuth = async ({ force = false } = {}) => {
  const now = Date.now()
  if (!force && yahooAuthCache.crumb && yahooAuthCache.cookieHeader && yahooAuthCache.expiresAt > now) {
    return { crumb: yahooAuthCache.crumb, cookieHeader: yahooAuthCache.cookieHeader }
  }

  const primerResponse = await fetch(YAHOO_COOKIE_PRIMER_URL, {
    headers: {
      'User-Agent': USER_AGENT,
    },
  })
  const primerCookie = extractCookieHeader(primerResponse)

  const crumbResponse = await fetch(YAHOO_CRUMB_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      Cookie: primerCookie,
    },
  })
  const crumbCookie = extractCookieHeader(crumbResponse)
  const crumb = String(await crumbResponse.text()).trim()

  if (!isValidCrumb(crumb)) {
    throw new Error('Yahoo crumb invalido.')
  }

  const cookieHeader = joinCookies(primerCookie, crumbCookie)
  if (!cookieHeader) {
    throw new Error('Cookie Yahoo nao disponivel.')
  }

  yahooAuthCache = {
    crumb,
    cookieHeader,
    expiresAt: Date.now() + YAHOO_AUTH_TTL_MS,
  }

  return { crumb, cookieHeader }
}

const readNumeric = (value) => {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'object' && value !== null && value.raw != null) {
    const num = Number(value.raw)
    return Number.isFinite(num) ? num : null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const readText = (value) => {
  if (value == null) return ''
  if (typeof value === 'object' && value !== null) {
    if (typeof value.fmt === 'string' && value.fmt.trim()) return value.fmt.trim()
    if (typeof value.longFmt === 'string' && value.longFmt.trim()) return value.longFmt.trim()
    if (typeof value.shortFmt === 'string' && value.shortFmt.trim()) return value.shortFmt.trim()
    return ''
  }
  return String(value).trim()
}

const toEpochMs = (value) => {
  const raw = readNumeric(value)
  if (!Number.isFinite(raw)) return null
  if (raw > 10_000_000_000) return Math.round(raw)
  return Math.round(raw * 1000)
}

const toIsoDateFromEpoch = (value) => {
  const ms = toEpochMs(value)
  if (!ms) return ''
  const dt = new Date(ms)
  if (Number.isNaN(dt.getTime())) return ''
  return dt.toISOString().slice(0, 10)
}

const pickEarningsEpoch = (entries) => {
  if (!Array.isArray(entries) || !entries.length) return null
  const epochs = entries
    .map((entry) => toEpochMs(entry?.raw ?? entry))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  if (!epochs.length) return null
  const now = Date.now()
  const next = epochs.find((value) => value >= (now - (12 * 60 * 60 * 1000)))
  return next ?? epochs[0]
}

const detectMarket = (symbol, price, profile) => {
  const exchange = String(price?.exchangeName || price?.fullExchangeName || '').toUpperCase()
  const country = String(profile?.country || '').toUpperCase()
  if (String(symbol || '').toUpperCase().endsWith('.SA')) return 'BR'
  if (exchange.includes('SAO') || exchange.includes('B3') || country === 'BRAZIL') return 'BR'
  return 'US'
}

const mapResult = ({ inputSymbol, normalizedSymbol, result }) => {
  const calendarEvents = result?.calendarEvents || {}
  const earnings = calendarEvents?.earnings || {}
  const price = result?.price || {}
  const profile = result?.summaryProfile || {}
  const statistics = result?.defaultKeyStatistics || {}
  const financialData = result?.financialData || {}

  const earningsEpoch = pickEarningsEpoch(earnings?.earningsDate)
  const eventDate = earningsEpoch ? toIsoDateFromEpoch(earningsEpoch) : ''
  const currency = readText(price?.currency) || readText(financialData?.financialCurrency)
  const companyName = readText(price?.shortName) || readText(price?.longName) || inputSymbol
  const market = detectMarket(normalizedSymbol, price, profile)

  const item = {
    id: normalizedSymbol || inputSymbol,
    inputSymbol,
    symbol: normalizedSymbol || inputSymbol,
    displaySymbol: normalizedSymbol.endsWith('.SA') ? normalizedSymbol.slice(0, -3) : normalizedSymbol,
    companyName,
    market,
    exchange: readText(price?.exchangeName) || readText(price?.fullExchangeName),
    timezone: readText(price?.exchangeTimezoneShortName),
    currency,
    eventDate: eventDate || null,
    eventTimestamp: earningsEpoch || null,
    status: eventDate ? 'SCHEDULED' : 'NO_DATE',
    expectations: {
      epsAverage: readNumeric(earnings?.earningsAverage),
      epsLow: readNumeric(earnings?.earningsLow),
      epsHigh: readNumeric(earnings?.earningsHigh),
      revenueAverage: readNumeric(earnings?.revenueAverage),
      revenueLow: readNumeric(earnings?.revenueLow),
      revenueHigh: readNumeric(earnings?.revenueHigh),
      targetMeanPrice: readNumeric(financialData?.targetMeanPrice),
      recommendationKey: readText(financialData?.recommendationKey),
    },
    metrics: {
      regularMarketPrice: readNumeric(price?.regularMarketPrice),
      previousClose: readNumeric(price?.regularMarketPreviousClose),
      marketCap: readNumeric(price?.marketCap) ?? readNumeric(statistics?.marketCap),
      fiftyTwoWeekHigh: readNumeric(price?.fiftyTwoWeekHigh),
      fiftyTwoWeekLow: readNumeric(price?.fiftyTwoWeekLow),
    },
    profile: {
      sector: readText(profile?.sector),
      industry: readText(profile?.industry),
      country: readText(profile?.country),
      website: readText(profile?.website),
    },
  }

  return item
}

const fetchSymbolEarnings = async (inputSymbol) => {
  const normalizedSymbol = normalizeYahooSymbol(inputSymbol)
  if (!normalizedSymbol) {
    return {
      id: inputSymbol || 'unknown',
      inputSymbol,
      symbol: inputSymbol,
      displaySymbol: inputSymbol,
      status: 'ERROR',
      error: 'Simbolo invalido.',
    }
  }

  const fetchSummary = async (auth) => {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(normalizedSymbol)}?modules=${encodeURIComponent(YAHOO_MODULES)}&formatted=false&crumb=${encodeURIComponent(auth.crumb)}`
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Cookie: auth.cookieHeader,
      },
    })
    return { url, response }
  }

  try {
    let auth = await getYahooAuth()
    let { url, response } = await fetchSummary(auth)
    if (response.status === 401 || response.status === 403) {
      auth = await getYahooAuth({ force: true })
      ;({ url, response } = await fetchSummary(auth))
    }

    if (!response.ok) {
      const body = await readBodySnippet(response)
      return {
        id: normalizedSymbol,
        inputSymbol,
        symbol: normalizedSymbol,
        displaySymbol: normalizedSymbol.endsWith('.SA') ? normalizedSymbol.slice(0, -3) : normalizedSymbol,
        status: 'ERROR',
        error: `HTTP ${response.status}`,
        detailsSnippet: body,
      }
    }

    const payload = await response.json()
    const result = payload?.quoteSummary?.result?.[0]
    const error = payload?.quoteSummary?.error

    if (!result) {
      return {
        id: normalizedSymbol,
        inputSymbol,
        symbol: normalizedSymbol,
        displaySymbol: normalizedSymbol.endsWith('.SA') ? normalizedSymbol.slice(0, -3) : normalizedSymbol,
        status: 'ERROR',
        error: readText(error?.description) || 'Sem dados para o simbolo.',
      }
    }

    return mapResult({ inputSymbol, normalizedSymbol, result })
  } catch (error) {
    return {
      id: normalizedSymbol,
      inputSymbol,
      symbol: normalizedSymbol,
      displaySymbol: normalizedSymbol.endsWith('.SA') ? normalizedSymbol.slice(0, -3) : normalizedSymbol,
      status: 'ERROR',
      error: error?.message || 'Falha ao consultar Yahoo.',
    }
  }
}

const mapWithConcurrency = async (items, concurrency, worker) => {
  const queue = Array.isArray(items) ? [...items] : []
  if (!queue.length) return []

  const limit = Math.max(1, Math.min(concurrency || DEFAULT_CONCURRENCY, queue.length))
  const out = []

  const runWorker = async () => {
    while (queue.length) {
      const next = queue.shift()
      const result = await worker(next)
      out.push(result)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()))
  return out
}

const inDateRange = (isoDate, fromIso, toIso) => {
  if (!isoDate) return false
  if (fromIso && isoDate < fromIso) return false
  if (toIso && isoDate > toIso) return false
  return true
}

const compareByDateThenSymbol = (left, right) => {
  const leftDate = String(left?.eventDate || '')
  const rightDate = String(right?.eventDate || '')
  if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate)
  if (leftDate && !rightDate) return -1
  if (!leftDate && rightDate) return 1
  return String(left?.displaySymbol || '').localeCompare(String(right?.displaySymbol || ''))
}

const getEarningsCalendarSnapshot = async ({
  symbols,
  from = '',
  to = '',
  maxSymbols = DEFAULT_MAX_SYMBOLS,
  concurrency = DEFAULT_CONCURRENCY,
  scrape = true,
} = {}) => {
  const symbolList = parseSymbolsParam(symbols, maxSymbols)
  if (!symbolList.length) {
    return {
      generatedAt: new Date().toISOString(),
      range: { from: parseIsoDate(from) || null, to: parseIsoDate(to) || null },
      symbols: [],
      items: [],
      undated: [],
      errors: [],
      summary: {
        totalSymbols: 0,
        scheduledCount: 0,
        undatedCount: 0,
        errorCount: 0,
      },
      source: 'yahoo',
      scrapeInfo: null,
    }
  }

  const fromIso = parseIsoDate(from)
  const toIso = parseIsoDate(to)
  const low = fromIso && toIso && fromIso > toIso ? toIso : fromIso
  const high = fromIso && toIso && fromIso > toIso ? fromIso : toIso

  // 1. Fire-and-forget: kick off background scrape (NOT awaited, uses cache)
  if (scrape) {
    scrapeAllEarningsSources().catch((err) => {
      console.warn('[earningsCalendar] Background scrape failed:', err?.message)
    })
  }

  // 2. Fetch Yahoo data (this is the blocking part, fast per symbol)
  const results = await mapWithConcurrency(symbolList, concurrency, fetchSymbolEarnings)

  // 3. Use cached scrape results (may be from a previous run, or null on first call)
  const scrapeResult = scrape ? getLastScrapeResult() : null
  let scrapeInfo = null
  if (scrapeResult) {
    scrapeInfo = {
      scrapedAt: scrapeResult.scrapedAt,
      totalEntries: scrapeResult.totalEntries,
      sources: scrapeResult.sources,
      errors: scrapeResult.sourceErrors?.length || 0,
    }
  }

  // 4. Enrich Yahoo results with scraped dates
  if (scrapeResult?.data) {
    for (const item of results) {
      const displaySymbol = item.displaySymbol || item.symbol || ''

      if (item.status === 'NO_DATE' || item.status === 'ERROR') {
        // Try to fill in date from scraped sources
        const scrapedDate = findScrapedDate(scrapeResult, displaySymbol)
        if (scrapedDate) {
          item.eventDate = scrapedDate
          item.eventTimestamp = new Date(`${scrapedDate}T12:00:00Z`).getTime()
          item.status = 'SCHEDULED'
          item.dateSource = 'scraped'
          item.dateSources = getScrapedSources(scrapeResult, displaySymbol)
        }
      } else if (item.status === 'SCHEDULED') {
        // Yahoo has a date — mark it, but also note if scraped sources confirm
        item.dateSource = 'yahoo'
        const scrapedSources = getScrapedSources(scrapeResult, displaySymbol)
        if (scrapedSources.length) {
          item.dateSources = ['yahoo', ...scrapedSources]
          // If scraper has a different (closer future) date, add a hint
          const scrapedDate = findScrapedDate(scrapeResult, displaySymbol)
          if (scrapedDate && scrapedDate !== item.eventDate) {
            item.alternateDate = scrapedDate
            item.alternateDateSources = scrapedSources
          }
        } else {
          item.dateSources = ['yahoo']
        }
      }
    }
  }

  // 5. Also add scraped-only entries (symbols not in Yahoo results)
  if (scrapeResult?.data) {
    const existingSymbols = new Set(results.map((r) => (r.displaySymbol || r.symbol || '').toUpperCase()))
    for (const [scrapedSymbol, entries] of scrapeResult.data) {
      if (existingSymbols.has(scrapedSymbol)) continue
      // Only include BR tickers (4-6 letters + 1-2 digits) or known US tickers
      const isBR = /^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(scrapedSymbol)
      if (!isBR) continue // skip US-only scraped if not in our symbol list
      const bestDate = entries
        .map((e) => e.eventDate)
        .filter((d) => d >= (new Date().toISOString().slice(0, 10)))
        .sort()[0] || entries[0]?.eventDate
      if (bestDate) {
        results.push({
          id: scrapedSymbol,
          inputSymbol: scrapedSymbol,
          symbol: scrapedSymbol,
          displaySymbol: scrapedSymbol,
          companyName: entries[0]?.companyName || scrapedSymbol,
          market: 'BR',
          exchange: '',
          timezone: '',
          currency: 'BRL',
          eventDate: bestDate,
          eventTimestamp: new Date(`${bestDate}T12:00:00Z`).getTime(),
          status: 'SCHEDULED',
          dateSource: 'scraped',
          dateSources: entries.map((e) => e.source),
          expectations: {},
          metrics: {},
          profile: {},
        })
      }
    }
  }

  const scheduledAll = results.filter((item) => item?.status === 'SCHEDULED')
  const scheduled = (low || high)
    ? scheduledAll.filter((item) => inDateRange(item.eventDate, low, high))
    : scheduledAll
  const undated = results.filter((item) => item?.status === 'NO_DATE')
  const errors = results.filter((item) => item?.status === 'ERROR')

  scheduled.sort(compareByDateThenSymbol)
  undated.sort(compareByDateThenSymbol)
  errors.sort(compareByDateThenSymbol)

  return {
    generatedAt: new Date().toISOString(),
    range: { from: low || null, to: high || null },
    symbols: symbolList,
    items: scheduled,
    undated,
    errors,
    summary: {
      totalSymbols: symbolList.length,
      scheduledCount: scheduled.length,
      undatedCount: undated.length,
      errorCount: errors.length,
    },
    source: 'yahoo+scraped',
    scrapeInfo,
  }
}

module.exports = {
  parseSymbolsParam,
  getEarningsCalendarSnapshot,
}
