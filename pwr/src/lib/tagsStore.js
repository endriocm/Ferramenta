import { loadTags } from '../services/tags'
import { getCurrentUserKey } from '../services/currentUser'
import { buildTagIndex } from './tagResolver'

let cachedUserKey = ''
let cachedTags = null
let cachedIndex = null
let inFlight = null

const normalizeRow = (row) => {
  if (!row || typeof row !== 'object') return row
  return {
    ...row,
    time: String(row.time || '').trim(),
  }
}

const resetCache = (userKey) => {
  cachedUserKey = userKey || ''
  cachedTags = null
  cachedIndex = null
  inFlight = null
}

export const getAllTags = async () => {
  const userKey = getCurrentUserKey()
  if (cachedUserKey && userKey !== cachedUserKey) resetCache(userKey)
  if (cachedTags) return cachedTags
  if (inFlight) return inFlight
  inFlight = (async () => {
    const payload = await loadTags(userKey)
    const rows = Array.isArray(payload?.rows) ? payload.rows.map(normalizeRow) : []
    cachedTags = rows
    cachedUserKey = userKey
    return cachedTags
  })()
  return inFlight
}

export const getTagIndex = async () => {
  if (cachedIndex) return cachedIndex
  const rows = await getAllTags()
  cachedIndex = buildTagIndex(rows)
  return cachedIndex
}
