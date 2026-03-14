const normalizeYahooSymbol = (ticker) => {
  if (!ticker) return ''
  const raw = String(ticker).trim().toUpperCase()
  if (raw.includes('.')) return raw
  if (/^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw)) return `${raw}.SA`
  return raw
}

const normalizeBrapiSymbol = (ticker) => {
  if (!ticker) return ''
  const raw = String(ticker).toUpperCase()
  if (raw.endsWith('.SA')) return raw.replace('.SA', '')
  return raw
}

const { getBrapiToken } = require('./lib/dividends')
const BRAPI_RANGE_PRESETS = [
  { maxDays: 5, value: '5d' },
  { maxDays: 30, value: '1mo' },
  { maxDays: 60, value: '2mo' },
  { maxDays: 90, value: '3mo' },
  { maxDays: 180, value: '6mo' },
  { maxDays: 365, value: '1y' },
  { maxDays: 730, value: '2y' },
  { maxDays: 1825, value: '5y' },
]

const isBrazilianSymbol = (ticker) => {
  const raw = String(ticker || '').trim().toUpperCase()
  return /^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw) || raw.endsWith('.SA')
}

const lastValid = (values) => {
  if (!Array.isArray(values)) return null
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i]
    if (value != null) return value
  }
  return null
}

const getRangeStats = (values) => {
  if (!Array.isArray(values)) return { min: null, max: null }
  const filtered = values.filter((value) => value != null)
  if (!filtered.length) return { min: null, max: null }
  return {
    min: Math.min(...filtered),
    max: Math.max(...filtered),
  }
}

const toDateKeyFromUnix = (value) => {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

const normalizeDateKey = (value) => {
  if (value == null || value === '') return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    if (value > 1e12) return new Date(value).toISOString().slice(0, 10)
    if (value > 1e9) return new Date(value * 1000).toISOString().slice(0, 10)
    return ''
  }
  const raw = String(value).trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) return isoMatch[1]
  const brMatch = raw.match(/(\d{2})[/-](\d{2})[/-](\d{4})/)
  if (brMatch) {
    const [, day, month, year] = brMatch
    return `${year}-${month}-${day}`
  }
  const parsed = Date.parse(raw)
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  return ''
}

const toUnixFromDateKey = (dateKey) => {
  const normalized = normalizeDateKey(dateKey)
  if (!normalized) return 0
  const parsed = Date.parse(`${normalized}T00:00:00Z`)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

const resolveBrapiRange = (startSec, endSec) => {
  const safeStart = Number(startSec)
  const safeEnd = Number(endSec)
  const diffSeconds = Number.isFinite(safeStart) && Number.isFinite(safeEnd)
    ? Math.max(0, safeEnd - safeStart)
    : 0
  const days = Math.max(1, Math.ceil(diffSeconds / 86400))
  const preset = BRAPI_RANGE_PRESETS.find((entry) => days <= entry.maxDays)
  return preset?.value || 'max'
}

const buildSeriesFromBrapiHistory = ({
  historyRows = [],
  quote = null,
  startDate = '',
  endDate = '',
} = {}) => {
  const startKey = normalizeDateKey(startDate)
  const endKey = normalizeDateKey(endDate)
  const rows = []

  ;(Array.isArray(historyRows) ? historyRows : []).forEach((item) => {
    const date = normalizeDateKey(item?.date ?? item?.datetime ?? item?.timestamp)
    if (!date) return
    if (startKey && date < startKey) return
    if (endKey && date > endKey) return
    rows.push({
      timestamp: toUnixFromDateKey(date),
      date,
      open: item?.open != null ? Number(item.open) : null,
      high: item?.high != null ? Number(item.high) : null,
      low: item?.low != null ? Number(item.low) : null,
      close: item?.close != null ? Number(item.close) : (item?.adjustedClose != null ? Number(item.adjustedClose) : null),
    })
  })

  const quoteDate = normalizeDateKey(
    quote?.regularMarketTime
    ?? quote?.regularMarketDate
    ?? quote?.updatedAt
    ?? quote?.updateDate
    ?? '',
  )
  const shouldAppendQuoteRow = quoteDate
    && (!startKey || quoteDate >= startKey)
    && (!endKey || quoteDate <= endKey)
    && !rows.some((item) => item.date === quoteDate)
    && (
      quote?.regularMarketDayHigh != null
      || quote?.regularMarketDayLow != null
      || quote?.regularMarketPrice != null
    )

  if (shouldAppendQuoteRow) {
    rows.push({
      timestamp: toUnixFromDateKey(quoteDate),
      date: quoteDate,
      open: quote?.regularMarketOpen != null ? Number(quote.regularMarketOpen) : null,
      high: quote?.regularMarketDayHigh != null ? Number(quote.regularMarketDayHigh) : null,
      low: quote?.regularMarketDayLow != null ? Number(quote.regularMarketDayLow) : null,
      close: quote?.regularMarketPrice != null ? Number(quote.regularMarketPrice) : null,
    })
  }

  rows.sort((left, right) => left.date.localeCompare(right.date))
  return rows
}

const buildSeries = (timestamps, quote) => {
  if (!Array.isArray(timestamps) || !quote || typeof quote !== 'object') return []
  const open = Array.isArray(quote.open) ? quote.open : []
  const high = Array.isArray(quote.high) ? quote.high : []
  const low = Array.isArray(quote.low) ? quote.low : []
  const close = Array.isArray(quote.close) ? quote.close : []
  const series = []

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = Number(timestamps[index])
    if (!Number.isFinite(timestamp)) continue
    const row = {
      timestamp,
      date: toDateKeyFromUnix(timestamp),
      open: open[index] != null ? Number(open[index]) : null,
      high: high[index] != null ? Number(high[index]) : null,
      low: low[index] != null ? Number(low[index]) : null,
      close: close[index] != null ? Number(close[index]) : null,
    }
    if (row.open == null && row.high == null && row.low == null && row.close == null) continue
    series.push(row)
  }

  return series
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

const buildBrapiHeaders = () => {
  const brapiToken = getBrapiToken()
  if (!brapiToken) return {}
  return { Authorization: `Bearer ${brapiToken}` }
}

const fetchBrapiQuoteData = async ({
  symbol,
  startDate,
  endDate,
  startSec,
  endSec,
  withSeries = false,
}) => {
  const brapiSymbol = normalizeBrapiSymbol(symbol)
  const params = new URLSearchParams()
  if (withSeries) {
    params.set('range', resolveBrapiRange(startSec, endSec))
    params.set('interval', '1d')
    params.set('fundamental', 'false')
    params.set('dividends', 'false')
  }

  const url = `https://brapi.dev/api/quote/${encodeURIComponent(brapiSymbol)}${params.toString() ? `?${params.toString()}` : ''}`
  const response = await fetch(url, { headers: buildBrapiHeaders() })
  if (!response.ok) {
    const error = new Error('Brapi request failed')
    error.provider = 'brapi'
    error.status = response.status
    error.detailsSnippet = await readBodySnippet(response)
    throw error
  }

  const payload = await response.json()
  const result = payload?.results?.[0]
  if (!result) {
    const error = new Error('Brapi payload missing results')
    error.provider = 'brapi'
    error.status = 502
    throw error
  }

  const series = withSeries
    ? buildSeriesFromBrapiHistory({
        historyRows: result?.historicalDataPrice || result?.historicalData || result?.priceHistory || result?.prices || [],
        quote: result,
        startDate,
        endDate,
      })
    : []
  const highs = withSeries ? getRangeStats(series.map((item) => item.high)) : { min: null, max: result?.regularMarketDayHigh ?? null }
  const lows = withSeries ? getRangeStats(series.map((item) => item.low)) : { min: result?.regularMarketDayLow ?? null, max: null }
  const close = withSeries
    ? (lastValid(series.map((item) => item.close)) ?? result?.regularMarketPrice ?? result?.regularMarketPreviousClose ?? null)
    : (result?.regularMarketPrice ?? result?.regularMarketPreviousClose ?? null)

  return {
    symbol: result?.symbol || brapiSymbol,
    close,
    high: highs.max ?? result?.regularMarketDayHigh ?? null,
    low: lows.min ?? result?.regularMarketDayLow ?? null,
    dividendsTotal: 0,
    series,
    source: 'brapi',
    lastUpdate: Date.now(),
  }
}

const quotesHandler = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo nao permitido.' })
    return
  }

  const { symbol, startDate, endDate, start, end, includeSeries, provider } = req.query || {}
  if (!symbol || (!startDate && !start) || (!endDate && !end)) {
    res.status(400).json({ error: 'Parametros invalidos.' })
    return
  }

  const normalized = normalizeYahooSymbol(symbol)
  const startSec = start ? Number(start) : Math.floor(new Date(startDate).getTime() / 1000)
  const endSec = end ? Number(end) : Math.floor(new Date(endDate).getTime() / 1000) + 86400

  const withSeries = String(includeSeries || '').trim() === '1'
  const requestedProvider = String(provider || '').trim().toLowerCase()
  const canUseBrapi = isBrazilianSymbol(symbol) && requestedProvider !== 'yahoo'
  const canUseYahoo = requestedProvider !== 'brapi'

  try {
    if (canUseBrapi) {
      try {
        const brapiData = await fetchBrapiQuoteData({
          symbol,
          startDate,
          endDate,
          startSec,
          endSec,
          withSeries,
        })
        const hasSeries = Array.isArray(brapiData?.series) && brapiData.series.length > 0
        const hasSpot = brapiData?.close != null || brapiData?.high != null || brapiData?.low != null
        if ((withSeries && hasSeries) || (!withSeries && hasSpot) || (withSeries && hasSpot)) {
          res.status(200).json(brapiData)
          return
        }
      } catch (error) {
        if (requestedProvider === 'brapi') {
          res.status(error?.status || 502).json({
            error: error?.message || 'Falha ao buscar cotacao.',
            source: 'brapi',
            status: error?.status || 502,
            detailsSnippet: error?.detailsSnippet || '',
          })
          return
        }
      }
    }

    if (!canUseYahoo) {
      res.status(502).json({
        error: 'Falha ao buscar cotacao.',
        source: 'brapi',
        status: 502,
      })
      return
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?period1=${startSec}&period2=${endSec}&interval=1d&events=div`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    })
    if (!response.ok) {
      const body = await readBodySnippet(response)
      res.status(502).json({
        error: 'Falha ao buscar cotacao.',
        source: 'yahoo',
        status: response.status,
        url,
        body,
        detailsSnippet: body,
      })
      return
    }
    const payload = await response.json()
    const result = payload?.chart?.result?.[0]
    const quote = result?.indicators?.quote?.[0]
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : []
    const series = withSeries ? buildSeries(timestamps, quote) : []
    const close = lastValid(quote?.close)
    const highs = getRangeStats(quote?.high)
    const lows = getRangeStats(quote?.low)

    const dividendsObj = result?.events?.dividends || {}
    const dividends = Object.values(dividendsObj)
    const dividendTotal = dividends.reduce((sum, item) => sum + (item?.amount || 0), 0)

    res.status(200).json({
      symbol: normalized,
      close,
      high: highs.max,
      low: lows.min,
      dividendsTotal: dividendTotal,
      series,
      source: 'yahoo',
      lastUpdate: Date.now(),
    })
  } catch (error) {
    res.status(500).json({
      error: 'Erro ao consultar Yahoo.',
      message: error?.message,
    })
  }
}

module.exports = quotesHandler
module.exports._internal = {
  buildSeries,
  buildSeriesFromBrapiHistory,
  normalizeBrapiSymbol,
  normalizeYahooSymbol,
  resolveBrapiRange,
}
