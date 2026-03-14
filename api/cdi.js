const { getCdiSnapshot } = require('./lib/cdi')

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

  try {
    const snapshot = await getCdiSnapshot()
    res.status(200).json(snapshot)
  } catch (error) {
    res.status(error?.status || 502).json({
      error: 'Falha ao consultar CDI.',
      message: error?.message || 'erro desconhecido',
      details: error?.details || [],
    })
  }
}
