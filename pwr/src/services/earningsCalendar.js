import { mapWithConcurrency } from '../utils/concurrent'
import { apiFetch } from './apiBase'
import { getCurrentUserKey } from './currentUser'
import { loadLastImported } from './vencimentoCache'

export const DEFAULT_EARNINGS_SYMBOLS = [
  'PETR4',
  'VALE3',
  'ITUB4',
  'BBDC4',
  'ABEV3',
  'NVDC34',
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'META',
  'TSLA',
]

const STORAGE_KEY = 'pwr.earnings.symbols'
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_TRACKED_SYMBOLS = 2000
const MAX_SYMBOLS_PER_REQUEST = 80
const REQUEST_CHUNK_CONCURRENCY = 3
const requestCache = new Map()

/**
 * Module-level snapshot — survives component unmount/remount so the page
 * can render the last known data instantly instead of flashing empty state.
 */
let _lastEarningsSnapshot = null

export const getLastEarningsSnapshot = () => _lastEarningsSnapshot

export const setLastEarningsSnapshot = (snapshot) => {
  _lastEarningsSnapshot = snapshot
}
const AUTO_SYMBOL_KEYS = ['ativo', 'ticker', 'symbol', 'papel', 'underlying', 'ativoObjeto', 'codigoAtivo']
const AUTO_COLLECTION_KEYS = ['rows', 'items', 'entries', 'operations', 'data']

export const normalizeTicker = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return ''
  return raw.replace(/[^A-Z0-9.-]/g, '')
}

export const parseSymbolsInput = (value) => {
  const source = Array.isArray(value) ? value.join(',') : String(value || '')
  return Array.from(new Set(
    source
      .split(/[\s,;|]+/g)
      .map((item) => normalizeTicker(item))
      .filter(Boolean),
  )).slice(0, MAX_TRACKED_SYMBOLS)
}

export const symbolsToInput = (symbols) => {
  return parseSymbolsInput(symbols).join(', ')
}

const readSavedSymbolsFromStorage = () => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...DEFAULT_EARNINGS_SYMBOLS]

    let parsed = []
    if (raw.trim().startsWith('[')) {
      parsed = JSON.parse(raw)
    } else {
      parsed = raw.split(/[,\s;|]+/g)
    }
    const symbols = parseSymbolsInput(parsed)
    return symbols.length ? symbols : [...DEFAULT_EARNINGS_SYMBOLS]
  } catch {
    return [...DEFAULT_EARNINGS_SYMBOLS]
  }
}

const safeParseJson = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const appendTickerFromValue = (bucket, value) => {
  const tokens = parseSymbolsInput(value)
  tokens.forEach((symbol) => bucket.add(symbol))
}

const appendTickersFromRecord = (bucket, record) => {
  if (!record || typeof record !== 'object') return
  AUTO_SYMBOL_KEYS.forEach((key) => appendTickerFromValue(bucket, record[key]))
}

const appendTickersFromArray = (bucket, list) => {
  if (!Array.isArray(list)) return
  list.forEach((item) => appendTickersFromRecord(bucket, item))
}

const collectAutoSymbols = () => {
  if (typeof window === 'undefined') return []
  const userKey = String(getCurrentUserKey() || 'guest').trim() || 'guest'

  const bucket = new Set()

  // Vencimento usa armazenamento chunked — deve ser lido via loadLastImported
  // para reconstituir os chunks corretamente (leitura direta retorna rows: [])
  const vencimentoData = loadLastImported(userKey)
  if (vencimentoData) {
    if (Array.isArray(vencimentoData.rows)) {
      appendTickersFromArray(bucket, vencimentoData.rows)
    }
    AUTO_COLLECTION_KEYS.forEach((collectionKey) => {
      if (collectionKey !== 'rows') {
        appendTickersFromArray(bucket, vencimentoData[collectionKey])
      }
    })
  }

  // Outras fontes: leitura direta (não usam chunking)
  const sourceKeys = [
    `pwr.antecipacao.state.${userKey}`,
    'pwr.receita.estruturadas',
    'pwr.receita.manual',
    'pwr.receita.bovespa',
    'pwr.receita.bmf',
  ]

  sourceKeys.forEach((storageKey) => {
    const payload = safeParseJson(window.localStorage.getItem(storageKey))
    if (!payload) return
    if (Array.isArray(payload)) {
      appendTickersFromArray(bucket, payload)
      return
    }
    appendTickersFromRecord(bucket, payload)
    AUTO_COLLECTION_KEYS.forEach((collectionKey) => appendTickersFromArray(bucket, payload[collectionKey]))
  })

  return parseSymbolsInput(Array.from(bucket))
}

export const getSavedEarningsSymbols = () => readSavedSymbolsFromStorage()

export const getAutoEarningsSymbols = () => collectAutoSymbols()

export const getTrackedEarningsSymbols = () => {
  const saved = readSavedSymbolsFromStorage()
  const automatic = collectAutoSymbols()
  const merged = parseSymbolsInput([...saved, ...automatic])
  return merged.length ? merged : [...DEFAULT_EARNINGS_SYMBOLS]
}

export const setTrackedEarningsSymbols = (symbols) => {
  const normalized = parseSymbolsInput(symbols)
  const safe = normalized.length ? normalized : [...DEFAULT_EARNINGS_SYMBOLS]
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe))
  } catch {
    // noop
  }
  return safe
}

const parseApiError = async (response) => {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const detail = payload?.error || payload?.message || `Falha HTTP ${response.status}`
  const error = new Error(detail)
  error.status = response.status
  error.payload = payload
  return error
}

const toIsoDate = (value) => {
  const dt = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(dt.getTime())) return ''
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const d = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export const getMonthRange = (monthKey) => {
  const [yearPart, monthPart] = String(monthKey || '').split('-')
  const year = Number(yearPart)
  const month = Number(monthPart)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    return { from: toIsoDate(start), to: toIsoDate(end) }
  }
  const start = new Date(year, month - 1, 1)
  const end = new Date(year, month, 0)
  return { from: toIsoDate(start), to: toIsoDate(end) }
}

const startOfWeekSunday = (value) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - date.getDay())
  return date
}

const addDays = (value, days) => {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

export const getWeekRanges = (referenceDate = new Date()) => {
  const currentFromDate = startOfWeekSunday(referenceDate)
  const currentToDate = addDays(currentFromDate, 6)
  const nextFromDate = addDays(currentFromDate, 7)
  const nextToDate = addDays(nextFromDate, 6)

  return {
    current: {
      from: toIsoDate(currentFromDate),
      to: toIsoDate(currentToDate),
    },
    next: {
      from: toIsoDate(nextFromDate),
      to: toIsoDate(nextToDate),
    },
  }
}

export const filterItemsByRange = (items, fromIso, toIso) => {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const date = String(item?.eventDate || '')
    if (!date) return false
    if (fromIso && date < fromIso) return false
    if (toIso && date > toIso) return false
    return true
  })
}

const normalizeRangeBounds = (fromIso, toIso) => {
  const from = String(fromIso || '').trim()
  const to = String(toIso || '').trim()
  if (from && to && from > to) {
    return { from: to, to: from }
  }
  return { from, to }
}

const hasExpectedRevenue = (item) => {
  const revenueAverage = item?.expectations?.revenueAverage
  return revenueAverage != null && Number.isFinite(revenueAverage)
}

const toRangedPayload = (snapshot, symbols, fromIso, toIso) => {
  const { from, to } = normalizeRangeBounds(fromIso, toIso)
  const allItems = (Array.isArray(snapshot?.items) ? snapshot.items : []).filter(hasExpectedRevenue)
  const undated = (Array.isArray(snapshot?.undated) ? snapshot.undated : []).filter(hasExpectedRevenue)
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : []
  const rangedItems = (from || to)
    ? filterItemsByRange(allItems, from, to)
    : [...allItems]

  return {
    generatedAt: String(snapshot?.generatedAt || new Date().toISOString()),
    range: { from: from || null, to: to || null },
    symbols: [...symbols],
    items: rangedItems,
    undated: [...undated],
    errors: [...errors],
    summary: {
      totalSymbols: symbols.length,
      scheduledCount: rangedItems.length,
      undatedCount: undated.length,
      errorCount: errors.length,
    },
    source: String(snapshot?.source || 'yahoo'),
    scrapeInfo: snapshot?.scrapeInfo || null,
  }
}

const chunkArray = (items, chunkSize) => {
  const safe = Array.isArray(items) ? items : []
  const size = Math.max(1, Number(chunkSize) || 1)
  const chunks = []
  for (let index = 0; index < safe.length; index += size) {
    chunks.push(safe.slice(index, index + size))
  }
  return chunks
}

export const fetchEarningsCalendar = async ({
  symbols,
  from = '',
  to = '',
  force = false,
} = {}) => {
  const safeSymbols = parseSymbolsInput(symbols && symbols.length ? symbols : getTrackedEarningsSymbols())
  if (!safeSymbols.length) {
    return {
      generatedAt: new Date().toISOString(),
      range: { from: from || null, to: to || null },
      symbols: [],
      items: [],
      undated: [],
      errors: [],
      summary: { totalSymbols: 0, scheduledCount: 0, undatedCount: 0, errorCount: 0 },
      source: 'yahoo',
    }
  }

  const snapshotKey = [...safeSymbols].sort().join(',')
  const cachedSnapshot = requestCache.get(snapshotKey)
  if (!force && cachedSnapshot && (Date.now() - cachedSnapshot.at) < CACHE_TTL_MS) {
    const result = toRangedPayload(cachedSnapshot.payload, safeSymbols, from, to)
    _lastEarningsSnapshot = result
    return result
  }

  const symbolChunks = chunkArray(safeSymbols, MAX_SYMBOLS_PER_REQUEST)
  const chunkJobs = symbolChunks.map((chunk, index) => ({ chunk, index }))
  const chunkPayloads = await mapWithConcurrency(
    chunkJobs,
    REQUEST_CHUNK_CONCURRENCY,
    async ({ chunk, index }) => {
      const params = new URLSearchParams()
      params.set('symbols', chunk.join(','))
      if (index > 0) params.set('scrape', '0')

      const response = await apiFetch(
        `/api/earnings-calendar?${params.toString()}`,
        {},
        { retries: 2, backoffMs: 500, timeoutMs: 45000 },
      )
      if (!response.ok) throw await parseApiError(response)
      return response.json()
    },
  )

  const merged = {
    generatedAt: new Date().toISOString(),
    range: { from: null, to: null },
    symbols: safeSymbols,
    items: [],
    undated: [],
    errors: [],
    summary: {
      totalSymbols: safeSymbols.length,
      scheduledCount: 0,
      undatedCount: 0,
      errorCount: 0,
    },
    source: 'yahoo',
    scrapeInfo: null,
  }

  chunkPayloads.forEach((payload) => {
    if (!payload || typeof payload !== 'object') return
    if (Array.isArray(payload.items)) merged.items.push(...payload.items)
    if (Array.isArray(payload.undated)) merged.undated.push(...payload.undated)
    if (Array.isArray(payload.errors)) merged.errors.push(...payload.errors)
    if (payload.generatedAt) merged.generatedAt = String(payload.generatedAt)
    if (payload.source) merged.source = String(payload.source)
    if (payload.scrapeInfo) merged.scrapeInfo = payload.scrapeInfo
    if (payload.range?.from || payload.range?.to) {
      merged.range = {
        from: payload.range?.from || merged.range.from,
        to: payload.range?.to || merged.range.to,
      }
    }
  })

  merged.items.sort((left, right) => {
    const leftDate = String(left?.eventDate || '')
    const rightDate = String(right?.eventDate || '')
    if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate)
    if (leftDate && !rightDate) return -1
    if (!leftDate && rightDate) return 1
    return String(left?.displaySymbol || '').localeCompare(String(right?.displaySymbol || ''))
  })
  merged.undated.sort((left, right) => String(left?.displaySymbol || '').localeCompare(String(right?.displaySymbol || '')))
  merged.errors.sort((left, right) => String(left?.displaySymbol || '').localeCompare(String(right?.displaySymbol || '')))

  merged.summary = {
    totalSymbols: safeSymbols.length,
    scheduledCount: merged.items.length,
    undatedCount: merged.undated.length,
    errorCount: merged.errors.length,
  }

  requestCache.set(snapshotKey, { at: Date.now(), payload: merged })
  const result = toRangedPayload(merged, safeSymbols, from, to)
  _lastEarningsSnapshot = result
  return result
}
