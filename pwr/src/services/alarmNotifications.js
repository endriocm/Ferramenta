import { normalizeUserKey } from './currentUser'

const STORAGE_PREFIX = 'pwr.alarm.notifications.'
const MAX_ITEMS = 60

export const ALARM_NOTIFICATION_EVENT = 'pwr:alarm-notifications-updated'
export const RIGHT_TOOL_OPEN_EVENT = 'pwr:right-tool-open'
export const RIGHT_TOOL_ALARMS_ID = 'alarms'

const buildKey = (userKey) => `${STORAGE_PREFIX}${normalizeUserKey(userKey, 'guest')}`

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const normalizeNotification = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const at = String(raw.at || new Date().toISOString()).trim()
  const timestamp = new Date(at).getTime()
  const seq = Number(raw.seq) || (Number.isFinite(timestamp) ? timestamp : Date.now())
  return {
    id: String(raw.id || `alarm-notification-${seq}-${Math.random().toString(36).slice(2, 8)}`),
    type: 'alarm',
    sender: String(raw.sender || 'Alarme').trim() || 'Alarme',
    subject: String(raw.subject || '').trim() || 'Alarme disparado.',
    at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString(),
    seq,
    alarmId: String(raw.alarmId || '').trim(),
    scheduleType: String(raw.scheduleType || '').trim(),
    soundType: String(raw.soundType || '').trim(),
    mode: String(raw.mode || '').trim(),
  }
}

const emitUpdated = (userKey) => {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(ALARM_NOTIFICATION_EVENT, {
      detail: {
        userKey: normalizeUserKey(userKey, 'guest'),
        updatedAt: Date.now(),
      },
    }))
  } catch {
    // noop
  }
}

const loadItems = (userKey) => {
  if (typeof window === 'undefined') return []
  try {
    const parsed = safeParse(window.localStorage.getItem(buildKey(userKey)))
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => normalizeNotification(item))
      .filter(Boolean)
      .sort((left, right) => Number(right.seq || 0) - Number(left.seq || 0))
      .slice(0, MAX_ITEMS)
  } catch {
    return []
  }
}

const saveItems = (userKey, items) => {
  if (typeof window === 'undefined') return []
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => normalizeNotification(item))
    .filter(Boolean)
    .sort((left, right) => Number(right.seq || 0) - Number(left.seq || 0))
    .slice(0, MAX_ITEMS)
  try {
    window.localStorage.setItem(buildKey(userKey), JSON.stringify(normalized))
    emitUpdated(userKey)
  } catch {
    // noop
  }
  return normalized
}

export const listAlarmNotifications = (userKey) => loadItems(userKey)

export const pushAlarmNotification = (userKey, payload) => {
  const nextItem = normalizeNotification(payload)
  if (!nextItem) return null
  const current = loadItems(userKey)
  saveItems(userKey, [nextItem, ...current])
  return nextItem
}

export const clearAlarmNotifications = (userKey) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(buildKey(userKey))
    emitUpdated(userKey)
  } catch {
    // noop
  }
}

export const openRightToolPanel = (toolId) => {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(RIGHT_TOOL_OPEN_EVENT, {
      detail: {
        tool: String(toolId || '').trim(),
      },
    }))
  } catch {
    // noop
  }
}
