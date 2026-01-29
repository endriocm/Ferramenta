const { getDividendsResult, normalizeDateKey, normalizeTicker } = require('./lib/dividends')

const readJsonBody = (req) => new Promise((resolve, reject) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    if (!raw) {
      resolve({})
      return
    }
    try {
      resolve(JSON.parse(raw))
    } catch (error) {
      reject(error)
    }
  })
  req.on('error', reject)
})

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index
      index += 1
      if (current >= items.length) break
      results[current] = await mapper(items[current], current)
    }
  })
  await Promise.all(workers)
  return results
}

const buildKey = (ticker, from, to) => `${normalizeTicker(ticker)}|${normalizeDateKey(from)}|${normalizeDateKey(to)}`

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.status(204).end()
    return
  }

  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method === 'GET') {
    const { ticker, from, to } = req.query || {}
    if (!ticker || !from || !to) {
      res.status(400).json({ error: 'Parametros invalidos.' })
      return
    }
    const debug = req.query?.debug === '1' || req.query?.debug === 'true'
    try {
      const result = await getDividendsResult({ ticker, from, to, includeEvents: debug })
      res.status(200).json(result)
    } catch (error) {
      res.status(error?.status || 502).json({
        error: 'Falha ao buscar dividendos.',
        providers: error?.providers || [],
      })
    }
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo nao permitido.' })
    return
  }

  try {
    const body = await readJsonBody(req)
    const requests = Array.isArray(body?.requests) ? body.requests : []
    if (!requests.length) {
      res.status(400).json({ error: 'Lista vazia.' })
      return
    }
    const debug = body?.debug === true
    const results = await mapWithConcurrency(requests, 4, async (request) => {
      if (!request?.ticker || !request?.from || !request?.to) {
        return {
          key: buildKey(request?.ticker, request?.from, request?.to),
          ticker: normalizeTicker(request?.ticker),
          from: request?.from,
          to: request?.to,
          total: 0,
          source: 'invalid',
        }
      }
      try {
        const result = await getDividendsResult({
          ticker: request.ticker,
          from: request.from,
          to: request.to,
          includeEvents: debug,
        })
        return {
          key: buildKey(request.ticker, request.from, request.to),
          ...result,
        }
      } catch (error) {
        return {
          key: buildKey(request.ticker, request.from, request.to),
          ticker: normalizeTicker(request.ticker),
          from: normalizeDateKey(request.from),
          to: normalizeDateKey(request.to),
          total: 0,
          source: 'error',
          error: error?.message || 'Falha ao buscar dividendos.',
        }
      }
    })
    res.status(200).json({ results })
  } catch {
    res.status(500).json({ error: 'Falha ao processar dividendos.' })
  }
}
