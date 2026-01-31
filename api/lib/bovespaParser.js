const XLSX = require('xlsx')

const normalizeHeader = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, '')

const normalizeValue = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

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

const parseDate = (value) => {
  if (!value) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  if (typeof value === 'number' && XLSX?.SSF?.parse_date_code) {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed?.y && parsed?.m && parsed?.d) {
      const date = new Date(parsed.y, parsed.m - 1, parsed.d)
      return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
    }
  }
  const raw = String(value).trim()
  const match = raw.match(/(\d{2})[\/-](\d{2})[\/-](\d{4})/)
  if (match) {
    const [, day, month, year] = match
    const date = new Date(Number(year), Number(month) - 1, Number(day))
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  return ''
}

const pickSheetName = (workbook) => {
  if (!workbook?.SheetNames?.length) return null
  const preferred = workbook.SheetNames.find((name) => normalizeHeader(name) === 'export')
  return preferred || workbook.SheetNames[0]
}

const parseBovespaReceitas = (buffer, { tipo = 'variavel' } = {}) => {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheetName = pickSheetName(workbook)
  if (!sheetName) {
    return { ok: false, error: { code: 'SHEET_NOT_FOUND', message: 'Sheet "Export" nao encontrada.' } }
  }
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  const headers = rows.length ? Object.keys(rows[0] || {}) : []
  const headerMap = headers.reduce((acc, header) => {
    acc[normalizeHeader(header)] = header
    return acc
  }, {})

  const required = {
    conta: ['conta', 'contacliente', 'codigocliente', 'cliente'],
    corretagem: ['corretagem'],
    volume: ['volumenegociado', 'volumenegociacao', 'volume', 'vol'],
    tipoCorretagem: ['tipodecorretagem', 'tipocorretagem', 'corretagemtipo'],
    mercado: ['mercado'],
    data: ['data', 'dataoperacao', 'dataoperacao'],
  }

  const resolveHeader = (keys) => keys.find((key) => headerMap[key])
  const missing = Object.entries(required)
    .filter(([, keys]) => !resolveHeader(keys))
    .map(([label]) => label)

  if (missing.length) {
    return { ok: false, error: { code: 'MISSING_COLUMN', message: 'Colunas obrigatorias ausentes.', details: { missing, headers } } }
  }

  const tipoTarget = normalizeValue(tipo)
  const rowsRead = rows.length
  let rowsValid = 0
  let rowsFiltered = 0
  let totalCorretagem = 0
  let totalReceita = 0
  let totalVolume = 0
  const uniqueContas = new Set()
  const entries = []
  const fatorReceita = 0.9335 * 0.8285

  rows.forEach((row, index) => {
    const conta = String(row[headerMap[resolveHeader(required.conta)]] || '').trim()
    const corretagem = toNumber(row[headerMap[resolveHeader(required.corretagem)]])
    const volume = toNumber(row[headerMap[resolveHeader(required.volume)]])
    const tipoCorretagem = normalizeValue(row[headerMap[resolveHeader(required.tipoCorretagem)]])
    const mercado = normalizeValue(row[headerMap[resolveHeader(required.mercado)]])
    const dataISO = parseDate(row[headerMap[resolveHeader(required.data)]])

    if (!conta || corretagem == null || !dataISO) {
      rowsFiltered += 1
      return
    }
    if (mercado !== 'bov') {
      rowsFiltered += 1
      return
    }
    if (tipoCorretagem !== tipoTarget) {
      rowsFiltered += 1
      return
    }

    rowsValid += 1
    uniqueContas.add(conta)
    totalCorretagem += corretagem
    totalVolume += volume || 0
    const receitaCalculada = corretagem * fatorReceita
    totalReceita += receitaCalculada
    entries.push({
      id: `bov-${index}-${Date.now()}`,
      codigoCliente: conta,
      conta,
      data: dataISO,
      corretagem,
      volumeNegociado: volume || 0,
      tipoCorretagem: tipoCorretagem,
      mercado: mercado.toUpperCase(),
      receita: Number(receitaCalculada.toFixed(6)),
      origem: 'Bovespa',
      source: 'import',
    })
  })

  return {
    ok: true,
    entries,
    summary: {
      rowsRead,
      rowsValid,
      rowsFiltered,
      totalCorretagem: Number(totalCorretagem.toFixed(2)),
      totalReceita: Number(totalReceita.toFixed(2)),
      totalVolume: Number(totalVolume.toFixed(2)),
      uniqueContas: uniqueContas.size,
      sheetUsed: sheetName,
      tipoCorretagem: tipoTarget,
    },
  }
}

module.exports = { parseBovespaReceitas }
