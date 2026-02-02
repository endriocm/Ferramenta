import { normalizeDateKey } from '../utils/dateKey'

export const toMonthKey = (value) => {
  const key = normalizeDateKey(value)
  return key ? key.slice(0, 7) : ''
}

export const formatMonthLabel = (key) => {
  if (!key) return ''
  const [year, month] = String(key).split('-')
  if (!year || !month) return key
  return `${month}/${year.slice(2)}`
}

export const collectMonthsFromEntries = (entries, getDate) => {
  const list = Array.isArray(entries) ? entries : []
  const months = new Set()
  list.forEach((entry) => {
    const dateValue = getDate?.(entry)
    const key = toMonthKey(dateValue)
    if (key) months.add(key)
  })
  return Array.from(months).sort()
}

export const filterByApuracaoMonths = (entries, apuracao, getDate) => {
  const list = Array.isArray(entries) ? entries : []
  if (!apuracao || apuracao.all || !apuracao.months?.length) return list
  const allowed = new Set(apuracao.months)
  return list.filter((entry) => {
    const dateValue = getDate?.(entry)
    const key = toMonthKey(dateValue)
    if (!key) return false
    return allowed.has(key)
  })
}
