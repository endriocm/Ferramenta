import { normalizeDateKey } from '../utils/dateKey.js'
import { mapWithConcurrency } from '../utils/concurrent.js'
import { getCurrentUserKey } from './currentUser.js'

export const HISTORICO_STATE_VERSION = 2
export const HISTORICO_STATE_PREFIX = 'pwr.historico-operacoes.state'
export const HISTORICO_UPDATED_EVENT = 'pwr:historico-operacoes-updated'
export const HISTORICO_ORIGIN_LEGACY = 'legacy'
export const HISTORICO_ORIGIN_VENCIMENTO = 'vencimento'
export const HISTORICO_SPOT_CONCURRENCY = 8

const HISTORICO_MONTH_LABEL = new Intl.DateTimeFormat('pt-BR', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

const LEGACY_IMPORT_META = {
  fileName: '',
  importedAt: '',
}

const normalizeHistoricalYahooSymbol = (ticker) => {
  if (!ticker) return ''
  const raw = String(ticker).trim().toUpperCase()
  if (raw.includes('.')) return raw
  if (/^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw)) return `${raw}.SA`
  return raw
}

export const DADOS_EXPORT_COLUMNS = [
  { key: 'assessor', label: 'ASSESSOR' },
  { key: 'broker', label: 'BROKER' },
  { key: 'cliente', label: 'CLIENTE' },
  { key: 'dataRegistro', label: 'DATA DE REGISTRO' },
  { key: 'ativo', label: 'ATIVO' },
  { key: 'estrutura', label: 'ESTRUTURA' },
  { key: 'valorCompra', label: 'VALOR DE COMPRA' },
  { key: 'dataVencimento', label: 'DATA DE VENCIMENTO' },
  { key: 'quantidade', label: 'QUANTIDADE' },
  { key: 'custoUnitario', label: 'CUSTO UNITÁRIO' },
  { key: 'callComprada', label: 'STRIKE CALL COMPRADA' },
  { key: 'callVendida', label: 'STRIKE CALL VENDIDA' },
  { key: 'putComprada', label: 'STRIKE PUT COMPRADA' },
  { key: 'putComprada2', label: 'STRIKE PUT COMPRADA 2' },
  { key: 'putVendida', label: 'STRIKE PUT VENDIDA' },
  { key: 'barreiraKi', label: 'BARREIRA KI' },
  { key: 'barreiraKo', label: 'BARREIRA KO' },
  { key: 'spot', label: 'SPOT' },
  { key: 'ganhoPrejuizo', label: 'GANHO / PREJUÍZO' },
  { key: 'financeiroFinal', label: 'FINANCEIRO FINAL' },
  { key: 'vendaAtivoMercado', label: 'VENDA DO ATIVO A MERCADO' },
  { key: 'lucroPercentual', label: 'LUCRO %' },
  { key: 'debito', label: 'DÉBITO' },
  { key: 'dividendos', label: 'DIVIDENDOS' },
  { key: 'ganhosOpcoes', label: 'GANHOS NAS OPÇÕES' },
  { key: 'ganhoPut', label: 'GANHO NA PUT' },
  { key: 'ganhoCall', label: 'GANHO NA CALL' },
  { key: 'cupom', label: 'CUPOM' },
  { key: 'pagou', label: 'PAGOU' },
]

export const DADOS_EXPORT_KEYS = DADOS_EXPORT_COLUMNS.map((column) => column.key)
export const DADOS_EXPORT_LABELS = DADOS_EXPORT_COLUMNS.map((column) => column.label)

export const toOptionalNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const formatDatePtBr = (value) => {
  const key = normalizeDateKey(value)
  if (!key) return ''
  const [year, month, day] = key.split('-')
  return `${day}/${month}/${year}`
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

const isShortLegExport = (leg) => {
  const side = String(leg?.side || '').toLowerCase()
  if (side === 'short' || side === 'vendida' || side === 'venda') return true
  return Number(leg?.quantidade || 0) < 0
}

const resolveLegStrike = (leg) => {
  const adjusted = leg?.strikeAjustado ?? leg?.strikeAdjusted
  if (adjusted != null && Number.isFinite(Number(adjusted))) return Number(adjusted)
  const raw = leg?.strike
  return Number.isFinite(Number(raw)) ? Number(raw) : null
}

const normalizeOrigin = (value) => {
  if (value === HISTORICO_ORIGIN_VENCIMENTO) return HISTORICO_ORIGIN_VENCIMENTO
  return HISTORICO_ORIGIN_LEGACY
}

const normalizeStructureLabel = (value) => String(value || '').trim().toLowerCase()

const isCupomRecorrenteStructure = (estrutura) => {
  const normalized = normalizeStructureLabel(estrutura)
  return normalized === 'cupom recorrente' || normalized === 'cupom recorrente europeia'
}

const resolveCupomRecorrenteLowBarrier = (row) => {
  const barriers = [
    toOptionalNumber(row?.barreiraKi),
    toOptionalNumber(row?.barreiraKo),
  ].filter((value) => value != null && value > 0)
  return barriers.length ? Math.min(...barriers) : null
}

const buildHistoricalRowId = (row) => {
  const preferred = String(row?.id || '').trim()
  if (preferred) return preferred
  const source = String(row?.sourceId || '').trim()
  if (source) return source
  return `hist-${hashString([
    row?.cliente,
    row?.ativo,
    row?.estrutura,
    row?.dataVencimento,
    row?.quantidade,
    row?.batchMonth,
    row?.origin,
  ].join('|'))}`
}

export const normalizeHistoricalMonthKey = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}$/.test(raw)) return raw
  const key = normalizeDateKey(raw)
  return key ? key.slice(0, 7) : ''
}

export const formatHistoricalMonthLabel = (monthKey) => {
  const normalized = normalizeHistoricalMonthKey(monthKey)
  if (!normalized) return '-'
  const [year, month] = normalized.split('-')
  const date = new Date(`${year}-${month}-01T00:00:00Z`)
  return HISTORICO_MONTH_LABEL.format(date)
}

export const normalizeHistoricalRow = (row, overrides = {}) => {
  const dataRegistro = normalizeDateKey(overrides.dataRegistro ?? row?.dataRegistro)
  const dataVencimento = normalizeDateKey(overrides.dataVencimento ?? row?.dataVencimento)
  const batchMonth = overrides.batchMonth ?? normalizeHistoricalMonthKey(row?.batchMonth || dataVencimento)
  const normalized = {
    id: String(overrides.id ?? row?.id ?? '').trim(),
    sourceId: String(overrides.sourceId ?? row?.sourceId ?? '').trim(),
    assessor: String(overrides.assessor ?? row?.assessor ?? '').trim(),
    broker: String(overrides.broker ?? row?.broker ?? '').trim(),
    cliente: String(overrides.cliente ?? row?.cliente ?? '').trim(),
    dataRegistro,
    ativo: String(overrides.ativo ?? row?.ativo ?? '').trim().toUpperCase(),
    estrutura: String(overrides.estrutura ?? row?.estrutura ?? '').trim(),
    valorCompra: toOptionalNumber(overrides.valorCompra ?? row?.valorCompra),
    dataVencimento,
    quantidade: toOptionalNumber(overrides.quantidade ?? row?.quantidade),
    custoUnitario: toOptionalNumber(overrides.custoUnitario ?? row?.custoUnitario),
    callComprada: toOptionalNumber(overrides.callComprada ?? row?.callComprada),
    callVendida: toOptionalNumber(overrides.callVendida ?? row?.callVendida),
    putComprada: toOptionalNumber(overrides.putComprada ?? row?.putComprada),
    putComprada2: toOptionalNumber(overrides.putComprada2 ?? row?.putComprada2),
    putVendida: toOptionalNumber(overrides.putVendida ?? row?.putVendida),
    barreiraKi: toOptionalNumber(overrides.barreiraKi ?? row?.barreiraKi),
    barreiraKo: toOptionalNumber(overrides.barreiraKo ?? row?.barreiraKo),
    spot: toOptionalNumber(overrides.spot ?? row?.spot),
    ganhoPrejuizo: toOptionalNumber(overrides.ganhoPrejuizo ?? row?.ganhoPrejuizo),
    financeiroFinal: toOptionalNumber(overrides.financeiroFinal ?? row?.financeiroFinal),
    vendaAtivoMercado: toOptionalNumber(overrides.vendaAtivoMercado ?? row?.vendaAtivoMercado),
    lucroPercentual: toOptionalNumber(overrides.lucroPercentual ?? row?.lucroPercentual),
    debito: toOptionalNumber(overrides.debito ?? row?.debito),
    dividendos: toOptionalNumber(overrides.dividendos ?? row?.dividendos),
    ganhosOpcoes: toOptionalNumber(overrides.ganhosOpcoes ?? row?.ganhosOpcoes),
    ganhoPut: toOptionalNumber(overrides.ganhoPut ?? row?.ganhoPut),
    ganhoCall: toOptionalNumber(overrides.ganhoCall ?? row?.ganhoCall),
    cupom: toOptionalNumber(overrides.cupom ?? row?.cupom),
    pagou: toOptionalNumber(overrides.pagou ?? row?.pagou),
    origin: normalizeOrigin(overrides.origin ?? row?.origin),
    batchMonth,
    sourceSheet: String(overrides.sourceSheet ?? row?.sourceSheet ?? '').trim(),
    sourceRow: Number.isFinite(Number(overrides.sourceRow ?? row?.sourceRow)) ? Number(overrides.sourceRow ?? row?.sourceRow) : null,
    pushedAt: String(overrides.pushedAt ?? row?.pushedAt ?? '').trim(),
    spotSource: String(overrides.spotSource ?? row?.spotSource ?? '').trim(),
  }
  normalized.id = buildHistoricalRowId(normalized)
  return normalized
}

export const buildHistoricalRowFromParsedRow = (row) => {
  return normalizeHistoricalRow({
    id: row?.id || '',
    assessor: row?.assessor || '',
    broker: row?.broker || '',
    cliente: row?.cliente || '',
    dataRegistro: row?.dataRegistro || '',
    ativo: row?.ativo || '',
    estrutura: row?.estrutura || '',
    valorCompra: row?.valorCompra,
    dataVencimento: row?.vencimento || '',
    quantidade: row?.quantidade,
    custoUnitario: row?.custoUnitario,
    callComprada: row?.callComprada,
    callVendida: row?.callVendida,
    putComprada: row?.putComprada,
    putComprada2: row?.putComprada2,
    putVendida: row?.putVendida,
    barreiraKi: row?.barreiraKi,
    barreiraKo: row?.barreiraKo,
    spot: row?.spotInformado,
    ganhoPrejuizo: row?.ganhoPrejuizoInformado,
    financeiroFinal: row?.financeiroFinalInformado,
    vendaAtivoMercado: row?.vendaAtivoInformado,
    lucroPercentual: row?.lucroPctInformado,
    debito: row?.debitoInformado,
    dividendos: row?.dividendosInformado,
    ganhosOpcoes: row?.ganhosOpcoesInformado,
    ganhoPut: row?.ganhoPutInformado,
    ganhoCall: row?.ganhoCallInformado,
    cupom: row?.cupomInformado,
    pagou: row?.pagouInformado,
    origin: HISTORICO_ORIGIN_LEGACY,
    sourceSheet: row?.sourceSheet || '',
    sourceRow: row?.sourceRow || null,
    spotSource: Number.isFinite(Number(row?.spotInformado)) ? 'planilha' : '',
  })
}

export const buildHistoricalRowFromVencimentoRow = (row, overrides = {}) => {
  const legs = Array.isArray(row?.effectiveLegs) ? row.effectiveLegs : []
  const callLong = legs.find((leg) => leg.tipo?.toUpperCase() === 'CALL' && !isShortLegExport(leg))
  const callShort = legs.find((leg) => leg.tipo?.toUpperCase() === 'CALL' && isShortLegExport(leg))
  const putLongs = legs.filter((leg) => leg.tipo?.toUpperCase() === 'PUT' && !isShortLegExport(leg))
  const putShort = legs.find((leg) => leg.tipo?.toUpperCase() === 'PUT' && isShortLegExport(leg))
  const kiLeg = legs.find((leg) => ['KI', 'DI', 'UI'].includes(leg?.barreiraTipo))
  const koLeg = legs.find((leg) => ['KO', 'DO', 'UO'].includes(leg?.barreiraTipo))
  const dataVencimento = normalizeDateKey(overrides.dataVencimento ?? row?.vencimento)
  const sourceId = String(row?.id || '').trim()
  const monthKey = normalizeHistoricalMonthKey(dataVencimento)
  const isCupomRecorrente = isCupomRecorrenteStructure(row?.estrutura)
  const vendaAtivoMercado = isCupomRecorrente
    ? toOptionalNumber(row?.result?.valorSaida ?? row?.result?.vendaAtivo ?? row?.result?.vendaAtivoAjustada ?? row?.result?.vendaAtivoBruta)
    : toOptionalNumber(row?.result?.vendaAtivoBruta)
  return normalizeHistoricalRow({
    id: sourceId && monthKey ? `hist-${monthKey}-${sourceId}` : sourceId,
    sourceId,
    assessor: row?.assessor || '',
    broker: row?.broker || '',
    cliente: row?.codigoCliente || row?.cliente || '',
    dataRegistro: normalizeDateKey(row?.dataRegistro) || '',
    ativo: row?.ativo || '',
    estrutura: row?.estrutura || '',
    valorCompra: toOptionalNumber(row?.result?.valorEntrada ?? row?.result?.pagou ?? row?.result?.custoTotal),
    dataVencimento,
    quantidade: toOptionalNumber(row?.qtyAtual ?? row?.quantidade),
    custoUnitario: toOptionalNumber(row?.custoUnitario),
    callComprada: resolveLegStrike(callLong),
    callVendida: resolveLegStrike(callShort),
    putComprada: resolveLegStrike(putLongs[0]),
    putComprada2: resolveLegStrike(putLongs[1]),
    putVendida: resolveLegStrike(putShort),
    barreiraKi: toOptionalNumber(kiLeg?.barreiraValor),
    barreiraKo: toOptionalNumber(koLeg?.barreiraValor),
    spot: toOptionalNumber(row?.result?.spotFinal),
    ganhoPrejuizo: toOptionalNumber(row?.result?.ganho),
    financeiroFinal: toOptionalNumber(row?.result?.financeiroFinal),
    vendaAtivoMercado,
    lucroPercentual: toOptionalNumber(row?.result?.percent),
    debito: toOptionalNumber(row?.result?.debito),
    dividendos: toOptionalNumber(row?.result?.dividends),
    ganhosOpcoes: toOptionalNumber(row?.result?.ganhosOpcoes),
    ganhoPut: toOptionalNumber(row?.result?.ganhoPut),
    ganhoCall: toOptionalNumber(row?.result?.ganhoCall),
    cupom: toOptionalNumber(row?.result?.cupomTotal),
    pagou: toOptionalNumber(row?.result?.pagou),
    origin: overrides.origin ?? HISTORICO_ORIGIN_VENCIMENTO,
    batchMonth: overrides.batchMonth ?? monthKey,
    pushedAt: overrides.pushedAt ?? '',
    spotSource: overrides.spotSource ?? (Number.isFinite(Number(row?.result?.spotFinal)) ? 'vencimento' : ''),
  })
}

export const recalculateHistoricalWorkbookValues = (row, spotOverride = null, overrides = {}) => {
  const normalized = normalizeHistoricalRow(row, overrides)
  const quantity = Number(normalized.quantidade || 0)
  const spot = toOptionalNumber(spotOverride ?? normalized.spot)
  const isCupomRecorrente = isCupomRecorrenteStructure(normalized.estrutura)
  const lowBarrier = resolveCupomRecorrenteLowBarrier(normalized)
  const lowBarrierHit = isCupomRecorrente && spot != null && lowBarrier != null && spot <= lowBarrier
  const gainPut = normalized.putComprada != null && spot != null
    ? (Number(normalized.putComprada) - spot) * quantity
    : 0
  const gainCall = normalized.callComprada != null && spot != null
    ? (spot - Number(normalized.callComprada)) * quantity
    : 0
  const optionGain = gainPut + gainCall
  const vendaAtivoMercadoInput = toOptionalNumber(normalized.vendaAtivoMercado)
  const pagou = toOptionalNumber(normalized.pagou)
  const useManualVendaAtivoMercado = Boolean(overrides?.manualVendaAtivoMercado)
  const vendaAtivoMercado = isCupomRecorrente
    ? (
      lowBarrierHit && spot != null
        ? spot * quantity
        : (
          useManualVendaAtivoMercado && vendaAtivoMercadoInput != null
            ? vendaAtivoMercadoInput
            : (pagou ?? vendaAtivoMercadoInput ?? 0)
        )
    )
    : Number(vendaAtivoMercadoInput || 0)
  const debito = Number(normalized.debito || 0)
  const dividendos = Number(normalized.dividendos || 0)
  const cupom = Number(normalized.cupom || 0)
  const financeiroFinal = vendaAtivoMercado + debito + dividendos + optionGain + cupom
  const ganhoPrejuizo = pagou != null ? financeiroFinal - pagou : financeiroFinal
  const lucroPercentual = pagou ? (financeiroFinal / pagou) - 1 : 0
  return normalizeHistoricalRow(normalized, {
    spot,
    vendaAtivoMercado,
    ganhoPut: gainPut,
    ganhoCall: gainCall,
    ganhosOpcoes: optionGain,
    financeiroFinal,
    ganhoPrejuizo,
    lucroPercentual,
  })
}

export const serializeHistoricalRowForExport = (row) => {
  return {
    assessor: row?.assessor || '',
    broker: row?.broker || '',
    cliente: row?.cliente || '',
    dataRegistro: formatDatePtBr(row?.dataRegistro),
    ativo: row?.ativo || '',
    estrutura: row?.estrutura || '',
    valorCompra: toOptionalNumber(row?.valorCompra),
    dataVencimento: formatDatePtBr(row?.dataVencimento),
    quantidade: toOptionalNumber(row?.quantidade),
    custoUnitario: toOptionalNumber(row?.custoUnitario),
    callComprada: toOptionalNumber(row?.callComprada),
    callVendida: toOptionalNumber(row?.callVendida),
    putComprada: toOptionalNumber(row?.putComprada),
    putComprada2: toOptionalNumber(row?.putComprada2),
    putVendida: toOptionalNumber(row?.putVendida),
    barreiraKi: toOptionalNumber(row?.barreiraKi),
    barreiraKo: toOptionalNumber(row?.barreiraKo),
    spot: toOptionalNumber(row?.spot),
    ganhoPrejuizo: toOptionalNumber(row?.ganhoPrejuizo),
    financeiroFinal: toOptionalNumber(row?.financeiroFinal),
    vendaAtivoMercado: toOptionalNumber(row?.vendaAtivoMercado),
    lucroPercentual: toOptionalNumber(row?.lucroPercentual),
    debito: toOptionalNumber(row?.debito),
    dividendos: toOptionalNumber(row?.dividendos),
    ganhosOpcoes: toOptionalNumber(row?.ganhosOpcoes),
    ganhoPut: toOptionalNumber(row?.ganhoPut),
    ganhoCall: toOptionalNumber(row?.ganhoCall),
    cupom: toOptionalNumber(row?.cupom),
    pagou: toOptionalNumber(row?.pagou),
  }
}

export const buildHistoricalQuoteKey = (row) => {
  const symbol = normalizeHistoricalYahooSymbol(row?.ativo)
  const date = normalizeDateKey(row?.dataVencimento)
  if (!symbol || !date) return null
  return `${symbol}:${date}`
}

export const fetchHistoricalCloseMap = async (rows) => {
  const { fetchYahooMarketData } = await import('./marketData.js')
  const requests = new Map()
  ;(Array.isArray(rows) ? rows : []).forEach((row) => {
    const quoteKey = buildHistoricalQuoteKey(row)
    if (!quoteKey || requests.has(quoteKey)) return
    const [symbol, date] = quoteKey.split(':')
    if (!symbol || !date) return
    requests.set(quoteKey, { quoteKey, symbol, date })
  })

  if (!requests.size) return {}

  const results = await mapWithConcurrency(
    Array.from(requests.values()),
    HISTORICO_SPOT_CONCURRENCY,
    async (request) => {
      try {
        const market = await fetchYahooMarketData({
          symbol: request.symbol,
          startDate: request.date,
          endDate: request.date,
          provider: 'yahoo',
        })
        const close = toOptionalNumber(market?.close)
        if (close == null) return [request.quoteKey, null]
        return [request.quoteKey, { close, source: String(market?.source || 'yahoo') }]
      } catch {
        return [request.quoteKey, null]
      }
    },
  )

  return results.reduce((acc, [key, value]) => {
    if (value) acc[key] = value
    return acc
  }, {})
}

export const applyHistoricalCloseMap = (rows, closeMap, { reprocessOrigins = [HISTORICO_ORIGIN_LEGACY] } = {}) => {
  const originSet = new Set(reprocessOrigins)
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const normalized = normalizeHistoricalRow(row)
    if (!originSet.has(normalized.origin)) return normalized
    const quoteKey = buildHistoricalQuoteKey(normalized)
    const quote = quoteKey ? closeMap?.[quoteKey] : null
    const spot = toOptionalNumber(quote?.close ?? normalized.spot)
    return recalculateHistoricalWorkbookValues(normalized, spot, {
      spotSource: quote?.source || normalized.spotSource || 'planilha',
    })
  })
}

const normalizeMonthlyBatch = (batchKey, batch) => {
  const monthKey = normalizeHistoricalMonthKey(batch?.monthKey || batchKey)
  const rows = Array.isArray(batch?.rows)
    ? batch.rows.map((row) => normalizeHistoricalRow(row, {
      origin: HISTORICO_ORIGIN_VENCIMENTO,
      batchMonth: monthKey,
      pushedAt: batch?.pushedAt || row?.pushedAt || '',
    }))
    : []
  return {
    monthKey,
    monthLabel: String(batch?.monthLabel || formatHistoricalMonthLabel(monthKey)),
    origin: HISTORICO_ORIGIN_VENCIMENTO,
    pushedAt: String(batch?.pushedAt || '').trim(),
    rows,
  }
}

export const buildEmptyHistoricoState = (userKey = getCurrentUserKey()) => ({
  version: HISTORICO_STATE_VERSION,
  storageKey: resolveHistoricoStorageKey(userKey),
  savedAt: '',
  legacyRows: [],
  monthlyBatches: {},
  importMeta: { ...LEGACY_IMPORT_META },
})

const migrateHistoricoState = (parsed, userKey) => {
  const fallback = buildEmptyHistoricoState(userKey)
  if (!parsed || typeof parsed !== 'object') return fallback

  const importMeta = parsed.importMeta && typeof parsed.importMeta === 'object'
    ? {
      fileName: String(parsed.importMeta.fileName || ''),
      importedAt: String(parsed.importMeta.importedAt || ''),
    }
    : { ...LEGACY_IMPORT_META }

  const monthlyBatches = parsed.monthlyBatches && typeof parsed.monthlyBatches === 'object'
    ? Object.entries(parsed.monthlyBatches).reduce((acc, [monthKey, batch]) => {
      const normalizedBatch = normalizeMonthlyBatch(monthKey, batch)
      if (!normalizedBatch.monthKey) return acc
      acc[normalizedBatch.monthKey] = normalizedBatch
      return acc
    }, {})
    : {}

  const legacyRowsRaw = Array.isArray(parsed.legacyRows)
    ? parsed.legacyRows
    : Array.isArray(parsed.baseRows)
      ? parsed.baseRows.map((row) => (
        row?.dataVencimento || row?.spot != null
          ? normalizeHistoricalRow(row, { origin: HISTORICO_ORIGIN_LEGACY })
          : buildHistoricalRowFromParsedRow(row)
      ))
      : []

  return {
    version: HISTORICO_STATE_VERSION,
    storageKey: fallback.storageKey,
    savedAt: String(parsed.savedAt || ''),
    legacyRows: legacyRowsRaw.map((row) => normalizeHistoricalRow(row, { origin: HISTORICO_ORIGIN_LEGACY })),
    monthlyBatches,
    importMeta,
  }
}

export const resolveHistoricoStorageKey = (userKey = getCurrentUserKey()) => {
  const resolved = String(userKey || 'guest').trim() || 'guest'
  return `${HISTORICO_STATE_PREFIX}.${resolved}`
}

export const loadHistoricoOperacoesState = (userKey = getCurrentUserKey()) => {
  const fallback = buildEmptyHistoricoState(userKey)
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(fallback.storageKey)
    if (!raw) return fallback
    return migrateHistoricoState(JSON.parse(raw), userKey)
  } catch {
    return fallback
  }
}

export const composeHistoricoRows = (state) => {
  const normalizedState = migrateHistoricoState(state, getCurrentUserKey())
  const activeMonths = new Set(Object.keys(normalizedState.monthlyBatches || {}))
  const legacyRows = normalizedState.legacyRows.filter((row) => {
    const monthKey = normalizeHistoricalMonthKey(row?.batchMonth || row?.dataVencimento)
    return monthKey ? !activeMonths.has(monthKey) : true
  })
  const batchRows = Object.values(normalizedState.monthlyBatches || {})
    .flatMap((batch) => Array.isArray(batch?.rows) ? batch.rows : [])
  return [...legacyRows, ...batchRows]
    .map((row) => normalizeHistoricalRow(row))
    .sort((left, right) => {
      const leftDate = normalizeDateKey(left?.dataVencimento) || ''
      const rightDate = normalizeDateKey(right?.dataVencimento) || ''
      if (leftDate !== rightDate) return rightDate.localeCompare(leftDate)
      return String(left?.id || '').localeCompare(String(right?.id || ''), 'pt-BR')
    })
}

export const saveHistoricoOperacoesState = (state, userKey = getCurrentUserKey()) => {
  const normalizedState = migrateHistoricoState(state, userKey)
  const payload = {
    version: HISTORICO_STATE_VERSION,
    savedAt: new Date().toISOString(),
    legacyRows: normalizedState.legacyRows,
    monthlyBatches: normalizedState.monthlyBatches,
    importMeta: normalizedState.importMeta,
  }
  if (typeof window === 'undefined') return migrateHistoricoState(payload, userKey)
  try {
    const storageKey = resolveHistoricoStorageKey(userKey)
    window.localStorage.setItem(storageKey, JSON.stringify(payload))
    window.dispatchEvent(new CustomEvent(HISTORICO_UPDATED_EVENT, {
      detail: { storageKey, savedAt: payload.savedAt },
    }))
  } catch {
    return migrateHistoricoState(payload, userKey)
  }
  return migrateHistoricoState(payload, userKey)
}

export const replaceHistoricoLegacyRows = (rows, importMeta = {}, userKey = getCurrentUserKey()) => {
  const currentState = loadHistoricoOperacoesState(userKey)
  return saveHistoricoOperacoesState({
    ...currentState,
    legacyRows: (Array.isArray(rows) ? rows : []).map((row) => normalizeHistoricalRow(row, {
      origin: HISTORICO_ORIGIN_LEGACY,
    })),
    importMeta: {
      fileName: String(importMeta.fileName || currentState.importMeta.fileName || ''),
      importedAt: String(importMeta.importedAt || currentState.importMeta.importedAt || ''),
    },
  }, userKey)
}

export const upsertHistoricoMonthlyBatch = (batch, userKey = getCurrentUserKey()) => {
  const currentState = loadHistoricoOperacoesState(userKey)
  const normalizedBatch = normalizeMonthlyBatch(batch?.monthKey, batch)
  if (!normalizedBatch.monthKey) return currentState
  return saveHistoricoOperacoesState({
    ...currentState,
    monthlyBatches: {
      ...currentState.monthlyBatches,
      [normalizedBatch.monthKey]: normalizedBatch,
    },
  }, userKey)
}

export const updateHistoricoRow = (rowId, nextRow, userKey = getCurrentUserKey()) => {
  const targetId = String(rowId || '').trim()
  if (!targetId) return null

  const currentState = loadHistoricoOperacoesState(userKey)
  let updatedRow = null

  const legacyRows = currentState.legacyRows.map((row) => {
    const normalized = normalizeHistoricalRow(row, { origin: HISTORICO_ORIGIN_LEGACY })
    if (normalized.id !== targetId) return normalized
    updatedRow = normalizeHistoricalRow(nextRow, {
      id: normalized.id,
      sourceId: normalized.sourceId,
      origin: HISTORICO_ORIGIN_LEGACY,
      batchMonth: normalized.batchMonth,
      sourceSheet: normalized.sourceSheet,
      sourceRow: normalized.sourceRow,
      pushedAt: normalized.pushedAt,
    })
    return updatedRow
  })

  if (updatedRow) {
    const nextState = saveHistoricoOperacoesState({
      ...currentState,
      legacyRows,
    }, userKey)
    return {
      state: nextState,
      row: normalizeHistoricalRow(updatedRow),
    }
  }

  const monthlyBatches = Object.entries(currentState.monthlyBatches || {}).reduce((acc, [monthKey, batch]) => {
    const normalizedBatch = normalizeMonthlyBatch(monthKey, batch)
    const rows = normalizedBatch.rows.map((row) => {
      const normalized = normalizeHistoricalRow(row, {
        origin: HISTORICO_ORIGIN_VENCIMENTO,
        batchMonth: normalizedBatch.monthKey,
        pushedAt: normalizedBatch.pushedAt,
      })
      if (normalized.id !== targetId) return normalized
      updatedRow = normalizeHistoricalRow(nextRow, {
        id: normalized.id,
        sourceId: normalized.sourceId,
        origin: HISTORICO_ORIGIN_VENCIMENTO,
        batchMonth: normalizedBatch.monthKey,
        sourceSheet: normalized.sourceSheet,
        sourceRow: normalized.sourceRow,
        pushedAt: normalizedBatch.pushedAt || normalized.pushedAt,
      })
      return updatedRow
    })
    acc[normalizedBatch.monthKey] = {
      ...normalizedBatch,
      rows,
    }
    return acc
  }, {})

  if (!updatedRow) return null

  const nextState = saveHistoricoOperacoesState({
    ...currentState,
    monthlyBatches,
  }, userKey)
  return {
    state: nextState,
    row: normalizeHistoricalRow(updatedRow),
  }
}

export const buildHistoricoBatchSummary = (state) => {
  const rows = composeHistoricoRows(state)
  const groups = new Map()
  rows.forEach((row) => {
    const monthKey = normalizeHistoricalMonthKey(row?.batchMonth || row?.dataVencimento)
    if (!monthKey) return
    const current = groups.get(monthKey) || {
      id: monthKey,
      monthKey,
      monthLabel: formatHistoricalMonthLabel(monthKey),
      origin: row?.origin === HISTORICO_ORIGIN_VENCIMENTO ? 'Vencimento' : 'Legado',
      rows: 0,
      pushedAt: row?.pushedAt || '',
    }
    current.rows += 1
    if (!current.pushedAt && row?.pushedAt) current.pushedAt = row.pushedAt
    groups.set(monthKey, current)
  })
  return Array.from(groups.values()).sort((left, right) => right.monthKey.localeCompare(left.monthKey))
}

export const subscribeHistoricoOperacoesState = (callback, userKey = getCurrentUserKey()) => {
  if (typeof window === 'undefined' || typeof callback !== 'function') return () => {}
  const storageKey = resolveHistoricoStorageKey(userKey)
  const emit = () => callback(loadHistoricoOperacoesState(userKey))
  const handleCustom = (event) => {
    if (event?.detail?.storageKey !== storageKey) return
    emit()
  }
  const handleStorage = (event) => {
    if (event?.key !== storageKey) return
    emit()
  }
  window.addEventListener(HISTORICO_UPDATED_EVENT, handleCustom)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(HISTORICO_UPDATED_EVENT, handleCustom)
    window.removeEventListener('storage', handleStorage)
  }
}
