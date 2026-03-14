const { normalizeDateKey } = require('./dividends')

const STATUSINVEST_BASE_URL = 'https://statusinvest.com.br'
const STATUSINVEST_CALENDAR_TYPES = [1, 2, 4, 12, 13, 901]
const CACHE_TTL_MS = 15 * 60 * 1000
const FETCH_TIMEOUT_MS = 12000
const FETCH_CONCURRENCY = 4

const cache = new Map()

const pad2 = (value) => String(value).padStart(2, '0')

const getMonthKeyFromDate = (date) => `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`

const getMonthStart = (monthKey) => {
  const [yearRaw, monthRaw] = String(monthKey || '').split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return ''
  return `${year}-${pad2(month)}-01`
}

const getMonthEnd = (monthKey) => {
  const [yearRaw, monthRaw] = String(monthKey || '').split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return ''
  const endDate = new Date(Date.UTC(year, month, 0))
  return `${endDate.getUTCFullYear()}-${pad2(endDate.getUTCMonth() + 1)}-${pad2(endDate.getUTCDate())}`
}

const buildDefaultRange = () => {
  const now = new Date()
  const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const currentKey = getMonthKeyFromDate(current)
  const nextKey = getMonthKeyFromDate(next)
  return {
    from: getMonthStart(currentKey),
    to: getMonthEnd(nextKey),
    monthKeys: [currentKey, nextKey],
  }
}

const buildRange = ({ from, to } = {}) => {
  const safeFrom = normalizeDateKey(from)
  const safeTo = normalizeDateKey(to)
  if (!safeFrom || !safeTo || safeFrom > safeTo) {
    return buildDefaultRange()
  }
  const monthKeys = []
  const cursor = new Date(`${safeFrom}T00:00:00Z`)
  const end = new Date(`${safeTo}T00:00:00Z`)
  cursor.setUTCDate(1)
  let guard = 0
  while (cursor <= end && guard < 24) {
    monthKeys.push(getMonthKeyFromDate(cursor))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    guard += 1
  }
  return {
    from: safeFrom,
    to: safeTo,
    monthKeys,
  }
}

const parseLocaleNumber = (value) => {
  if (value == null || value === '') return NaN
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const raw = String(value).trim()
  if (!raw) return NaN
  const cleaned = raw.replace(/[^\d,.-]/g, '')
  if (!cleaned) return NaN
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    return Number(cleaned.replace(/\./g, '').replace(/,/g, '.'))
  }
  if (hasComma) return Number(cleaned.replace(',', '.'))
  return Number(cleaned)
}

const normalizeProventType = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return 'DIV'
  if (raw.includes('JCP') || raw.includes('JUROS')) return 'JCP'
  return 'DIV'
}

const isLikelyListedAssetTicker = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return false
  if (/^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw)) return true
  if (/^[A-Z]{1,6}$/.test(raw)) return true
  if (/^[A-Z]{1,5}[-.][A-Z]{1,3}$/.test(raw)) return true
  return false
}

const inferMarketByType = (type) => {
  const parsed = Number(type)
  return parsed === 12 || parsed === 13 ? 'US' : 'BR'
}

const toAbsoluteStatusInvestUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw
  if (raw.startsWith('/')) return `${STATUSINVEST_BASE_URL}${raw}`
  return `${STATUSINVEST_BASE_URL}/${raw}`
}

const inRange = (value, from, to) => {
  const key = normalizeDateKey(value)
  if (!key || !from || !to) return false
  return key >= from && key <= to
}

const mapEntryToEvent = ({ entry, from, to, type, monthKey }) => {
  const ticker = String(entry?.code || '').trim().toUpperCase()
  if (!isLikelyListedAssetTicker(ticker)) return null

  const eventDate = normalizeDateKey(entry?.dateCom || entry?.date)
  if (!eventDate || !inRange(eventDate, from, to)) return null

  const paymentDate = normalizeDateKey(entry?.paymentDividend)
  const amount = parseLocaleNumber(entry?.resultAbsoluteValue)
  const normalizedType = normalizeProventType(entry?.typeDesc)
  const valueNet = Number.isFinite(amount)
    ? (normalizedType === 'JCP' ? amount * 0.85 : amount)
    : 0
  const market = inferMarketByType(type)
  const currency = market === 'BR' ? 'BRL' : 'USD'
  const amountValue = Number.isFinite(amount) ? amount : 0
  const typeLabel = String(entry?.typeDesc || '').trim() || normalizedType
  const companyName = String(entry?.companyName || '').trim() || ticker
  const url = toAbsoluteStatusInvestUrl(entry?.url)
  const id = [
    monthKey,
    ticker,
    eventDate,
    paymentDate || '-',
    typeLabel,
    Number(amountValue).toFixed(8),
  ].join('|')

  return {
    id,
    ticker,
    displaySymbol: ticker,
    companyName,
    market,
    currency,
    source: 'statusinvest-calendar',
    type: normalizedType,
    typeRaw: typeLabel,
    eventDate,
    paymentDate,
    amount: amountValue,
    valueNet,
    url,
    categoryType: Number(entry?.categoryType) || null,
  }
}

const dedupeEvents = (items) => {
  const map = new Map()
  ;(Array.isArray(items) ? items : []).forEach((item) => {
    if (!item?.id) return
    if (!map.has(item.id)) {
      map.set(item.id, item)
    }
  })
  return Array.from(map.values())
}

const compareEvents = (left, right) => {
  const leftDate = String(left?.eventDate || '')
  const rightDate = String(right?.eventDate || '')
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)
  return String(left?.displaySymbol || '').localeCompare(String(right?.displaySymbol || ''))
}

const mapWithConcurrency = async (items, limit, mapper) => {
  const safeItems = Array.isArray(items) ? items : []
  if (!safeItems.length) return []
  const safeLimit = Math.max(1, Number(limit) || 1)
  const results = new Array(safeItems.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(safeLimit, safeItems.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= safeItems.length) break
      results[index] = await mapper(safeItems[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

const fetchWithTimeout = async (url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

const fetchStatusInvestMonth = async ({ type, country, year, month }) => {
  const url = new URL('/calendar/getevents', STATUSINVEST_BASE_URL)
  url.searchParams.set('type', String(type))
  url.searchParams.set('country', String(country))
  url.searchParams.set('year', String(year))
  url.searchParams.set('month', String(month))
  url.searchParams.set('companyname', '')
  url.searchParams.set('companyid', '')

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json,text/plain,*/*',
      'X-Requested-With': 'XMLHttpRequest',
    },
  })

  if (!response.ok) {
    const error = new Error(`StatusInvest calendar HTTP ${response.status}`)
    error.status = response.status
    throw error
  }

  const payload = await response.json()
  const root = payload && typeof payload === 'object'
    ? (payload.result && typeof payload.result === 'object' ? payload.result : payload)
    : {}
  const provents = Array.isArray(root?.provents) ? root.provents : []
  return { provents }
}

const buildCacheKey = ({ from, to, country, types }) => {
  const serializedTypes = (Array.isArray(types) ? types : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)
    .join(',')
  return `${from}|${to}|${country}|${serializedTypes}`
}

const getDividendsCalendarSnapshot = async ({
  from,
  to,
  country = 1,
  types = STATUSINVEST_CALENDAR_TYPES,
} = {}) => {
  const range = buildRange({ from, to })
  const safeTypes = (Array.isArray(types) ? types : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  const selectedTypes = safeTypes.length ? safeTypes : [...STATUSINVEST_CALENDAR_TYPES]
  const cacheKey = buildCacheKey({
    from: range.from,
    to: range.to,
    country,
    types: selectedTypes,
  })
  const cached = cache.get(cacheKey)
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.value
  }

  const jobs = []
  range.monthKeys.forEach((monthKey) => {
    const [yearRaw, monthRaw] = monthKey.split('-')
    const year = Number(yearRaw)
    const month = Number(monthRaw)
    if (!Number.isFinite(year) || !Number.isFinite(month)) return
    selectedTypes.forEach((type) => {
      jobs.push({ type, country, year, month, monthKey })
    })
  })

  const errors = []
  const collected = []

  const jobResults = await mapWithConcurrency(jobs, FETCH_CONCURRENCY, async (job) => {
    try {
      const payload = await fetchStatusInvestMonth(job)
      return { ok: true, job, payload }
    } catch (error) {
      return { ok: false, job, error }
    }
  })

  jobResults.forEach((result) => {
    if (!result?.ok) {
      errors.push({
        source: 'statusinvest-calendar',
        marketType: result?.job?.type,
        month: result?.job?.monthKey,
        message: result?.error?.message || 'Falha ao coletar eventos do calendario.',
      })
      return
    }
    const provents = Array.isArray(result?.payload?.provents) ? result.payload.provents : []
    provents.forEach((entry) => {
      const item = mapEntryToEvent({
        entry,
        from: range.from,
        to: range.to,
        type: result.job.type,
        monthKey: result.job.monthKey,
      })
      if (item) collected.push(item)
    })
  })

  const items = dedupeEvents(collected).sort(compareEvents)
  const payload = {
    items,
    undated: [],
    errors,
    summary: {
      from: range.from,
      to: range.to,
      totalMonths: range.monthKeys.length,
      totalTypes: selectedTypes.length,
      scheduledCount: items.length,
      undatedCount: 0,
      errorCount: errors.length,
    },
    generatedAt: new Date().toISOString(),
  }

  cache.set(cacheKey, {
    timestamp: Date.now(),
    value: payload,
  })

  return payload
}

module.exports = {
  STATUSINVEST_CALENDAR_TYPES,
  buildDefaultRange,
  getDividendsCalendarSnapshot,
}

