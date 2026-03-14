const { getDividendsCalendarSnapshot } = require('./lib/dividendsCalendar')

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

  const { from, to } = req.query || {}
  const typesRaw = String(req.query?.types || '').trim()
  const types = typesRaw
    ? typesRaw.split(',').map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : undefined

  try {
    const payload = await getDividendsCalendarSnapshot({
      from,
      to,
      types,
      country: 1,
    })
    res.status(200).json(payload)
  } catch (error) {
    res.status(error?.status || 502).json({
      error: 'Falha ao montar calendario global de proventos.',
      message: error?.message || 'erro desconhecido',
    })
  }
}

