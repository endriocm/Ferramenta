import { getHydratedStorageValue, persistLocalStorage, setHydratedStorageValue } from './nativeStorage'
import { normalizeAssessorName } from '../utils/assessor'
import { applyRepasseToRevenueEntries, getRepasseConfigSignature } from './revenueRepasse'

const STORAGE_KEYS = {
  bovespa: 'pwr.receita.bovespa',
  bmf: 'pwr.receita.bmf',
  manual: 'pwr.receita.manual',
}
const rawCache = new Map()

const normalizeTypeKey = (type) => {
  const key = String(type || '').trim().toLowerCase()
  if (key === 'bovespa') return 'bovespa'
  if (key === 'bmf') return 'bmf'
  if (key === 'estruturadas' || key === 'estruturada') return 'estruturadas'
  return key
}

const safeParse = (raw) => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const normalizeRevenueEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return entry
  const current = String(entry.assessor || '').trim()
  const normalized = normalizeAssessorName(current)
  if (normalized === current) return entry
  return {
    ...entry,
    assessor: normalized,
  }
}

const normalizeRevenueEntries = (entries) => {
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => normalizeRevenueEntry(entry))
}

const readStorageEntries = (key) => {
  if (!key) return { raw: '', entries: [] }

  try {
    const rawLocal = localStorage.getItem(key)
    if (rawLocal) {
      return { raw: rawLocal, entries: normalizeRevenueEntries(safeParse(rawLocal)) }
    }
  } catch {
    // noop
  }

  const hydrated = getHydratedStorageValue(key)
  if (Array.isArray(hydrated)) {
    const normalized = normalizeRevenueEntries(hydrated)
    return { raw: JSON.stringify(normalized), entries: normalized }
  }
  if (typeof hydrated === 'string') {
    const normalized = normalizeRevenueEntries(safeParse(hydrated))
    return { raw: JSON.stringify(normalized), entries: normalized }
  }
  return { raw: '', entries: [] }
}

const readCachedEntries = (key, type) => {
  if (!key) return []
  const { raw, entries } = readStorageEntries(key)
  if (!raw) {
    rawCache.delete(key)
    return []
  }
  const repasseSignature = getRepasseConfigSignature(type)
  const cached = rawCache.get(key)
  if (cached?.raw === raw && cached?.repasseSignature === repasseSignature) return cached.entries
  const adjustedEntries = applyRepasseToRevenueEntries(entries, type)
  rawCache.set(key, { raw, repasseSignature, entries: adjustedEntries })
  return adjustedEntries
}

export const loadRevenueList = (type) => {
  const normalizedType = normalizeTypeKey(type)
  const key = STORAGE_KEYS[normalizedType]
  if (!key) return []
  return readCachedEntries(key, normalizedType)
}

export const saveRevenueList = (type, entries) => {
  const normalizedType = normalizeTypeKey(type)
  const key = STORAGE_KEYS[normalizedType]
  if (!key) return
  const normalizedEntries = normalizeRevenueEntries(entries || [])
  const raw = JSON.stringify(normalizedEntries)
  try {
    localStorage.setItem(key, raw)
  } catch {
    // noop
  }
  setHydratedStorageValue(key, normalizedEntries)
  const repasseSignature = getRepasseConfigSignature(normalizedType)
  const adjustedEntries = applyRepasseToRevenueEntries(normalizedEntries, normalizedType)
  rawCache.set(key, { raw, repasseSignature, entries: adjustedEntries })
  window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
  void persistLocalStorage(key, normalizedEntries)
}

const getTodayDateKey = () => {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const isCentralOrdensEntry = (entry) => (
  String(entry?.sourceDetail || '').trim().toLowerCase() === 'central-ordens'
)

// Entradas do Central de Ordens têm validade de um dia.
// Se foram criadas em um dia anterior a hoje, são removidas automaticamente.
const isCentralOrdensExpired = (entry, todayKey) => {
  if (!isCentralOrdensEntry(entry)) return false
  const createdAt = Number(entry?.createdAt)
  if (!Number.isFinite(createdAt) || createdAt <= 0) return true
  const createdDay = new Date(createdAt)
  const yyyy = createdDay.getFullYear()
  const mm = String(createdDay.getMonth() + 1).padStart(2, '0')
  const dd = String(createdDay.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}` !== todayKey
}

export const loadManualRevenue = () => {
  const all = loadRevenueList('manual')
  const todayKey = getTodayDateKey()
  const active = all.filter((entry) => !isCentralOrdensExpired(entry, todayKey))
  if (active.length !== all.length) {
    // Persistir versão limpa sem disparar evento de atualização
    const key = STORAGE_KEYS.manual
    const raw = JSON.stringify(active)
    try { localStorage.setItem(key, raw) } catch { /* noop */ }
    setHydratedStorageValue(key, active)
    rawCache.set(key, { raw, repasseSignature: getRepasseConfigSignature('manual'), entries: active })
    void persistLocalStorage(key, active)
  }
  return active
}

const filterManualRevenueByOrigin = (entries, originType) => {
  const normalizedOrigin = normalizeTypeKey(originType)
  if (!normalizedOrigin) return []
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => normalizeTypeKey(entry?.origem) === normalizedOrigin)
}

export const loadManualRevenueByOrigin = (type) => {
  return filterManualRevenueByOrigin(loadManualRevenue(), type)
}

export const loadRevenueListWithManual = (type) => {
  const normalized = normalizeTypeKey(type)
  if (!normalized) return []
  const base = loadRevenueList(normalized)
  const manual = loadManualRevenueByOrigin(normalized)
  if (!manual.length) return base
  if (!base.length) return manual
  return [...base, ...manual]
}

export const appendManualRevenue = (entry) => {
  const current = loadManualRevenue()
  const next = [entry, ...current]
  saveRevenueList('manual', next)
  return next
}

export const appendManualRevenueBatch = (entries, {
  dedupeByImportKey = true,
  replaceOnImportKey = false,
} = {}) => {
  const current = loadManualRevenue()
  const incoming = Array.isArray(entries)
    ? entries.filter((entry) => entry && typeof entry === 'object')
    : []
  if (!incoming.length) {
    return { entries: current, addedCount: 0, skippedCount: 0, replacedCount: 0 }
  }

  const nextCurrent = [...current]
  const currentImportKeyIndex = new Map()
  if (dedupeByImportKey) {
    nextCurrent.forEach((entry, index) => {
      const importKey = String(entry?.importKey || '').trim()
      if (!importKey || currentImportKeyIndex.has(importKey)) return
      currentImportKeyIndex.set(importKey, index)
    })
  }

  const pendingImportKeyIndex = new Map()

  const toAdd = []
  let skippedCount = 0
  let replacedCount = 0

  incoming.forEach((entry) => {
    const importKey = String(entry?.importKey || '').trim()
    if (dedupeByImportKey && importKey) {
      const existingIndex = currentImportKeyIndex.get(importKey)
      if (Number.isInteger(existingIndex) && existingIndex >= 0) {
        if (replaceOnImportKey) {
          const existing = nextCurrent[existingIndex] || {}
          nextCurrent[existingIndex] = {
            ...existing,
            ...entry,
            id: existing.id || entry.id,
          }
          replacedCount += 1
        } else {
          skippedCount += 1
        }
        return
      }

      const pendingIndex = pendingImportKeyIndex.get(importKey)
      if (Number.isInteger(pendingIndex) && pendingIndex >= 0) {
        if (replaceOnImportKey) {
          toAdd[pendingIndex] = entry
          replacedCount += 1
        } else {
          skippedCount += 1
        }
        return
      }
    }

    if (dedupeByImportKey && importKey) pendingImportKeyIndex.set(importKey, toAdd.length)
    toAdd.push(entry)
  })

  if (!toAdd.length) {
    if (replacedCount > 0) {
      saveRevenueList('manual', nextCurrent)
      return { entries: nextCurrent, addedCount: 0, skippedCount, replacedCount }
    }
    return { entries: current, addedCount: 0, skippedCount, replacedCount: 0 }
  }

  const next = [...toAdd, ...nextCurrent]
  saveRevenueList('manual', next)
  return { entries: next, addedCount: toAdd.length, skippedCount, replacedCount }
}

export const removeManualRevenue = (id) => {
  if (!id) return loadManualRevenue()
  const current = loadManualRevenue()
  const next = current.filter((item) => item.id !== id)
  saveRevenueList('manual', next)
  return next
}

export const bulkDeleteManualRevenue = ({ origem, dateFrom, dateTo } = {}) => {
  const current = loadManualRevenue()
  const normOrigem = origem ? normalizeTypeKey(origem) : ''
  const next = current.filter((item) => {
    const itemOrigem = normalizeTypeKey(item.origem)
    if (normOrigem && itemOrigem !== normOrigem) return true
    const itemDate = String(item.data || item.dataEntrada || '').slice(0, 10)
    if (dateFrom && itemDate < dateFrom) return true
    if (dateTo && itemDate > dateTo) return true
    return false
  })
  saveRevenueList('manual', next)
  return next
}

export const loadRevenueByType = (type) => {
  const normalized = normalizeTypeKey(type)
  if (!normalized) return []
  if (normalized === 'estruturadas') {
    return loadManualRevenueByOrigin(normalized)
  }
  return loadRevenueListWithManual(normalized)
}

export const loadAllRevenues = () => {
  const manual = loadManualRevenue()
  return {
    bovespa: loadRevenueList('bovespa'),
    bmf: loadRevenueList('bmf'),
    manual,
  }
}
