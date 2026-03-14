const DEFAULT_USER_KEY = 'guest'

const normalizeValue = (value) => {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

const collapseRepeatedPrefix = (value, prefix) => {
  const token = `${prefix}:`
  let next = String(value || '')
  while (next.startsWith(token)) {
    next = next.slice(token.length)
  }
  return next
}

const normalizeKey = (value) => {
  const raw = normalizeValue(value)
  if (!raw) return ''

  const lower = raw.toLowerCase()
  if (lower.startsWith('email:')) {
    const rest = collapseRepeatedPrefix(lower, 'email')
    return rest ? `email:${rest}` : ''
  }
  if (lower.startsWith('id:')) {
    const rest = collapseRepeatedPrefix(lower, 'id')
    return rest ? `id:${rest}` : ''
  }
  if (lower.includes('@')) return `email:${lower}`
  return `id:${lower}`
}

const pickFromObject = (obj) => {
  if (!obj || typeof obj !== 'object') return ''
  return normalizeKey(
    obj.userKey
    || obj.userId
    || obj.id
    || obj.sub
    || obj.email
    || obj.username
    || obj.name,
  )
}

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const resolveUserKey = () => {
  if (typeof window === 'undefined') return DEFAULT_USER_KEY

  const directKey = normalizeKey(window.__PWR_USER_KEY__)
  if (directKey) return directKey

  const fromWindow = pickFromObject(window.__PWR_USER__)
  if (fromWindow) return fromWindow

  const storageKeys = [
    'pwr.userKey',
    'pwr.user',
    'pwr.currentUser',
  ]

  for (const key of storageKeys) {
    const raw = window.localStorage.getItem(key)
    if (!raw) continue
    const parsed = safeParse(raw)
    const candidate = parsed ? pickFromObject(parsed) : normalizeKey(raw)
    if (candidate) return candidate
  }

  return DEFAULT_USER_KEY
}

export const getCurrentUserKey = () => resolveUserKey()

export const normalizeUserKey = (value, fallback = DEFAULT_USER_KEY) => {
  const normalized = normalizeKey(value)
  return normalized || fallback
}

export const invalidateUserKeyCache = () => {
  // no-op: cache removido para evitar chave de usuario stale
}
