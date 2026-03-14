import { parseXlsxInWorker } from './xlsxWorkerClient'
import { toNumber } from '../utils/number'
import { excelSerialToDateComponents } from '../utils/excelDate'

const MONTH_INDEX = {
  jan: 1,
  fev: 2,
  mar: 3,
  abr: 4,
  mai: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  set: 9,
  out: 10,
  nov: 11,
  dez: 12,
}

const FIELD_DEFAULT_INDEX = {
  assessor: 0,
  broker: 1,
  cliente: 2,
  dataRegistro: 3,
  ativo: 4,
  estrutura: 5,
  valorCompra: 6,
  dataVencimento: 7,
  quantidade: 8,
  custoUnitario: 9,
  callComprada: 10,
  callVendida: 11,
  putComprada: 12,
  putComprada2: 13,
  putVendida: 14,
  barreiraKi: 15,
  barreiraKo: 16,
  spot: 17,
  ganhoPrejuizo: 18,
  financeiroFinal: 19,
  vendaAtivo: 20,
  lucroPct: 21,
  debito: 22,
  dividendos: 23,
  ganhosOpcoes: 24,
  ganhoPut: 25,
  ganhoCall: 26,
  cupom: 27,
  pagou: 28,
  id: 29,
}

const FIELD_ALIASES = {
  assessor: ['assessor'],
  broker: ['broker'],
  cliente: ['cliente'],
  dataRegistro: ['data de registro', 'data registro'],
  ativo: ['ativo'],
  estrutura: ['estrutura'],
  valorCompra: ['valor de compra', 'valor compra'],
  dataVencimento: ['data de vencimento', 'vencimento', 'data vencimento'],
  quantidade: ['quantidade'],
  custoUnitario: ['custo unitario', 'custo unitário'],
  callComprada: ['call comprada'],
  callVendida: ['call vendida'],
  putComprada: ['put comprada'],
  putComprada2: ['put comprada 2'],
  putVendida: ['put vendida'],
  barreiraKi: ['barreira ki'],
  barreiraKo: ['barreira ko'],
  spot: ['spot'],
  ganhoPrejuizo: ['ganho / prejuizo', 'ganho/prejuizo'],
  financeiroFinal: ['financeiro final'],
  vendaAtivo: ['venda do ativo a mercado', 'venda do ativo'],
  lucroPct: ['lucro %', 'lucro percentual'],
  debito: ['debito', 'débito', 'debito dividendos', 'débito dividendos'],
  dividendos: ['dividendos'],
  ganhosOpcoes: ['ganhos nas opcoes', 'ganhos nas opções'],
  ganhoPut: ['ganho na put'],
  ganhoCall: ['ganho na call'],
  cupom: ['cupom'],
  pagou: ['pagou'],
  id: ['id', 'codigo interno'],
}

const normalizeKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/%/g, ' percentual ')
  .replace(/[^a-z0-9]/g, '')

const ALIAS_INDEX = Object.entries(FIELD_ALIASES).reduce((acc, [field, aliases]) => {
  aliases.forEach((alias) => {
    const token = normalizeKey(alias)
    if (!token || acc.has(token)) return
    acc.set(token, field)
  })
  return acc
}, new Map())

const normalizeSheetName = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, '')

const toDateOnlyString = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const normalizeDate = (value) => {
  if (value == null || value === '') return ''
  if (value instanceof Date) return toDateOnlyString(value)
  if (typeof value === 'number') {
    const parts = excelSerialToDateComponents(value)
    if (parts?.y && parts?.m && parts?.d) {
      return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`
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
  return ''
}

const parsePercentDecimal = (value) => {
  if (value == null || value === '') return null
  // Numbers from Excel: treat as raw decimal values.
  // Excel stores 41.08% as 0.4108 — SheetJS returns 0.4108 as a number.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value
  }
  const raw = String(value).trim()
  if (!raw) return null
  const parsed = toNumber(raw)
  if (!Number.isFinite(parsed)) return null
  if (raw.includes('%')) return parsed / 100
  if (Math.abs(parsed) > 1) return parsed / 100
  return parsed
}

const isMonthlySheet = (sheetName) => {
  const normalized = normalizeSheetName(sheetName)
  if (!normalized || normalized.startsWith('res_') || normalized.startsWith('res')) return false
  return /^(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[_-]\d{4}$/.test(normalized)
}

const toMonthlySortKey = (sheetName) => {
  const normalized = normalizeSheetName(sheetName)
  const match = normalized.match(/^(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[_-](\d{4})$/)
  if (!match) return Number.MAX_SAFE_INTEGER
  const [, monthToken, yearToken] = match
  const month = MONTH_INDEX[monthToken] || 0
  const year = Number(yearToken)
  if (!Number.isFinite(year) || !month) return Number.MAX_SAFE_INTEGER
  return year * 100 + month
}

const resolveTargetSheets = (sheetNames) => {
  const names = Array.isArray(sheetNames) ? sheetNames : []
  const monthly = names
    .filter(isMonthlySheet)
    .sort((left, right) => toMonthlySortKey(left) - toMonthlySortKey(right))
  if (monthly.length) return monthly
  return names.filter((name) => !normalizeSheetName(name).startsWith('res'))
}

const isRowEmpty = (row) => {
  if (!Array.isArray(row) || !row.length) return true
  for (let i = 0; i < row.length; i += 1) {
    const value = row[i]
    if (value == null) continue
    if (typeof value === 'string' && !value.trim()) continue
    return false
  }
  return true
}

const detectHeaderRow = (rows) => {
  if (!Array.isArray(rows)) return -1
  const limit = Math.min(rows.length, 20)
  for (let index = 0; index < limit; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index] : []
    const matched = new Set()
    row.forEach((cell) => {
      const token = normalizeKey(cell)
      if (!token) return
      const field = ALIAS_INDEX.get(token)
      if (field) matched.add(field)
    })
    if (matched.size >= 6) return index
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
    if (!field || lookup.has(field)) return
    lookup.set(field, columnIndex)
  })
  return lookup
}

const resolveFieldValue = (row, headerLookup, field) => {
  if (!Array.isArray(row)) return undefined
  const headerColumn = headerLookup.get(field)
  if (headerColumn != null) {
    const value = row[headerColumn]
    if (value != null && value !== '') return value
  }
  const fallbackIndex = FIELD_DEFAULT_INDEX[field]
  if (fallbackIndex != null) return row[fallbackIndex]
  return undefined
}

const toText = (value) => {
  if (value == null) return ''
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return String(value).trim()
}

const hashString = (value) => {
  let hash = 5381
  const input = String(value || '')
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(index)
    hash &= 0xffffffff
  }
  return Math.abs(hash).toString(36)
}

const isHeaderLikeRecord = ({ cliente, ativo, estrutura }) => {
  const clienteToken = normalizeKey(cliente)
  const ativoToken = normalizeKey(ativo)
  const estruturaToken = normalizeKey(estrutura)
  return clienteToken === 'cliente' && ativoToken === 'ativo' && estruturaToken === 'estrutura'
}

const parseSheetRows = (sheetName, sheetData) => {
  const rawRows = sheetData?.rawRows
  if (!Array.isArray(rawRows) || !rawRows.length) return []

  const headerIndex = detectHeaderRow(rawRows)
  if (headerIndex < 0) return []

  const headerLookup = buildHeaderLookup(rawRows[headerIndex])
  const parsed = []
  for (let rowIndex = headerIndex + 1; rowIndex < rawRows.length; rowIndex += 1) {
    const row = rawRows[rowIndex]
    if (isRowEmpty(row)) continue

    const cliente = toText(resolveFieldValue(row, headerLookup, 'cliente'))
    const ativo = toText(resolveFieldValue(row, headerLookup, 'ativo')).toUpperCase()
    const estrutura = toText(resolveFieldValue(row, headerLookup, 'estrutura'))
    if (isHeaderLikeRecord({ cliente, ativo, estrutura })) continue

    const vencimento = normalizeDate(resolveFieldValue(row, headerLookup, 'dataVencimento'))
    const dataRegistro = normalizeDate(resolveFieldValue(row, headerLookup, 'dataRegistro'))
    const quantidade = toNumber(resolveFieldValue(row, headerLookup, 'quantidade'))

    const hasCoreData = Boolean(
      cliente
      || ativo
      || estrutura
      || vencimento
      || Number.isFinite(quantidade),
    )
    if (!hasCoreData) continue

    const idRaw = toText(resolveFieldValue(row, headerLookup, 'id'))
    const sheetToken = normalizeSheetName(sheetName) || 'sheet'
    const lineToken = rowIndex + 1
    const idSeed = idRaw || hashString([
      sheetName,
      rowIndex,
      cliente,
      ativo,
      estrutura,
      vencimento,
      quantidade,
      toText(resolveFieldValue(row, headerLookup, 'pagou')),
    ].join('|'))
    const id = `hist-${sheetToken}-${lineToken}-${idSeed}`

    parsed.push({
      id,
      sourceSheet: sheetName,
      sourceRow: rowIndex + 1,
      assessor: toText(resolveFieldValue(row, headerLookup, 'assessor')),
      broker: toText(resolveFieldValue(row, headerLookup, 'broker')),
      cliente,
      dataRegistro,
      ativo,
      estrutura,
      valorCompra: toNumber(resolveFieldValue(row, headerLookup, 'valorCompra')),
      vencimento,
      quantidade: Number.isFinite(quantidade) ? quantidade : 0,
      custoUnitario: toNumber(resolveFieldValue(row, headerLookup, 'custoUnitario')),
      callComprada: toNumber(resolveFieldValue(row, headerLookup, 'callComprada')),
      callVendida: toNumber(resolveFieldValue(row, headerLookup, 'callVendida')),
      putComprada: toNumber(resolveFieldValue(row, headerLookup, 'putComprada')),
      putComprada2: toNumber(resolveFieldValue(row, headerLookup, 'putComprada2')),
      putVendida: toNumber(resolveFieldValue(row, headerLookup, 'putVendida')),
      barreiraKi: toNumber(resolveFieldValue(row, headerLookup, 'barreiraKi')),
      barreiraKo: toNumber(resolveFieldValue(row, headerLookup, 'barreiraKo')),
      spotInformado: toNumber(resolveFieldValue(row, headerLookup, 'spot')),
      ganhoPrejuizoInformado: toNumber(resolveFieldValue(row, headerLookup, 'ganhoPrejuizo')),
      financeiroFinalInformado: toNumber(resolveFieldValue(row, headerLookup, 'financeiroFinal')),
      vendaAtivoInformado: toNumber(resolveFieldValue(row, headerLookup, 'vendaAtivo')),
      lucroPctInformado: parsePercentDecimal(resolveFieldValue(row, headerLookup, 'lucroPct')),
      debitoInformado: toNumber(resolveFieldValue(row, headerLookup, 'debito')),
      dividendosInformado: toNumber(resolveFieldValue(row, headerLookup, 'dividendos')),
      ganhosOpcoesInformado: toNumber(resolveFieldValue(row, headerLookup, 'ganhosOpcoes')),
      ganhoPutInformado: toNumber(resolveFieldValue(row, headerLookup, 'ganhoPut')),
      ganhoCallInformado: toNumber(resolveFieldValue(row, headerLookup, 'ganhoCall')),
      cupomInformado: toNumber(resolveFieldValue(row, headerLookup, 'cupom')),
      pagouInformado: toNumber(resolveFieldValue(row, headerLookup, 'pagou')),
    })
  }

  return parsed
}

const parseWorkbookRows = (sheetNames, sheets) => {
  const targets = resolveTargetSheets(sheetNames)
  const rows = []

  targets.forEach((sheetName) => {
    const parsed = parseSheetRows(sheetName, sheets?.[sheetName])
    if (parsed.length) rows.push(...parsed)
  })

  if (!rows.length) {
    ;(sheetNames || []).forEach((sheetName) => {
      const parsed = parseSheetRows(sheetName, sheets?.[sheetName])
      if (parsed.length) rows.push(...parsed)
    })
  }

  rows.sort((left, right) => {
    const leftDate = left.vencimento || ''
    const rightDate = right.vencimento || ''
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)
    return String(left.id || '').localeCompare(String(right.id || ''), 'pt-BR')
  })

  return rows
}

export const parseHistoricoWorkbookBuffer = async (buffer) => {
  const { sheetNames, sheets } = await parseXlsxInWorker(buffer)
  return parseWorkbookRows(sheetNames, sheets)
}

export const parseHistoricoWorkbook = async (file) => {
  const buffer = await file.arrayBuffer()
  return parseHistoricoWorkbookBuffer(buffer)
}
