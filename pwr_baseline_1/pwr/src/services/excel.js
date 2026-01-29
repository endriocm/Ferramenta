const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'

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

const normalizeCodigoCliente = (value) => {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const normalized = normalizeKey(raw)
  if (normalized.includes('codigocliente') || normalized.includes('codigodocliente')) return null
  return raw
}

const resolveCodigoCliente = (normalizedRow, fallbackValue) => {
  const byHeader = getValue(normalizedRow, CODIGO_CLIENTE_KEYS)
  if (byHeader != null && byHeader !== '') return String(byHeader).trim()
  return normalizeCodigoCliente(fallbackValue)
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

const toDateOnlyString = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const CODIGO_CLIENTE_KEYS = ['codigocliente', 'codigodocliente', 'codcliente', 'clienteid', 'conta', 'numerodaconta', 'codconta']
const CODIGO_OPERACAO_KEYS = ['codigooperacao', 'codigodaoperacao', 'codoperacao', 'operacaoid', 'idoperacao', 'operacao', 'codigo']

const hashString = (value) => {
  let hash = 5381
  const str = String(value || '')
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash &= 0xffffffff
  }
  return Math.abs(hash).toString(36)
}

const buildOperationId = (payload) => {
  const base = [
    payload.codigoOperacao,
    payload.codigoCliente,
    payload.cliente,
    payload.ativo,
    payload.estrutura,
    payload.dataRegistro,
    payload.vencimento,
    payload.spotInicial,
    payload.custoUnitario,
    payload.quantidade,
  ].map((item) => String(item || '').trim()).join('|')
  const legs = (payload.pernas || [])
    .map((leg) => `${leg.tipo || ''}:${leg.side || ''}:${leg.quantidade || ''}:${leg.strike || ''}:${leg.barreiraTipo || ''}:${leg.barreiraValor || ''}`)
    .join('|')
  return `op-${hashString(`${base}|${legs}`)}`
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

const parsePosicaoConsolidada = (normalizedRow, fallbackRow, XLSX) => {
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

  const codigoCliente = resolveCodigoCliente(normalizedRow, fallbackRow?.[0])
  const codigoOperacao = getValue(normalizedRow, CODIGO_OPERACAO_KEYS)
  const clienteNome = getValue(normalizedRow, ['cliente', 'nomecliente'])
  const clienteLabel = clienteNome || codigoCliente

  return {
    id: codigoOperacao != null && codigoOperacao !== '' ? String(codigoOperacao) : buildOperationId({
      codigoOperacao,
      codigoCliente,
      cliente: clienteLabel,
      ativo: getValue(normalizedRow, ['ativo', 'ticker']),
      estrutura: getValue(normalizedRow, ['estrutura', 'tipoestrutura']),
      dataRegistro: normalizeDate(getValue(normalizedRow, ['dataregistro']), XLSX),
      vencimento: normalizeDate(getValue(normalizedRow, ['datavencimento']), XLSX),
      spotInicial: spotInicial ?? null,
      custoUnitario: custoUnitario ?? null,
      quantidade: quantidadeStock ?? 0,
      pernas: legs,
    }),
    codigoCliente,
    cliente: clienteLabel,
    assessor: getValue(normalizedRow, ['codigodoassessor', 'assessor', 'consultor']),
    broker: getValue(normalizedRow, ['canaldeorigem', 'broker', 'corretora']),
    ativo: getValue(normalizedRow, ['ativo', 'ticker']),
    estrutura: getValue(normalizedRow, ['estrutura', 'tipoestrutura']),
    codigoOperacao,
    dataRegistro: normalizeDate(getValue(normalizedRow, ['dataregistro']), XLSX),
    vencimento: normalizeDate(getValue(normalizedRow, ['datavencimento']), XLSX),
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

const normalizeDate = (value, XLSX) => {
  if (!value) return ''
  if (value instanceof Date) return toDateOnlyString(value)
  if (typeof value === 'number' && XLSX?.SSF?.parse_date_code) {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed?.y && parsed?.m && parsed?.d) {
      const date = new Date(parsed.y, parsed.m - 1, parsed.d)
      return toDateOnlyString(date)
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const match = trimmed.match(/(\d{2})[/-](\d{2})[/-](\d{4})/)
    if (match) {
      const [, day, month, year] = match
      return `${year}-${month}-${day}`
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
  }
  return value
}

const parseBuffer = (buffer, XLSX) => {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = pickSheetName(workbook)
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false })
  const rowOffset = rawRows.length > rows.length ? 1 : 0

  return rows.map((row, index) => {
    const fallbackRow = rawRows?.[rowOffset + index] || []
    const normalizedRow = Object.keys(row).reduce((acc, key) => {
      acc[normalizeKey(key)] = row[key]
      return acc
    }, {})

    const posicaoRow = parsePosicaoConsolidada(normalizedRow, fallbackRow, XLSX)
    if (posicaoRow) return posicaoRow

    const dataRegistro = normalizeDate(getValue(normalizedRow, ['dataregistro', 'dataderegistro', 'dataentrada', 'datainicio', 'entrada']), XLSX)
    const dataVencimento = normalizeDate(getValue(normalizedRow, ['datavencimento', 'datadevencimento', 'datafim', 'vencimento']), XLSX)

    const quantidade = toNumber(getValue(normalizedRow, ['quantidade', 'qtd', 'lote', 'quantidadeacoes', 'quantidadeacao', 'qtdacoes', 'qtdacao', 'estoque', 'posicao']))
    const pernas = parseLegs(normalizedRow)
    const columnLegs = parseColumnLegs(normalizedRow, quantidade)
    const codigoCliente = resolveCodigoCliente(normalizedRow, fallbackRow?.[0])
    const codigoOperacao = getValue(normalizedRow, CODIGO_OPERACAO_KEYS)
    const clienteNome = getValue(normalizedRow, ['cliente', 'nomecliente'])
    const clienteLabel = clienteNome || codigoCliente

    return {
      id: codigoOperacao != null && codigoOperacao !== '' ? String(codigoOperacao) : buildOperationId({
        codigoOperacao,
        codigoCliente,
        cliente: clienteLabel,
        ativo: getValue(normalizedRow, ['ativo', 'ticker']),
        estrutura: getValue(normalizedRow, ['estrutura', 'tipoestrutura']),
        dataRegistro: dataRegistro || '',
        vencimento: dataVencimento || '',
        spotInicial: toNumber(getValue(normalizedRow, ['spotinicial', 'spotentrada', 'spot', 'valordecompra', 'valorentrada'])),
        custoUnitario: toNumber(getValue(normalizedRow, ['custounitario', 'custounit', 'custo'])),
        quantidade: quantidade ?? 0,
        pernas: pernas.length ? pernas : columnLegs,
      }),
      cliente: clienteLabel,
      codigoCliente,
      assessor: getValue(normalizedRow, ['assessor', 'consultor']),
      broker: getValue(normalizedRow, ['broker', 'corretora']),
      ativo: getValue(normalizedRow, ['ativo', 'ticker']),
      estrutura: getValue(normalizedRow, ['estrutura', 'tipoestrutura']),
      codigoOperacao,
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

export const parseWorkbookBuffer = async (buffer) => {
  const XLSX = await import(/* @vite-ignore */ XLSX_URL)
  return parseBuffer(buffer, XLSX)
}

export const parseWorkbook = async (file) => {
  const buffer = await file.arrayBuffer()
  return parseWorkbookBuffer(buffer)
}
