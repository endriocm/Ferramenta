import { persistLocalStorage } from './nativeStorage'
import { buildMonthLabel, getMonthKey } from '../lib/periodTree'
import { normalizeAssessorName } from '../utils/assessor'

const STORAGE_KEY = 'pwr.receita.estruturadas'
let rawCache = null
let entriesCache = []

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

export const loadStructuredRevenue = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    if (rawCache === raw) return entriesCache
    const parsed = JSON.parse(raw)
    const entries = normalizeStructuredEntries(Array.isArray(parsed) ? parsed : [])
    rawCache = raw
    entriesCache = entries
    return entries
  } catch {
    rawCache = null
    entriesCache = []
    return []
  }
}

export const saveStructuredRevenue = (entries) => {
  const normalizedEntries = normalizeStructuredEntries(entries || [])
  try {
    const raw = JSON.stringify(normalizedEntries)
    localStorage.setItem(STORAGE_KEY, raw)
    rawCache = raw
    entriesCache = normalizedEntries
    window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
  } catch {
    // noop
  }
  void persistLocalStorage(STORAGE_KEY, normalizedEntries)
}

export { buildMonthLabel, getMonthKey }
