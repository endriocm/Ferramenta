import { normalizeDateKey } from '../utils/dateKey'
import { loadXlsx } from './xlsxLoader'
import { loadRevenueList, saveRevenueList } from './revenueStore'
import { loadStructuredRevenue, saveStructuredRevenue } from './revenueStructured'
import { normalizeAssessorName } from '../utils/assessor'
import { enrichRow } from './tags'

const CONSOLIDATED_SOURCE = 'consolidated-import'

const normalizeHeader = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '')

const normalizeToken = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const toSafeNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const toRounded = (value, digits = 2) => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const parseNumber = (value) => {
  if (value == null) return null
  let text = String(value).trim()
  if (!text) return null
  text = text.replace(/\s+/g, '')
  const hasComma = text.includes(',')
  const hasDot = text.includes('.')
  if (hasComma && hasDot) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.')
    } else {
      text = text.replace(/,/g, '')
    }
  } else if (hasComma) {
    text = text.replace(/\./g, '').replace(',', '.')
  } else {
    text = text.replace(/,/g, '')
  }
  text = text.replace(/[^0-9.-]/g, '')
  const parsed = Number(text)
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

const getMonthKey = (value) => {
  const date = normalizeDateKey(value)
  return date ? date.slice(0, 7) : ''
}

const normalizeLine = (value) => {
  const token = normalizeToken(value)
  if (!token) return ''
  if (token.includes('total')) return ''
  if (token.includes('bovespa') || token === 'bov') return 'Bovespa'
  if (token === 'bmf' || token.includes('futuro')) return 'BMF'
  if (token.includes('estrutur')) return 'Estruturadas'
  return ''
}

const normalizeTipoCorretagem = (value) => {
  const token = normalizeToken(value)
  if (!token) return 'variavel'
  if (token.includes('indep')) return 'independente'
  return 'variavel'
}

const resolveDataKey = (entry) => normalizeDateKey(entry?.dataEntrada || entry?.data || entry?.vencimento) || ''

const resolveGrossRevenue = (line, entry) => {
  if (line === 'Estruturadas') {
    const base = toSafeNumber(entry?.comissao ?? entry?.receita ?? entry?.valor)
    return base * 2
  }

  const corretagem = toSafeNumber(entry?.corretagem)
  if (corretagem !== 0) return corretagem
  return toSafeNumber(entry?.receita ?? entry?.valor ?? entry?.comissao)
}

const resolveConsolidatedRow = (line, entry, tagsIndex) => {
  const enriched = enrichRow(entry, tagsIndex)
  const data = resolveDataKey(enriched)
  if (!data) return null
  const mesApuracao = data.slice(0, 7)
  const conta = String(enriched?.codigoCliente || enriched?.conta || enriched?.cliente || '').trim()
  const cliente = String(enriched?.nomeCliente || enriched?.cliente || '').trim()
  const assessor = String(enriched?.assessor || '').trim()
  const broker = String(enriched?.broker || '').trim()
  const equipe = String(enriched?.time || '').trim()
  const unidade = String(enriched?.unit || enriched?.unidade || '').trim()
  const senioridade = String(enriched?.seniority || '').trim()
  const estrategiaRaw = String(enriched?.estrategia || enriched?.strategy || '').trim()
  const operacaoRaw = String(enriched?.operacao || enriched?.operation || enriched?.tipoOperacao || '').trim()
  const origemRaw = String(enriched?.origemOperacao || enriched?.origem || '').trim()
  const tipoCorretagem = line === 'Estruturadas' ? '' : normalizeTipoCorretagem(enriched?.tipoCorretagem)
  const mercado = line === 'Estruturadas'
    ? ''
    : String(enriched?.mercado || (line === 'BMF' ? 'BMF' : 'BOV')).trim().toUpperCase()
  const estrutura = line === 'Estruturadas' ? String(enriched?.estrutura || '').trim() : ''
  const estrategia = line === 'Estruturadas'
    ? (estrategiaRaw || estrutura)
    : (estrategiaRaw || tipoCorretagem)
  const operacao = operacaoRaw || (line === 'Estruturadas'
    ? (estrutura ? `Estruturada - ${estrutura}` : 'Estruturada')
    : `${line} - ${tipoCorretagem}`)
  const ativo = String(enriched?.ativo || '').trim()
  const vencimento = normalizeDateKey(enriched?.vencimento) || ''
  const quantidade = parseNumber(enriched?.quantidade)
  const precoCompra = parseNumber(enriched?.precoCompra)
  const volumeNegociado = line === 'Estruturadas' ? null : toSafeNumber(enriched?.volumeNegociado ?? enriched?.volume)
  const corretagemBruta = line === 'Estruturadas'
    ? null
    : toSafeNumber(enriched?.corretagem ?? enriched?.valor ?? enriched?.receita)
  const comissaoBase = line === 'Estruturadas'
    ? toSafeNumber(enriched?.comissao ?? enriched?.receita ?? enriched?.valor)
    : null
  const receitaLiquida = line === 'Estruturadas'
    ? comissaoBase
    : toSafeNumber(enriched?.receita ?? enriched?.valor)
  const receitaBruta = resolveGrossRevenue(line, enriched)

  return {
    linha: line,
    origemOperacao: origemRaw || line,
    operacao,
    estrategia,
    data,
    mesApuracao,
    idOperacao: String(enriched?.id || '').trim(),
    conta,
    cliente,
    assessor,
    broker,
    equipe,
    unidade,
    senioridade,
    tipoCorretagem,
    mercado,
    estrutura,
    ativo,
    vencimento,
    quantidade: quantidade == null ? '' : quantidade,
    precoCompra: precoCompra == null ? '' : toRounded(precoCompra),
    volumeNegociado: volumeNegociado == null ? '' : toRounded(volumeNegociado),
    corretagemBruta: corretagemBruta == null ? '' : toRounded(corretagemBruta),
    comissaoBase: comissaoBase == null ? '' : toRounded(comissaoBase),
    receitaLiquida: toRounded(receitaLiquida),
    receitaBruta: toRounded(receitaBruta),
    sourceRegistro: String(enriched?.source || 'import').trim(),
  }
}

const buildRowMap = (row) => {
  const next = {}
  Object.keys(row || {}).forEach((key) => {
    next[normalizeHeader(key)] = row[key]
  })
  return next
}

const getByAliases = (row, aliases) => {
  for (const alias of aliases) {
    const key = normalizeHeader(alias)
    if (row[key] != null && row[key] !== '') return row[key]
  }
  return ''
}

const parseConsolidatedLine = (row) => {
  const direct = getByAliases(row, ['linha'])
  const parsedDirect = normalizeLine(direct)
  if (parsedDirect) return parsedDirect
  return normalizeLine(getByAliases(row, ['origem operacao', 'origem da operacao', 'origem']))
}

const parseConsolidatedRows = (rawRows) => {
  const parsedRows = []
  const ignoredRows = []

  ;(Array.isArray(rawRows) ? rawRows : []).forEach((rawRow, index) => {
    const row = buildRowMap(rawRow)
    const line = parseConsolidatedLine(row)
    if (!line) {
      ignoredRows.push({ index: index + 2, reason: 'Linha/origem invalida.' })
      return
    }

    const dataRaw = getByAliases(row, ['data', 'data entrada', 'data operacao', 'data da operacao'])
    const data = normalizeDateKey(dataRaw)
    if (!data) {
      ignoredRows.push({ index: index + 2, reason: 'Data invalida.' })
      return
    }

    const receitaBruta = parseNumber(getByAliases(row, ['receita bruta', 'receita bruta total', 'valor bruto']))
    const corretagemBruta = parseNumber(getByAliases(row, ['corretagem bruta']))
    const comissaoBase = parseNumber(getByAliases(row, ['comissao base']))
    const receitaLiquida = parseNumber(getByAliases(row, ['receita liquida']))
    const receitaResolved = receitaBruta ?? corretagemBruta ?? comissaoBase ?? receitaLiquida
    if (receitaResolved == null) {
      ignoredRows.push({ index: index + 2, reason: 'Receita ausente.' })
      return
    }

    const vencimento = normalizeDateKey(getByAliases(row, ['vencimento']))
    const conta = String(getByAliases(row, ['conta', 'codigo cliente', 'codigo'])).trim()
    const cliente = String(getByAliases(row, ['cliente', 'nome cliente'])).trim()
    const assessor = normalizeAssessorName(getByAliases(row, ['assessor']), '')
    const broker = String(getByAliases(row, ['broker'])).trim()
    const equipe = String(getByAliases(row, ['equipe', 'time'])).trim()
    const unidade = String(getByAliases(row, ['unidade'])).trim()
    const senioridade = String(getByAliases(row, ['senioridade'])).trim()
    const tipoCorretagem = normalizeTipoCorretagem(getByAliases(row, ['tipo corretagem', 'tipo']))
    const mercado = String(getByAliases(row, ['mercado'])).trim().toUpperCase()
    const estrutura = String(getByAliases(row, ['estrutura'])).trim()
    const estrategia = String(getByAliases(row, ['estrategia', 'strategy'])).trim()
    const operacao = String(getByAliases(row, ['operacao'])).trim()
    const ativo = String(getByAliases(row, ['ativo'])).trim()
    const quantidade = parseNumber(getByAliases(row, ['quantidade']))
    const precoCompra = parseNumber(getByAliases(row, ['preco compra', 'preco']))
    const volumeNegociado = parseNumber(getByAliases(row, ['volume negociado', 'volume']))
    const idOperacao = String(getByAliases(row, ['id operacao', 'id'])).trim()
    const origemOperacao = String(getByAliases(row, ['origem operacao', 'origem da operacao', 'origem'])).trim()
    const sourceRegistro = String(getByAliases(row, ['source registro', 'source'])).trim()

    const rowMes = data.slice(0, 7)
    parsedRows.push({
      line,
      data,
      mesApuracao: rowMes,
      conta,
      cliente,
      assessor,
      broker,
      equipe,
      unidade,
      senioridade,
      tipoCorretagem,
      mercado,
      estrutura,
      estrategia,
      operacao,
      ativo,
      vencimento: vencimento || '',
      quantidade,
      precoCompra,
      volumeNegociado,
      corretagemBruta: corretagemBruta ?? (line !== 'Estruturadas' ? receitaResolved : null),
      comissaoBase: comissaoBase ?? (line === 'Estruturadas' ? receitaResolved / 2 : null),
      receitaLiquida: receitaLiquida ?? (line === 'Estruturadas'
        ? (comissaoBase ?? receitaResolved / 2)
        : (corretagemBruta ?? receitaResolved)),
      receitaBruta: receitaBruta ?? receitaResolved,
      idOperacao,
      origemOperacao,
      sourceRegistro,
    })
  })

  return { parsedRows, ignoredRows }
}

const buildBovespaOrBmfEntry = (line, row, index, tagsIndex) => {
  const prefix = line === 'BMF' ? 'bmf' : 'bov'
  const id = `${prefix}-cns-${Date.now()}-${index}`
  const corretagem = toSafeNumber(row.corretagemBruta ?? row.receitaBruta)
  const tipoCorretagem = normalizeTipoCorretagem(row.tipoCorretagem || row.estrategia)
  const receita = row.receitaLiquida != null
    ? toSafeNumber(row.receitaLiquida)
    : corretagem
  const origemOperacao = String(row.origemOperacao || line).trim() || line
  const estrategia = String(row.estrategia || row.tipoCorretagem || '').trim()
  const operacao = String(row.operacao || '').trim() || `${line} - ${tipoCorretagem}`
  const baseEntry = {
    id,
    codigoCliente: row.conta || '',
    conta: row.conta || '',
    data: row.data,
    nomeCliente: row.cliente || '',
    cliente: row.cliente || row.conta || '',
    assessor: normalizeAssessorName(row.assessor, 'Sem assessor') || 'Sem assessor',
    broker: row.broker || '',
    corretagem: toRounded(corretagem, 6),
    volumeNegociado: toRounded(toSafeNumber(row.volumeNegociado), 6),
    tipoCorretagem,
    mercado: row.mercado || (line === 'BMF' ? 'BMF' : 'BOV'),
    receita: toRounded(receita, 6),
    origem: origemOperacao,
    origemOperacao,
    estrategia,
    operacao,
    source: CONSOLIDATED_SOURCE,
    ativo: row.ativo || '',
    vencimento: row.vencimento || '',
    time: row.equipe || '',
    unit: row.unidade || '',
    seniority: row.senioridade || '',
    importedAt: Date.now(),
  }
  return tagsIndex ? enrichRow(baseEntry, tagsIndex) : baseEntry
}

const buildStructuredEntry = (row, index, tagsIndex) => {
  const id = `estr-cns-${Date.now()}-${index}`
  const comissaoBase = row.comissaoBase != null
    ? toSafeNumber(row.comissaoBase)
    : toSafeNumber(row.receitaBruta) / 2
  const estrutura = String(row.estrutura || row.estrategia || row.operacao || 'Estruturada').trim()
  const origemOperacao = String(row.origemOperacao || 'Estruturadas').trim() || 'Estruturadas'
  const baseEntry = {
    id,
    codigoCliente: row.conta || '',
    dataEntrada: row.data,
    estrutura,
    ativo: row.ativo || '',
    vencimento: row.vencimento || '',
    comissao: toRounded(comissaoBase, 6),
    quantidade: row.quantidade != null ? row.quantidade : null,
    precoCompra: row.precoCompra != null ? row.precoCompra : null,
    nomeCliente: row.cliente || '',
    cliente: row.cliente || row.conta || '',
    assessor: normalizeAssessorName(row.assessor, 'Sem assessor') || 'Sem assessor',
    broker: row.broker || '',
    origem: origemOperacao,
    origemOperacao,
    estrategia: String(row.estrategia || estrutura).trim(),
    operacao: String(row.operacao || '').trim() || `Estruturada - ${estrutura}`,
    source: CONSOLIDATED_SOURCE,
    time: row.equipe || '',
    unit: row.unidade || '',
    seniority: row.senioridade || '',
    importedAt: Date.now(),
  }
  return tagsIndex ? enrichRow(baseEntry, tagsIndex) : baseEntry
}

export const CONSOLIDATED_EXPORT_COLUMNS = [
  { key: 'linha', label: 'Linha' },
  { key: 'origemOperacao', label: 'Origem Operacao' },
  { key: 'operacao', label: 'Operacao' },
  { key: 'estrategia', label: 'Estrategia' },
  { key: 'data', label: 'Data' },
  { key: 'mesApuracao', label: 'Mes Apuracao' },
  { key: 'idOperacao', label: 'ID Operacao' },
  { key: 'conta', label: 'Conta' },
  { key: 'cliente', label: 'Cliente' },
  { key: 'assessor', label: 'Assessor' },
  { key: 'broker', label: 'Broker' },
  { key: 'equipe', label: 'Equipe' },
  { key: 'unidade', label: 'Unidade' },
  { key: 'senioridade', label: 'Senioridade' },
  { key: 'tipoCorretagem', label: 'Tipo Corretagem' },
  { key: 'mercado', label: 'Mercado' },
  { key: 'estrutura', label: 'Estrutura' },
  { key: 'ativo', label: 'Ativo' },
  { key: 'vencimento', label: 'Vencimento' },
  { key: 'quantidade', label: 'Quantidade' },
  { key: 'precoCompra', label: 'Preco Compra' },
  { key: 'volumeNegociado', label: 'Volume Negociado' },
  { key: 'corretagemBruta', label: 'Corretagem Bruta' },
  { key: 'comissaoBase', label: 'Comissao Base' },
  { key: 'receitaLiquida', label: 'Receita Liquida' },
  { key: 'receitaBruta', label: 'Receita Bruta' },
  { key: 'sourceRegistro', label: 'Source Registro' },
]

export const buildMonthlyConsolidatedExportPayload = ({ monthKey, tagsIndex }) => {
  const sources = [
    { line: 'Bovespa', entries: loadRevenueList('bovespa') },
    { line: 'BMF', entries: loadRevenueList('bmf') },
    { line: 'Estruturadas', entries: loadStructuredRevenue() },
  ]

  const totals = {
    Bovespa: 0,
    BMF: 0,
    Estruturadas: 0,
  }
  const rows = []

  sources.forEach(({ line, entries }) => {
    ;(Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (getMonthKey(resolveDataKey(entry)) !== monthKey) return
      const resolved = resolveConsolidatedRow(line, entry, tagsIndex)
      if (!resolved) return
      rows.push(resolved)
      totals[line] += toSafeNumber(resolved.receitaBruta)
    })
  })

  rows.sort((left, right) => {
    if (left.linha !== right.linha) {
      return String(left.linha).localeCompare(String(right.linha), 'pt-BR')
    }
    if (left.data !== right.data) {
      return String(left.data).localeCompare(String(right.data), 'pt-BR')
    }
    return String(left.conta).localeCompare(String(right.conta), 'pt-BR')
  })

  const headers = CONSOLIDATED_EXPORT_COLUMNS.map((column) => column.label)
  const exportRows = rows.map((row) => CONSOLIDATED_EXPORT_COLUMNS.map((column) => row[column.key] ?? ''))
  const totalColumnIndex = CONSOLIDATED_EXPORT_COLUMNS.findIndex((column) => column.key === 'receitaBruta')
  const appendTotalRow = (label, value) => {
    const totalRow = Array.from({ length: headers.length }, () => '')
    totalRow[0] = label
    totalRow[Math.max(totalColumnIndex, 0)] = Number(toRounded(value))
    exportRows.push(totalRow)
  }

  if (rows.length) {
    exportRows.push([])
    appendTotalRow('TOTAL BOVESPA', totals.Bovespa)
    appendTotalRow('TOTAL BMF', totals.BMF)
    appendTotalRow('TOTAL ESTRUTURADAS (x2)', totals.Estruturadas)
    appendTotalRow('TOTAL GERAL BRUTO', totals.Bovespa + totals.BMF + totals.Estruturadas)
  }

  return {
    headers,
    rows: exportRows,
    totals: {
      ...totals,
      geral: totals.Bovespa + totals.BMF + totals.Estruturadas,
    },
    rowCount: rows.length,
  }
}

export const importConsolidatedRevenueComplement = async ({ input, tagsIndex }) => {
  const buffer = await toArrayBuffer(input)
  if (!buffer) {
    return {
      ok: false,
      error: 'Arquivo invalido.',
    }
  }

  const XLSX = await loadXlsx()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader('Receita Bruta'))
    || workbook.SheetNames[0]
  if (!sheetName) {
    return {
      ok: false,
      error: 'Planilha nao encontrada no arquivo.',
    }
  }

  const sheet = workbook.Sheets[sheetName]
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  const { parsedRows, ignoredRows } = parseConsolidatedRows(rawRows)

  const existingBovespa = loadRevenueList('bovespa')
  const existingBmf = loadRevenueList('bmf')
  const existingStructured = loadStructuredRevenue()
  const existingMonths = new Set(
    [...existingBovespa, ...existingBmf, ...existingStructured]
      .map((entry) => getMonthKey(resolveDataKey(entry)))
      .filter(Boolean),
  )
  const fileMonths = Array.from(new Set(parsedRows.map((row) => row.mesApuracao))).sort()
  const monthsToImport = fileMonths.filter((monthKey) => !existingMonths.has(monthKey))
  const monthsSkipped = fileMonths.filter((monthKey) => existingMonths.has(monthKey))
  const monthsToImportSet = new Set(monthsToImport)
  const rowsToImport = parsedRows.filter((row) => monthsToImportSet.has(row.mesApuracao))

  const newBovespa = []
  const newBmf = []
  const newStructured = []

  rowsToImport.forEach((row, index) => {
    if (row.line === 'Bovespa') {
      newBovespa.push(buildBovespaOrBmfEntry('Bovespa', row, index, tagsIndex))
      return
    }
    if (row.line === 'BMF') {
      newBmf.push(buildBovespaOrBmfEntry('BMF', row, index, tagsIndex))
      return
    }
    if (row.line === 'Estruturadas') {
      newStructured.push(buildStructuredEntry(row, index, tagsIndex))
    }
  })

  if (newBovespa.length) {
    saveRevenueList('bovespa', [...existingBovespa, ...newBovespa])
  }
  if (newBmf.length) {
    saveRevenueList('bmf', [...existingBmf, ...newBmf])
  }
  if (newStructured.length) {
    saveStructuredRevenue([...existingStructured, ...newStructured])
  }

  return {
    ok: true,
    summary: {
      sheetName,
      fileRows: rawRows.length,
      parsedRows: parsedRows.length,
      ignoredRows,
      fileMonths,
      monthsToImport,
      monthsSkipped,
      importedRows: rowsToImport.length,
      importedByLine: {
        bovespa: newBovespa.length,
        bmf: newBmf.length,
        estruturadas: newStructured.length,
      },
    },
  }
}
