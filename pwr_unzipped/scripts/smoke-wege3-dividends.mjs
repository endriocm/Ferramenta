const main = async () => {
  const url = 'http://localhost:4170/api/dividends?ticker=WEGE3.SA&from=2025-02-28&to=2025-12-19&debug=1'
  const res = await fetch(url)
  if (!res.ok) {
    console.error('Falha na API', res.status)
    process.exit(1)
  }
  const data = await res.json()
  const total = Number(data?.total || 0)
  const quantity = 200
  const totalEstrutura = total * quantity
  const events = Array.isArray(data?.events) ? data.events : []
  console.log(JSON.stringify({
    ticker: data?.ticker,
    from: data?.from,
    to: data?.to,
    source: data?.source,
    totalPorAcao: total,
    totalEstrutura,
    eventsCount: events.length,
    sampleEvents: events.slice(0, 5),
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
