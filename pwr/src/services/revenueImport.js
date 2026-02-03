import { loadXlsx } from './xlsxLoader'

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

const toArrayBuffer = async (input) => {
  if (!input) return null
  if (input instanceof ArrayBuffer) return input
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
  }
  if (typeof input.arrayBuffer === 'function') {
    return input.arrayBuffer()
  }
  return null
}

const parseDate = (value, XLSX) => {
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
  const match = raw.match(/(\d{2})[/-](\d{2})[/-](\d{4})/)
  if (match) {
    const [, day, month, year] = match
    const date = new Date(Number(year), Number(month) - 1, Number(day))
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  return ''
}

const parseDateBr = (value, XLSX) => parseDate(value, XLSX)

const pickSheetName = (workbook) => {
  if (!workbook?.SheetNames?.length) return null
  const preferred = workbook.SheetNames.find((name) => normalizeHeader(name) === 'export')
  return preferred || workbook.SheetNames[0]
}

const buildHeaderMap = (rows) => {
  const headers = rows.length ? Object.keys(rows[0] || {}) : []
  const headerMap = headers.reduce((acc, header) => {
    acc[normalizeHeader(header)] = header
    return acc
  }, {})
  return { headers, headerMap }
}

export const parseBovespaReceitasFile = async (input, { mercado = 'bov', fatorReceita = 0.9335 * 0.8285 } = {}) => {
  const buffer = await toArrayBuffer(input)
  if (!buffer) return { ok: false, error: { code: 'BUFFER_INVALID', message: 'Arquivo invalido.' } }
  const XLSX = await loadXlsx()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = pickSheetName(workbook)
  if (!sheetName) {
    return { ok: false, error: { code: 'SHEET_NOT_FOUND', message: 'Sheet "Export" nao encontrada.' } }
  }
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  const { headers, headerMap } = buildHeaderMap(rows)

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

  const mercadoTarget = normalizeValue(mercado)
  const rowsRead = rows.length
  let rowsValid = 0
  let rowsFiltered = 0
  let totalCorretagem = 0
  let totalReceita = 0
  let totalVolume = 0
  const uniqueContas = new Set()
  const entries = []

  rows.forEach((row, index) => {
    const conta = String(row[headerMap[resolveHeader(required.conta)]] || '').trim()
    const corretagem = toNumber(row[headerMap[resolveHeader(required.corretagem)]])
    const volume = toNumber(row[headerMap[resolveHeader(required.volume)]])
    const tipoCorretagem = normalizeValue(row[headerMap[resolveHeader(required.tipoCorretagem)]])
    const mercadoValue = normalizeValue(row[headerMap[resolveHeader(required.mercado)]])
    const dataISO = parseDate(row[headerMap[resolveHeader(required.data)]], XLSX)

    if (!conta || corretagem == null || !dataISO) {
      rowsFiltered += 1
      return
    }
    if (mercadoValue !== mercadoTarget) {
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
      tipoCorretagem,
      mercado: mercadoValue.toUpperCase(),
      receita: Number(receitaCalculada.toFixed(6)),
      origem: mercadoTarget === 'bmf' ? 'BMF' : 'Bovespa',
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
      mercado: mercadoTarget,
    },
  }
}

export const parseStructuredReceitasFile = async (input) => {
  const buffer = await toArrayBuffer(input)
  if (!buffer) return { ok: false, error: { code: 'BUFFER_INVALID', message: 'Arquivo invalido.' } }
  const XLSX = await loadXlsx()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames.find((name) => {
    const trimmed = String(name || '').trim()
    return trimmed === 'Operações' || trimmed === 'Operacoes'
  })
  if (!sheetName) {
    return { ok: false, error: { code: 'SHEET_NOT_FOUND', message: 'Sheet "Operações" nao encontrada.' } }
  }
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  const { headers, headerMap } = buildHeaderMap(rows)

  const required = {
    codigoCliente: 'codigocliente',
    dataInclusao: 'datainclusao',
    estrutura: 'estrutura',
    ativo: 'ativo',
    fixing: 'fixing',
    comissao: 'comissao',
  }
  const optional = {
    quantidade: ['quantidade', 'quantidadeacoes', 'quantidadeacao', 'qtd', 'qtde'],
    precoCompra: ['precocompraacao', 'precocompra', 'precodecompra', 'precoacao', 'preco'],
  }
  const missing = Object.values(required).filter((key) => !headerMap[key])
  if (missing.length) {
    return {
      ok: false,
      error: { code: 'MISSING_COLUMN', message: 'Colunas obrigatorias ausentes.', details: { missing, headers } },
    }
  }

  let rowsValid = 0
  let rowsSkipped = 0
  let totalCommission = 0
  const months = new Set()
  const entries = rows.map((row, index) => {
    const dataInclusao = parseDateBr(row[headerMap[required.dataInclusao]], XLSX)
    const comissao = toNumber(row[headerMap[required.comissao]])
    const quantidadeHeader = optional.quantidade.find((key) => headerMap[key])
    const precoHeader = optional.precoCompra.find((key) => headerMap[key])
    const quantidade = quantidadeHeader ? toNumber(row[headerMap[quantidadeHeader]]) : null
    const precoCompra = precoHeader ? toNumber(row[headerMap[precoHeader]]) : null
    if (!dataInclusao || comissao == null) {
      rowsSkipped += 1
      return null
    }
    rowsValid += 1
    totalCommission += comissao
    months.add(dataInclusao.slice(0, 7))
    return {
      id: `estr-${index}-${Date.now()}`,
      codigoCliente: String(row[headerMap[required.codigoCliente]] || '').trim(),
      dataEntrada: dataInclusao,
      estrutura: String(row[headerMap[required.estrutura]] || '').trim(),
      ativo: String(row[headerMap[required.ativo]] || '').trim(),
      vencimento: parseDateBr(row[headerMap[required.fixing]], XLSX) || '',
      comissao,
      quantidade: quantidade ?? null,
      precoCompra: precoCompra ?? null,
      origem: 'Estruturadas',
      source: 'import',
    }
  }).filter(Boolean)

  return {
    ok: true,
    entries,
    summary: {
      rowsRead: rows.length,
      rowsValid,
      rowsSkipped,
      totalCommission: Number(totalCommission.toFixed(2)),
      months: Array.from(months).sort(),
      sheetUsed: sheetName,
    },
  }
}
