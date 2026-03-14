import { getHydratedStorageValue, persistLocalStorage, setHydratedStorageValue } from './nativeStorage'
import { buildMonthLabel, getMonthKey } from '../lib/periodTree'
import { normalizeAssessorName } from '../utils/assessor'
import { applyRepasseToStructuredEntries, getRepasseConfigSignature } from './revenueRepasse'

const STORAGE_KEY = 'pwr.receita.estruturadas'
let rawCache = null
let entriesCache = []
let repasseSignatureCache = ''

const normalizeStructuredEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return entry
  const current = String(entry.assessor || '').trim()
  const normalized = normalizeAssessorName(current)
  if (normalized === current) return entry
  return {
    ...entry,
    assessor: normalized,
  }
}

const normalizeStructuredEntries = (entries) => {
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => normalizeStructuredEntry(entry))
}

const readStructuredRaw = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return raw
  } catch {
    // noop
  }
  const hydrated = getHydratedStorageValue(STORAGE_KEY)
  if (Array.isArray(hydrated)) return JSON.stringify(normalizeStructuredEntries(hydrated))
  if (typeof hydrated === 'string') return hydrated
  return ''
}

export const loadStructuredRevenue = () => {
  try {
    const raw = readStructuredRaw()
    if (!raw) return []
    const repasseSignature = getRepasseConfigSignature('estruturadas')
    if (rawCache === raw && repasseSignatureCache === repasseSignature) return entriesCache
    const parsed = JSON.parse(raw)
    const entries = normalizeStructuredEntries(Array.isArray(parsed) ? parsed : [])
    const adjustedEntries = applyRepasseToStructuredEntries(entries)
    rawCache = raw
    repasseSignatureCache = repasseSignature
    entriesCache = adjustedEntries
    return adjustedEntries
  } catch {
    rawCache = null
    repasseSignatureCache = ''
    entriesCache = []
    return []
  }
}

export const saveStructuredRevenue = (entries) => {
  const normalizedEntries = normalizeStructuredEntries(entries || [])
  const raw = JSON.stringify(normalizedEntries)
  try {
    localStorage.setItem(STORAGE_KEY, raw)
  } catch {
    // noop
  }
  setHydratedStorageValue(STORAGE_KEY, normalizedEntries)
  rawCache = raw
  repasseSignatureCache = getRepasseConfigSignature('estruturadas')
  entriesCache = applyRepasseToStructuredEntries(normalizedEntries)
  window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
  void persistLocalStorage(STORAGE_KEY, normalizedEntries)
}

export { buildMonthLabel, getMonthKey }
