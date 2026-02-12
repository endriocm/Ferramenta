const profileCache = new Map()
const pendingProfileCache = new Map()

const normalizeTicker = (ticker) => {
  const raw = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '')
  if (!raw) return ''
  return raw.endsWith('.SA') ? raw.slice(0, -3) : raw
}

const pickName = (result = {}) => String(
  result?.longName
  || result?.shortName
  || result?.displayName
  || result?.companyName
  || result?.name
  || '',
).trim()

const pickSummary = (result = {}) => String(
  result?.summaryProfile?.longBusinessSummary
  || result?.summaryProfile?.description
  || result?.summaryProfile?.businessSummary
  || result?.longBusinessSummary
  || result?.summary
  || '',
).trim()

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const mapProfile = (result = {}, symbol) => {
  const summaryProfile = result?.summaryProfile || {}
  return {
    symbol,
    name: pickName(result),
    summary: pickSummary(result),
    sector: String(summaryProfile?.sector || '').trim(),
    industry: String(summaryProfile?.industry || '').trim(),
    website: String(summaryProfile?.website || '').trim(),
    marketCap: toNumber(result?.marketCap),
    priceEarnings: toNumber(result?.priceEarnings),
    earningsPerShare: toNumber(result?.earningsPerShare),
    regularMarketChangePercent: toNumber(result?.regularMarketChangePercent),
    fiftyTwoWeekLow: toNumber(result?.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: toNumber(result?.fiftyTwoWeekHigh),
  }
}

export const fetchCompanyProfile = async (ticker) => {
  const symbol = normalizeTicker(ticker)
  if (!symbol) return null

  if (profileCache.has(symbol)) return profileCache.get(symbol)
  if (pendingProfileCache.has(symbol)) return pendingProfileCache.get(symbol)

  const pending = (async () => {
    try {
      const response = await fetch(
        `https://brapi.dev/api/quote/${encodeURIComponent(symbol)}?modules=summaryProfile,defaultKeyStatistics`,
      )
      if (!response.ok) {
        profileCache.set(symbol, null)
        return null
      }
      const payload = await response.json()
      const result = payload?.results?.[0]
      if (!result) {
        profileCache.set(symbol, null)
        return null
      }
      const mapped = mapProfile(result, symbol)
      profileCache.set(symbol, mapped)
      return mapped
    } catch {
      profileCache.set(symbol, null)
      return null
    } finally {
      pendingProfileCache.delete(symbol)
    }
  })()

  pendingProfileCache.set(symbol, pending)
  return pending
}

