export default async function handler(req, res) {
  try {
    const symbol = String(req.query.symbol || '').trim()
    if (!symbol) return res.status(400).json({ error: 'Faltou ?symbol=PETR4' })

    const token = process.env.BRAPI_TOKEN || process.env.brapi_token
    if (!token) return res.status(500).json({ error: 'BRAPI_TOKEN nao configurado no Vercel/.env.local' })

    const url = `https://brapi.dev/api/quote/${encodeURIComponent(symbol)}`
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })

    const data = await r.json()
    const price = data?.results?.[0]?.regularMarketPrice

    if (price == null) return res.status(404).json({ error: 'Preco nao encontrado', raw: data })

    return res.status(200).json({ symbol, price })
  } catch (e) {
    return res.status(500).json({ error: 'Erro geral', detail: String(e) })
  }
}
