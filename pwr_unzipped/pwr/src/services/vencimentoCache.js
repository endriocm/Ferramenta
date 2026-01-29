const STORAGE_PREFIX = 'pwr.vencimento.cache.'
const MAX_CACHE_BYTES = 2_000_000
const MAX_CACHE_ROWS = 500

const buildKey = (userKey) => `${STORAGE_PREFIX}${userKey}`

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const serializeWithLimit = (payload) => {
  const raw = JSON.stringify(payload)
  if (raw.length <= MAX_CACHE_BYTES) {
    return { raw, payload }
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : []
  const trimmed = rows.slice(0, MAX_CACHE_ROWS)
  const trimmedPayload = {
    ...payload,
    rows: trimmed,
    truncated: true,
    totalRows: rows.length,
  }
  const trimmedRaw = JSON.stringify(trimmedPayload)
  if (trimmedRaw.length <= MAX_CACHE_BYTES) {
    return { raw: trimmedRaw, payload: trimmedPayload }
  }

  const minimalPayload = {
    ...payload,
    rows: [],
    truncated: true,
    totalRows: rows.length,
    cacheError: 'size-limit',
  }
  return { raw: JSON.stringify(minimalPayload), payload: minimalPayload }
}

export const saveLastImported = (userKey, payload) => {
  if (!userKey || !payload) return null
  const data = {
    version: 1,
    importedAt: payload.importedAt || Date.now(),
    source: payload.source || 'unknown',
    fileName: payload.fileName || null,
    rows: payload.rows || [],
  }
  const { raw, payload: stored } = serializeWithLimit(data)
  try {
    localStorage.setItem(buildKey(userKey), raw)
  } catch {
    return null
  }
  return stored
}

export const loadLastImported = (userKey) => {
  if (!userKey) return null
  let raw = null
  try {
    raw = localStorage.getItem(buildKey(userKey))
  } catch {
    raw = null
  }
  if (!raw) return null
  return safeParse(raw)
}

export const clearLastImported = (userKey) => {
  if (!userKey) return
  try {
    localStorage.removeItem(buildKey(userKey))
  } catch {
    // noop
  }
}
