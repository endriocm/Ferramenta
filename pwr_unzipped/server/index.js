const express = require('express')
const cors = require('cors')
const multer = require('multer')
const XLSX = require('xlsx')
const { getBrapiToken, getDividendsResult } = require('../api/lib/dividends')

const PORT = process.env.PORT || 4170

const app = express()
app.use(cors())

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

const normalizeKey = (value) => String(value || '')
  .toLowerCase()
  .replace(/\s+/g, '')
  .replace(/[^a-z0-9]/g, '')

const normalizeSheetName = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, '')

const pickSheetName = (workbook) => {
  if (!workbook?.SheetNames?.length) return null
  const preferred = workbook.SheetNames.find((name) => {
    const normalized = normalizeSheetName(name)
    return normalized.includes('posicaoconsolidada')
      || (normalized.includes('posicao') && normalized.includes('consolidada'))
  })
  return preferred || workbook.SheetNames[0]
}

const getValue = (row, keys) => {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return row[key]
  }
  return null
}

const toNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
  if (!cleaned) return null
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeDate = (value) => {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && XLSX?.SSF?.parse_date_code) {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed?.y && parsed?.m && parsed?.d) {
      const date = new Date(parsed.y, parsed.m - 1, parsed.d)
      return date.toISOString().slice(0, 10)
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const match = trimmed.match(/(\d{2})[\/-](\d{2})[\/-](\d{4})/)
    if (match) {
      const [, day, month, year] = match
      const date = new Date(`${year}-${month}-${day}T00:00:00`)
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
  }
  return value
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

const mapLegType = (value) => {
  const upper = String(value || '').toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  if (!upper) return null
  if (upper.includes('STOCK') || upper.includes('ESTOQUE') || upper.includes('ACAO')) return 'STOCK'
  if (upper.includes('CALL')) return 'CALL'
  if (upper.includes('PUT')) return 'PUT'
  return null
}

const parsePosicaoConsolidada = (normalizedRow) => {
  const hasLayout = normalizedRow.tipo1 || normalizedRow.quantidadeativa1 || normalizedRow.valordostrike1
  if (!hasLayout) return null

  const legs = []
  let quantidadeStock = null

  for (let i = 1; i <= 4; i += 1) {
    const tipoRaw = getValue(normalizedRow, [`tipo${i}`])
    const mapped = mapLegType(tipoRaw)
    const qty = toNumber(getValue(normalizedRow, [`quantidadeativa${i}`]))
    const strike = toNumber(getValue(normalizedRow, [`valordostrike${i}`]))
    const barreiraValor = toNumber(getValue(normalizedRow, [`valordabarreira${i}`]))
    const barreiraTipo = getValue(normalizedRow, [`tipodabarreira${i}`])
    const rebate = toNumber(getValue(normalizedRow, [`valordorebate${i}`]))

    if (!mapped && qty == null && strike == null && barreiraValor == null) continue

    if (mapped === 'STOCK') {
      if (qty != null) quantidadeStock = (quantidadeStock ?? 0) + qty
      continue
    }

    if (mapped === 'CALL' || mapped === 'PUT') {
      legs.push({
        id: `leg-${i}`,
        tipo: mapped,
        quantidade: qty ?? 0,
        strike: strike ?? null,
        barreiraValor: barreiraValor ?? null,
        barreiraTipo,
        rebate: rebate ?? 0,
      })
    }
  }

  const spotInicial = toNumber(getValue(normalizedRow, ['valorativo']))
  const custoUnitarioRaw = toNumber(getValue(normalizedRow, ['custounitariocliente']))
  const custoUnitario = custoUnitarioRaw > 0 ? custoUnitarioRaw : spotInicial

  const codigoCliente = getValue(normalizedRow, ['codigodocliente'])
  const codigoOperacao = getValue(normalizedRow, ['codigodaoperacao'])

  return {
    id: String(codigoOperacao || Math.random().toString(36).slice(2)),
    codigoCliente,
    cliente: codigoCliente,
    assessor: getValue(normalizedRow, ['codigodoassessor', 'assessor', 'consultor']),
    broker: getValue(normalizedRow, ['canaldeorigem', 'broker', 'corretora']),
    ativo: getValue(normalizedRow, ['ativo', 'ticker']),
    estrutura: getValue(normalizedRow, ['estrutura', 'tipoestrutura']),
    codigoOperacao,
    dataRegistro: normalizeDate(getValue(normalizedRow, ['dataregistro'])),
    vencimento: normalizeDate(getValue(normalizedRow, ['datavencimento'])),
    spotInicial: spotInicial ?? null,
    custoUnitario: custoUnitario ?? null,
    quantidade: quantidadeStock ?? 0,
    cupom: getValue(normalizedRow, ['cupom', 'taxacupom']),
    pagou: toNumber(getValue(normalizedRow, ['pagou'])),
    pernas: legs,
  }
}

const parseLegs = (row) => {
  const legs = []
  for (let i = 1; i <= 4; i += 1) {
    const prefix = `perna${i}`
    const tipo = getValue(row, [`${prefix}tipo`, `${prefix}opcao`, `${prefix}tipoperna`])
    const strike = toNumber(getValue(row, [`${prefix}strike`, `${prefix}preco`, `${prefix}precoexercicio`]))
    const barreiraValor = toNumber(getValue(row, [`${prefix}barreira`, `${prefix}nivelbarreira`]))
    const barreiraTipo = getValue(row, [`${prefix}tipobarreira`, `${prefix}barreiratipo`])
    const rebate = toNumber(getValue(row, [`${prefix}rebate`, `${prefix}rebatevalor`]))
    if (!tipo && strike == null && barreiraValor == null) continue
    legs.push({
      id: `${prefix}`,
      tipo,
      strike,
      barreiraValor,
      barreiraTipo,
      rebate: rebate ?? 0,
    })
  }
  return legs
}

const parseColumnLegs = (row, quantity) => {
  const legs = []
  const callComprada = toNumber(getValue(row, ['callcomprada', 'callcompra']))
  const callVendida = toNumber(getValue(row, ['callvendida', 'callvenda']))
  const putComprada = toNumber(getValue(row, ['putcomprada', 'putcompra']))
  const putComprada2 = toNumber(getValue(row, ['putcomprada2', 'putcompra2']))
  const putVendida = toNumber(getValue(row, ['putvendida', 'putvenda']))

  if (callComprada) legs.push({ id: 'call-comprada', tipo: 'CALL', side: 'long', strike: callComprada, quantidade: quantity })
  if (callVendida) legs.push({ id: 'call-vendida', tipo: 'CALL', side: 'short', strike: callVendida, quantidade: quantity })
  if (putComprada) legs.push({ id: 'put-comprada', tipo: 'PUT', side: 'long', strike: putComprada, quantidade: quantity })
  if (putComprada2) legs.push({ id: 'put-comprada-2', tipo: 'PUT', side: 'long', strike: putComprada2, quantidade: quantity })
  if (putVendida) legs.push({ id: 'put-vendida', tipo: 'PUT', side: 'short', strike: putVendida, quantidade: quantity })

  const barreiraKi = toNumber(getValue(row, ['barreiraki', 'barreira_ki']))
  const barreiraKo = toNumber(getValue(row, ['barreirako', 'barreira_ko']))
  if (barreiraKi) legs.push({ id: 'barreira-ki', barreiraValor: barreiraKi, barreiraTipo: 'KI' })
  if (barreiraKo) legs.push({ id: 'barreira-ko', barreiraValor: barreiraKo, barreiraTipo: 'KO' })

  return legs
}

const parseBuffer = (buffer) => {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheetName = pickSheetName(workbook)
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })

  return rows.map((row) => {
    const normalizedRow = Object.keys(row).reduce((acc, key) => {
      acc[normalizeKey(key)] = row[key]
      return acc
    }, {})

    const posicaoRow = parsePosicaoConsolidada(normalizedRow)
    if (posicaoRow) return posicaoRow

    const dataRegistro = normalizeDate(getValue(normalizedRow, ['dataregistro', 'dataderegistro', 'dataentrada', 'datainicio', 'entrada']))
    const dataVencimento = normalizeDate(getValue(normalizedRow, ['datavencimento', 'datadevencimento', 'datafim', 'vencimento']))

    const quantidade = toNumber(getValue(normalizedRow, ['quantidade', 'qtd', 'lote']))
    const pernas = parseLegs(normalizedRow)
    const columnLegs = parseColumnLegs(normalizedRow, quantidade)

    return {
      id: String(getValue(normalizedRow, ['id', 'operacao', 'codigooperacao']) || Math.random().toString(36).slice(2)),
      cliente: getValue(normalizedRow, ['cliente', 'nomecliente']),
      assessor: getValue(normalizedRow, ['assessor', 'consultor']),
      broker: getValue(normalizedRow, ['broker', 'corretora']),
      ativo: getValue(normalizedRow, ['ativo', 'ticker']),
      estrutura: getValue(normalizedRow, ['estrutura', 'tipoestrutura']),
      codigoOperacao: getValue(normalizedRow, ['codigooperacao', 'operacao', 'codigo']),
      dataRegistro: dataRegistro || '',
      vencimento: dataVencimento || '',
      spotInicial: toNumber(getValue(normalizedRow, ['spotinicial', 'spotentrada', 'spot', 'valordecompra', 'valorentrada'])),
      custoUnitario: toNumber(getValue(normalizedRow, ['custounitario', 'custounit', 'custo'])),
      quantidade: quantidade ?? 0,
      cupom: getValue(normalizedRow, ['cupom', 'taxacupom']),
      pagou: toNumber(getValue(normalizedRow, ['pagou'])),
      pernas: pernas.length ? pernas : columnLegs,
    }
  })
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/dividends', async (req, res) => {
  const { ticker, from, to, debug } = req.query || {}
  if (!ticker || !from || !to) {
    res.status(400).json({ error: 'Parametros invalidos.' })
    return
  }
  try {
    const result = await getDividendsResult({
      ticker,
      from,
      to,
      includeEvents: debug === '1' || debug === 'true',
    })
    res.json(result)
  } catch (error) {
    res.status(error?.status || 502).json({
      error: 'Falha ao buscar dividendos.',
      providers: error?.providers || [],
    })
  }
})

app.get('/api/quotes', async (req, res) => {
  const { symbol, startDate, endDate, start, end } = req.query || {}
  if (!symbol || (!startDate && !start) || (!endDate && !end)) {
    res.status(400).json({ error: 'Parametros invalidos.' })
    return
  }

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

  const normalized = normalizeYahooSymbol(symbol)
  const startSec = start ? Number(start) : Math.floor(new Date(startDate).getTime() / 1000)
  const endSec = end ? Number(end) : Math.floor(new Date(endDate).getTime() / 1000) + 86400
  try {
    if (isBrazilianSymbol(symbol)) {
      const brapiSymbol = normalizeBrapiSymbol(symbol)
      const brapiUrl = `https://brapi.dev/api/quote/${encodeURIComponent(brapiSymbol)}`
      const brapiToken = getBrapiToken()
      const brapiHeaders = {}
      if (brapiToken) {
        brapiHeaders.Authorization = `Bearer ${brapiToken}`
      }
      const brapiResponse = await fetch(brapiUrl, { headers: brapiHeaders })
      if (brapiResponse.ok) {
        const brapiPayload = await brapiResponse.json()
        const result = brapiPayload?.results?.[0]
        if (result?.regularMarketPrice != null) {
          res.json({
            symbol: result.symbol || brapiSymbol,
            close: result.regularMarketPrice,
            high: result.regularMarketDayHigh ?? null,
            low: result.regularMarketDayLow ?? null,
            dividendsTotal: 0,
            source: 'brapi',
            lastUpdate: Date.now(),
          })
          return
        }
      }
    }
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?period1=${startSec}&period2=${endSec}&interval=1d&events=div`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    })
    if (!response.ok) {
      const body = await readBodySnippet(response)
      res.status(502).json({
        error: 'Falha ao buscar cotacao.',
        source: 'yahoo',
        status: response.status,
        url,
        body,
        detailsSnippet: body,
      })
      return
    }
    const payload = await response.json()
    const result = payload?.chart?.result?.[0]
    const quote = result?.indicators?.quote?.[0]
    const lastValid = (values) => {
      if (!Array.isArray(values)) return null
      for (let i = values.length - 1; i >= 0; i -= 1) {
        const value = values[i]
        if (value != null) return value
      }
      return null
    }
    const getRangeStats = (values) => {
      if (!Array.isArray(values)) return { min: null, max: null }
      const filtered = values.filter((value) => value != null)
      if (!filtered.length) return { min: null, max: null }
      return {
        min: Math.min(...filtered),
        max: Math.max(...filtered),
      }
    }
    const close = lastValid(quote?.close)
    const highs = getRangeStats(quote?.high)
    const lows = getRangeStats(quote?.low)

    const dividendsObj = result?.events?.dividends || {}
    const dividends = Object.values(dividendsObj)
    const dividendTotal = dividends.reduce((sum, item) => sum + (item?.amount || 0), 0)

    res.json({
      symbol: normalized,
      close,
      high: highs.max,
      low: lows.min,
      dividendsTotal: dividendTotal,
      source: 'yahoo',
      lastUpdate: Date.now(),
    })
  } catch (error) {
    res.status(500).json({
      error: 'Erro ao consultar Yahoo.',
      message: error?.message,
    })
  }
})

app.post('/api/vencimentos/parse', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Arquivo nao enviado.' })
    return
  }
  try {
    const rows = parseBuffer(req.file.buffer)
    res.json({ rows, fileName: req.file.originalname })
  } catch (error) {
    res.status(500).json({ error: 'Falha ao ler a planilha.' })
  }
})

app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`)
})
