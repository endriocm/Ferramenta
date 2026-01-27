const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'

const normalizeKey = (value) => String(value || '')
  .toLowerCase()
  .replace(/\s+/g, '')
  .replace(/[^a-z0-9]/g, '')

const getValue = (row, keys) => {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return row[key]
  }
  return null
}

const parseLegs = (row) => {
  const legs = []
  for (let i = 1; i <= 4; i += 1) {
    const prefix = `perna${i}`
    const tipo = getValue(row, [`${prefix}tipo`, `${prefix}opcao`, `${prefix}tipoperna`])
    const strike = getValue(row, [`${prefix}strike`, `${prefix}preco`, `${prefix}precoexercicio`])
    const barreiraValor = getValue(row, [`${prefix}barreira`, `${prefix}nivelbarreira`])
    const barreiraTipo = getValue(row, [`${prefix}tipobarreira`, `${prefix}barreiratipo`])
    const rebate = getValue(row, [`${prefix}rebate`, `${prefix}rebatevalor`])
    if (!tipo && !strike && !barreiraValor) continue
    legs.push({
      id: `${prefix}`,
      tipo,
      strike,
      barreiraValor,
      barreiraTipo,
      rebate: rebate || 0,
    })
  }
  return legs
}

const parseColumnLegs = (row, quantity) => {
  const legs = []
  const callComprada = getValue(row, ['callcomprada', 'callcompra'])
  const callVendida = getValue(row, ['callvendida', 'callvenda'])
  const putComprada = getValue(row, ['putcomprada', 'putcompra'])
  const putComprada2 = getValue(row, ['putcomprada2', 'putcompra2'])
  const putVendida = getValue(row, ['putvendida', 'putvenda'])

  if (callComprada) legs.push({ id: 'call-comprada', tipo: 'CALL', side: 'long', strike: callComprada, quantidade: quantity })
  if (callVendida) legs.push({ id: 'call-vendida', tipo: 'CALL', side: 'short', strike: callVendida, quantidade: quantity })
  if (putComprada) legs.push({ id: 'put-comprada', tipo: 'PUT', side: 'long', strike: putComprada, quantidade: quantity })
  if (putComprada2) legs.push({ id: 'put-comprada-2', tipo: 'PUT', side: 'long', strike: putComprada2, quantidade: quantity })
  if (putVendida) legs.push({ id: 'put-vendida', tipo: 'PUT', side: 'short', strike: putVendida, quantidade: quantity })

  const barreiraKi = getValue(row, ['barreiraki', 'barreira_ki'])
  const barreiraKo = getValue(row, ['barreirako', 'barreira_ko'])
  if (barreiraKi) legs.push({ id: 'barreira-ki', barreiraValor: barreiraKi, barreiraTipo: 'KI' })
  if (barreiraKo) legs.push({ id: 'barreira-ko', barreiraValor: barreiraKo, barreiraTipo: 'KO' })

  return legs
}

const normalizeDate = (value, XLSX) => {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && XLSX?.SSF?.parse_date_code) {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed?.y && parsed?.m && parsed?.d) {
      const date = new Date(parsed.y, parsed.m - 1, parsed.d)
      return date.toISOString().slice(0, 10)
    }
  }
  return value
}

export const parseWorkbook = async (file) => {
  const XLSX = await import(/* @vite-ignore */ XLSX_URL)
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })

  return rows.map((row) => {
    const normalizedRow = Object.keys(row).reduce((acc, key) => {
      acc[normalizeKey(key)] = row[key]
      return acc
    }, {})

    const dataRegistro = normalizeDate(getValue(normalizedRow, ['dataregistro', 'dataentrada', 'datainicio']), XLSX)
    const dataVencimento = normalizeDate(getValue(normalizedRow, ['datavencimento', 'datafim']), XLSX)

    const quantidade = getValue(normalizedRow, ['quantidade', 'qtd', 'lote'])
    const pernas = parseLegs(normalizedRow)
    const columnLegs = parseColumnLegs(normalizedRow, quantidade)

    return {
      id: String(getValue(normalizedRow, ['id', 'operacao', 'codigooperacao']) || Math.random().toString(36).slice(2)),
      cliente: getValue(normalizedRow, ['cliente', 'nomecliente']),
      assessor: getValue(normalizedRow, ['assessor', 'consultor']),
      broker: getValue(normalizedRow, ['broker', 'corretora']),
      ativo: getValue(normalizedRow, ['ativo', 'ticker']),
      estrutura: getValue(normalizedRow, ['estrutura', 'tipoestrutura']),
      codigoOperacao: getValue(normalizedRow, ['codigooperacao', 'operacao']),
      dataRegistro: dataRegistro || '',
      vencimento: dataVencimento || '',
      spotInicial: getValue(normalizedRow, ['spotinicial', 'spotentrada', 'spot', 'valordecompra', 'valorentrada']),
      custoUnitario: getValue(normalizedRow, ['custounitario', 'custounit', 'custo']),
      quantidade,
      cupom: getValue(normalizedRow, ['cupom', 'taxacupom']),
      pagou: getValue(normalizedRow, ['pagou']),
      pernas: pernas.length ? pernas : columnLegs,
    }
  })
}
