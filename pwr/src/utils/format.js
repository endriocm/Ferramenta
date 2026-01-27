const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

const numberFormatter = new Intl.NumberFormat('pt-BR')

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const shortDateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
})

const MAX_CACHE = 2000

const cacheSet = (cache, key, value) => {
  if (cache.size >= MAX_CACHE) {
    cache.clear()
  }
  cache.set(key, value)
  return value
}

const currencyCache = new Map()
const numberCache = new Map()
const dateCache = new Map()
const shortDateCache = new Map()

export const formatCurrency = (value) => {
  const number = Number(value || 0)
  if (currencyCache.has(number)) return currencyCache.get(number)
  return cacheSet(currencyCache, number, currencyFormatter.format(number))
}

export const formatNumber = (value) => {
  const number = Number(value || 0)
  if (numberCache.has(number)) return numberCache.get(number)
  return cacheSet(numberCache, number, numberFormatter.format(number))
}

export const formatDate = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  const time = date.getTime()
  if (Number.isNaN(time)) return '-'
  if (dateCache.has(time)) return dateCache.get(time)
  return cacheSet(dateCache, time, dateFormatter.format(date))
}

export const formatShortDate = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  const time = date.getTime()
  if (Number.isNaN(time)) return '-'
  if (shortDateCache.has(time)) return shortDateCache.get(time)
  return cacheSet(shortDateCache, time, shortDateFormatter.format(date))
}

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
