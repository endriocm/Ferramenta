const STORAGE_PREFIX = 'pwr.vencimento.cache.'
const MAX_CACHE_BYTES = 2_000_000
const ROW_CHUNK_PREFIX = `${STORAGE_PREFIX}rows.`
const ROW_CHUNK_SIZE = 180_000

// Cache de contagem de chunks por userKey — evita scan O(n) em todo localStorage
const knownChunkCounts = new Map()

const buildKey = (userKey) => `${STORAGE_PREFIX}${userKey}`
const buildRowChunkPrefix = (userKey) => `${ROW_CHUNK_PREFIX}${userKey}.`
const buildRowChunkKey = (userKey, index) => `${buildRowChunkPrefix(userKey)}${index}`

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const safeStorageLength = () => {
  try {
    return localStorage.length
  } catch {
    return 0
  }
}

const safeStorageKey = (index) => {
  try {
    return localStorage.key(index)
  } catch {
    return null
  }
}

const safeStorageSet = (key, value) => {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

const safeStorageRemove = (key) => {
  try {
    localStorage.removeItem(key)
  } catch {
    // noop
  }
}

const safeStorageGet = (key) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const listRowChunkKeys = (userKey) => {
  const cachedCount = knownChunkCounts.get(userKey)
  if (typeof cachedCount === 'number' && cachedCount > 0) {
    return Array.from({ length: cachedCount }, (_, i) => buildRowChunkKey(userKey, i))
  }
  // Fallback: scan único ao localStorage (apenas no cold start ou estado desconhecido)
  const prefix = buildRowChunkPrefix(userKey)
  const keys = []
  const total = safeStorageLength()
  for (let index = 0; index < total; index += 1) {
    const key = safeStorageKey(index)
    if (key && key.startsWith(prefix)) keys.push(key)
  }
  knownChunkCounts.set(userKey, keys.length)
  return keys
}

const clearRowChunks = (userKey) => {
  listRowChunkKeys(userKey).forEach((key) => safeStorageRemove(key))
  knownChunkCounts.delete(userKey)
}

const sortChunkKeys = (keys) => [...keys].sort((left, right) => {
  const leftIndex = Number.parseInt(String(left).split('.').pop() || '0', 10)
  const rightIndex = Number.parseInt(String(right).split('.').pop() || '0', 10)
  if (Number.isNaN(leftIndex) || Number.isNaN(rightIndex)) return left.localeCompare(right, 'pt-BR')
  return leftIndex - rightIndex
})

const chunkString = (input, size) => {
  if (!input) return ['']
  const chunks = []
  for (let index = 0; index < input.length; index += size) {
    chunks.push(input.slice(index, index + size))
  }
  return chunks
}

const readRowsFromChunks = (userKey, chunkCount) => {
  let keys = []
  if (Number.isFinite(chunkCount) && chunkCount > 0) {
    keys = Array.from({ length: chunkCount }, (_, index) => buildRowChunkKey(userKey, index))
  } else {
    keys = sortChunkKeys(listRowChunkKeys(userKey))
  }
  if (!keys.length) return null

  let rawRows = ''
  for (const key of keys) {
    const chunk = safeStorageGet(key)
    if (chunk == null) return null
    rawRows += chunk
  }

  const parsed = safeParse(rawRows)
  return Array.isArray(parsed) ? parsed : null
}

const writeChunkedRows = (userKey, rows) => {
  const rawRows = JSON.stringify(rows)
  const chunks = chunkString(rawRows, ROW_CHUNK_SIZE)

  clearRowChunks(userKey)
  let written = 0
  for (let index = 0; index < chunks.length; index += 1) {
    const ok = safeStorageSet(buildRowChunkKey(userKey, index), chunks[index])
    if (!ok) {
      for (let rollback = 0; rollback < written; rollback += 1) {
        safeStorageRemove(buildRowChunkKey(userKey, rollback))
      }
      return null
    }
    written += 1
  }
  knownChunkCounts.set(userKey, chunks.length)
  return chunks.length
}

const storeMinimalPayload = (userKey, payload, rowsCount) => {
  const minimalPayload = {
    ...payload,
    rows: [],
    truncated: true,
    totalRows: rowsCount,
    cacheError: 'size-limit',
  }
  const ok = safeStorageSet(buildKey(userKey), JSON.stringify(minimalPayload))
  return ok ? minimalPayload : null
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
  const rows = Array.isArray(data.rows) ? data.rows : []
  const raw = JSON.stringify(data)

  if (raw.length <= MAX_CACHE_BYTES && safeStorageSet(buildKey(userKey), raw)) {
    clearRowChunks(userKey)
    return data
  }

  const chunkCount = writeChunkedRows(userKey, rows)
  if (chunkCount && chunkCount > 0) {
    const chunkedPayload = {
      ...data,
      rows: [],
      rowsChunked: true,
      rowsChunkCount: chunkCount,
      totalRows: rows.length,
      truncated: false,
    }
    const ok = safeStorageSet(buildKey(userKey), JSON.stringify(chunkedPayload))
    if (ok) {
      return data
    }
    clearRowChunks(userKey)
  }

  return storeMinimalPayload(userKey, data, rows.length)
}

export const loadLastImported = (userKey) => {
  if (!userKey) return null
  const raw = safeStorageGet(buildKey(userKey))
  if (!raw) return null
  const parsed = safeParse(raw)
  if (!parsed) return null

  if (parsed.rowsChunked) {
    if (typeof parsed.rowsChunkCount === 'number' && parsed.rowsChunkCount > 0) {
      knownChunkCounts.set(userKey, parsed.rowsChunkCount)
    }
    const restoredRows = readRowsFromChunks(userKey, parsed.rowsChunkCount)
    if (restoredRows) {
      return {
        ...parsed,
        rows: restoredRows,
        totalRows: restoredRows.length,
        truncated: false,
      }
    }
    return {
      ...parsed,
      rows: [],
      truncated: true,
      cacheError: parsed.cacheError || 'chunk-read-failed',
    }
  }

  return parsed
}

export const clearLastImported = (userKey) => {
  if (!userKey) return
  safeStorageRemove(buildKey(userKey))
  clearRowChunks(userKey)
}
