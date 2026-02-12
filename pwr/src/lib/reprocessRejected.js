import { loadXlsx } from '../services/xlsxLoader'
import { resolveByClientCode, resolveByClientName } from './tagResolver'
import { normalizeAssessorName } from '../utils/assessor'

const FACTOR_RECEITA = {
  bovespa: 0.9335 * 0.8285,
  bmf: 0.9435 * 0.8285,
}

const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0))

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

let xlsxCache = null
const getXlsx = async () => {
  if (xlsxCache) return xlsxCache
  xlsxCache = await loadXlsx()
  return xlsxCache
}

const parseDate = async (value) => {
  if (!value) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  if (typeof value === 'number') {
    const XLSX = await getXlsx()
    if (XLSX?.SSF?.parse_date_code) {
      const parsed = XLSX.SSF.parse_date_code(value)
      if (parsed?.y && parsed?.m && parsed?.d) {
        const date = new Date(parsed.y, parsed.m - 1, parsed.d)
        return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
      }
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

const resolveModuleKey = (moduleLabel) => {
  const label = normalizeValue(moduleLabel)
  if (label.includes('estrutur')) return 'estruturadas'
  if (label.includes('bmf')) return 'bmf'
  return 'bovespa'
}

const enrichFromTags = (partial, tagIndex) => {
  if (!tagIndex || !tagIndex.size) return { enriched: false, data: partial }
  const resolved = resolveByClientCode(tagIndex, partial.codigoCliente)
    || resolveByClientName(tagIndex, partial.nomeCliente)
  if (!resolved) return { enriched: false, data: partial }
  const next = { ...partial }
  let enriched = false
  if (!next.codigoCliente && resolved.codigoCliente) {
    next.codigoCliente = resolved.codigoCliente
    enriched = true
  }
  if (!next.nomeCliente && resolved.nomeCliente) {
    next.nomeCliente = resolved.nomeCliente
    enriched = true
  }
  if (!next.assessor && resolved.assessor) {
    next.assessor = normalizeAssessorName(resolved.assessor)
    enriched = true
  }
  if (!next.broker && resolved.broker) {
    next.broker = resolved.broker
    enriched = true
  }
  return { enriched, data: next }
}

export const buildDuplicateKey = (entry, moduleLabel) => {
  if (!entry) return ''
  const moduleKey = resolveModuleKey(moduleLabel)
  if (moduleKey === 'estruturadas') {
    const codigoCliente = String(entry.codigoCliente || '').trim()
    const data = String(entry.dataEntrada || entry.data || '').trim()
    const estrutura = String(entry.estrutura || '').trim()
    const ativo = String(entry.ativo || '').trim()
    const comissao = entry.comissao ?? ''
    const quantidade = entry.quantidade ?? ''
    const precoCompra = entry.precoCompra ?? ''
    const vencimento = String(entry.vencimento || '').trim()
    return [
      codigoCliente,
      data,
      estrutura,
      ativo,
      comissao,
      quantidade,
      precoCompra,
      vencimento,
    ].join('|')
  }
  const conta = String(entry.conta || entry.codigoCliente || '').trim()
  const data = String(entry.data || entry.dataEntrada || '').trim()
  const corretagem = entry.corretagem ?? ''
  const volume = entry.volumeNegociado ?? entry.volume ?? ''
  const tipoCorretagem = normalizeValue(entry.tipoCorretagem)
  const mercadoValue = normalizeValue(entry.mercado)
  return [
    conta,
    data,
    corretagem,
    volume ?? '',
    tipoCorretagem,
    mercadoValue,
  ].join('|')
}

export const tryNormalizeFromRejected = async (item, moduleLabel, { tagIndex } = {}) => {
  const moduleKey = resolveModuleKey(moduleLabel)
  const raw = item?.raw || {}
  const normalizedHint = item?.normalized || {}

  if (moduleKey === 'estruturadas') {
    let codigoCliente = String(
      normalizedHint.codigoCliente ?? raw.codigoCliente ?? raw.conta ?? raw.cliente ?? '',
    ).trim()
    const nomeCliente = String(normalizedHint.nomeCliente ?? raw.nomeCliente ?? '').trim()
    const assessor = normalizeAssessorName(String(normalizedHint.assessor ?? raw.assessor ?? '').trim())
    const broker = String(normalizedHint.broker ?? raw.broker ?? '').trim()
    const enriched = enrichFromTags({ codigoCliente, nomeCliente, assessor, broker }, tagIndex)
    const enrichedFields = enriched.data
    codigoCliente = enrichedFields.codigoCliente || codigoCliente
    const estrutura = String(normalizedHint.estrutura ?? raw.estrutura ?? '').trim()
    const ativo = String(normalizedHint.ativo ?? raw.ativo ?? '').trim()
    const data = await parseDate(normalizedHint.data ?? raw.dataInclusao ?? raw.data ?? raw.dataEntrada)
    const vencimento = await parseDate(normalizedHint.vencimento ?? raw.fixing ?? raw.vencimento)
    const comissao = toNumber(normalizedHint.comissao ?? raw.comissao)
    const quantidade = toNumber(normalizedHint.quantidade ?? raw.quantidade)
    const precoCompra = toNumber(normalizedHint.precoCompra ?? raw.precoCompra)

    if (!data || comissao == null) {
      return { ok: false }
    }

    return {
      ok: true,
      entry: {
        id: `estr-rep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        codigoCliente,
        dataEntrada: data,
        estrutura,
        ativo,
        vencimento: vencimento || '',
        comissao,
        quantidade: quantidade ?? null,
        precoCompra: precoCompra ?? null,
        nomeCliente: enrichedFields.nomeCliente || nomeCliente,
        assessor: normalizeAssessorName(enrichedFields.assessor || assessor),
        broker: enrichedFields.broker || broker,
        origem: 'Estruturadas',
        source: 'import',
      },
    }
  }

  let conta = String(
    normalizedHint.conta ?? normalizedHint.codigoCliente ?? raw.conta ?? raw.codigoCliente ?? raw.cliente ?? '',
  ).trim()
  const nomeCliente = String(normalizedHint.nomeCliente ?? raw.nomeCliente ?? '').trim()
  const assessor = normalizeAssessorName(String(normalizedHint.assessor ?? raw.assessor ?? '').trim())
  const broker = String(normalizedHint.broker ?? raw.broker ?? '').trim()
  const enriched = enrichFromTags({
    codigoCliente: conta,
    nomeCliente,
    assessor,
    broker,
  }, tagIndex)
  const enrichedFields = enriched.data
  if (!conta && enrichedFields.codigoCliente) conta = enrichedFields.codigoCliente
  const corretagem = toNumber(normalizedHint.corretagem ?? raw.corretagem)
  const volume = toNumber(normalizedHint.volume ?? normalizedHint.volumeNegociado ?? raw.volume ?? raw.volumeNegociado)
  const tipoCorretagem = normalizeValue(normalizedHint.tipoCorretagem ?? raw.tipoCorretagem)
  const mercadoRaw = normalizedHint.mercado ?? raw.mercado ?? ''
  const mercadoValue = normalizeValue(mercadoRaw)
  const data = await parseDate(normalizedHint.data ?? raw.data ?? raw.dataEntrada)

  const mercadoTarget = moduleKey === 'bmf' ? 'bmf' : 'bov'
  if (!conta || corretagem == null || !data) {
    return { ok: false }
  }
  if (!mercadoValue || mercadoValue !== mercadoTarget) {
    return { ok: false }
  }

  const fatorReceita = moduleKey === 'bmf' ? FACTOR_RECEITA.bmf : FACTOR_RECEITA.bovespa
  const receitaCalculada = corretagem * fatorReceita

  return {
    ok: true,
    entry: {
      id: `bov-rep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      codigoCliente: conta,
      conta,
      data,
      nomeCliente: enrichedFields.nomeCliente || nomeCliente,
      assessor: normalizeAssessorName(enrichedFields.assessor || assessor),
      broker: enrichedFields.broker || broker,
      corretagem,
      volumeNegociado: volume || 0,
      tipoCorretagem,
      mercado: mercadoTarget.toUpperCase(),
      receita: Number(receitaCalculada.toFixed(6)),
      origem: moduleKey === 'bmf' ? 'BMF' : 'Bovespa',
      source: 'import',
    },
  }
}

export const reprocessRejected = async ({
  rejectedItems,
  baseEntries,
  moduleLabel,
  tagIndex,
  onProgress,
  signal,
  chunkSize = 500,
}) => {
  const rejectedList = Array.isArray(rejectedItems) ? rejectedItems : []
  const base = Array.isArray(baseEntries) ? baseEntries : []
  const duplicateKeys = new Set(base.map((entry) => buildDuplicateKey(entry, moduleLabel)).filter(Boolean))
  const recoveredEntries = []
  const rejectedStill = []
  let duplicatesCount = 0
  let processedCount = 0

  const total = rejectedList.length
  const size = Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : 500

  for (let start = 0; start < total; start += size) {
    if (signal?.aborted) {
      rejectedStill.push(...rejectedList.slice(start))
      return { recoveredEntries, rejectedStill, duplicatesCount, processedCount, canceled: true }
    }
    const end = Math.min(total, start + size)
    for (let index = start; index < end; index += 1) {
      if (signal?.aborted) {
        rejectedStill.push(...rejectedList.slice(index))
        return { recoveredEntries, rejectedStill, duplicatesCount, processedCount, canceled: true }
      }
      const item = rejectedList[index]
      processedCount += 1
      const normalized = await tryNormalizeFromRejected(item, moduleLabel, { tagIndex })
      if (!normalized?.ok || !normalized?.entry) {
        rejectedStill.push(item)
        continue
      }
      const duplicateKey = buildDuplicateKey(normalized.entry, moduleLabel)
      if (!duplicateKey) {
        rejectedStill.push(item)
        continue
      }
      if (duplicateKeys.has(duplicateKey)) {
        duplicatesCount += 1
        continue
      }
      duplicateKeys.add(duplicateKey)
      recoveredEntries.push(normalized.entry)
    }
    if (onProgress) {
      onProgress({
        processed: processedCount,
        total,
        progress: total ? processedCount / total : 1,
      })
    }
    await yieldToMain()
  }

  return {
    recoveredEntries,
    rejectedStill,
    duplicatesCount,
    processedCount,
    canceled: false,
  }
}
