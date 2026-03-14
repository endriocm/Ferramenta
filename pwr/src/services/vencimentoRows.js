import { normalizeDateKey } from '../utils/dateKey.js'

export const resolveReferenceDateKey = (referenceDate = new Date()) => {
  if (referenceDate instanceof Date) {
    if (Number.isNaN(referenceDate.getTime())) return ''
    return referenceDate.toISOString().slice(0, 10)
  }
  return normalizeDateKey(referenceDate)
}

export const isOperationExpiredOnDate = (row, referenceDate = new Date()) => {
  const vencimentoKey = normalizeDateKey(row?.vencimento)
  const referenceKey = resolveReferenceDateKey(referenceDate)
  return Boolean(vencimentoKey && referenceKey && vencimentoKey <= referenceKey)
}

export const resolveSettlementTargetDate = (row) => normalizeDateKey(row?.vencimento)

export const annotateSettlementMarket = (row, market, referenceDate = new Date()) => {
  if (!market || typeof market !== 'object') return market
  const settlementTargetDate = resolveSettlementTargetDate(row)
  if (!settlementTargetDate) return market
  return {
    ...market,
    settlementTargetDate,
    settlementSnapshotDate: resolveReferenceDateKey(referenceDate),
  }
}

export const hasSettlementCloseLoaded = (row, market, referenceDate = new Date()) => {
  const settlementTargetDate = resolveSettlementTargetDate(row)
  if (!settlementTargetDate) return false
  const marketTargetDate = normalizeDateKey(market?.settlementTargetDate)
  if (marketTargetDate !== settlementTargetDate) return false

  const referenceKey = resolveReferenceDateKey(referenceDate)
  if (!referenceKey || settlementTargetDate >= referenceKey) return true

  const snapshotKey = normalizeDateKey(market?.settlementSnapshotDate)
  return Boolean(snapshotKey && snapshotKey > settlementTargetDate)
}

export const shouldLoadSettlementClose = (row, market, referenceDate = new Date()) => {
  if (!row?.id || !row?.ativo) return false
  if (!normalizeDateKey(row?.dataRegistro) || !resolveSettlementTargetDate(row)) return false
  if (!isOperationExpiredOnDate(row, referenceDate)) return false
  return !hasSettlementCloseLoaded(row, market, referenceDate)
}

export const mergeRowsPreservingExpired = ({ previousRows = [], nextRows = [], referenceDate = new Date() } = {}) => {
  const merged = []
  const seenIds = new Set()
  const nextList = Array.isArray(nextRows) ? nextRows.filter(Boolean) : []
  const previousList = Array.isArray(previousRows) ? previousRows.filter(Boolean) : []

  nextList.forEach((row) => {
    const rowId = row?.id != null ? String(row.id) : ''
    if (rowId && seenIds.has(rowId)) return
    if (rowId) seenIds.add(rowId)
    merged.push(row)
  })

  previousList.forEach((row) => {
    const rowId = row?.id != null ? String(row.id) : ''
    if (rowId && seenIds.has(rowId)) return
    if (!isOperationExpiredOnDate(row, referenceDate)) return
    if (rowId) seenIds.add(rowId)
    merged.push(row)
  })

  return merged
}
