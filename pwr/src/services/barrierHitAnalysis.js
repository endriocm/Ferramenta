import { normalizeDateKey } from '../utils/dateKey.js'

const toOptionalNumber = (value) => {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const toLocalDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const getBarrierHitTodayKey = () => toLocalDateKey(new Date())

export const hydrateBarrierHitDateInputs = ({ savedState = null, todayKey = '' } = {}) => {
  const resolvedTodayKey = normalizeDateKey(todayKey) || getBarrierHitTodayKey()
  let reportDate = normalizeDateKey(savedState?.reportDate) || resolvedTodayKey
  const analysisFrom = normalizeDateKey(savedState?.analysisFrom) || ''
  let analysisTo = normalizeDateKey(savedState?.analysisTo) || ''

  let advancedReportDate = false
  let advancedAnalysisTo = false
  let adjustedInvalidRange = false

  if (reportDate && reportDate < resolvedTodayKey) {
    reportDate = resolvedTodayKey
    advancedReportDate = true
  }

  if (analysisTo && analysisTo < resolvedTodayKey) {
    analysisTo = resolvedTodayKey
    advancedAnalysisTo = true
  }

  if (analysisFrom && (!analysisTo || analysisFrom > analysisTo)) {
    analysisTo = analysisFrom
    adjustedInvalidRange = true
  }

  return {
    reportDate,
    analysisFrom,
    analysisTo,
    advancedReportDate,
    advancedAnalysisTo,
    adjustedInvalidRange,
    advancedToToday: advancedReportDate || advancedAnalysisTo,
  }
}

export const normalizeBarrierSeriesDateKey = (row) => {
  const fromDate = normalizeDateKey(row?.date)
  if (fromDate) return fromDate
  const ts = Number(row?.timestamp)
  if (!Number.isFinite(ts)) return ''
  const ms = ts > 9999999999 ? ts : ts * 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

export const buildBarrierSeriesInRange = (series, range) => {
  const rows = []
  ;(Array.isArray(series) ? series : []).forEach((row) => {
    const date = normalizeBarrierSeriesDateKey(row)
    if (!date) return
    if (range?.start && date < range.start) return
    if (range?.end && date > range.end) return
    rows.push({
      date,
      high: toOptionalNumber(row?.high ?? row?.close),
      low: toOptionalNumber(row?.low ?? row?.close),
    })
  })
  rows.sort((left, right) => left.date.localeCompare(right.date))
  return rows
}

export const findHighBarrierHit = (series, barriers) => {
  if (!series.length || !barriers.length) return null
  const minBarrier = barriers[0]

  for (const row of series) {
    const high = toOptionalNumber(row?.high)
    if (high == null || high <= 0 || high < minBarrier) continue
    const matchedBarrier = barriers.find((value) => high >= value) ?? minBarrier
    return { date: row.date, marketValue: high, barrierValue: matchedBarrier }
  }

  return null
}

export const findLowBarrierHit = (series, barriers) => {
  if (!series.length || !barriers.length) return null
  const maxBarrier = barriers[barriers.length - 1]

  for (const row of series) {
    const low = toOptionalNumber(row?.low)
    if (low == null || low <= 0 || low > maxBarrier) continue
    const matchedBarrierCandidates = barriers.filter((value) => low <= value)
    const matchedBarrier = matchedBarrierCandidates.length
      ? matchedBarrierCandidates[matchedBarrierCandidates.length - 1]
      : maxBarrier
    return { date: row.date, marketValue: low, barrierValue: matchedBarrier }
  }

  return null
}
