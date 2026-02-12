import { normalizeDateKey as baseNormalizeDateKey } from '../utils/dateKey'

export const normalizeDateKey = baseNormalizeDateKey

export const getMonthKey = (dateKey) => String(dateKey || '').slice(0, 7)

export const buildMonthLabel = (key) => {
  if (!key) return ''
  const [year, month] = String(key).split('-').map(Number)
  if (!year || !month) return key
  const date = new Date(year, month - 1, 1)
  const label = date.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export const buildDateTree = (items = [], getDateValue) => {
  const years = new Map()
  const allValues = new Set()
  const dateGetter = typeof getDateValue === 'function' ? getDateValue : (entry) => entry

  items.forEach((item) => {
    const key = normalizeDateKey(dateGetter(item))
    if (!key) return
    allValues.add(key)
    const [year, month] = key.split('-')
    if (!years.has(year)) years.set(year, new Map())
    const monthMap = years.get(year)
    if (!monthMap.has(month)) monthMap.set(month, new Set())
    monthMap.get(month).add(key)
  })

  const tree = Array.from(years.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, monthMap]) => {
      const months = Array.from(monthMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, daySet]) => {
          const days = Array.from(daySet).sort()
          const children = days.map((key) => ({
            key,
            label: key.split('-')[2],
            value: key,
            values: [key],
          }))
          return {
            key: `${year}-${month}`,
            label: buildMonthLabel(`${year}-${month}`),
            children,
            values: days,
            count: days.length,
          }
        })
      const values = months.flatMap((month) => month.values)
      return {
        key: year,
        label: year,
        children: months,
        values,
        count: values.length,
      }
    })

  return { tree, allValues: Array.from(allValues).sort() }
}
