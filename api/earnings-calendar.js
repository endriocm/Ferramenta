const { getEarningsCalendarSnapshot, parseSymbolsParam } = require('./lib/earningsCalendar')

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo nao permitido.' })
    return
  }

  const symbols = parseSymbolsParam(req.query?.symbols || req.query?.symbolsList || req.query?.tickers || '')
  if (!symbols.length) {
    res.status(400).json({
      error: 'Parametro symbols e obrigatorio (ex.: PETR4,NVDA,MSFT).',
    })
    return
  }

  try {
    const scrapeParam = String(req.query?.scrape || '').toLowerCase()
    const scrape = scrapeParam !== 'false' && scrapeParam !== '0'
    const payload = await getEarningsCalendarSnapshot({
      symbols,
      from: req.query?.from,
      to: req.query?.to,
      scrape,
    })
    res.status(200).json(payload)
  } catch (error) {
    res.status(500).json({
      error: 'Falha ao montar calendario de resultados.',
      message: error?.message || 'erro desconhecido',
    })
  }
}
