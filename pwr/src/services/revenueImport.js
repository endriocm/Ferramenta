import { parseXlsxInWorker } from './xlsxWorkerClient'
import { resolveByClientCode } from '../lib/tagResolver'
import { normalizeAssessorName } from '../utils/assessor'
import { toNumber } from '../utils/number'
import { mapXpProductCategoryToLine } from './revenueXpCommission'

const normalizeHeader = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '')

const normalizeValue = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const isTotalMarker = (value) => {
  const normalized = normalizeValue(value)
  return normalized === 'total' || normalized === 'totais'
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

const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0))

const processInChunks = async (rows, chunkSize, { onProgress, isCanceled, onChunk, getProcessed }) => {
  const total = rows.length
  let processed = 0
  const size = Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : 500

  for (let start = 0; start < total; start += size) {
    if (isCanceled?.()) return { canceled: true, processed }
    const end = Math.min(total, start + size)
    const chunkResult = await onChunk(rows, start, end)
    if (chunkResult === 'cancelled') {
      processed = getProcessed ? getProcessed() : processed
      return { canceled: true, processed }
    }
    processed = getProcessed ? getProcessed() : end
    if (onProgress) {
      onProgress({
        processed,
        rawRows: total,
        progress: total ? processed / total : 1,
      })
    }
    await yieldToMain()
  }

  return { canceled: false, processed }
}

const parseDate = (value, XLSX) => {
  if (!value) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  if (typeof value === 'number') {
    if (XLSX?.SSF?.parse_date_code) {
      const parsed = XLSX.SSF.parse_date_code(value)
      if (parsed?.y && parsed?.m && parsed?.d) {
        const date = new Date(parsed.y, parsed.m - 1, parsed.d)
        return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
      }
    }
    // Fallback sem dependencia de XLSX (serial Excel -> data UTC)
    const serial = Number(value)
    if (Number.isFinite(serial)) {
      const baseUtc = Date.UTC(1899, 11, 30)
      const ms = Math.round(serial * 86400000)
      const date = new Date(baseUtc + ms)
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
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

const parseDateFlexible = (value, XLSX) => {
  const base = parseDate(value, XLSX)
  if (base) return base
  const raw = String(value || '').trim()
  if (!raw) return ''
  const shortMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/)
  if (shortMatch) {
    const [, firstRaw, secondRaw, yearRaw] = shortMatch
    const first = Number(firstRaw)
    const second = Number(secondRaw)
    const month = first > 12 && second <= 12 ? second : first
    const day = first > 12 && second <= 12 ? first : second
    const year = 2000 + Number(yearRaw)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(year, month - 1, day)
      return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
    }
  }
  const longMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (longMatch) {
    const [, firstRaw, secondRaw, yearRaw] = longMatch
    const first = Number(firstRaw)
    const second = Number(secondRaw)
    const month = first > 12 && second <= 12 ? second : first
    const day = first > 12 && second <= 12 ? first : second
    const year = Number(yearRaw)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(year, month - 1, day)
      return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
    }
  }
  return ''
}

const pickSheetName = (sheetNames) => {
  if (!sheetNames?.length) return null
  const preferred = sheetNames.find((name) => normalizeHeader(name) === 'export')
  return preferred || sheetNames[0]
}

const shouldLogImportStats = () => {
  if (typeof window === 'undefined') return false
  try {
    if (import.meta?.env?.DEV) return true
    return localStorage.getItem('pwr.debug.receita') === '1'
  } catch {
    return false
  }
}

const createDiscardTracker = () => ({
  counts: {},
  samples: {},
})

const recordDiscard = (tracker, reason, rowIndex) => {
  if (!tracker) return
  tracker.counts[reason] = (tracker.counts[reason] || 0) + 1
  if (!tracker.samples[reason]) tracker.samples[reason] = []
  if (tracker.samples[reason].length < 3) {
    tracker.samples[reason].push(rowIndex + 2)
  }
}

const buildHeaderMap = (rows) => {
  const headers = rows.length ? Object.keys(rows[0] || {}) : []
  const headerMap = headers.reduce((acc, header) => {
    acc[normalizeHeader(header)] = header
    return acc
  }, {})
  return { headers, headerMap }
}

const buildIntegrityReport = ({ sheetName, meta, processedRows, validRows, savedRows }) => {
  const estimatedExcelRows = meta?.estimatedExcelRows ?? 0
  const estimatedDataRows = meta?.estimatedDataRows ?? 0
  const rawRows = meta?.rawRowCount ?? 0
  const processed = processedRows || 0
  const mismatch = estimatedDataRows - processed
  const mismatchPct = estimatedDataRows ? mismatch / estimatedDataRows : 0
  return {
    sheetName: sheetName || '',
    estimatedExcelRows,
    estimatedDataRows,
    rawRows,
    processedRows: processed,
    validRows: validRows || 0,
    savedRows: savedRows || 0,
    mismatch,
    mismatchPct,
  }
}

const buildWarningsFromIntegrity = (integrity) => {
  if (!integrity) return []
  const mismatch = Number(integrity.mismatch) || 0
  const mismatchPct = Number(integrity.mismatchPct) || 0
  if (mismatch > 0 && (mismatchPct > 0.01 || mismatch >= 10)) {
    return [{
      code: 'POSSIBLE_TRUNCATION',
      message: `Possivel truncamento: Excel tem ${integrity.estimatedDataRows} linhas e so ${integrity.processedRows} foram processadas.`,
    }]
  }
  return []
}

const enrichFromTags = (partial, tagIndex) => {
  const next = {
    ...partial,
    assessor: normalizeAssessorName(partial?.assessor),
  }
  if (!tagIndex || !tagIndex.size) return { enriched: false, data: next }
  const resolved = resolveByClientCode(tagIndex, partial.codigoCliente)
  if (!resolved) return { enriched: false, data: next }
  let enriched = false
  if (!next.codigoCliente && resolved.codigoCliente) {
    next.codigoCliente = resolved.codigoCliente
    enriched = true
  }
  const resolvedAssessor = normalizeAssessorName(resolved.assessor)
  if (!next.assessor && resolvedAssessor) {
    next.assessor = resolvedAssessor
    enriched = true
  }
  if (!next.broker && resolved.broker) {
    next.broker = resolved.broker
    enriched = true
  }
  if (!next.time && resolved.time) {
    next.time = resolved.time
    enriched = true
  }
  if (!next.unit && resolved.unit) {
    next.unit = resolved.unit
    enriched = true
  }
  if (!next.seniority && resolved.seniority) {
    next.seniority = resolved.seniority
    enriched = true
  }
  return { enriched, data: next }
}

const REJECT_REASON_MESSAGES = {
  header_repeat: 'Linha de cabecalho repetida',
  total_row: 'Linha de total/rodape',
  missing_required: 'Campos obrigatorios ausentes',
  mercado_mismatch: 'Mercado diferente do selecionado',
  category_unmapped: 'Categoria XP nao mapeada',
}

const buildDetailsPayload = (rejected, duplicated, { canceled } = {}) => ({
  rejected: Array.isArray(rejected) ? rejected : [],
  duplicated: Array.isArray(duplicated) ? duplicated : [],
  canceled: Boolean(canceled),
})

export const parseBovespaReceitasFile = async (
  input,
  {
    mercado = 'bov',
    fatorReceita = 0.9335 * 0.8285,
    onProgress,
    signal,
    tagIndex,
    chunkSize = 500,
  } = {},
) => {
  const buffer = await toArrayBuffer(input)
  if (!buffer) return { ok: false, error: { code: 'BUFFER_INVALID', message: 'Arquivo invalido.' } }
  const { sheetNames, sheets } = await parseXlsxInWorker(buffer)
  const sheetName = pickSheetName(sheetNames)
  if (!sheetName) {
    return { ok: false, error: { code: 'SHEET_NOT_FOUND', message: 'Sheet "Export" nao encontrada.' } }
  }
  const { rows, meta } = sheets[sheetName]
  const { headers, headerMap } = buildHeaderMap(rows)

  const required = {
    conta: ['conta', 'contacliente', 'codigocliente', 'cliente'],
    corretagem: ['corretagem'],
    volume: ['volumenegociado', 'volumenegociacao', 'volume', 'vol'],
    tipoCorretagem: ['tipodecorretagem', 'tipocorretagem', 'corretagemtipo'],
    mercado: ['mercado'],
    data: ['data', 'dataoperacao', 'dataoperacao'],
  }
  const optional = {
    nomeCliente: ['nomecliente', 'nomedocliente', 'razaosocial', 'clientenome'],
    assessor: ['assessor', 'consultor', 'assessorresponsavel'],
    broker: ['broker', 'corretora', 'canaldeorigem', 'origem'],
  }

  const resolveHeader = (keys) => keys.find((key) => headerMap[key])
  const resolveOptional = (keys) => keys.find((key) => headerMap[key])
  const optionalHeaders = {
    nomeCliente: resolveOptional(optional.nomeCliente),
    assessor: resolveOptional(optional.assessor),
    broker: resolveOptional(optional.broker),
  }
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
  let duplicatedRows = 0
  let processedRows = 0
  let enrichedRows = 0
  let autoFixedRows = 0
  let totalCorretagem = 0
  let totalReceita = 0
  let totalVolume = 0
  const uniqueContas = new Set()
  const entries = []
  const rejectedDetails = []
  const duplicatedDetails = []
  const duplicateIndex = new Map()
  const headerRows = meta?.headerRows ?? 1
  const toExcelRowIndex = (index) => index + headerRows + 1
  const tagWarning = (!tagIndex || !tagIndex.size)
    ? { code: 'TAGS_EMPTY', message: 'Tags nao carregadas - enrich desativado.' }
    : null
  const pushRejected = (item) => { rejectedDetails.push(item) }
  const pushDuplicated = (item) => { duplicatedDetails.push(item) }
  const discardTracker = createDiscardTracker()
  const isHeaderRepeat = (values) => {
    const matches = []
    const contaNorm = normalizeHeader(values.conta)
    const corretagemNorm = normalizeHeader(values.corretagem)
    const mercadoNorm = normalizeHeader(values.mercado)
    if (required.conta.includes(contaNorm)) matches.push('conta')
    if (required.corretagem.includes(corretagemNorm)) matches.push('corretagem')
    if (required.mercado.includes(mercadoNorm)) matches.push('mercado')
    return matches.length >= 2
  }

  const isCanceled = () => Boolean(signal?.aborted)
  const chunkResult = await processInChunks(rows, chunkSize, {
    onProgress,
    isCanceled,
    getProcessed: () => processedRows,
    onChunk: (allRows, start, end) => {
      for (let index = start; index < end; index += 1) {
        if (isCanceled()) return 'cancelled'
        const row = allRows[index]
        processedRows += 1
        const contaRaw = row[headerMap[resolveHeader(required.conta)]]
        const corretagemRaw = row[headerMap[resolveHeader(required.corretagem)]]
        const volumeRaw = row[headerMap[resolveHeader(required.volume)]]
        const tipoRaw = row[headerMap[resolveHeader(required.tipoCorretagem)]]
        const mercadoRaw = row[headerMap[resolveHeader(required.mercado)]]
        const dataRaw = row[headerMap[resolveHeader(required.data)]]
        const nomeClienteRaw = optionalHeaders.nomeCliente ? row[headerMap[optionalHeaders.nomeCliente]] : ''
        const assessorRaw = optionalHeaders.assessor ? row[headerMap[optionalHeaders.assessor]] : ''
        const brokerRaw = optionalHeaders.broker ? row[headerMap[optionalHeaders.broker]] : ''
        const rowIndex = toExcelRowIndex(index)
        const raw = {
          conta: contaRaw,
          corretagem: corretagemRaw,
          volume: volumeRaw,
          tipoCorretagem: tipoRaw,
          mercado: mercadoRaw,
          data: dataRaw,
          nomeCliente: nomeClienteRaw,
          assessor: assessorRaw,
          broker: brokerRaw,
        }

        if (isHeaderRepeat({ conta: contaRaw, corretagem: corretagemRaw, mercado: mercadoRaw })) {
          rowsFiltered += 1
          recordDiscard(discardTracker, 'header_repeat', index)
          pushRejected({
            rowIndex,
            reasonCode: 'header_repeat',
            reasonMessage: REJECT_REASON_MESSAGES.header_repeat,
            raw,
          })
          continue
        }

        let conta = String(contaRaw || '').trim()
        if (isTotalMarker(conta)) {
          rowsFiltered += 1
          recordDiscard(discardTracker, 'total_row', index)
          pushRejected({
            rowIndex,
            reasonCode: 'total_row',
            reasonMessage: REJECT_REASON_MESSAGES.total_row,
            raw,
            normalized: { conta },
          })
          continue
        }

        const corretagem = toNumber(corretagemRaw)
        const volume = toNumber(volumeRaw)
        const tipoCorretagem = normalizeValue(tipoRaw)
        const mercadoValue = normalizeValue(mercadoRaw)
        const dataISO = parseDate(dataRaw)
        const basePartial = {
          codigoCliente: conta,
          nomeCliente: String(nomeClienteRaw || '').trim(),
          assessor: normalizeAssessorName(String(assessorRaw || '').trim()),
          broker: String(brokerRaw || '').trim(),
        }
        const wasMissingRequired = (!conta || corretagem == null || !dataISO)
        const enrichedResult = enrichFromTags(basePartial, tagIndex)
        if (enrichedResult.enriched) enrichedRows += 1
        const enrichedFields = enrichedResult.data
        if (!conta && enrichedFields.codigoCliente) {
          conta = enrichedFields.codigoCliente
        }
        const nomeCliente = enrichedFields.nomeCliente || basePartial.nomeCliente
        const assessor = enrichedFields.assessor || basePartial.assessor
        const broker = enrichedFields.broker || basePartial.broker
        const normalized = {
          conta,
          codigoCliente: conta,
          corretagem,
          volume,
          volumeNegociado: volume ?? '',
          tipoCorretagem,
          mercado: mercadoValue,
          data: dataISO,
          nomeCliente: '',
          assessor,
          broker,
        }

        if (!conta || corretagem == null || !dataISO) {
          rowsFiltered += 1
          recordDiscard(discardTracker, 'missing_required', index)
          pushRejected({
            rowIndex,
            reasonCode: 'missing_required',
            reasonMessage: REJECT_REASON_MESSAGES.missing_required,
            raw,
            normalized,
          })
          continue
        }
        if (wasMissingRequired && conta && corretagem != null && dataISO) {
          autoFixedRows += 1
        }
        if (mercadoValue !== mercadoTarget) {
          rowsFiltered += 1
          recordDiscard(discardTracker, 'mercado_mismatch', index)
          pushRejected({
            rowIndex,
            reasonCode: 'mercado_mismatch',
            reasonMessage: REJECT_REASON_MESSAGES.mercado_mismatch,
            raw,
            normalized,
          })
          continue
        }

        rowsValid += 1
        uniqueContas.add(conta)
        totalCorretagem += corretagem
        totalVolume += volume || 0
        const receitaCalculada = corretagem * fatorReceita
        totalReceita += receitaCalculada
        const duplicateKey = [
          conta,
          dataISO,
          corretagem,
          volume ?? '',
          tipoCorretagem,
          mercadoValue,
        ].join('|')
        if (duplicateIndex.has(duplicateKey)) {
          duplicatedRows += 1
          const firstSeenRowIndex = duplicateIndex.get(duplicateKey)
          pushDuplicated({
            rowIndex,
            duplicateKey,
            firstSeenRowIndex,
            reasonMessage: firstSeenRowIndex ? `Duplicado (primeira linha ${firstSeenRowIndex})` : 'Duplicado',
            raw,
            normalized,
          })
        } else {
          duplicateIndex.set(duplicateKey, rowIndex)
        }
        entries.push({
          id: `bov-${index}-${Date.now()}`,
          codigoCliente: conta,
          conta,
          data: dataISO,
          nomeCliente: '',
          assessor,
          broker,
          corretagem,
          receitaBrutaBase: Number(corretagem.toFixed(6)),
          volumeNegociado: volume || 0,
          tipoCorretagem,
          mercado: mercadoValue.toUpperCase(),
          repasse: Number(fatorReceita.toFixed(6)),
          receita: Number(receitaCalculada.toFixed(6)),
          origem: mercadoTarget === 'bmf' ? 'BMF' : 'Bovespa',
          source: 'import',
        })
      }
      return null
    },
  })

  if (chunkResult.canceled) {
    const integrity = buildIntegrityReport({
      sheetName,
      meta,
      processedRows,
      validRows: rowsValid,
      savedRows: entries.length,
    })
    const details = buildDetailsPayload(rejectedDetails, duplicatedDetails, {
      canceled: true,
    })
    const canceledStats = {
      rawRows: rowsRead,
      processedRows,
      validRows: rowsValid,
      savedRows: entries.length,
      rejectedRows: rowsFiltered,
      duplicatedRows,
      enrichedRows,
      autoFixedRows,
      integrity,
      warnings: [],
      details,
    }
    if (tagWarning) canceledStats.warnings.push(tagWarning)
    return {
      ok: false,
      error: { code: 'CANCELLED', message: 'Importacao cancelada.' },
      entries: [],
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
        stats: canceledStats,
      },
    }
  }

  const integrity = buildIntegrityReport({
    sheetName,
    meta,
    processedRows,
    validRows: rowsValid,
    savedRows: entries.length,
  })
  const warnings = buildWarningsFromIntegrity(integrity)
  const details = buildDetailsPayload(rejectedDetails, duplicatedDetails, {
    canceled: false,
  })
  if (tagWarning) warnings.push(tagWarning)
  const importStats = {
    sheetRef: meta.sheetRef,
    sheetRefResolved: meta.fullRef,
    sheetRows: meta.rowCount,
    rawRowCount: meta.rawRowCount,
    rowsRead,
    processedRows,
    excelValidCount: rowsValid,
    importedCount: entries.length,
    discardedCount: rowsFiltered,
    discardedReasons: discardTracker.counts,
    discardedReasonsSample: discardTracker.samples,
    integrity,
    warnings,
  }

  const importLabel = mercadoTarget === 'bmf' ? 'BMF' : 'Bovespa'
  const rawRows = importStats.rawRowCount ?? rowsRead
  if (shouldLogImportStats()) {
    console.info('[receita-import:bovespa]', importStats)
  }
  if (warnings.length) {
    console.warn(`[receita-import:${importLabel.toLowerCase()}] warnings`, warnings)
  }
  console.log(`[IMPORT][${importLabel}] rawRows=`, rawRows, 'validRows=', rowsValid, 'savedRows=', entries.length)

  const stats = {
    rawRows: rowsRead,
    processedRows,
    validRows: rowsValid,
    savedRows: entries.length,
    rejectedRows: rowsFiltered,
    duplicatedRows,
    enrichedRows,
    autoFixedRows,
    integrity,
    warnings,
    details,
  }

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
      importStats,
      stats,
    },
  }
}

export const parseStructuredReceitasFile = async (
  input,
  { onProgress, signal, tagIndex, chunkSize = 500 } = {},
) => {
  const buffer = await toArrayBuffer(input)
  if (!buffer) return { ok: false, error: { code: 'BUFFER_INVALID', message: 'Arquivo invalido.' } }
  const { sheetNames, sheets } = await parseXlsxInWorker(buffer)
  const sheetName = sheetNames.find((name) => {
    const trimmed = String(name || '').trim()
    return trimmed === 'Operações' || trimmed === 'Operacoes'
  })
  if (!sheetName) {
    return { ok: false, error: { code: 'SHEET_NOT_FOUND', message: 'Sheet "Operações" nao encontrada.' } }
  }
  const { rows, meta } = sheets[sheetName]
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
  const optionalTag = {
    nomeCliente: ['nomecliente', 'nomedocliente', 'razaosocial', 'clientenome'],
    assessor: ['assessor', 'consultor', 'assessorresponsavel'],
    broker: ['broker', 'corretora', 'canaldeorigem', 'origem'],
  }
  const missing = Object.values(required).filter((key) => !headerMap[key])
  if (missing.length) {
    return {
      ok: false,
      error: { code: 'MISSING_COLUMN', message: 'Colunas obrigatorias ausentes.', details: { missing, headers } },
    }
  }

  const optionalHeaders = {
    nomeCliente: optionalTag.nomeCliente.find((key) => headerMap[key]),
    assessor: optionalTag.assessor.find((key) => headerMap[key]),
    broker: optionalTag.broker.find((key) => headerMap[key]),
  }

  let rowsValid = 0
  let rowsSkipped = 0
  let duplicatedRows = 0
  let processedRows = 0
  let enrichedRows = 0
  let autoFixedRows = 0
  let totalCommission = 0
  const months = new Set()
  const rejectedDetails = []
  const duplicatedDetails = []
  const duplicateIndex = new Map()
  const headerRows = meta?.headerRows ?? 1
  const toExcelRowIndex = (index) => index + headerRows + 1
  const tagWarning = (!tagIndex || !tagIndex.size)
    ? { code: 'TAGS_EMPTY', message: 'Tags nao carregadas - enrich desativado.' }
    : null
  const pushRejected = (item) => { rejectedDetails.push(item) }
  const pushDuplicated = (item) => { duplicatedDetails.push(item) }
  const discardTracker = createDiscardTracker()
  const isHeaderRepeat = (values) => {
    const matches = []
    const codigoNorm = normalizeHeader(values.codigoCliente)
    const dataNorm = normalizeHeader(values.dataInclusao)
    const estruturaNorm = normalizeHeader(values.estrutura)
    if (codigoNorm === required.codigoCliente) matches.push('codigoCliente')
    if (dataNorm === required.dataInclusao) matches.push('dataInclusao')
    if (estruturaNorm === required.estrutura) matches.push('estrutura')
    return matches.length >= 2
  }
  const entries = []
  const isCanceled = () => Boolean(signal?.aborted)
  const chunkResult = await processInChunks(rows, chunkSize, {
    onProgress,
    isCanceled,
    getProcessed: () => processedRows,
    onChunk: (allRows, start, end) => {
      for (let index = start; index < end; index += 1) {
        if (isCanceled()) return 'cancelled'
        const row = allRows[index]
        processedRows += 1
        const codigoRaw = row[headerMap[required.codigoCliente]]
        const dataRaw = row[headerMap[required.dataInclusao]]
        const estruturaRaw = row[headerMap[required.estrutura]]
        const ativoRaw = row[headerMap[required.ativo]]
        const fixingRaw = row[headerMap[required.fixing]]
        const comissaoRaw = row[headerMap[required.comissao]]
        const nomeClienteRaw = optionalHeaders.nomeCliente ? row[headerMap[optionalHeaders.nomeCliente]] : ''
        const assessorRaw = optionalHeaders.assessor ? row[headerMap[optionalHeaders.assessor]] : ''
        const brokerRaw = optionalHeaders.broker ? row[headerMap[optionalHeaders.broker]] : ''
        const rowIndex = toExcelRowIndex(index)
        const raw = {
          codigoCliente: codigoRaw,
          dataInclusao: dataRaw,
          estrutura: estruturaRaw,
          ativo: ativoRaw,
          fixing: fixingRaw,
          comissao: comissaoRaw,
          nomeCliente: nomeClienteRaw,
          assessor: assessorRaw,
          broker: brokerRaw,
          quantidade: row[headerMap[optional.quantidade.find((key) => headerMap[key])]],
          precoCompra: row[headerMap[optional.precoCompra.find((key) => headerMap[key])]],
        }

        if (isHeaderRepeat({ codigoCliente: codigoRaw, dataInclusao: dataRaw, estrutura: estruturaRaw })) {
          rowsSkipped += 1
          recordDiscard(discardTracker, 'header_repeat', index)
          pushRejected({
            rowIndex,
            reasonCode: 'header_repeat',
            reasonMessage: REJECT_REASON_MESSAGES.header_repeat,
            raw,
          })
          continue
        }

        if (isTotalMarker(codigoRaw)) {
          rowsSkipped += 1
          recordDiscard(discardTracker, 'total_row', index)
          pushRejected({
            rowIndex,
            reasonCode: 'total_row',
            reasonMessage: REJECT_REASON_MESSAGES.total_row,
            raw,
          })
          continue
        }

        const dataInclusao = parseDateBr(dataRaw)
        const comissao = toNumber(comissaoRaw)
        const quantidadeHeader = optional.quantidade.find((key) => headerMap[key])
        const precoHeader = optional.precoCompra.find((key) => headerMap[key])
        const quantidade = quantidadeHeader ? toNumber(row[headerMap[quantidadeHeader]]) : null
        const precoCompra = precoHeader ? toNumber(row[headerMap[precoHeader]]) : null
        const vencimento = parseDateBr(fixingRaw) || ''
        const basePartial = {
          codigoCliente: String(codigoRaw || '').trim(),
          nomeCliente: String(nomeClienteRaw || '').trim(),
          assessor: normalizeAssessorName(String(assessorRaw || '').trim()),
          broker: String(brokerRaw || '').trim(),
        }
        const wasMissingRequired = (!dataInclusao || comissao == null)
        const enrichedResult = enrichFromTags(basePartial, tagIndex)
        if (enrichedResult.enriched) enrichedRows += 1
        const enrichedFields = enrichedResult.data
        const codigoCliente = enrichedFields.codigoCliente || basePartial.codigoCliente
        const nomeCliente = enrichedFields.nomeCliente || basePartial.nomeCliente
        const assessor = enrichedFields.assessor || basePartial.assessor
        const broker = enrichedFields.broker || basePartial.broker
        const normalized = {
          codigoCliente,
          data: dataInclusao,
          estrutura: String(estruturaRaw || '').trim(),
          ativo: String(ativoRaw || '').trim(),
          vencimento,
          comissao,
          quantidade,
          precoCompra,
          nomeCliente: '',
          assessor,
          broker,
        }
        if (!dataInclusao || comissao == null) {
          rowsSkipped += 1
          recordDiscard(discardTracker, 'missing_required', index)
          pushRejected({
            rowIndex,
            reasonCode: 'missing_required',
            reasonMessage: REJECT_REASON_MESSAGES.missing_required,
            raw,
            normalized,
          })
          continue
        }
        if (wasMissingRequired && dataInclusao && comissao != null) {
          autoFixedRows += 1
        }
        rowsValid += 1
        totalCommission += comissao
        months.add(dataInclusao.slice(0, 7))
        const duplicateKey = [
          codigoCliente,
          dataInclusao,
          normalized.estrutura,
          normalized.ativo,
          comissao,
          quantidade ?? '',
          precoCompra ?? '',
          vencimento || '',
        ].join('|')
        if (duplicateIndex.has(duplicateKey)) {
          duplicatedRows += 1
          const firstSeenRowIndex = duplicateIndex.get(duplicateKey)
          pushDuplicated({
            rowIndex,
            duplicateKey,
            firstSeenRowIndex,
            reasonMessage: firstSeenRowIndex ? `Duplicado (primeira linha ${firstSeenRowIndex})` : 'Duplicado',
            raw,
            normalized,
          })
        } else {
          duplicateIndex.set(duplicateKey, rowIndex)
        }
        entries.push({
          id: `estr-${index}-${Date.now()}`,
          codigoCliente,
          dataEntrada: dataInclusao,
          estrutura: normalized.estrutura,
          ativo: normalized.ativo,
          vencimento,
          comissao,
          comissaoBaseBruta: Number(comissao.toFixed(6)),
          repasse: 1,
          quantidade: quantidade ?? null,
          precoCompra: precoCompra ?? null,
          nomeCliente: '',
          assessor,
          broker,
          origem: 'Estruturadas',
          source: 'import',
        })
      }
      return null
    },
  })

  if (chunkResult.canceled) {
    const integrity = buildIntegrityReport({
      sheetName,
      meta,
      processedRows,
      validRows: rowsValid,
      savedRows: entries.length,
    })
    const details = buildDetailsPayload(rejectedDetails, duplicatedDetails, {
      canceled: true,
    })
    const canceledStats = {
      rawRows: rows.length,
      processedRows,
      validRows: rowsValid,
      savedRows: entries.length,
      rejectedRows: rowsSkipped,
      duplicatedRows,
      enrichedRows,
      autoFixedRows,
      integrity,
      warnings: [],
      details,
    }
    if (tagWarning) canceledStats.warnings.push(tagWarning)
    return {
      ok: false,
      error: { code: 'CANCELLED', message: 'Importacao cancelada.' },
      entries: [],
      summary: {
        rowsRead: rows.length,
        rowsValid,
        rowsSkipped,
        totalCommission: Number(totalCommission.toFixed(2)),
        months: Array.from(months).sort(),
        sheetUsed: sheetName,
        stats: canceledStats,
      },
    }
  }

  const integrity = buildIntegrityReport({
    sheetName,
    meta,
    processedRows,
    validRows: rowsValid,
    savedRows: entries.length,
  })
  const warnings = buildWarningsFromIntegrity(integrity)
  const details = buildDetailsPayload(rejectedDetails, duplicatedDetails, {
    canceled: false,
  })
  if (tagWarning) warnings.push(tagWarning)
  const importStats = {
    sheetRef: meta.sheetRef,
    sheetRefResolved: meta.fullRef,
    sheetRows: meta.rowCount,
    rawRowCount: meta.rawRowCount,
    rowsRead: rows.length,
    processedRows,
    excelValidCount: rowsValid,
    importedCount: entries.length,
    discardedCount: rowsSkipped,
    discardedReasons: discardTracker.counts,
    discardedReasonsSample: discardTracker.samples,
    integrity,
    warnings,
  }

  const rawRows = importStats.rawRowCount ?? rows.length
  if (shouldLogImportStats()) {
    console.info('[receita-import:estruturadas]', importStats)
  }
  if (warnings.length) {
    console.warn('[receita-import:estruturadas] warnings', warnings)
  }
  console.log('[IMPORT][Estruturadas] rawRows=', rawRows, 'validRows=', rowsValid, 'savedRows=', entries.length)

  const stats = {
    rawRows: rows.length,
    processedRows,
    validRows: rowsValid,
    savedRows: entries.length,
    rejectedRows: rowsSkipped,
    duplicatedRows,
    enrichedRows,
    autoFixedRows,
    integrity,
    warnings,
    details,
  }

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
      importStats,
      stats,
    },
  }
}

const resolveHeaderByAliases = (headerMap, aliases = []) => {
  return aliases.find((key) => headerMap[key])
}

const parseClientCode = (value) => String(value || '')
  .replace(/\D/g, '')
  .trim()

const normalizeXpLineKey = (line) => {
  if (line === 'Bovespa') return 'bovespa'
  if (line === 'BMF') return 'bmf'
  if (line === 'Estruturadas') return 'estruturadas'
  return 'other'
}

export const parseXpCommissionFile = async (
  input,
  {
    onProgress,
    signal,
    tagIndex,
    chunkSize = 500,
  } = {},
) => {
  const buffer = await toArrayBuffer(input)
  if (!buffer) return { ok: false, error: { code: 'BUFFER_INVALID', message: 'Arquivo invalido.' } }
  const { sheetNames, sheets } = await parseXlsxInWorker(buffer)
  const sheetName = sheetNames?.[0]
  if (!sheetName) {
    return { ok: false, error: { code: 'SHEET_NOT_FOUND', message: 'Nenhuma planilha encontrada.' } }
  }

  const { rows, meta } = sheets[sheetName]
  const { headers, headerMap } = buildHeaderMap(rows)

  const required = {
    dataReferencia: ['datareferencia', 'data', 'dataoperacao'],
    produtoCategoria: ['produtocategoriaxp', 'produtocategoria', 'produto', 'categoria'],
    cliente: ['cliente', 'conta', 'codigocliente', 'codcliente'],
    comissao: ['comissaoxp', 'comissao'],
  }
  const optional = {
    dataOperacao: ['dataoperacao'],
    tipoPessoa: ['tipopessoa'],
    linhaReceita: ['linhareceita'],
    receitaAi: ['receitaai'],
    nivel1: ['nivel1'],
    nivel2: ['nivel2'],
    nivel3: ['nivel3'],
    nivel4: ['nivel4'],
    tipoServico: ['tipodoservico', 'tiposervico'],
    receitaBruta: ['receitabruta'],
    receitaLiquida: ['receitaliquida'],
    repasseXp: ['repassexp', 'repassexppercentual', 'repassexp%'],
    escritorio: ['escritorio'],
    senioridade: ['senioridade', 'seniority'],
    codAiXp: ['codaixp'],
    codAiLiberta: ['codailiberta'],
    nomeAi: ['nomeai'],
    squad: ['squad'],
    nomeCliente: ['nomecliente', 'nomedocliente', 'razaosocial', 'clientenome'],
  }

  const requiredHeaders = Object.entries(required).reduce((acc, [key, aliases]) => {
    acc[key] = resolveHeaderByAliases(headerMap, aliases)
    return acc
  }, {})
  const optionalHeaders = Object.entries(optional).reduce((acc, [key, aliases]) => {
    acc[key] = resolveHeaderByAliases(headerMap, aliases)
    return acc
  }, {})

  const missing = Object.entries(requiredHeaders)
    .filter(([, value]) => !value)
    .map(([key]) => key)

  if (missing.length) {
    return {
      ok: false,
      error: {
        code: 'MISSING_COLUMN',
        message: 'Colunas obrigatorias ausentes.',
        details: { missing, headers },
      },
    }
  }

  const rowsRead = rows.length
  let rowsValid = 0
  let rowsRejected = 0
  let duplicatedRows = 0
  let processedRows = 0
  let enrichedRows = 0
  let autoFixedRows = 0
  let totalCommission = 0
  const totalsByLine = { bovespa: 0, bmf: 0, estruturadas: 0 }
  const lineCounts = { bovespa: 0, bmf: 0, estruturadas: 0 }
  const months = new Set()
  const entries = []
  const rejectedDetails = []
  const duplicatedDetails = []
  const duplicateIndex = new Map()
  const headerRows = meta?.headerRows ?? 1
  const toExcelRowIndex = (index) => index + headerRows + 1
  const tagWarning = (!tagIndex || !tagIndex.size)
    ? { code: 'TAGS_EMPTY', message: 'Tags nao carregadas - enrich desativado.' }
    : null

  const pushRejected = (item) => { rejectedDetails.push(item) }
  const pushDuplicated = (item) => { duplicatedDetails.push(item) }
  const discardTracker = createDiscardTracker()

  const isCanceled = () => Boolean(signal?.aborted)
  const chunkResult = await processInChunks(rows, chunkSize, {
    onProgress,
    isCanceled,
    getProcessed: () => processedRows,
    onChunk: (allRows, start, end) => {
      for (let index = start; index < end; index += 1) {
        if (isCanceled()) return 'cancelled'
        processedRows += 1
        const row = allRows[index] || {}
        const rowIndex = toExcelRowIndex(index)

        const dataRaw = row[headerMap[requiredHeaders.dataReferencia]]
        const produtoRaw = row[headerMap[requiredHeaders.produtoCategoria]]
        const clienteRaw = row[headerMap[requiredHeaders.cliente]]
        const comissaoRaw = row[headerMap[requiredHeaders.comissao]]
        const dataOperacaoRaw = optionalHeaders.dataOperacao ? row[headerMap[optionalHeaders.dataOperacao]] : ''
        const tipoPessoaRaw = optionalHeaders.tipoPessoa ? row[headerMap[optionalHeaders.tipoPessoa]] : ''
        const linhaReceitaRaw = optionalHeaders.linhaReceita ? row[headerMap[optionalHeaders.linhaReceita]] : ''
        const receitaAiRaw = optionalHeaders.receitaAi ? row[headerMap[optionalHeaders.receitaAi]] : ''
        const nivel1Raw = optionalHeaders.nivel1 ? row[headerMap[optionalHeaders.nivel1]] : ''
        const nivel2Raw = optionalHeaders.nivel2 ? row[headerMap[optionalHeaders.nivel2]] : ''
        const nivel3Raw = optionalHeaders.nivel3 ? row[headerMap[optionalHeaders.nivel3]] : ''
        const nivel4Raw = optionalHeaders.nivel4 ? row[headerMap[optionalHeaders.nivel4]] : ''
        const tipoServicoRaw = optionalHeaders.tipoServico ? row[headerMap[optionalHeaders.tipoServico]] : ''
        const receitaBrutaRaw = optionalHeaders.receitaBruta ? row[headerMap[optionalHeaders.receitaBruta]] : ''
        const receitaLiquidaRaw = optionalHeaders.receitaLiquida ? row[headerMap[optionalHeaders.receitaLiquida]] : ''
        const repasseXpRaw = optionalHeaders.repasseXp ? row[headerMap[optionalHeaders.repasseXp]] : ''
        const escritorioRaw = optionalHeaders.escritorio ? row[headerMap[optionalHeaders.escritorio]] : ''
        const senioridadeRaw = optionalHeaders.senioridade ? row[headerMap[optionalHeaders.senioridade]] : ''
        const codAiXpRaw = optionalHeaders.codAiXp ? row[headerMap[optionalHeaders.codAiXp]] : ''
        const codAiLibertaRaw = optionalHeaders.codAiLiberta ? row[headerMap[optionalHeaders.codAiLiberta]] : ''
        const nomeAiRaw = optionalHeaders.nomeAi ? row[headerMap[optionalHeaders.nomeAi]] : ''
        const squadRaw = optionalHeaders.squad ? row[headerMap[optionalHeaders.squad]] : ''
        const nomeClienteRaw = optionalHeaders.nomeCliente ? row[headerMap[optionalHeaders.nomeCliente]] : ''

        const dataReferencia = parseDateFlexible(dataRaw)
        const dataOperacao = parseDateFlexible(dataOperacaoRaw)
        const dataBase = dataOperacao || dataReferencia
        const receitaLiquida = toNumber(receitaLiquidaRaw)
        const receitaBruta = toNumber(receitaBrutaRaw)
        const comissao = toNumber(comissaoRaw) ?? receitaLiquida ?? receitaBruta
        const line = mapXpProductCategoryToLine(produtoRaw || linhaReceitaRaw)
        const clienteBase = parseClientCode(clienteRaw)
        const basePartial = {
          codigoCliente: clienteBase,
          nomeCliente: String(nomeClienteRaw || '').trim(),
          assessor: normalizeAssessorName(String(nomeAiRaw || '').trim(), ''),
          broker: String(escritorioRaw || '').trim(),
          time: String(squadRaw || '').trim(),
          unit: '',
          seniority: String(senioridadeRaw || '').trim(),
        }
        const wasMissingRequired = (!dataBase || !clienteBase || comissao == null)
        const enrichedResult = enrichFromTags(basePartial, tagIndex)
        if (enrichedResult.enriched) enrichedRows += 1
        const enriched = enrichedResult.data || basePartial

        const codigoCliente = parseClientCode(enriched.codigoCliente || clienteBase)
        const nomeCliente = String(enriched.nomeCliente || '').trim()
        const assessor = normalizeAssessorName(enriched.assessor || '', '')
        const broker = String(enriched.broker || '').trim()
        const time = String(enriched.time || '').trim()
        const unit = String(enriched.unit || '').trim()
        const seniority = String(enriched.seniority || '').trim()
        const produtoCategoria = String(produtoRaw || '').trim()
        const tipoPessoa = String(tipoPessoaRaw || '').trim()
        const linhaReceita = String(linhaReceitaRaw || '').trim()
        const receitaAi = String(receitaAiRaw || '').trim()
        const nivel1 = String(nivel1Raw || '').trim()
        const nivel2 = String(nivel2Raw || '').trim()
        const nivel3 = String(nivel3Raw || '').trim()
        const nivel4 = String(nivel4Raw || '').trim()
        const tipoServico = String(tipoServicoRaw || '').trim()
        const repasseXp = toNumber(repasseXpRaw)
        const escritorio = String(escritorioRaw || '').trim()
        const senioridade = String(senioridadeRaw || '').trim()
        const codAiXp = String(codAiXpRaw || '').trim()
        const codAiLiberta = String(codAiLibertaRaw || '').trim()
        const nomeAi = String(nomeAiRaw || '').trim()
        const squad = String(squadRaw || '').trim()
        const monthKey = dataBase ? dataBase.slice(0, 7) : ''

        const raw = {
          dataReferencia: dataRaw,
          produtoCategoria: produtoRaw,
          cliente: clienteRaw,
          comissao: comissaoRaw,
          dataOperacao: dataOperacaoRaw,
          linhaReceita: linhaReceitaRaw,
          receitaAi: receitaAiRaw,
          tipoServico: tipoServicoRaw,
          receitaBruta: receitaBrutaRaw,
          receitaLiquida: receitaLiquidaRaw,
          repasseXp: repasseXpRaw,
          senioridade: senioridadeRaw,
          nomeAi: nomeAiRaw,
          escritorio: escritorioRaw,
          squad: squadRaw,
        }

        const normalized = {
          data: dataBase,
          dataOperacao,
          dataReferencia,
          produtoCategoria,
          line,
          codigoCliente,
          comissao,
          receitaLiquida,
          receitaBruta,
        }

        if (!line) {
          rowsRejected += 1
          recordDiscard(discardTracker, 'category_unmapped', index)
          pushRejected({
            rowIndex,
            reasonCode: 'category_unmapped',
            reasonMessage: REJECT_REASON_MESSAGES.category_unmapped,
            raw,
            normalized,
          })
          continue
        }

        if (!monthKey || !codigoCliente || comissao == null) {
          rowsRejected += 1
          recordDiscard(discardTracker, 'missing_required', index)
          pushRejected({
            rowIndex,
            reasonCode: 'missing_required',
            reasonMessage: REJECT_REASON_MESSAGES.missing_required,
            raw,
            normalized,
          })
          continue
        }

        if (wasMissingRequired && monthKey && codigoCliente && comissao != null) {
          autoFixedRows += 1
        }

        rowsValid += 1
        totalCommission += comissao
        const lineKey = normalizeXpLineKey(line)
        totalsByLine[lineKey] += comissao
        lineCounts[lineKey] += 1
        months.add(monthKey)

        const duplicateKey = [
          line,
          codigoCliente,
          dataBase,
          produtoCategoria,
          comissao,
        ].join('|')
        if (duplicateIndex.has(duplicateKey)) {
          duplicatedRows += 1
          const firstSeenRowIndex = duplicateIndex.get(duplicateKey)
          pushDuplicated({
            rowIndex,
            duplicateKey,
            firstSeenRowIndex,
            reasonMessage: firstSeenRowIndex ? `Duplicado (primeira linha ${firstSeenRowIndex})` : 'Duplicado',
            raw,
            normalized,
          })
        } else {
          duplicateIndex.set(duplicateKey, rowIndex)
        }

        entries.push({
          id: `xp-${index}-${Date.now()}`,
          data: dataBase,
          dataReferencia,
          dataOperacao,
          mesApuracao: monthKey,
          line,
          linhaReceita,
          produtoCategoria,
          codigoCliente,
          conta: codigoCliente,
          cliente: codigoCliente,
          nomeCliente: '',
          tipoPessoa,
          receitaAi,
          tipoServico,
          nivel1,
          nivel2,
          nivel3,
          nivel4,
          comissao: Number(comissao.toFixed(6)),
          receitaLiquida: Number((receitaLiquida ?? comissao).toFixed(6)),
          receitaBruta: Number((receitaBruta ?? comissao).toFixed(6)),
          repasseXp: repasseXp == null ? null : Number(repasseXp.toFixed(6)),
          escritorio,
          senioridade,
          codAiXp,
          codAiLiberta,
          nomeAi,
          squad,
          assessor,
          broker,
          time,
          unit,
          seniority,
          source: 'xp-commission',
          importedAt: Date.now(),
        })
      }
      return null
    },
  })

  if (chunkResult.canceled) {
    const integrity = buildIntegrityReport({
      sheetName,
      meta,
      processedRows,
      validRows: rowsValid,
      savedRows: entries.length,
    })
    const details = buildDetailsPayload(rejectedDetails, duplicatedDetails, {
      canceled: true,
    })
    const canceledStats = {
      rawRows: rowsRead,
      processedRows,
      validRows: rowsValid,
      savedRows: entries.length,
      rejectedRows: rowsRejected,
      duplicatedRows,
      enrichedRows,
      autoFixedRows,
      integrity,
      warnings: [],
      details,
    }
    if (tagWarning) canceledStats.warnings.push(tagWarning)
    return {
      ok: false,
      error: { code: 'CANCELLED', message: 'Importacao cancelada.' },
      entries: [],
      summary: {
        rowsRead,
        rowsValid,
        rowsRejected,
        totalCommission: Number(totalCommission.toFixed(2)),
        totalsByLine: {
          bovespa: Number(totalsByLine.bovespa.toFixed(2)),
          bmf: Number(totalsByLine.bmf.toFixed(2)),
          estruturadas: Number(totalsByLine.estruturadas.toFixed(2)),
        },
        lineCounts,
        months: Array.from(months).sort(),
        sheetUsed: sheetName,
        stats: canceledStats,
      },
    }
  }

  const integrity = buildIntegrityReport({
    sheetName,
    meta,
    processedRows,
    validRows: rowsValid,
    savedRows: entries.length,
  })
  const warnings = buildWarningsFromIntegrity(integrity)
  const details = buildDetailsPayload(rejectedDetails, duplicatedDetails, {
    canceled: false,
  })
  if (tagWarning) warnings.push(tagWarning)
  const importStats = {
    sheetRef: meta.sheetRef,
    sheetRefResolved: meta.fullRef,
    sheetRows: meta.rowCount,
    rawRowCount: meta.rawRowCount,
    rowsRead,
    processedRows,
    excelValidCount: rowsValid,
    importedCount: entries.length,
    discardedCount: rowsRejected,
    discardedReasons: discardTracker.counts,
    discardedReasonsSample: discardTracker.samples,
    integrity,
    warnings,
  }

  const rawRows = importStats.rawRowCount ?? rowsRead
  if (shouldLogImportStats()) {
    console.info('[receita-import:xp]', importStats)
  }
  if (warnings.length) {
    console.warn('[receita-import:xp] warnings', warnings)
  }
  console.log('[IMPORT][XP] rawRows=', rawRows, 'validRows=', rowsValid, 'savedRows=', entries.length)

  const stats = {
    rawRows: rowsRead,
    processedRows,
    validRows: rowsValid,
    savedRows: entries.length,
    rejectedRows: rowsRejected,
    duplicatedRows,
    enrichedRows,
    autoFixedRows,
    integrity,
    warnings,
    details,
  }

  return {
    ok: true,
    entries,
    summary: {
      rowsRead,
      rowsValid,
      rowsRejected,
      totalCommission: Number(totalCommission.toFixed(2)),
      totalsByLine: {
        bovespa: Number(totalsByLine.bovespa.toFixed(2)),
        bmf: Number(totalsByLine.bmf.toFixed(2)),
        estruturadas: Number(totalsByLine.estruturadas.toFixed(2)),
      },
      lineCounts,
      months: Array.from(months).sort(),
      sheetUsed: sheetName,
      importStats,
      stats,
    },
  }
}
