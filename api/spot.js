const { getBrapiToken } = require('./lib/dividends')

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

const readBodySnippet = async (response) => {
  try {
    const text = await response.text()
    if (!text) return ''
    return text.length > 300 ? `${text.slice(0, 300)}...` : text
  } catch {
    return ''
  }
}

const fetchBrapiSpot = async (symbol) => {
  const brapiSymbol = normalizeBrapiSymbol(symbol)
  const brapiUrl = `https://brapi.dev/api/quote/${encodeURIComponent(brapiSymbol)}`
  const brapiToken = getBrapiToken()
  const headers = {}
  if (brapiToken) headers.Authorization = `Bearer ${brapiToken}`
  const response = await fetch(brapiUrl, { headers })
  if (!response.ok) return null
  const payload = await response.json()
  const result = payload?.results?.[0]
  const price = Number(result?.regularMarketPrice)
  if (!Number.isFinite(price)) return null
  return {
    symbol: result?.symbol || brapiSymbol,
    price,
    source: 'brapi',
    lastUpdate: Date.now(),
  }
}

const fetchYahooSpot = async (symbol) => {
  const normalized = normalizeYahooSymbol(symbol)
  const endSec = Math.floor(Date.now() / 1000) + 86400
  const startSec = endSec - (7 * 24 * 60 * 60)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?period1=${startSec}&period2=${endSec}&interval=1d`
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  })
  if (!response.ok) {
    const body = await readBodySnippet(response)
    return {
      error: {
        status: response.status,
        url,
        body,
      },
    }
  }
  const payload = await response.json()
  const result = payload?.chart?.result?.[0]
  const quote = result?.indicators?.quote?.[0]
  const close = Number(lastValid(quote?.close))
  if (!Number.isFinite(close)) return null
  return {
    symbol: normalized,
    price: close,
    source: 'yahoo',
    lastUpdate: Date.now(),
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.status(204).end()
    return
  }

  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo nao permitido.' })
    return
  }

  const symbol = String(req.query?.symbol || '').trim()
  if (!symbol) {
    res.status(400).json({ error: 'Parametro symbol e obrigatorio.' })
    return
  }

  try {
    let payload = null
    if (isBrazilianSymbol(symbol)) {
      payload = await fetchBrapiSpot(symbol)
    }

    if (!payload) {
      const yahoo = await fetchYahooSpot(symbol)
      if (yahoo?.error) {
        res.status(502).json({
          error: 'Falha ao buscar spot.',
          source: 'yahoo',
          status: yahoo.error.status,
          url: yahoo.error.url,
          detailsSnippet: yahoo.error.body,
        })
        return
      }
      payload = yahoo
    }

    if (!payload || !Number.isFinite(Number(payload.price))) {
      res.status(502).json({ error: 'Spot indisponivel para o simbolo informado.' })
      return
    }

    res.status(200).json({
      symbol: payload.symbol || normalizeYahooSymbol(symbol),
      price: Number(payload.price),
      source: payload.source || 'unknown',
      lastUpdate: payload.lastUpdate || Date.now(),
    })
  } catch (error) {
    res.status(500).json({
      error: 'Erro ao consultar spot.',
      message: error?.message || 'erro desconhecido',
    })
  }
}
