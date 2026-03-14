import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import useImportedFileBinding from '../hooks/useImportedFileBinding'
import { formatDate, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { readImportedFileAsArrayBuffer } from '../services/importCatalog'
import { parseWorkbook, parseWorkbookBuffer } from '../services/excel'
import { getCurrentUserKey } from '../services/currentUser'
import { fetchYahooMarketData } from '../services/marketData'
import {
  buildBarrierSeriesInRange,
  findHighBarrierHit,
  findLowBarrierHit,
  getBarrierHitTodayKey,
  hydrateBarrierHitDateInputs,
} from '../services/barrierHitAnalysis'
import { enrichRow } from '../services/tags'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import {
  clearBarrierHitState,
  loadBarrierHitState,
  saveBarrierHitState,
} from '../services/barrierHitStore'

const getTodayKey = getBarrierHitTodayKey

const normalizeText = (value) => String(value || '').trim()
const normalizeMatch = (value) => normalizeText(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, '')

const DEFAULT_TABLE_FILTERS = {
  search: '',
  broker: 'all',
  assessor: 'all',
  estrutura: 'all',
  ativo: 'all',
  status: 'all',
  hit: 'all',
  dateFrom: '',
  dateTo: '',
}
const PAGE_SIZE = 50
const MARKET_FETCH_CONCURRENCY = 6

const EXCLUDED_STRUCTURE_TOKENS = [
  'opcaolistada',
  'opcoeslistadas',
  'opcaoflexivel',
  'opcoesflexiveis',
  'flexivel',
  'flexiveis',
  'cupomrecorrente',
  'smartcoupon',
  'smartcoupons',
  'cupomrecorrentesobcustodia',
  'cupomrecorrentesubcustodia',
  'smartcouponsobcustodia',
  'smartcouponsubcustodia',
]

const EXCLUDED_STRUCTURE_EXACT_TOKENS = new Set([
  'call',
  'callspread',
  'put',
  'putspread',
  'collar',
  'pop',
  'alocacaoprotegida',
  'alocacaoprotegidasobcustodia',
  'alocacaoprotegidasubcustodia',
])

const toOptionalNumber = (value) => {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeBarrierDirection = (barrierType, barrierValue, spotInicial) => {
  const normalized = normalizeMatch(barrierType)
  if (normalized.includes('ui') || normalized.includes('uo') || normalized.includes('up') || normalized.includes('alta')) return 'high'
  if (normalized.includes('ki') || normalized.includes('ko') || normalized.includes('di') || normalized.includes('do') || normalized.includes('down') || normalized.includes('baixa')) return 'low'
  const barrierNum = toOptionalNumber(barrierValue)
  const spotNum = toOptionalNumber(spotInicial)
  if (barrierNum == null || spotNum == null) return null
  return barrierNum >= spotNum ? 'high' : 'low'
}

const getBarrierDirections = (operation, fallback = null) => {
  const legs = Array.isArray(operation?.pernas) ? operation.pernas : []
  let hasHigh = false
  let hasLow = false
  const spotInicial = toOptionalNumber(operation?.spotInicial)

  legs.forEach((leg) => {
    const barrierValue = toOptionalNumber(leg?.barreiraValor)
    if (!(barrierValue > 0)) return
    const barrierType = normalizeText(leg?.barreiraTipo)
    const direction = normalizeBarrierDirection(barrierType, barrierValue, spotInicial)
    if (direction === 'high') hasHigh = true
    if (direction === 'low') hasLow = true
  })

  if (!hasHigh && !hasLow && fallback) {
    return {
      hasHigh: fallback.hasHighBarrier === true || fallback.highHit === true,
      hasLow: fallback.hasLowBarrier === true || fallback.lowHit === true,
    }
  }

  return { hasHigh, hasLow }
}

const buildById = (rows) => {
  const map = new Map()
  ;(Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = normalizeText(row?.id)
    if (!id) return
    map.set(id, row)
  })
  return map
}

const chooseText = (...values) => {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) return normalized
  }
  return ''
}

const hasBarrierHit = (row) => row?.highHit === true || row?.lowHit === true

const getLatestHitSeq = (row) => Math.max(
  Number(row?.highHitSeq) || 0,
  Number(row?.lowHitSeq) || 0,
)

const buildPagination = (current, total) => {
  if (total <= 1) return [1]
  const delta = 1
  const range = []
  for (let page = 1; page <= total; page += 1) {
    if (page === 1 || page === total || (page >= current - delta && page <= current + delta)) {
      range.push(page)
    }
  }
  const items = []
  let previous = 0
  range.forEach((page) => {
    if (page - previous > 1) items.push('ellipsis')
    items.push(page)
    previous = page
  })
  return items
}

const normalizeStructureToken = (value) => normalizeMatch(value).replace(/[^a-z0-9]/g, '')

const hasBarrierConfigured = (row) => {
  const directions = getBarrierDirections(row, row)
  return directions.hasHigh || directions.hasLow
}

const shouldIgnoreBarrierOperation = (row) => {
  const candidates = [
    row?.tipoEstrutura,
    row?.modalidadeOperacao,
    row?.estrutura,
  ]
    .map((value) => normalizeStructureToken(value))
    .filter(Boolean)

  if (!candidates.length) return false

  if (candidates.some((token) => EXCLUDED_STRUCTURE_EXACT_TOKENS.has(token))) return true

  return candidates.some((token) => (
    EXCLUDED_STRUCTURE_TOKENS.some((excluded) => token.includes(excluded))
  ))
}

const filterUnsupportedBarrierRows = (rows) => {
  let ignoredCount = 0
  const filtered = []
  ;(Array.isArray(rows) ? rows : []).forEach((row) => {
    if (shouldIgnoreBarrierOperation(row) || !hasBarrierConfigured(row)) {
      ignoredCount += 1
      return
    }
    filtered.push(row)
  })
  return { rows: filtered, ignoredCount }
}

const parseImportedWorkbook = async (file) => {
  if (!file) return []
  if (file?.source === 'electron') {
    const buffer = await readImportedFileAsArrayBuffer(file)
    if (!buffer) throw new Error('Nao foi possivel ler o arquivo importado.')
    return parseWorkbookBuffer(buffer)
  }
  return parseWorkbook(file)
}

const mapWithConcurrency = async (items, limit, mapper) => {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return []
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, list.length))
  const results = new Array(list.length)
  let pointer = 0
  const workers = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const index = pointer
      pointer += 1
      if (index >= list.length) break
      results[index] = await mapper(list[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

const formatBarrierNumber = (value) => {
  const num = toOptionalNumber(value)
  if (num == null) return ''
  return num.toFixed(4).replace(/\.?0+$/, '')
}

const sortDateKeys = (values) => values
  .map((value) => normalizeDateKey(value))
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right))

const pickEarliestDateKey = (...values) => {
  const sorted = sortDateKeys(values)
  return sorted[0] || ''
}

const resolveOperationRange = (operation, {
  reportDateKey = '',
  analysisFromKey = '',
  analysisToKey = '',
} = {}) => {
  const operationStart = normalizeDateKey(operation?.dataRegistro || operation?.firstSeenAt || '')
  if (!operationStart) return null
  const report = normalizeDateKey(reportDateKey) || getTodayKey()
  const activityEnd = operation?.active === false
    ? normalizeDateKey(operation?.lastSeenAt || '')
    : ''
  const endCandidate = activityEnd || report
  const vencimento = normalizeDateKey(operation?.vencimento || '')
  const operationEnd = vencimento && vencimento < endCandidate ? vencimento : endCandidate
  const periodEnd = normalizeDateKey(analysisToKey) || operationEnd
  const start = operationStart
  const end = periodEnd < operationEnd ? periodEnd : operationEnd
  if (!end || start > end) return null
  return { start, end }
}

const extractBarrierValues = (operation) => {
  const legs = Array.isArray(operation?.pernas) ? operation.pernas : []
  const high = []
  const low = []
  const spotInicial = toOptionalNumber(operation?.spotInicial)

  legs.forEach((leg) => {
    const barrier = toOptionalNumber(leg?.barreiraValor)
    if (barrier == null) return
    const direction = normalizeBarrierDirection(leg?.barreiraTipo, barrier, spotInicial)
    if (direction === 'high') high.push(barrier)
    if (direction === 'low') low.push(barrier)
  })

  return {
    high: Array.from(new Set(high)).sort((left, right) => left - right),
    low: Array.from(new Set(low)).sort((left, right) => left - right),
  }
}

const buildHighHitReason = (hit) => (
  `maxima_do_ativo (${formatBarrierNumber(hit?.marketValue)} >= ${formatBarrierNumber(hit?.barrierValue)})`
)

const buildLowHitReason = (hit) => (
  `minima_do_ativo (${formatBarrierNumber(hit?.marketValue)} <= ${formatBarrierNumber(hit?.barrierValue)})`
)

const readContractedQty = (leg) => (
  toOptionalNumber(leg?.quantidadeContratada ?? leg?.quantidadeBoleta)
)

const readActiveQty = (leg) => (
  toOptionalNumber(leg?.quantidadeAtiva)
)

const isNonZeroQty = (value) => {
  const qty = toOptionalNumber(value)
  return qty != null && Math.abs(qty) > 0
}

const resolveLegPositionQty = (leg) => {
  const active = readActiveQty(leg)
  if (active != null) return active
  return toOptionalNumber(leg?.quantidade)
}

const resolveOperationHasOpenPosition = (operation) => {
  if (!operation || typeof operation !== 'object') return false

  const quantidadeAtual = toOptionalNumber(operation?.quantidadeAtual)
  if (quantidadeAtual != null) return Math.abs(quantidadeAtual) > 0

  const legs = Array.isArray(operation?.pernas) ? operation.pernas : []
  let hasExplicitActiveQty = false
  for (const leg of legs) {
    const active = readActiveQty(leg)
    if (active == null) continue
    hasExplicitActiveQty = true
    if (Math.abs(active) > 0) return true
  }
  if (hasExplicitActiveQty) return false

  const quantidade = toOptionalNumber(operation?.quantidade)
  if (quantidade != null) return Math.abs(quantidade) > 0

  return legs.some((leg) => isNonZeroQty(resolveLegPositionQty(leg)))
}

const buildBarrierLegKey = (leg, index) => {
  if (!leg || typeof leg !== 'object') return `idx:${index}`
  const directId = normalizeText(leg?.id)
  if (directId) return directId
  return [
    normalizeText(leg?.tipo),
    formatBarrierNumber(leg?.strike),
    normalizeText(leg?.barreiraTipo),
    formatBarrierNumber(leg?.barreiraValor),
    index,
  ].join('|')
}

const buildLegMap = (legs) => {
  const map = new Map()
  ;(Array.isArray(legs) ? legs : []).forEach((leg, index) => {
    map.set(buildBarrierLegKey(leg, index), leg)
  })
  return map
}

const mergeBarrierLegs = ({
  previousLegs = [],
  baseLegs = [],
  dailyLegs = [],
}) => {
  const previousMap = buildLegMap(previousLegs)
  const baseMap = buildLegMap(baseLegs)
  const dailyMap = buildLegMap(dailyLegs)
  const allKeys = new Set([
    ...previousMap.keys(),
    ...baseMap.keys(),
    ...dailyMap.keys(),
  ])

  return Array.from(allKeys).map((key) => {
    const previousLeg = previousMap.get(key) || null
    const baseLeg = baseMap.get(key) || null
    const dailyLeg = dailyMap.get(key) || null
    const sourceLeg = dailyLeg || baseLeg || previousLeg || {}

    return {
      ...sourceLeg,
      id: sourceLeg.id || key,
      quantidadeBase: resolveLegPositionQty(baseLeg),
      quantidadeDiario: resolveLegPositionQty(dailyLeg),
      quantidadeContratadaBase: readContractedQty(baseLeg),
      quantidadeContratadaDiario: readContractedQty(dailyLeg),
    }
  })
}

const buildQuantitySignalReason = (signal) => (
  `quantidade_ativa_vazia_ou_zerada (base=${signal?.baseLabel || '-'}; diario=${signal?.activeLabel || 'vazia'}; contratada=${signal?.contractedLabel || '-'})`
)

const isQuantitySignalReason = (reason) => (
  normalizeText(reason).startsWith('quantidade_ativa_vazia_ou_zerada')
)

const resolveQuantitySignalByDirection = (operation, candidate) => {
  const legs = Array.isArray(operation?.pernas) ? operation.pernas : []
  const spotInicial = toOptionalNumber(operation?.spotInicial)
  const result = { high: null, low: null, unknown: null }

  legs.forEach((leg) => {
    const baseQty = toOptionalNumber(leg?.quantidadeBase)
    if (baseQty == null || Math.abs(baseQty) === 0) return

    const contracted = toOptionalNumber(leg?.quantidadeContratadaBase ?? leg?.quantidadeContratadaDiario ?? readContractedQty(leg))
    const active = toOptionalNumber(leg?.quantidadeDiario)
    const activeIsMissingOrZero = active == null || Math.abs(active) === 0
    if (!activeIsMissingOrZero) return

    const direction = normalizeBarrierDirection(leg?.barreiraTipo, leg?.barreiraValor, spotInicial)
    const signal = {
      baseLabel: formatBarrierNumber(baseQty),
      contractedLabel: formatBarrierNumber(contracted),
      activeLabel: active == null ? 'vazia' : formatBarrierNumber(active),
    }

    if (direction === 'high') {
      if (!result.high) result.high = signal
      return
    }
    if (direction === 'low') {
      if (!result.low) result.low = signal
      return
    }
    if (!result.unknown) result.unknown = signal
  })

  const hasHighBarrier = candidate?.barriers?.high?.length > 0
  const hasLowBarrier = candidate?.barriers?.low?.length > 0
  if (result.unknown) {
    if (hasHighBarrier && !hasLowBarrier && !result.high) result.high = result.unknown
    if (hasLowBarrier && !hasHighBarrier && !result.low) result.low = result.unknown
  }

  return result
}

const resolveBarrierHitsByMarket = async ({
  operations = [],
  reportDate = '',
  analysisFrom = '',
  analysisTo = '',
}) => {
  const reportDateKey = normalizeDateKey(reportDate) || getTodayKey()
  const analysisFromKey = normalizeDateKey(analysisFrom)
  const analysisToKey = normalizeDateKey(analysisTo)
  const hitFallbackDateKey = analysisToKey || reportDateKey
  const candidates = []
  const marketRequests = new Map()

  ;(Array.isArray(operations) ? operations : []).forEach((operation) => {
    const barriers = extractBarrierValues(operation)
    if (!barriers.high.length && !barriers.low.length) return
    const symbol = normalizeText(operation?.ativo)
    if (!symbol) return
    const range = resolveOperationRange(operation, {
      reportDateKey,
      analysisFromKey,
      analysisToKey,
    })
    if (!range) return
    const requestKey = `${symbol}:${range.start}:${range.end}`
    if (!marketRequests.has(requestKey)) {
      marketRequests.set(requestKey, {
        symbol,
        startDate: range.start,
        endDate: range.end,
      })
    }
    candidates.push({
      operationId: normalizeText(operation?.id),
      requestKey,
      range,
      barriers,
    })
  })

  const marketRowsByKey = new Map()
  await mapWithConcurrency(
    Array.from(marketRequests.entries()),
    MARKET_FETCH_CONCURRENCY,
    async ([requestKey, request]) => {
      try {
        const market = await fetchYahooMarketData({
          ...request,
          includeSeries: true,
        })
        const rows = buildBarrierSeriesInRange(market?.series, {
          start: request.startDate,
          end: request.endDate,
        })
        marketRowsByKey.set(requestKey, rows)
      } catch {
        marketRowsByKey.set(requestKey, null)
      }
    },
  )

  const candidateById = new Map(candidates.map((item) => [item.operationId, item]))
  let seqCursor = Date.now() * 100
  let verifiedOperations = 0
  let hitSides = 0
  let failedOperations = 0

  const isMarketHitReason = (reason) => {
    const r = normalizeText(reason)
    return r.startsWith('minima_do_ativo') || r.startsWith('maxima_do_ativo')
  }

  const nextOperations = (Array.isArray(operations) ? operations : []).map((operation) => {
    const operationId = normalizeText(operation?.id)
    const candidate = candidateById.get(operationId)
    if (!candidate) {
      // Operacao sem valores de barreira extraiveis — limpar hits de mercado obsoletos
      const clearHigh = operation?.highHit && isMarketHitReason(operation?.highHitReason)
      const clearLow = operation?.lowHit && isMarketHitReason(operation?.lowHitReason)
      if (clearHigh || clearLow) {
        return {
          ...operation,
          ...(clearHigh ? { highHit: false, highHitAt: '', highHitSeq: 0, highHitReason: '' } : {}),
          ...(clearLow ? { lowHit: false, lowHitAt: '', lowHitSeq: 0, lowHitReason: '' } : {}),
        }
      }
      return operation
    }

    const series = marketRowsByKey.get(candidate.requestKey)
    const hasSeries = Array.isArray(series) && series.length > 0
    if (!hasSeries) {
      failedOperations += 1
    } else {
      verifiedOperations += 1
    }
    const highHitDetected = hasSeries ? findHighBarrierHit(series, candidate.barriers.high) : null
    const lowHitDetected = hasSeries ? findLowBarrierHit(series, candidate.barriers.low) : null
    const vencimentoKey = normalizeDateKey(operation?.vencimento || '')
    const isClosedByMaturity = operation?.active !== true && Boolean(vencimentoKey && reportDateKey >= vencimentoKey)
    const baseHadPosition = Boolean(operation?.baseHasPosition)
    const quantitySignals = (isClosedByMaturity || !baseHadPosition)
      ? { high: null, low: null }
      : resolveQuantitySignalByDirection(operation, candidate)
    const highQtySignal = quantitySignals?.high
    const lowQtySignal = quantitySignals?.low

    let highHit = operation?.highHit === true
    let lowHit = operation?.lowHit === true
    let highHitAt = normalizeDateKey(operation?.highHitAt || '') || ''
    let lowHitAt = normalizeDateKey(operation?.lowHitAt || '') || ''
    let highHitSeq = Number(operation?.highHitSeq) || 0
    let lowHitSeq = Number(operation?.lowHitSeq) || 0
    let highHitReason = normalizeText(operation?.highHitReason)
    let lowHitReason = normalizeText(operation?.lowHitReason)

    if (candidate.barriers.high.length) {
      // Sinal de quantidade só é usado quando não há dados de mercado disponíveis.
      // Se o mercado retornou série mas não confirmou o batimento, a quantidade
      // zerada/ausente pode ser por outros motivos (cancelamento, reestruturação)
      // e NÃO deve ser tratada como batimento.
      const useHighQtySignal = highQtySignal && !hasSeries
      if (highHitDetected || useHighQtySignal) {
        highHit = true
        if (highHitDetected) {
          highHitAt = pickEarliestDateKey(highHitAt, highHitDetected.date) || highHitDetected.date
          highHitReason = buildHighHitReason(highHitDetected)
        } else {
          highHitAt = pickEarliestDateKey(highHitAt, hitFallbackDateKey) || hitFallbackDateKey
          highHitReason = buildQuantitySignalReason(highQtySignal)
        }
        if (!highHitSeq) {
          seqCursor += 1
          highHitSeq = seqCursor
        }
        hitSides += 1
      } else if (hasSeries) {
        highHit = false
        highHitAt = ''
        highHitSeq = 0
        highHitReason = ''
      } else if (isClosedByMaturity && isQuantitySignalReason(highHitReason)) {
        highHit = false
        highHitAt = ''
        highHitSeq = 0
        highHitReason = ''
      }
    }

    if (candidate.barriers.low.length) {
      // Mesma lógica: sinal de quantidade só quando sem dados de mercado.
      const useLowQtySignal = lowQtySignal && !hasSeries
      if (lowHitDetected || useLowQtySignal) {
        lowHit = true
        if (lowHitDetected) {
          lowHitAt = pickEarliestDateKey(lowHitAt, lowHitDetected.date) || lowHitDetected.date
          lowHitReason = buildLowHitReason(lowHitDetected)
        } else {
          lowHitAt = pickEarliestDateKey(lowHitAt, hitFallbackDateKey) || hitFallbackDateKey
          lowHitReason = buildQuantitySignalReason(lowQtySignal)
        }
        if (!lowHitSeq) {
          seqCursor += 1
          lowHitSeq = seqCursor
        }
        hitSides += 1
      } else if (hasSeries) {
        lowHit = false
        lowHitAt = ''
        lowHitSeq = 0
        lowHitReason = ''
      } else if (isClosedByMaturity && isQuantitySignalReason(lowHitReason)) {
        lowHit = false
        lowHitAt = ''
        lowHitSeq = 0
        lowHitReason = ''
      }
    }

    return {
      ...operation,
      highHit,
      lowHit,
      highHitAt,
      lowHitAt,
      highHitSeq,
      lowHitSeq,
      highHitReason,
      lowHitReason,
    }
  })

  return {
    operations: nextOperations,
    reportDate: reportDateKey,
    stats: {
      verifiedOperations,
      hitSides,
      failedOperations,
    },
  }
}

const mergeBarrierRecords = ({
  previousOperations = [],
  baseRows = [],
  dailyRows = [],
  reportDate = '',
}) => {
  const reportDateKey = normalizeDateKey(reportDate) || getTodayKey()
  const previousMap = buildById(previousOperations)
  const baseMap = buildById(baseRows)
  const dailyMap = buildById(dailyRows)
  const allIds = new Set([
    ...previousMap.keys(),
    ...baseMap.keys(),
    ...dailyMap.keys(),
  ])

  const merged = []

  allIds.forEach((id) => {
    const previous = previousMap.get(id) || null
    const fromBase = baseMap.get(id) || null
    const fromDaily = dailyMap.get(id) || null
    const source = fromDaily || fromBase || previous
    if (!source) return
    if (shouldIgnoreBarrierOperation(source) || shouldIgnoreBarrierOperation(previous)) return

    const sourceBarrierDirections = getBarrierDirections(source)
    const previousBarrierDirections = getBarrierDirections(previous)
    const hasHighBarrier = sourceBarrierDirections.hasHigh || previousBarrierDirections.hasHigh
    const hasLowBarrier = sourceBarrierDirections.hasLow || previousBarrierDirections.hasLow
    if (!hasHighBarrier && !hasLowBarrier) return
    const sourceLegs = mergeBarrierLegs({
      previousLegs: previous?.pernas,
      baseLegs: fromBase?.pernas,
      dailyLegs: fromDaily?.pernas,
    })
    const spotInicial = toOptionalNumber(source?.spotInicial ?? previous?.spotInicial)
    const baseHasPosition = resolveOperationHasOpenPosition(fromBase)
    const dailyHasPosition = resolveOperationHasOpenPosition(fromDaily)
    if (!baseHasPosition && !dailyHasPosition) return

    const activeNow = dailyHasPosition
    const vencimentoKey = normalizeDateKey(source?.vencimento) || normalizeDateKey(previous?.vencimento) || ''
    const inactiveReason = activeNow
      ? ''
      : (vencimentoKey && reportDateKey >= vencimentoKey ? 'vencimento' : (fromDaily ? 'zerada_no_diario' : 'fora_diario'))

    let highHit = previous?.highHit === true
    let lowHit = previous?.lowHit === true
    let highHitAt = normalizeDateKey(previous?.highHitAt || '') || ''
    let lowHitAt = normalizeDateKey(previous?.lowHitAt || '') || ''
    let highHitSeq = Number(previous?.highHitSeq) || 0
    let lowHitSeq = Number(previous?.lowHitSeq) || 0
    let highHitReason = normalizeText(previous?.highHitReason)
    let lowHitReason = normalizeText(previous?.lowHitReason)

    merged.push({
      id,
      codigoOperacao: chooseText(source?.codigoOperacao, previous?.codigoOperacao, id),
      codigoCliente: chooseText(source?.codigoCliente, previous?.codigoCliente),
      cliente: chooseText(source?.cliente, previous?.cliente),
      assessor: chooseText(source?.assessor, previous?.assessor),
      broker: chooseText(source?.broker, previous?.broker),
      ativo: chooseText(source?.ativo, previous?.ativo),
      estrutura: chooseText(source?.estrutura, previous?.estrutura),
      tipoEstrutura: chooseText(source?.tipoEstrutura, previous?.tipoEstrutura),
      modalidadeOperacao: chooseText(source?.modalidadeOperacao, previous?.modalidadeOperacao),
      vencimento: normalizeDateKey(source?.vencimento) || normalizeDateKey(previous?.vencimento) || '',
      dataRegistro: normalizeDateKey(source?.dataRegistro) || normalizeDateKey(previous?.dataRegistro) || '',
      spotInicial,
      pernas: sourceLegs,
      hasHighBarrier,
      hasLowBarrier,
      highHit,
      lowHit,
      highHitAt,
      lowHitAt,
      highHitSeq,
      lowHitSeq,
      highHitReason,
      lowHitReason,
      active: activeNow,
      inactiveReason,
      firstSeenAt: normalizeDateKey(previous?.firstSeenAt) || reportDateKey,
      lastSeenAt: activeNow
        ? reportDateKey
        : (normalizeDateKey(previous?.lastSeenAt) || (fromBase ? reportDateKey : '')),
      lastUpdatedAt: reportDateKey,
      baseHasPosition,
      dailyHasPosition,
      seenInBase: Boolean(fromBase),
      seenInDaily: Boolean(fromDaily),
    })
  })

  merged.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    const leftHit = left.highHit || left.lowHit
    const rightHit = right.highHit || right.lowHit
    if (leftHit !== rightHit) return leftHit ? -1 : 1
    return chooseText(left.ativo, left.cliente, left.id).localeCompare(chooseText(right.ativo, right.cliente, right.id), 'pt-BR')
  })

  return {
    operations: merged,
    reportDate: reportDateKey,
    baseCount: baseRows.length,
    dailyCount: dailyRows.length,
  }
}

const BatimentoBarreira = () => {
  const { notify } = useToast()
  const baseBinding = useImportedFileBinding('batimento-barreira', 'base')
  const dailyBinding = useImportedFileBinding('batimento-barreira', 'diario')
  const { selectedBroker, selectedAssessor, tagsIndex } = useGlobalFilters()
  const [userKey] = useState(() => getCurrentUserKey())
  const [reportDate, setReportDate] = useState(getTodayKey)
  const [analysisFrom, setAnalysisFrom] = useState('')
  const [analysisTo, setAnalysisTo] = useState('')
  const [processing, setProcessing] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [state, setState] = useState(() => loadBarrierHitState(userKey))
  const [tableFilters, setTableFilters] = useState(DEFAULT_TABLE_FILTERS)
  const [page, setPage] = useState(1)
  const hydrationNoticeRef = useRef('')
  const baseFile = baseBinding.selectedFile
  const dailyFile = dailyBinding.selectedFile

  useEffect(() => {
    const loaded = loadBarrierHitState(userKey)
    const hydratedDates = hydrateBarrierHitDateInputs({
      savedState: loaded,
      todayKey: getTodayKey(),
    })
    setState(loaded)
    setReportDate(hydratedDates.reportDate)
    setAnalysisFrom(hydratedDates.analysisFrom)
    setAnalysisTo(hydratedDates.analysisTo)

    if (hydratedDates.advancedToToday) {
      const noticeKey = [
        userKey,
        loaded?.updatedAt || '',
        hydratedDates.reportDate,
        hydratedDates.analysisFrom,
        hydratedDates.analysisTo,
      ].join('|')
      if (hydrationNoticeRef.current !== noticeKey) {
        hydrationNoticeRef.current = noticeKey
        notify(`Periodo atualizado para ${formatDate(getTodayKey())} para incluir a cotacao de hoje.`, 'warning')
      }
      return
    }

    hydrationNoticeRef.current = ''
  }, [notify, userKey])

  const operations = useMemo(
    () => (Array.isArray(state?.operations) ? state.operations : []).filter(
      (row) => !shouldIgnoreBarrierOperation(row) && hasBarrierConfigured(row),
    ),
    [state?.operations],
  )

  const enrichedOperations = useMemo(
    () => operations.map((operation) => enrichRow(operation, tagsIndex)),
    [operations, tagsIndex],
  )

  const kpis = useMemo(() => {
    const activeCount = enrichedOperations.filter((item) => item.active).length
    const hitCount = enrichedOperations.filter((item) => hasBarrierHit(item)).length
    return {
      total: enrichedOperations.length,
      activeCount,
      hitCount,
    }
  }, [enrichedOperations])

  const historicalHitOperations = useMemo(() => (
    [...enrichedOperations]
      .filter((row) => hasBarrierHit(row))
      .sort((left, right) => {
        const seqDiff = getLatestHitSeq(right) - getLatestHitSeq(left)
        if (seqDiff !== 0) return seqDiff
        return chooseText(right.lastUpdatedAt, right.lastSeenAt).localeCompare(
          chooseText(left.lastUpdatedAt, left.lastSeenAt),
          'pt-BR',
        )
      })
  ), [enrichedOperations])

  const lastRunLabel = useMemo(() => {
    const key = normalizeDateKey(state?.reportDate || '')
    return key ? formatDate(key) : '-'
  }, [state?.reportDate])

  const analyzedPeriodLabel = useMemo(() => {
    const from = normalizeDateKey(state?.analysisFrom || '')
    const to = normalizeDateKey(state?.analysisTo || '')
    if (!from || !to) return '-'
    return `${formatDate(from)} a ${formatDate(to)}`
  }, [state?.analysisFrom, state?.analysisTo])

  const brokerOptions = useMemo(() => (
    Array.from(new Set(
      historicalHitOperations
        .map((row) => normalizeText(row?.broker))
        .filter(Boolean),
    )).sort((left, right) => left.localeCompare(right, 'pt-BR'))
  ), [historicalHitOperations])

  const assessorOptions = useMemo(() => (
    Array.from(new Set(
      historicalHitOperations
        .map((row) => normalizeText(row?.assessor))
        .filter(Boolean),
    )).sort((left, right) => left.localeCompare(right, 'pt-BR'))
  ), [historicalHitOperations])

  const estruturaOptions = useMemo(() => (
    Array.from(new Set(
      historicalHitOperations
        .map((row) => normalizeText(row?.estrutura))
        .filter(Boolean),
    )).sort((left, right) => left.localeCompare(right, 'pt-BR'))
  ), [historicalHitOperations])

  const ativoOptions = useMemo(() => (
    Array.from(new Set(
      historicalHitOperations
        .map((row) => normalizeText(row?.ativo))
        .filter(Boolean),
    )).sort((left, right) => left.localeCompare(right, 'pt-BR'))
  ), [historicalHitOperations])

  const filteredOperations = useMemo(() => {
    const searchToken = normalizeMatch(tableFilters.search)
    const globalBrokerSet = new Set((Array.isArray(selectedBroker) ? selectedBroker : []).map((item) => normalizeText(item)).filter(Boolean))
    const globalAssessorSet = new Set((Array.isArray(selectedAssessor) ? selectedAssessor : []).map((item) => normalizeText(item)).filter(Boolean))

    return historicalHitOperations.filter((row) => {
      const broker = normalizeText(row?.broker)
      const assessor = normalizeText(row?.assessor)
      const estrutura = normalizeText(row?.estrutura)
      const ativo = normalizeText(row?.ativo)
      const active = row?.active === true

      if (globalBrokerSet.size && !globalBrokerSet.has(broker)) return false
      if (globalAssessorSet.size && !globalAssessorSet.has(assessor)) return false
      if (tableFilters.broker !== 'all' && broker !== tableFilters.broker) return false
      if (tableFilters.assessor !== 'all' && assessor !== tableFilters.assessor) return false
      if (tableFilters.estrutura !== 'all' && estrutura !== tableFilters.estrutura) return false
      if (tableFilters.ativo !== 'all' && ativo !== tableFilters.ativo) return false
      if (tableFilters.status === 'active' && !active) return false
      if (tableFilters.status === 'inactive' && active) return false
      if (tableFilters.hit === 'high' && row?.highHit !== true) return false
      if (tableFilters.hit === 'low' && row?.lowHit !== true) return false
      if (tableFilters.dateFrom || tableFilters.dateTo) {
        const from = tableFilters.dateFrom || ''
        const to = tableFilters.dateTo || ''
        // Filtra pela coluna "Data batimento" (highHitAt / lowHitAt).
        // Se o batimento existe mas sem data registrada, não filtra por data (inclui a linha).
        const highHitDate = row?.highHit ? (row.highHitAt || '') : null
        const lowHitDate = row?.lowHit ? (row.lowHitAt || '') : null
        const highInRange = highHitDate !== null && (
          !highHitDate || ((!from || highHitDate >= from) && (!to || highHitDate <= to))
        )
        const lowInRange = lowHitDate !== null && (
          !lowHitDate || ((!from || lowHitDate >= from) && (!to || lowHitDate <= to))
        )
        if (!highInRange && !lowInRange) return false
      }
      if (!searchToken) return true

      const haystack = normalizeMatch([
        row?.codigoOperacao,
        row?.id,
        row?.ativo,
        row?.cliente,
        row?.codigoCliente,
        row?.assessor,
        row?.broker,
        row?.estrutura,
      ].join(' '))
      return haystack.includes(searchToken)
    })
  }, [historicalHitOperations, selectedAssessor, selectedBroker, tableFilters.assessor, tableFilters.ativo, tableFilters.broker, tableFilters.dateFrom, tableFilters.dateTo, tableFilters.estrutura, tableFilters.hit, tableFilters.search, tableFilters.status])

  const visibleKpis = useMemo(() => {
    const activeCount = filteredOperations.filter((item) => item.active).length
    return {
      total: filteredOperations.length,
      activeCount,
    }
  }, [filteredOperations])

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(filteredOperations.length / PAGE_SIZE)),
    [filteredOperations.length],
  )

  const paginationItems = useMemo(
    () => buildPagination(page, pageCount),
    [page, pageCount],
  )

  const pageStart = (page - 1) * PAGE_SIZE

  const pagedOperations = useMemo(
    () => filteredOperations.slice(pageStart, pageStart + PAGE_SIZE),
    [filteredOperations, pageStart],
  )

  const normalizedAnalysisFrom = normalizeDateKey(analysisFrom)
  const normalizedAnalysisTo = normalizeDateKey(analysisTo)
  const hasAnalysisPeriod = Boolean(normalizedAnalysisFrom && normalizedAnalysisTo)
  const analysisPeriodInvalid = hasAnalysisPeriod && normalizedAnalysisFrom > normalizedAnalysisTo
  const processDisabled = processing || !hasAnalysisPeriod || analysisPeriodInvalid

  const pageStartLabel = filteredOperations.length ? pageStart + 1 : 0
  const pageEndLabel = filteredOperations.length ? pageStart + pagedOperations.length : 0

  useEffect(() => {
    setPage((previous) => Math.min(previous, pageCount))
  }, [pageCount])

  useEffect(() => {
    setPage(1)
  }, [
    tableFilters.search,
    tableFilters.broker,
    tableFilters.assessor,
    tableFilters.estrutura,
    tableFilters.ativo,
    tableFilters.status,
    tableFilters.hit,
    tableFilters.dateFrom,
    tableFilters.dateTo,
    Array.isArray(selectedBroker) ? selectedBroker.join('|') : '',
    Array.isArray(selectedAssessor) ? selectedAssessor.join('|') : '',
  ])

  const handleProcess = useCallback(async () => {
    if (!normalizedAnalysisFrom || !normalizedAnalysisTo) {
      notify('Selecione o periodo de analise (de e ate) antes de processar.', 'warning')
      return
    }
    if (normalizedAnalysisFrom > normalizedAnalysisTo) {
      notify('Periodo de analise invalido: a data inicial nao pode ser maior que a final.', 'warning')
      return
    }

    let nextBaseFile = baseFile
    let nextDailyFile = dailyFile
    if (!nextBaseFile) nextBaseFile = await baseBinding.refreshFromCatalog()
    if (!nextDailyFile) nextDailyFile = await dailyBinding.refreshFromCatalog()
    if (!nextBaseFile || !nextDailyFile) {
      notify('Selecione os dois arquivos: base e diario.', 'warning')
      return
    }

    const normalizedReportDate = normalizeDateKey(reportDate) || getTodayKey()
    setProcessing(true)
    try {
      const [baseRowsRaw, dailyRowsRaw] = await Promise.all([
        parseImportedWorkbook(nextBaseFile),
        parseImportedWorkbook(nextDailyFile),
      ])
      const basePrepared = filterUnsupportedBarrierRows(baseRowsRaw)
      const dailyPrepared = filterUnsupportedBarrierRows(dailyRowsRaw)

      const merged = mergeBarrierRecords({
        previousOperations: operations,
        baseRows: basePrepared.rows,
        dailyRows: dailyPrepared.rows,
        reportDate: normalizedReportDate,
      })
      const validated = await resolveBarrierHitsByMarket({
        operations: merged.operations,
        reportDate: normalizedReportDate,
        analysisFrom: normalizedAnalysisFrom,
        analysisTo: normalizedAnalysisTo,
      })
      const mergedOperations = validated.operations.map((operation) => enrichRow(operation, tagsIndex))

      const saved = saveBarrierHitState(userKey, {
        ...state,
        reportDate: validated.reportDate,
        analysisFrom: normalizedAnalysisFrom,
        analysisTo: normalizedAnalysisTo,
        updatedAt: Date.now(),
        baseFileName: nextBaseFile.fileName || nextBaseFile.name || '',
        dailyFileName: nextDailyFile.fileName || nextDailyFile.name || '',
        baseCount: merged.baseCount,
        dailyCount: merged.dailyCount,
        operations: mergedOperations,
      })

      if (!saved) {
        notify('Falha ao salvar historico local de batimento.', 'warning')
        return
      }

      setState(saved)
      setPage(1)
      const ignoredCount = basePrepared.ignoredCount + dailyPrepared.ignoredCount
      const ignoredMsg = ignoredCount
        ? ` ${formatNumber(ignoredCount)} linha(s) sem barreira ou de estruturas nao monitoradas foram desconsideradas.`
        : ''
      const validatedMsg = validated?.stats?.verifiedOperations
        ? ` ${formatNumber(validated.stats.verifiedOperations)} operacao(oes) validadas por maxima/minima do ativo.`
        : ''
      const failedValidationMsg = validated?.stats?.failedOperations
        ? ` ${formatNumber(validated.stats.failedOperations)} operacao(oes) sem serie de mercado para validar.`
        : ''
      notify(`Relatorios processados com sucesso.${ignoredMsg}${validatedMsg}${failedValidationMsg}`, 'success')
    } catch {
      notify('Falha ao processar os arquivos. Verifique se ambos sao planilhas validas.', 'warning')
    } finally {
      setProcessing(false)
    }
  }, [baseBinding.refreshFromCatalog, baseFile, dailyBinding.refreshFromCatalog, dailyFile, normalizedAnalysisFrom, normalizedAnalysisTo, notify, operations, reportDate, state, tagsIndex, userKey])

  const handleClear = useCallback(() => {
    clearBarrierHitState(userKey)
    setState(null)
    notify('Historico de batimento limpo.', 'success')
  }, [notify, userKey])

  const handleExportXlsx = useCallback(async () => {
    if (isExporting) return
    if (!filteredOperations.length) {
      notify('Nenhuma operacao com batimento para exportar.', 'warning')
      return
    }
    setIsExporting(true)
    try {
      const resolveBarrierValuesForExport = (pernas, direction, spotInicial) => {
        const legs = Array.isArray(pernas) ? pernas : []
        const values = []
        legs.forEach((leg) => {
          const barrier = toOptionalNumber(leg?.barreiraValor)
          if (barrier == null) return
          const dir = normalizeBarrierDirection(leg?.barreiraTipo, barrier, spotInicial)
          if (dir === direction) values.push(formatBarrierNumber(barrier))
        })
        return values.join(', ')
      }

      const exportColumns = [
        'CÓDIGO DO CLIENTE',
        'ASSESSOR',
        'BROKER',
        'ATIVO',
        'VENCIMENTO',
        'DATA DE REGISTRO',
        'SPOT INICIAL',
        'ESTRUTURA',
        'TIPO DA BARREIRA',
        'VALOR DA BARREIRA',
        'DATA DO BATIMENTO',
        'MOTIVO',
      ]
      const exportRows = filteredOperations.flatMap((row) => {
        const base = [
          row.codigoCliente || '',
          row.assessor || '',
          row.broker || '',
          row.ativo || '',
          row.vencimento ? formatDate(row.vencimento) : '',
          row.dataRegistro ? formatDate(row.dataRegistro) : '',
          formatBarrierNumber(row.spotInicial),
          row.estrutura || '',
        ]
        const hits = []
        if (row.highHit) hits.push([
          ...base,
          'Alta',
          resolveBarrierValuesForExport(row.pernas, 'high', row.spotInicial),
          row.highHitAt ? formatDate(row.highHitAt) : '',
          row.highHitReason || '',
        ])
        if (row.lowHit) hits.push([
          ...base,
          'Baixa',
          resolveBarrierValuesForExport(row.pernas, 'low', row.spotInicial),
          row.lowHitAt ? formatDate(row.lowHitAt) : '',
          row.lowHitReason || '',
        ])
        return hits
      })
      const fileDate = new Date().toISOString().slice(0, 10)
      const { exportXlsx } = await import('../services/exportXlsx')
      const border = {
        top: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
        right: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
        bottom: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
        left: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
      }
      await exportXlsx({
        fileName: `batimento_barreira_${fileDate}.xlsx`,
        sheetName: 'Batimento Barreira',
        columns: exportColumns,
        rows: exportRows,
        useStyles: true,
        columnWidths: [18, 20, 16, 12, 14, 16, 12, 22, 14, 18, 18, 40],
        decorateWorksheet: ({ worksheet, XLSX }) => {
          const centerAlign = { horizontal: 'center', vertical: 'center', wrapText: true }
          const buildDataStyle = (fillRgb) => ({
            alignment: centerAlign,
            border,
            fill: { patternType: 'solid', fgColor: { rgb: fillRgb } },
            font: { color: { rgb: 'FF0F172A' } },
          })
          const headerStyle = { alignment: centerAlign, border, fill: { patternType: 'solid', fgColor: { rgb: 'FF0F172A' } }, font: { bold: true, color: { rgb: 'FFFFFFFF' } } }
          const totalRows = exportRows.length + 1
          const totalCols = exportColumns.length
          for (let r = 0; r < totalRows; r += 1) {
            for (let c = 0; c < totalCols; c += 1) {
              const ref = XLSX.utils.encode_cell({ r, c })
              const cell = worksheet[ref]
              if (!cell) continue
              if (r === 0) { cell.s = headerStyle; continue }
              cell.s = buildDataStyle(r % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFD')
            }
          }
          const lastCol = XLSX.utils.encode_col(Math.max(exportColumns.length - 1, 0))
          worksheet['!autofilter'] = { ref: `A1:${lastCol}1` }
        },
      })
      notify('Exportacao concluida.', 'success')
    } catch {
      notify('Falha ao exportar.', 'warning')
    } finally {
      setIsExporting(false)
    }
  }, [isExporting, filteredOperations, notify])

  const columns = useMemo(() => ([
    {
      key: 'operacao',
      label: 'Operacao',
      render: (row) => (
        <div className="cell-stack">
          <strong>{row.codigoOperacao || row.id}</strong>
          <small>{row.id}</small>
        </div>
      ),
    },
    {
      key: 'ativo',
      label: 'Ativo',
      render: (row) => <strong>{row.ativo || '-'}</strong>,
    },
    {
      key: 'cliente',
      label: 'Conta',
      render: (row) => row.codigoCliente || row.cliente || '-',
    },
    {
      key: 'estrutura',
      label: 'Estrutura',
      render: (row) => row.estrutura || '-',
    },
    {
      key: 'responsavel',
      label: 'Assessor / Broker',
      render: (row) => (
        <div className="cell-stack">
          <strong>{row.assessor || '-'}</strong>
          <small>{row.broker || '-'}</small>
        </div>
      ),
    },
    {
      key: 'barreiras',
      label: 'Barreiras',
      render: (row) => {
        const labels = []
        if (row.hasHighBarrier) labels.push('Alta')
        if (row.hasLowBarrier) labels.push('Baixa')
        if (!labels.length) return <span className="muted">Sem barreira</span>
        return labels.join(' / ')
      },
    },
    {
      key: 'status',
      label: 'Status hoje',
      render: (row) => {
        if (row.active) return <Badge tone="cyan">Ativa no diario</Badge>
        if (row?.inactiveReason === 'vencimento') return <Badge tone="violet">Vencida</Badge>
        return <Badge tone="amber">Fora do diario</Badge>
      },
    },
    {
      key: 'batimento',
      label: 'Bateu barreira?',
      render: (row) => {
        if (!row.highHit && !row.lowHit) return <Badge tone="violet">Nao</Badge>
        const labels = []
        if (row.highHit) labels.push('Alta')
        if (row.lowHit) labels.push('Baixa')
        return (
          <div className="cell-stack">
            <Badge tone="green">Sim</Badge>
            <small>{labels.join(' / ')}</small>
          </div>
        )
      },
    },
    {
      key: 'dataBatimento',
      label: 'Data batimento',
      render: (row) => {
        if (!row.highHit && !row.lowHit) return '—'
        const dates = []
        if (row.highHit && row.highHitAt) dates.push(`Alta: ${formatDate(row.highHitAt)}`)
        if (row.lowHit && row.lowHitAt) dates.push(`Baixa: ${formatDate(row.lowHitAt)}`)
        return dates.length ? (
          <div className="cell-stack">
            {dates.map((d, i) => <small key={i}>{d}</small>)}
          </div>
        ) : '—'
      },
    },
    {
      key: 'datas',
      label: 'Linha do tempo',
      render: (row) => (
        <div className="cell-stack">
          <small>Primeira vez: {formatDate(row.firstSeenAt)}</small>
          <small>Ultima no diario: {formatDate(row.lastSeenAt)}</small>
        </div>
      ),
    },
    {
      key: 'motivo',
      label: 'Motivo',
      render: (row) => {
        const reasons = []
        if (row.highHitReason) reasons.push(`Alta: ${row.highHitReason}`)
        if (row.lowHitReason) reasons.push(`Baixa: ${row.lowHitReason}`)
        return reasons.length ? reasons.join(' | ') : '—'
      },
    },
  ]), [])

  return (
    <div className="page">
      <PageHeader
        title="Batimento de barreira"
        subtitle="Verifica se a barreira foi atingida pela maxima ou minima do ativo negociado dentro da janela processada. Importa base + diario e consolida o batimento por operacao."
        meta={[
          { label: 'Monitoradas', value: formatNumber(kpis.total) },
          { label: 'Com batimento na janela', value: formatNumber(kpis.hitCount) },
          { label: 'Em tela', value: formatNumber(visibleKpis.total) },
          { label: 'Ativas no diario', value: formatNumber(visibleKpis.activeCount) },
        ]}
        actions={[
          {
            label: isExporting ? 'Exportando...' : 'Exportar',
            icon: 'download',
            variant: 'btn-secondary',
            onClick: handleExportXlsx,
            disabled: isExporting || !filteredOperations.length,
          },
          {
            label: 'Limpar historico',
            icon: 'x',
            variant: 'btn-danger',
            onClick: handleClear,
            disabled: processing || !operations.length,
          },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Processamento diario</h3>
            <p className="muted">
              Suba os dois arquivos todos os dias: base (inicio do mes) + diario.
              Se a operacao sair do diario, o sistema trava batimento para aquela operacao.
            </p>
          </div>
        </div>

        <div className="filter-grid barrier-hit-processing-grid">
          <label className="barrier-hit-field">
            Data de referencia
            <input
              className="input"
              type="date"
              value={reportDate}
              onChange={(event) => setReportDate(event.target.value)}
            />
          </label>

          <label className="barrier-hit-field">
            Periodo de analise (de)
            <input
              className="input"
              type="date"
              value={analysisFrom}
              onChange={(event) => setAnalysisFrom(event.target.value)}
              max={analysisTo || undefined}
            />
          </label>

          <label className="barrier-hit-field">
            Periodo de analise (ate)
            <input
              className="input"
              type="date"
              value={analysisTo}
              onChange={(event) => setAnalysisTo(event.target.value)}
              min={analysisFrom || undefined}
            />
          </label>

          <label className="barrier-hit-field barrier-hit-upload-field">
            Relatorio base (inicio do mes)
            <select
              className="input"
              value={baseBinding.value || ''}
              onChange={(event) => baseBinding.setValue(event.target.value)}
              disabled={!baseBinding.options.length || processing}
            >
              {!baseBinding.options.length ? <option value="">Sem arquivos disponiveis</option> : null}
              {baseBinding.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <small className="muted">
              {baseBinding.options.find((option) => option.value === baseBinding.value)?.description
                || baseBinding.emptyMessage
                || state?.baseFileName
                || 'Nenhum arquivo selecionado'}
            </small>
          </label>

          <label className="barrier-hit-field barrier-hit-upload-field">
            Relatorio diario
            <select
              className="input"
              value={dailyBinding.value || ''}
              onChange={(event) => dailyBinding.setValue(event.target.value)}
              disabled={!dailyBinding.options.length || processing}
            >
              {!dailyBinding.options.length ? <option value="">Sem arquivos disponiveis</option> : null}
              {dailyBinding.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <small className="muted">
              {dailyBinding.options.find((option) => option.value === dailyBinding.value)?.description
                || dailyBinding.emptyMessage
                || state?.dailyFileName
                || 'Nenhum arquivo selecionado'}
            </small>
          </label>
        </div>

        <div className="row-actions">
          <button
            className="btn btn-primary"
            type="button"
            onClick={handleProcess}
            disabled={processDisabled}
          >
            {processing ? 'Processando...' : 'Processar base + diario'}
          </button>
        </div>

        {analysisPeriodInvalid ? (
          <p className="muted">
            Periodo de analise invalido: a data inicial nao pode ser maior que a final.
          </p>
        ) : null}

        <p className="muted">
          Ultima consolidacao: {lastRunLabel} | Base: {formatNumber(state?.baseCount || 0)} linhas |
          Diario: {formatNumber(state?.dailyCount || 0)} linhas | Periodo analisado: {analyzedPeriodLabel}
        </p>
        <p className="muted">
          Regra adicional: operacoes sem barreira ou de estruturas nao monitoradas (ex.: call/call spread, put/put spread, alocacao protegida, cupom recorrente/europeia e sob/sub custodia) sao ignoradas no processamento. Se o ativo saiu do diario por vencimento, isso nao e contado como batimento.
        </p>
        <p className="muted">
          O periodo de analise filtra a janela de batimento. Se voce informar ontem e hoje, o processamento retorna apenas estruturas que bateram barreira dentro desse intervalo.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Historico travado de batimento</h3>
            <p className="muted">
              Exibindo apenas as operacoes que bateram barreira dentro da janela processada.
            </p>
          </div>
        </div>

        <div className="filter-grid barrier-hit-filter-grid">
          <label className="barrier-hit-field barrier-hit-filter-search">
            Busca
            <input
              className="input"
              type="text"
              value={tableFilters.search}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, search: event.target.value }))}
              placeholder="Operacao, conta, assessor, broker, ativo ou estrutura"
            />
          </label>

          <label className="barrier-hit-field">
            Assessor
            <select
              className="input"
              value={tableFilters.assessor}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, assessor: event.target.value }))}
            >
              <option value="all">Todos</option>
              {assessorOptions.map((assessor) => (
                <option key={assessor} value={assessor}>{assessor}</option>
              ))}
            </select>
          </label>

          <label className="barrier-hit-field">
            Broker
            <select
              className="input"
              value={tableFilters.broker}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, broker: event.target.value }))}
            >
              <option value="all">Todos</option>
              {brokerOptions.map((broker) => (
                <option key={broker} value={broker}>{broker}</option>
              ))}
            </select>
          </label>

          <label className="barrier-hit-field">
            Estrutura
            <select
              className="input"
              value={tableFilters.estrutura}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, estrutura: event.target.value }))}
            >
              <option value="all">Todas</option>
              {estruturaOptions.map((estrutura) => (
                <option key={estrutura} value={estrutura}>{estrutura}</option>
              ))}
            </select>
          </label>

          <label className="barrier-hit-field">
            Ativo
            <select
              className="input"
              value={tableFilters.ativo}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, ativo: event.target.value }))}
            >
              <option value="all">Todos</option>
              {ativoOptions.map((ativo) => (
                <option key={ativo} value={ativo}>{ativo}</option>
              ))}
            </select>
          </label>

          <label className="barrier-hit-field">
            Status hoje
            <select
              className="input"
              value={tableFilters.status}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, status: event.target.value }))}
            >
              <option value="all">Todos</option>
              <option value="active">Ativa no diario</option>
              <option value="inactive">Fora do diario</option>
            </select>
          </label>

          <label className="barrier-hit-field">
            Tipo de batimento
            <select
              className="input"
              value={tableFilters.hit}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, hit: event.target.value }))}
            >
              <option value="all">Alta ou baixa</option>
              <option value="high">Somente alta</option>
              <option value="low">Somente baixa</option>
            </select>
          </label>

          <label className="barrier-hit-field">
            Data de batimento (de)
            <input
              className="input"
              type="date"
              value={tableFilters.dateFrom}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, dateFrom: event.target.value }))}
              max={tableFilters.dateTo || undefined}
            />
          </label>

          <label className="barrier-hit-field">
            Data de batimento (até)
            <input
              className="input"
              type="date"
              value={tableFilters.dateTo}
              onChange={(event) => setTableFilters((previous) => ({ ...previous, dateTo: event.target.value }))}
              min={tableFilters.dateFrom || undefined}
            />
          </label>
        </div>

        <div className="row-actions">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              setTableFilters(DEFAULT_TABLE_FILTERS)
              setPage(1)
            }}
            disabled={
              tableFilters.search === DEFAULT_TABLE_FILTERS.search
              && tableFilters.broker === DEFAULT_TABLE_FILTERS.broker
              && tableFilters.assessor === DEFAULT_TABLE_FILTERS.assessor
              && tableFilters.estrutura === DEFAULT_TABLE_FILTERS.estrutura
              && tableFilters.ativo === DEFAULT_TABLE_FILTERS.ativo
              && tableFilters.status === DEFAULT_TABLE_FILTERS.status
              && tableFilters.hit === DEFAULT_TABLE_FILTERS.hit
              && tableFilters.dateFrom === DEFAULT_TABLE_FILTERS.dateFrom
              && tableFilters.dateTo === DEFAULT_TABLE_FILTERS.dateTo
            }
          >
            Limpar filtros
          </button>
        </div>

        <p className="muted">
          {filteredOperations.length
            ? `Exibindo ${formatNumber(pageStartLabel)}-${formatNumber(pageEndLabel)} de ${formatNumber(filteredOperations.length)} operacao(oes) com batimento.`
            : 'Exibindo 0 de 0 operacao(oes) com batimento.'}
          {' '}Monitoradas no total: {formatNumber(operations.length)}.
        </p>

        <DataTable
          columns={columns}
          rows={pagedOperations}
          emptyMessage={operations.length ? 'Nenhuma operacao com barreira batida para os filtros atuais.' : 'Nenhuma operacao monitorada ainda.'}
          visibleRows={14}
        />

        <div className="table-footer">
          <div className="table-pagination">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPage((previous) => Math.max(previous - 1, 1))}
              disabled={page <= 1}
            >
              Anterior
            </button>
            <div className="page-list" role="navigation" aria-label="Paginacao">
              <span className="page-label">Pagina</span>
              {paginationItems.map((item, index) => (
                item === 'ellipsis' ? (
                  <span key={`ellipsis-${index}`} className="page-ellipsis">...</span>
                ) : (
                  <button
                    key={`page-${item}`}
                    className={`page-number ${item === page ? 'active' : ''}`}
                    type="button"
                    onClick={() => setPage(item)}
                    aria-current={item === page ? 'page' : undefined}
                  >
                    {item}
                  </button>
                )
              ))}
            </div>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPage((previous) => Math.min(previous + 1, pageCount))}
              disabled={page >= pageCount}
            >
              Proxima
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

export default BatimentoBarreira
