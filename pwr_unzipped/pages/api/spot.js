export default async function handler(req, res) {
  try {
    const symbol = String(req.query.symbol || '').trim()
    if (!symbol) return res.status(400).json({ error: 'Faltou ?symbol=PETR4' })
    const normalized = symbol.toUpperCase().replace(/\.SA$/, '')

    const getBrapiToken = () => process.env.BRAPI_TOKEN || process.env.brapi_token || process.env.BRAPI_API_KEY
    const normalizeYahooSymbol = (ticker) => {
      if (!ticker) return ''
      const raw = String(ticker).trim().toUpperCase()
      if (raw.includes('.')) return raw
      if (/^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw)) return `${raw}.SA`
      return raw
    }
    const readPayload = async (response) => {
      try {
        const text = await response.text()
        return { text, data: text ? JSON.parse(text) : null }
      } catch {
        return { text: '', data: null }
      }
    }
    const snippet = (text) => (text ? text.slice(0, 300) : '')

    const token = getBrapiToken()
    const brapiUrl = `https://brapi.dev/api/quote/${encodeURIComponent(normalized)}`
    const brapiHeaders = token ? { Authorization: `Bearer ${token}` } : {}
    const brapiResponse = await fetch(brapiUrl, { headers: brapiHeaders })

    const brapiPayload = await readPayload(brapiResponse)
    const price = brapiPayload.data?.results?.[0]?.regularMarketPrice

    if (brapiResponse.ok && price != null) {
      return res.status(200).json({ symbol: normalized, price, source: 'brapi' })
    }

    const yahooSymbol = normalizeYahooSymbol(symbol)
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`
    const yahooResponse = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    })
    const yahooPayload = await readPayload(yahooResponse)
    if (!yahooResponse.ok) {
      return res.status(502).json({
        error: 'spot_unavailable',
        source: 'yahoo',
        status: yahooResponse.status,
        detailsSnippet: snippet(yahooPayload.text),
      })
    }
    const result = yahooPayload.data?.chart?.result?.[0]
    const meta = result?.meta
    const closes = result?.indicators?.quote?.[0]?.close || []
    const lastClose = closes.length ? closes[closes.length - 1] : null
    const yahooPrice = meta?.regularMarketPrice ?? lastClose

    if (yahooPrice == null) {
      return res.status(502).json({
        error: 'spot_unavailable',
        source: 'yahoo',
        status: yahooResponse.status,
        detailsSnippet: snippet(yahooPayload.text),
      })
    }

    return res.status(200).json({ symbol: yahooSymbol, price: yahooPrice, source: 'yahoo' })
  } catch (e) {
    return res.status(500).json({ error: 'Erro geral', source: 'server', status: 500, detailsSnippet: String(e).slice(0, 300) })
  }
}
