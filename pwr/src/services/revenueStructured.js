const STORAGE_KEY = 'pwr.receita.estruturadas'

export const loadStructuredRevenue = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const saveStructuredRevenue = (entries) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries || []))
    window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
  } catch {
    // noop
  }
}

export const buildMonthLabel = (key) => {
  if (!key) return ''
  const [year, month] = String(key).split('-').map(Number)
  if (!year || !month) return key
  const date = new Date(year, month - 1, 1)
  const label = date.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export const getMonthKey = (dateKey) => String(dateKey || '').slice(0, 7)
