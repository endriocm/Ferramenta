const express = require('express')
const cors = require('cors')
const multer = require('multer')
const { getDividendsResult } = require('../api/lib/dividends')
const { getBonusResult } = require('../api/lib/bonus')
const { getDividendsCalendarSnapshot } = require('../api/lib/dividendsCalendar')
const { getCdiSnapshot } = require('../api/lib/cdi')
const { getEarningsCalendarSnapshot, parseSymbolsParam } = require('../api/lib/earningsCalendar')
const { registerHubxpOrdersRoutes } = require('./hubxpOrders')
const { registerOutlookRoutes } = require('./outlookMail')

const PORT = process.env.PORT || 4170
const debugReceitas = process.env.DEBUG_RECEITAS === '1'

const app = express()
const corsOptions = {
  origin: true,
  credentials: false,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Disposition'],
  optionsSuccessStatus: 204,
  maxAge: 86400,
}
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json({ limit: '1mb' }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

let xlsxModule = null
let parseStructuredReceitas = null
let parseBovespaReceitas = null

const getXlsx = () => {
  if (!xlsxModule) {
    xlsxModule = require('xlsx')
  }
  return xlsxModule
}

const getStructuredReceitasParser = () => {
  if (!parseStructuredReceitas) {
    ({ parseStructuredReceitas } = require('../api/lib/estruturadasParser'))
  }
  return parseStructuredReceitas
}

const getBovespaReceitasParser = () => {
  if (!parseBovespaReceitas) {
    ({ parseBovespaReceitas } = require('../api/lib/bovespaParser'))
  }
  return parseBovespaReceitas
}

const normalizeKey = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
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
  if (typeof value === 'number') {
    const XLSX = getXlsx()
    if (!XLSX?.SSF?.parse_date_code) return value
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

const normalizeYahooSymbol = (ticker) => {
  if (!ticker) return ''
  const raw = String(ticker).trim().toUpperCase()
  if (raw.includes('.')) return raw
  if (/^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw)) return `${raw}.SA`
  return raw
}

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

const toDateKeyFromUnix = (value) => {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

const buildSeries = (timestamps, quote) => {
  if (!Array.isArray(timestamps) || !quote || typeof quote !== 'object') return []
  const open = Array.isArray(quote.open) ? quote.open : []
  const high = Array.isArray(quote.high) ? quote.high : []
  const low = Array.isArray(quote.low) ? quote.low : []
  const close = Array.isArray(quote.close) ? quote.close : []
  const series = []

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = Number(timestamps[index])
    if (!Number.isFinite(timestamp)) continue
    const row = {
      timestamp,
      date: toDateKeyFromUnix(timestamp),
      open: open[index] != null ? Number(open[index]) : null,
      high: high[index] != null ? Number(high[index]) : null,
      low: low[index] != null ? Number(low[index]) : null,
      close: close[index] != null ? Number(close[index]) : null,
    }
    if (row.open == null && row.high == null && row.low == null && row.close == null) continue
    series.push(row)
  }

  return series
}

const fetchYahooSpot = async (symbol, { startSec = null, endSec = null, withSeries = false } = {}) => {
  const normalizedSymbol = normalizeYahooSymbol(symbol)
  const periodStart = Number.isFinite(startSec)
    ? startSec
    : Math.floor((Date.now() - (7 * 24 * 60 * 60 * 1000)) / 1000)
  const periodEnd = Number.isFinite(endSec)
    ? endSec
    : Math.floor(Date.now() / 1000) + 86400
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalizedSymbol)}?period1=${periodStart}&period2=${periodEnd}&interval=1d&events=div`
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  })
  if (!response.ok) {
    const body = await readBodySnippet(response)
    return {
      error: {
        status: response.status,
        url,
        body,
      },
    }
  }
  const payload = await response.json()
  const result = payload?.chart?.result?.[0]
  const quote = result?.indicators?.quote?.[0]
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : []
  const series = withSeries ? buildSeries(timestamps, quote) : []
  const close = lastValid(quote?.close)
  const highs = getRangeStats(quote?.high)
  const lows = getRangeStats(quote?.low)
  const dividendsObj = result?.events?.dividends || {}
  const dividends = Object.values(dividendsObj)
  const dividendTotal = dividends.reduce((sum, item) => sum + (item?.amount || 0), 0)
  return {
    symbol: normalizedSymbol,
    close,
    high: highs.max,
    low: lows.min,
    dividendsTotal: dividendTotal,
    series,
    source: 'yahoo',
    lastUpdate: Date.now(),
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
    const qtyAtiva = toNumber(getValue(normalizedRow, [`quantidadeativa${i}`]))
    const qtyBoleta = toNumber(getValue(normalizedRow, [`quantidadeboleta${i}`]))
    const optionQty = qtyAtiva != null && qtyAtiva !== 0
      ? qtyAtiva
      : (qtyBoleta ?? null)
    const strike = toNumber(getValue(normalizedRow, [`valordostrike${i}`]))
    const barreiraValor = toNumber(getValue(normalizedRow, [`valordabarreira${i}`]))
    const barreiraTipo = getValue(normalizedRow, [`tipodabarreira${i}`])
    const rebate = toNumber(getValue(normalizedRow, [`valordorebate${i}`]))

    if (!mapped && optionQty == null && strike == null && barreiraValor == null) continue

    if (mapped === 'STOCK') {
      if (qtyAtiva != null && qtyAtiva !== 0) quantidadeStock = (quantidadeStock ?? 0) + Math.abs(qtyAtiva)
      continue
    }

    if (mapped === 'CALL' || mapped === 'PUT') {
      legs.push({
        id: `leg-${i}`,
        tipo: mapped,
        quantidade: optionQty ?? 0,
        quantidadeAtiva: qtyAtiva ?? null,
        quantidadeContratada: qtyBoleta ?? null,
        strike: strike ?? null,
        barreiraValor: barreiraValor ?? null,
        barreiraTipo,
        rebate: rebate ?? 0,
      })
    }
  }

  const spotInicial = toNumber(getValue(normalizedRow, ['valorativo']))
  const quantidadeAtual = toNumber(getValue(normalizedRow, [
    'quantidadeatual',
    'qtdatual',
    'qtd_atual',
    'posicaoatual',
    'quantidadefinal',
    'qtdeatual',
  ]))
  const custoUnitarioRaw = toNumber(getValue(normalizedRow, ['custounitariocliente', 'custounitriocliente']))
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
    custoUnitarioCliente: custoUnitarioRaw ?? null,
    quantidade: quantidadeStock ?? 0,
    quantidadeAtual: quantidadeAtual ?? null,
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
  const XLSX = getXlsx()
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

app.get('/api/cdi', async (_req, res) => {
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

app.post('/api/dividends', async (req, res) => {
  const requests = Array.isArray(req.body?.requests) ? req.body.requests : []
  if (!requests.length) {
    res.status(400).json({ error: 'Lista vazia.' })
    return
  }
  const includeEvents = req.body?.includeEvents === true
  const buildKey = (ticker, from, to) => `${String(ticker || '').trim().toUpperCase()}|${from || ''}|${to || ''}`
  const limit = 4
  let index = 0
  const results = new Array(requests.length)
  const workers = Array.from({ length: Math.min(limit, requests.length) }, async () => {
    while (true) {
      const current = index
      index += 1
      if (current >= requests.length) break
      const request = requests[current]
      if (!request?.ticker || !request?.from || !request?.to) {
        results[current] = {
          key: buildKey(request?.ticker, request?.from, request?.to),
          total: 0,
          source: 'invalid',
        }
        continue
      }
      try {
        const result = await getDividendsResult({
          ticker: request.ticker,
          from: request.from,
          to: request.to,
          includeEvents,
        })
        results[current] = { key: buildKey(request.ticker, request.from, request.to), ...result }
      } catch (error) {
        results[current] = {
          key: buildKey(request.ticker, request.from, request.to),
          total: 0,
          source: 'error',
          error: error?.message || 'Falha ao buscar dividendos.',
        }
      }
    }
  })
  await Promise.all(workers)
  res.json({ results })
})

app.get('/api/bonus', async (req, res) => {
  const { ticker, from, to, debug, includeEvents } = req.query || {}
  if (!ticker || !from || !to) {
    res.status(400).json({ error: 'Parametros invalidos.' })
    return
  }
  const shouldIncludeEvents = includeEvents === '1' || includeEvents === 'true' || debug === '1' || debug === 'true'
  const key = `${String(ticker || '').trim().toUpperCase()}|${from || ''}|${to || ''}`
  try {
    const result = await getBonusResult({
      ticker,
      from,
      to,
      includeEvents: shouldIncludeEvents,
    })
    res.json({ key, ...result })
  } catch (error) {
    res.status(error?.status || 502).json({
      error: 'Falha ao buscar bonificacoes.',
      providers: error?.providers || [],
    })
  }
})

app.post('/api/bonus', async (req, res) => {
  const requests = Array.isArray(req.body?.requests) ? req.body.requests : []
  if (!requests.length) {
    res.status(400).json({ error: 'Lista vazia.' })
    return
  }
  const includeEvents = req.body?.includeEvents === true
  const buildKey = (ticker, from, to) => `${String(ticker || '').trim().toUpperCase()}|${from || ''}|${to || ''}`
  const limit = 4
  let index = 0
  const results = new Array(requests.length)
  const workers = Array.from({ length: Math.min(limit, requests.length) }, async () => {
    while (true) {
      const current = index
      index += 1
      if (current >= requests.length) break
      const request = requests[current]
      if (!request?.ticker || !request?.from || !request?.to) {
        results[current] = {
          key: buildKey(request?.ticker, request?.from, request?.to),
          factor: 1,
          totalPct: 0,
          source: 'invalid',
        }
        continue
      }
      try {
        const result = await getBonusResult({
          ticker: request.ticker,
          from: request.from,
          to: request.to,
          includeEvents,
        })
        results[current] = { key: buildKey(request.ticker, request.from, request.to), ...result }
      } catch (error) {
        results[current] = {
          key: buildKey(request.ticker, request.from, request.to),
          factor: 1,
          totalPct: 0,
          source: 'error',
          error: error?.message || 'Falha ao buscar bonificacoes.',
        }
      }
    }
  })
  await Promise.all(workers)
  res.json({ results })
})

app.get('/api/dividends-calendar', async (req, res) => {
  try {
    const { from, to } = req.query || {}
    const typesRaw = String(req.query?.types || '').trim()
    const types = typesRaw
      ? typesRaw.split(',').map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : undefined
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
})

app.get('/api/earnings-calendar', async (req, res) => {
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
})

app.get('/api/spot', async (req, res) => {
  const symbol = String(req.query?.symbol || '').trim()
  if (!symbol) {
    res.status(400).json({ error: 'Parametro symbol e obrigatorio.' })
    return
  }

  try {
    const yahoo = await fetchYahooSpot(symbol)
    if (yahoo?.error) {
      res.status(502).json({
        error: 'Falha ao buscar spot.',
        source: 'yahoo',
        status: yahoo.error.status,
        url: yahoo.error.url,
        detailsSnippet: yahoo.error.body,
      })
      return
    }
    const close = Number(yahoo?.close)
    if (!Number.isFinite(close)) {
      res.status(502).json({ error: 'Spot indisponivel para o simbolo informado.', source: 'yahoo' })
      return
    }

    res.json({
      symbol: yahoo.symbol || normalizeYahooSymbol(symbol),
      price: close,
      source: yahoo.source || 'yahoo',
      lastUpdate: yahoo.lastUpdate || Date.now(),
    })
  } catch (error) {
    res.status(500).json({
      error: 'Erro ao consultar spot.',
      message: error?.message || 'erro desconhecido',
    })
  }
})

app.get('/api/quotes', async (req, res) => {
  const { symbol, startDate, endDate, start, end, includeSeries } = req.query || {}
  if (!symbol || (!startDate && !start) || (!endDate && !end)) {
    res.status(400).json({ error: 'Parametros invalidos.' })
    return
  }
  const startSec = start ? Number(start) : Math.floor(new Date(startDate).getTime() / 1000)
  const endSec = end ? Number(end) : Math.floor(new Date(endDate).getTime() / 1000) + 86400
  const withSeries = String(includeSeries || '').trim() === '1'

  try {
    const yahoo = await fetchYahooSpot(symbol, { startSec, endSec, withSeries })
    if (yahoo?.error) {
      res.status(502).json({
        error: 'Falha ao buscar cotacao.',
        source: 'yahoo',
        status: yahoo.error.status,
        url: yahoo.error.url,
        detailsSnippet: yahoo.error.body,
      })
      return
    }

    res.json({
      symbol: yahoo.symbol || normalizeYahooSymbol(symbol),
      close: yahoo.close ?? null,
      high: yahoo.high ?? null,
      low: yahoo.low ?? null,
      dividendsTotal: yahoo.dividendsTotal ?? 0,
      series: Array.isArray(yahoo.series) ? yahoo.series : [],
      source: yahoo.source || 'yahoo',
      lastUpdate: yahoo.lastUpdate || Date.now(),
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

app.post('/api/receitas/estruturadas/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: { code: 'FILE_NOT_RECEIVED', message: 'Arquivo nao enviado.' } })
    return
  }
  try {
    const parseStructured = getStructuredReceitasParser()
    const result = parseStructured(req.file.buffer)
    if (!result.ok) {
      res.status(400).json(result)
      return
    }
    if (debugReceitas) {
      console.log('[receitas] structured:stats', result.summary)
    }
    res.status(200).json({ ...result, fileName: req.file.originalname })
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'PARSER_FAILED', message: 'Falha ao ler a planilha.' } })
  }
})

app.post('/api/receitas/bovespa/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: { code: 'FILE_NOT_RECEIVED', message: 'Arquivo nao enviado.' } })
    return
  }
  try {
    const parseBovespa = getBovespaReceitasParser()
    const result = parseBovespa(req.file.buffer, { mercado: 'bov', fatorReceita: 0.9335 * 0.8285 })
    if (!result.ok) {
      res.status(400).json(result)
      return
    }
    if (debugReceitas) {
      console.log('[receitas] bovespa:stats', result.summary)
    }
    res.status(200).json({ ...result, fileName: req.file.originalname })
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'PARSER_FAILED', message: 'Falha ao ler a planilha.' } })
  }
})

app.post('/api/receitas/bmf/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: { code: 'FILE_NOT_RECEIVED', message: 'Arquivo nao enviado.' } })
    return
  }
  try {
    const parseBovespa = getBovespaReceitasParser()
    const result = parseBovespa(req.file.buffer, { mercado: 'bmf', fatorReceita: 0.9435 * 0.8285 })
    if (!result.ok) {
      res.status(400).json(result)
      return
    }
    if (debugReceitas) {
      console.log('[receitas] bmf:stats', result.summary)
    }
    res.status(200).json({ ...result, fileName: req.file.originalname })
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'PARSER_FAILED', message: 'Falha ao ler a planilha.' } })
  }
})

registerHubxpOrdersRoutes(app)
registerOutlookRoutes(app)

// Só faz listen automatico quando executado diretamente (node server/index.js)
// Quando importado pelo Electron, ele faz o listen com tratamento de erro
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API rodando em http://localhost:${PORT}`)
  })
}

module.exports = { app }
