const STORAGE_KEYS = {
  bovespa: 'pwr.receita.bovespa',
  bmf: 'pwr.receita.bmf',
  manual: 'pwr.receita.manual',
}

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

export const loadRevenueList = (type) => {
  const key = STORAGE_KEYS[normalizeTypeKey(type)]
  if (!key) return []
  return safeParse(localStorage.getItem(key))
}

export const saveRevenueList = (type, entries) => {
  const key = STORAGE_KEYS[normalizeTypeKey(type)]
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(entries || []))
    window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
  } catch {
    // noop
  }
}

export const loadManualRevenue = () => loadRevenueList('manual')

export const appendManualRevenue = (entry) => {
  const current = loadManualRevenue()
  const next = [entry, ...current]
  saveRevenueList('manual', next)
  return next
}

export const removeManualRevenue = (id) => {
  if (!id) return loadManualRevenue()
  const current = loadManualRevenue()
  const next = current.filter((item) => item.id !== id)
  saveRevenueList('manual', next)
  return next
}

export const loadRevenueByType = (type) => {
  const normalized = normalizeTypeKey(type)
  if (normalized === 'estruturadas') return []
  const entries = loadRevenueList(normalized)
  const manual = loadManualRevenue().filter((item) => normalizeTypeKey(item.origem) === normalized)
  return [...entries, ...manual]
}

export const loadAllRevenues = () => {
  const manual = loadManualRevenue()
  return {
    bovespa: loadRevenueList('bovespa'),
    bmf: loadRevenueList('bmf'),
    manual,
  }
}
