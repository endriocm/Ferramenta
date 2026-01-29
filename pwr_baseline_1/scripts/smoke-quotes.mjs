const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
const symbols = ['MELI34', 'VAMO3']
const range = {
  startDate: '2025-01-01',
  endDate: '2025-01-10',
}

const safeJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const fetchAndPrint = async (url) => {
  const response = await fetch(url)
  const text = await response.text()
  const data = safeJson(text)
  const payload = data ?? text.slice(0, 300)
  console.log(JSON.stringify({
    url,
    status: response.status,
    ok: response.ok,
    payload,
  }, null, 2))
}

const run = async () => {
  for (const symbol of symbols) {
    await fetchAndPrint(`${baseUrl}/api/spot?symbol=${encodeURIComponent(symbol)}`)
    await fetchAndPrint(`${baseUrl}/api/quotes?symbol=${encodeURIComponent(symbol)}&startDate=${range.startDate}&endDate=${range.endDate}`)
  }
}

run().catch((error) => {
  console.error('smoke-quotes failed:', error?.message || error)
  process.exit(1)
})
