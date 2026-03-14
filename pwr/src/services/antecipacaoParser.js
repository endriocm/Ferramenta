import { parseXlsxInWorker } from './xlsxWorkerClient'
import { toNumber } from '../utils/number'
import { normalizeAssessorName } from '../utils/assessor'
import { excelSerialToDateComponents } from '../utils/excelDate'

const normalizeKey = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/%/g, ' percentual ')
  .replace(/[^a-z0-9]/g, '')

const normalizeText = (value) => {
  if (value == null) return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    if (Number.isInteger(value)) return String(value)
    return String(value)
  }
  return String(value).trim()
}

const toDateOnlyString = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const normalizeDate = (value) => {
  if (!value && value !== 0) return ''
  if (value instanceof Date) return toDateOnlyString(value)

  if (typeof value === 'number') {
    const parsed = excelSerialToDateComponents(value)
    if (parsed?.y && parsed?.m && parsed?.d) {
      const date = new Date(parsed.y, parsed.m - 1, parsed.d)
      return toDateOnlyString(date)
    }
  }

  const raw = String(value).trim()
  if (!raw) return ''
  const brMatch = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/)
  if (brMatch) {
    const [, day, month, year] = brMatch
    return `${year}-${month}-${day}`
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  return raw
}

const parseLocaleValue = (value) => {
  const number = toNumber(value)
  return Number.isFinite(number) ? number : null
}

const parsePercentDecimal = (value) => {
  if (value == null || value === '') return null

  // Numbers from Excel: ALWAYS treat as raw decimal values.
  // Excel stores 41.08% as 0.4108 — SheetJS returns 0.4108 as a number.
  // The old heuristic (abs > 1 → divide by 100) broke for legitimate values > 100%.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value
  }

  const raw = String(value).trim()
  if (!raw) return null
  const numeric = parseLocaleValue(raw)
  if (!Number.isFinite(numeric)) return null

  // Strings with explicit "%": this is a display value (e.g. "41,08%").
  // Divide by 100 to convert to decimal (0.4108).
  if (raw.includes('%')) return numeric / 100

  // Strings without "%": use heuristic — values > 1 are likely percentage points.
  if (Math.abs(numeric) > 1) return numeric / 100
  return numeric
}

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const parseTempoMeses = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value

  const raw = String(value).trim()
  if (!raw) return null

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  const yearsRegex = /(-?\d+(?:[.,]\d+)?)\s*(?:ano|anos)\b/g
  const monthsRegex = /(-?\d+(?:[.,]\d+)?)\s*(?:mes|meses)\b/g
  const daysRegex = /(-?\d+(?:[.,]\d+)?)\s*(?:dia|dias)\b/g

  let years = 0
  let months = 0
  let days = 0
  let matched = false

  for (const match of normalized.matchAll(yearsRegex)) {
    const parsed = parseLocaleValue(match[1])
    if (Number.isFinite(parsed)) {
      years += parsed
      matched = true
    }
  }

  for (const match of normalized.matchAll(monthsRegex)) {
    const parsed = parseLocaleValue(match[1])
    if (Number.isFinite(parsed)) {
      months += parsed
      matched = true
    }
  }

  for (const match of normalized.matchAll(daysRegex)) {
    const parsed = parseLocaleValue(match[1])
    if (Number.isFinite(parsed)) {
      days += parsed
      matched = true
    }
  }

  if (matched) {
    return round((years * 12) + months + (days / 30), 4)
  }

  const numeric = parseLocaleValue(raw)
  if (Number.isFinite(numeric)) return numeric

  return null
}

const hashString = (value) => {
  let hash = 5381
  const str = String(value || '')
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash &= 0xffffffff
  }
  return Math.abs(hash).toString(36)
}

const FIELD_MAP = {
  codigoCliente: {
    columnIndex: 1,
    aliases: [
      'codigo do cliente',
      'codigo cliente',
      'codigodocliente',
      'codigocliente',
      'cliente',
      'conta',
      'numero da conta',
      'no cliente',
      'n cliente',
      'cod cliente',
    ],
  },
  estrutura: {
    columnIndex: 2,
    aliases: ['estrutura', 'tipo estrutura', 'tipo da estrutura'],
  },
  ativo: {
    columnIndex: 3,
    aliases: ['ativo', 'papel', 'ticker', 'ativo objeto', 'ativo-objeto', 'codigo ativo'],
  },
  assessor: {
    columnIndex: null,
    aliases: ['assessor', 'consultor'],
  },
  broker: {
    columnIndex: null,
    aliases: ['broker', 'corretora', 'canal de origem', 'canal'],
  },
  nomeCliente: {
    columnIndex: null,
    aliases: ['nome cliente', 'nome do cliente', 'cliente nome', 'razao social', 'nome'],
  },
  vencimento: {
    columnIndex: 7,
    aliases: ['vencimento', 'data de vencimento', 'data vencimento'],
  },
  tempoNaEstruturaRaw: {
    columnIndex: 8,
    aliases: ['tempo na estrutura', 'tempo estrutura', 'tempo da estrutura', 'prazo'],
  },
  desembolsoEntradaBRL: {
    columnIndex: 9,
    aliases: [
      'desembolso na entrada',
      'desembolso entrada',
      'desembolso',
      'valor de entrada',
      'valor desembolsado na entrada',
      'valor desembolsado na entrada r',
      'valor desembolsado',
      'desembolso na entrada r',
    ],
  },
  performanceAtivoBRL: {
    columnIndex: 14,
    aliases: ['performance ativo', 'performance do ativo', 'performance ativo r'],
  },
  performanceEstruturaBRL: {
    columnIndex: 16,
    aliases: ['performance da estrutura', 'performance estrutura', 'performance estrutura r', 'performance da estrutura r'],
  },
  valorSaidaAtualBRL: {
    columnIndex: 17,
    aliases: ['valor de saida atual', 'valor de saida atual acoes opcoes', 'saida atual', 'valor de saida atual r', 'valor saida atual'],
  },
  proventosBRL: {
    columnIndex: 18,
    aliases: ['proventos', 'dividendos', 'proventos r'],
  },
  resultadoBrutoAtualBRL: {
    columnIndex: 19,
    aliases: ['resultado bruto atual', 'resultado bruto atual r', 'resultado bruto'],
  },
  resultadoBrutoAtualPct: {
    columnIndex: 20,
    aliases: ['resultado bruto atual percentual', 'resultado bruto atual %', 'resultado percentual', 'rentabilidade'],
  },
}

const FIELD_KEYS = Object.keys(FIELD_MAP)
const ALIAS_INDEX = FIELD_KEYS.reduce((acc, fieldKey) => {
  const aliases = FIELD_MAP[fieldKey].aliases || []
  aliases.forEach((alias) => {
    const normalized = normalizeKey(alias)
    if (!normalized || acc.has(normalized)) return
    acc.set(normalized, fieldKey)
  })
  return acc
}, new Map())

const resolveSheetName = (sheetNames) => {
  const names = Array.isArray(sheetNames) ? sheetNames : []
  if (!names.length) return null
  const preferred = names.find((name) => {
    const normalized = normalizeKey(name)
    return normalized.includes('antecip')
  })
  return preferred || names[0]
}

const detectHeaderRow = (rows) => {
  for (let index = 0; index < rows.length; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index] : []
    const matchedFields = new Set()
    row.forEach((cell) => {
      const token = normalizeKey(cell)
      if (!token) return
      const field = ALIAS_INDEX.get(token)
      if (field) matchedFields.add(field)
    })
    if (matchedFields.size >= 3) return index
  }
  return -1
}

const buildHeaderLookup = (headerRow) => {
  const lookup = new Map()
  if (!Array.isArray(headerRow)) return lookup
  headerRow.forEach((cell, columnIndex) => {
    const token = normalizeKey(cell)
    if (!token) return
    const field = ALIAS_INDEX.get(token)
    if (field && !lookup.has(field)) {
      lookup.set(field, columnIndex)
    }
  })
  return lookup
}

const resolveValue = (row, headerLookup, fieldKey) => {
  const headerColumn = headerLookup.get(fieldKey)
  if (headerColumn != null) {
    const headerValue = row?.[headerColumn]
    // Se o header mapeou mas o valor esta vazio, tenta o fallback por indice
    if (headerValue != null && headerValue !== '') return headerValue
    const fallbackColumn = FIELD_MAP[fieldKey]?.columnIndex
    if (fallbackColumn != null && fallbackColumn !== headerColumn) {
      const fallbackValue = row?.[fallbackColumn]
      if (fallbackValue != null && fallbackValue !== '') return fallbackValue
    }
    return headerValue
  }
  const fallbackColumn = FIELD_MAP[fieldKey]?.columnIndex
  if (fallbackColumn != null) return row?.[fallbackColumn]
  return undefined
}

const isRowEmpty = (row) => {
  if (!Array.isArray(row)) return true
  for (let i = 0; i < row.length; i += 1) {
    const value = row[i]
    if (value == null) continue
    if (typeof value === 'string' && !value.trim()) continue
    return false
  }
  return true
}

const isHeaderLikeValue = (fieldKey, value) => {
  const token = normalizeKey(value)
  if (!token) return false
  if (ALIAS_INDEX.get(token) === fieldKey) return true
  return false
}

const parseRow = ({ row, sourceIndex, headerLookup }) => {
  if (isRowEmpty(row)) return null

  const codigoClienteRaw = resolveValue(row, headerLookup, 'codigoCliente')
  const estruturaRaw = resolveValue(row, headerLookup, 'estrutura')
  const vencimentoRaw = resolveValue(row, headerLookup, 'vencimento')

  if (
    isHeaderLikeValue('codigoCliente', codigoClienteRaw)
    && isHeaderLikeValue('estrutura', estruturaRaw)
  ) {
    return null
  }

  const codigoCliente = normalizeText(codigoClienteRaw)
  const estrutura = normalizeText(estruturaRaw)
  const ativo = normalizeText(resolveValue(row, headerLookup, 'ativo'))
  const vencimento = normalizeDate(vencimentoRaw)
  const tempoNaEstruturaRaw = normalizeText(resolveValue(row, headerLookup, 'tempoNaEstruturaRaw'))
  const tempoMeses = parseTempoMeses(tempoNaEstruturaRaw)

  const assessorFallback = normalizeAssessorName(normalizeText(resolveValue(row, headerLookup, 'assessor')), '')
  const brokerFallback = normalizeText(resolveValue(row, headerLookup, 'broker'))
  const nomeClienteFallback = normalizeText(resolveValue(row, headerLookup, 'nomeCliente'))

  const desembolsoEntradaBRL = parseLocaleValue(resolveValue(row, headerLookup, 'desembolsoEntradaBRL'))
  const performanceAtivoBRL = parseLocaleValue(resolveValue(row, headerLookup, 'performanceAtivoBRL'))
  const performanceEstruturaBRL = parseLocaleValue(resolveValue(row, headerLookup, 'performanceEstruturaBRL'))
  const valorSaidaAtualBRL = parseLocaleValue(resolveValue(row, headerLookup, 'valorSaidaAtualBRL'))
  const proventosBRL = parseLocaleValue(resolveValue(row, headerLookup, 'proventosBRL'))
  const resultadoBrutoAtualBRL = parseLocaleValue(resolveValue(row, headerLookup, 'resultadoBrutoAtualBRL'))
  const resultadoBrutoAtualPct = parsePercentDecimal(resolveValue(row, headerLookup, 'resultadoBrutoAtualPct'))

  const hasMinimumData = Boolean(
    codigoCliente
    || estrutura
    || nomeClienteFallback
    || Number.isFinite(desembolsoEntradaBRL)
    || Number.isFinite(resultadoBrutoAtualPct),
  )
  if (!hasMinimumData) return null

  const idHash = hashString([
    sourceIndex,
    codigoCliente,
    estrutura,
    vencimento,
    desembolsoEntradaBRL,
    resultadoBrutoAtualPct,
  ].join('|'))

  return {
    id: `ant-${sourceIndex + 1}-${idHash}`,
    codigoCliente,
    estrutura,
    ativo,
    assessor: assessorFallback,
    broker: brokerFallback,
    nomeCliente: nomeClienteFallback,
    vencimento,
    tempoNaEstruturaRaw,
    tempoMeses: Number.isFinite(tempoMeses) ? tempoMeses : 0,
    desembolsoEntradaBRL: Number.isFinite(desembolsoEntradaBRL) ? desembolsoEntradaBRL : 0,
    performanceAtivoBRL: Number.isFinite(performanceAtivoBRL) ? performanceAtivoBRL : 0,
    performanceEstruturaBRL: Number.isFinite(performanceEstruturaBRL) ? performanceEstruturaBRL : 0,
    valorSaidaAtualBRL: Number.isFinite(valorSaidaAtualBRL) ? valorSaidaAtualBRL : 0,
    proventosBRL: Number.isFinite(proventosBRL) ? proventosBRL : 0,
    resultadoBrutoAtualBRL: Number.isFinite(resultadoBrutoAtualBRL) ? resultadoBrutoAtualBRL : 0,
    resultadoBrutoAtualPct: Number.isFinite(resultadoBrutoAtualPct) ? resultadoBrutoAtualPct : 0,
  }
}

const parseWorkbookRows = (sheetNames, sheets) => {
  const sheetName = resolveSheetName(sheetNames)
  if (!sheetName) return []

  const sheetData = sheets[sheetName]
  if (!sheetData) return []

  const rows = sheetData.rawRows
  if (!Array.isArray(rows) || !rows.length) return []

  const headerRowIndex = detectHeaderRow(rows)
  const headerLookup = headerRowIndex >= 0 ? buildHeaderLookup(rows[headerRowIndex]) : new Map()
  const startIndex = headerRowIndex >= 0 ? headerRowIndex + 1 : 0

  const parsed = []
  for (let i = startIndex; i < rows.length; i += 1) {
    const row = rows[i]
    const mapped = parseRow({
      row,
      sourceIndex: i,
      headerLookup,
    })
    if (mapped) parsed.push(mapped)
  }
  return parsed
}

export const parseAntecipacaoWorkbookBuffer = async (buffer) => {
  const { sheetNames, sheets } = await parseXlsxInWorker(buffer)
  return parseWorkbookRows(sheetNames, sheets)
}

export const parseAntecipacaoWorkbook = async (file) => {
  const buffer = await file.arrayBuffer()
  return parseAntecipacaoWorkbookBuffer(buffer)
}
