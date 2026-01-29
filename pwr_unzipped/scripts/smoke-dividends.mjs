const baseUrl = process.env.DIVIDENDS_URL || 'http://localhost:4170'

const run = async (ticker, from, to) => {
  const url = new URL('/api/dividends', baseUrl)
  url.searchParams.set('ticker', ticker)
  url.searchParams.set('from', from)
  url.searchParams.set('to', to)
  url.searchParams.set('debug', '1')
  const response = await fetch(url.toString())
  const payload = await response.json().catch(() => ({}))
  console.log({
    status: response.status,
    ticker: payload.ticker,
    source: payload.source,
    total: payload.total,
    events: Array.isArray(payload.events) ? payload.events.length : 0,
  })
}

await run('PETR4.SA', '2025-08-20', '2025-08-22')
await run('PETR4.SA', '2025-12-05', '2026-01-06')
