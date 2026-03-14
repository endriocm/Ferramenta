import { useEffect, useMemo, useRef, useState } from 'react'

import { formatCurrency, formatNumber } from '../utils/format'

import { normalizeDateKey } from '../utils/dateKey'
import { toNumber } from '../utils/number'

import { loadStructuredRevenue } from '../services/revenueStructured'

import { loadManualRevenue, loadRevenueList } from '../services/revenueStore'
import { getCurrentUserKey } from '../services/currentUser'

import { enrichRow } from '../services/tags'

import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { useToast } from '../hooks/useToast'

import { filterByApuracaoMonths, formatMonthLabel } from '../services/apuracao'
import { exportDashboardPdf } from '../services/dashboardExport'
import { buildEffectiveBmfEntries, buildEffectiveBovespaEntries, buildEffectiveStructuredEntries } from '../services/revenueXpCommission'

const ASSESSOR_RANK_LIMIT = 7

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const DASHBOARD_BROKER_GOALS_STORAGE_PREFIX = 'pwr.dashboard.broker-goals.'
const DASHBOARD_CPF_GOAL_STORAGE_PREFIX = 'pwr.dashboard.cpf-goal.'
const DASHBOARD_GOAL_BLOCKS_STORAGE_PREFIX = 'pwr.dashboard.goal-blocks.'
const DASHBOARD_BROKER_META_ASSESSOR_EXCLUSIONS_STORAGE_PREFIX = 'pwr.dashboard.broker-meta-assessor-exclusions.'
const DASHBOARD_FECHAMENTO_EXCLUDED_BROKERS_STORAGE_PREFIX = 'pwr.dashboard.fechamento-excluded-brokers.'
const DASHBOARD_HEATMAP_EXCLUDED_BROKERS_STORAGE_PREFIX = 'pwr.dashboard.heatmap-excluded-brokers.'
const DASHBOARD_GOAL_BLOCKS_STORAGE_VERSION = 2

const buildDashboardBrokerGoalsKey = (userKey) => `${DASHBOARD_BROKER_GOALS_STORAGE_PREFIX}${userKey || 'guest'}`
const buildDashboardCpfGoalKey = (userKey) => `${DASHBOARD_CPF_GOAL_STORAGE_PREFIX}${userKey || 'guest'}`
const buildDashboardGoalBlocksKey = (userKey) => `${DASHBOARD_GOAL_BLOCKS_STORAGE_PREFIX}${userKey || 'guest'}`
const buildDashboardBrokerMetaAssessorExclusionsKey = (userKey) => `${DASHBOARD_BROKER_META_ASSESSOR_EXCLUSIONS_STORAGE_PREFIX}${userKey || 'guest'}`
const buildDashboardFechamentoExcludedBrokersKey = (userKey) => `${DASHBOARD_FECHAMENTO_EXCLUDED_BROKERS_STORAGE_PREFIX}${userKey || 'guest'}`
const buildDashboardHeatmapExcludedBrokersKey = (userKey) => `${DASHBOARD_HEATMAP_EXCLUDED_BROKERS_STORAGE_PREFIX}${userKey || 'guest'}`

const normalizeLookupKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const findNormalizedObjectKey = (source, lookupValue) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return ''
  const lookupKey = normalizeLookupKey(lookupValue)
  if (!lookupKey) return ''
  return Object.keys(source).find((key) => normalizeLookupKey(key) === lookupKey) || ''
}

const normalizeMonthKey = (value) => {
  const raw = String(value || '').trim()
  return /^\d{4}-\d{2}$/.test(raw) ? raw : ''
}

const buildGoalBlockId = () => `goal-block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const normalizeGoalBlockBrokerGoals = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  Object.entries(value).forEach(([broker, rawValue]) => {
    const brokerName = String(broker || '').trim()
    if (!brokerName) return
    normalized[brokerName] = String(rawValue ?? '').trim()
  })
  return normalized
}
const normalizeGoalBlockExcludedBrokers = (value) => {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ))
}
const normalizeGoalBlockExcludedFromTotalBrokers = (value) => {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ))
}
const applyBrokerExclusionToGoalBlock = (block, brokerNameRaw) => {
  if (!block || typeof block !== 'object') return block
  const brokerName = String(brokerNameRaw || '').trim()
  const brokerLookup = normalizeLookupKey(brokerName)
  if (!brokerLookup) return block
  const excluded = normalizeGoalBlockExcludedBrokers(block?.excludedBrokers)
  if (excluded.some((item) => normalizeLookupKey(item) === brokerLookup)) return block
  return {
    ...block,
    excludedBrokers: [...excluded, brokerName],
  }
}
const createGoalBlock = (
  goalRaw = '',
  brokerGoals = {},
  excludedBrokers = [],
  name = '',
  excludedFromTotalBrokers = [],
) => ({
  id: buildGoalBlockId(),
  name: String(name ?? '').trim(),
  goalRaw: String(goalRaw ?? '').trim(),
  brokerGoals: normalizeGoalBlockBrokerGoals(brokerGoals),
  excludedBrokers: normalizeGoalBlockExcludedBrokers(excludedBrokers),
  excludedFromTotalBrokers: normalizeGoalBlockExcludedFromTotalBrokers(excludedFromTotalBrokers),
})

const buildGoalBlockDraftValue = (block) => ({
  name: String(block?.name || '').trim(),
  goalRaw: String(block?.goalRaw || '').trim(),
  brokerGoals: normalizeGoalBlockBrokerGoals(block?.brokerGoals),
  excludedBrokers: normalizeGoalBlockExcludedBrokers(block?.excludedBrokers),
  excludedFromTotalBrokers: normalizeGoalBlockExcludedFromTotalBrokers(block?.excludedFromTotalBrokers),
})

const buildGoalBlockViewModel = (block, brokers, order) => {
  const goalRaw = String(block?.goalRaw || '').trim()
  const parsed = toNumber(goalRaw)
  const goalDefault = parsed != null && parsed > 0 ? parsed : null
  const brokerGoals = normalizeGoalBlockBrokerGoals(block?.brokerGoals)
  const excludedBrokers = normalizeGoalBlockExcludedBrokers(block?.excludedBrokers)
  const excludedFromTotalBrokers = normalizeGoalBlockExcludedFromTotalBrokers(block?.excludedFromTotalBrokers)
  const excludedSet = new Set(excludedBrokers)
  const excludedFromTotalSet = new Set(excludedFromTotalBrokers)
  const safeBrokers = Array.isArray(brokers) ? brokers : []
  const visibleBrokers = safeBrokers.filter((brokerRow) => !excludedSet.has(brokerRow.broker))
  const availableBrokers = safeBrokers
    .filter((brokerRow) => excludedSet.has(brokerRow.broker))
    .map((brokerRow) => brokerRow.broker)

  const rows = visibleBrokers.map((brokerRow) => {
    const brokerGoalRaw = String(brokerGoals[brokerRow.broker] ?? '').trim()
    const brokerGoalParsed = toNumber(brokerGoalRaw)
    const hasCustomGoal = brokerGoalRaw !== ''
    const customGoal = brokerGoalParsed != null && brokerGoalParsed > 0 ? brokerGoalParsed : null
    const goalValue = customGoal != null ? customGoal : goalDefault
    const receitaMeta = Number(brokerRow?.receitaMeta ?? brokerRow?.receita ?? 0)
    const receitaAbsoluta = Number(brokerRow?.receitaAbsoluta ?? brokerRow?.receita ?? 0)
    const gap = goalValue != null ? goalValue - receitaMeta : null
    const gapAbs = goalValue != null ? Math.abs(gap) : null
    const reached = goalValue != null ? gap <= 0 : false
    const progress = goalValue != null ? clamp((receitaMeta / goalValue) * 100, 0, 9999) : null
    return {
      ...brokerRow,
      receita: receitaMeta,
      receitaMeta,
      receitaAbsoluta,
      goalRawInput: hasCustomGoal ? brokerGoalRaw : goalRaw,
      hasCustomGoal,
      goalValue,
      countsInTotal: !excludedFromTotalSet.has(brokerRow.broker),
      gap,
      gapAbs,
      reached,
      progress,
    }
  })

  const rowsInTotal = rows.filter((row) => row.countsInTotal)
  const totalRevenue = rowsInTotal.reduce((sum, row) => sum + (Number(row.receitaMeta) || 0), 0)
  const totalRevenueAbsolute = rowsInTotal.reduce((sum, row) => sum + (Number(row.receitaAbsoluta) || 0), 0)
  const totalTargetRaw = rowsInTotal.reduce((sum, row) => (
    sum + (row.goalValue != null && row.goalValue > 0 ? row.goalValue : 0)
  ), 0)
  const totalTarget = totalTargetRaw > 0 ? totalTargetRaw : null
  const hasTarget = totalTarget != null && totalTarget > 0
  const gap = hasTarget ? totalTarget - totalRevenue : null
  const gapAbs = hasTarget ? Math.abs(gap) : null
  const reached = hasTarget ? gap <= 0 : false
  const progress = hasTarget ? clamp((totalRevenue / totalTarget) * 100, 0, 9999) : null

  return {
    id: String(block?.id || `goal-block-${order || 1}`),
    order: Number(order) || 1,
    name: String(block?.name || '').trim(),
    goalRaw,
    goalDefault,
    brokerGoals,
    excludedBrokers,
    excludedFromTotalBrokers,
    availableBrokers,
    rows,
    totals: {
      totalRevenue,
      totalRevenueAbsolute,
      totalTarget,
      hasTarget,
      gap,
      gapAbs,
      reached,
      progress,
    },
  }
}

const normalizeGoalBlocks = (value) => {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const id = String(item.id || '').trim() || buildGoalBlockId()
      return {
        id,
        name: String(item.name ?? item.title ?? '').trim(),
        goalRaw: String(item.goalRaw ?? item.goal ?? '').trim(),
        brokerGoals: normalizeGoalBlockBrokerGoals(item.brokerGoals),
        excludedBrokers: normalizeGoalBlockExcludedBrokers(item.excludedBrokers),
        excludedFromTotalBrokers: normalizeGoalBlockExcludedFromTotalBrokers(item.excludedFromTotalBrokers),
      }
    })
    .filter(Boolean)
}

const normalizeGoalBlocksByMonth = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  Object.entries(value).forEach(([monthKeyRaw, blocksRaw]) => {
    const monthKey = normalizeMonthKey(monthKeyRaw)
    if (!monthKey) return
    const blocks = normalizeGoalBlocks(blocksRaw)
    if (blocks.length) normalized[monthKey] = blocks
  })
  return normalized
}

const createDashboardGoalBlocksStore = (months = {}) => ({
  version: DASHBOARD_GOAL_BLOCKS_STORAGE_VERSION,
  months: normalizeGoalBlocksByMonth(months),
})

const loadDashboardBrokerGoals = (userKey) => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(buildDashboardBrokerGoalsKey(userKey))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const normalized = {}
    Object.entries(parsed).forEach(([broker, rawValue]) => {
      const brokerName = String(broker || '').trim()
      if (!brokerName) return
      normalized[brokerName] = String(rawValue ?? '').trim()
    })
    return normalized
  } catch {
    return {}
  }
}

const loadDashboardGoalBlocksStore = (userKey) => {
  if (typeof window === 'undefined') return createDashboardGoalBlocksStore()
  try {
    const raw = localStorage.getItem(buildDashboardGoalBlocksKey(userKey))
    const parsed = raw ? JSON.parse(raw) : null

    if (Array.isArray(parsed)) {
      const legacyBlocks = normalizeGoalBlocks(parsed)
      if (legacyBlocks.length) {
        return createDashboardGoalBlocksStore({
          [buildCurrentMonthKey()]: legacyBlocks,
        })
      }
    }

    if (parsed && typeof parsed === 'object') {
      const months = normalizeGoalBlocksByMonth(parsed.months)
      if (Object.keys(months).length) {
        return createDashboardGoalBlocksStore(months)
      }

      const legacyBlocks = normalizeGoalBlocks(parsed.blocks || parsed.goalBlocks)
      if (legacyBlocks.length) {
        return createDashboardGoalBlocksStore({
          [buildCurrentMonthKey()]: legacyBlocks,
        })
      }
    }
  } catch {
    // noop
  }

  const legacyGoals = loadDashboardBrokerGoals(userKey)
  const uniqueLegacyValues = Array.from(new Set(
    Object.values(legacyGoals || {})
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ))
  if (uniqueLegacyValues.length) {
    return createDashboardGoalBlocksStore({
      [buildCurrentMonthKey()]: uniqueLegacyValues.map((value) => createGoalBlock(value)),
    })
  }

  return createDashboardGoalBlocksStore()
}

const loadDashboardGoalBlocks = (userKey, monthKey) => {
  const resolvedMonthKey = normalizeMonthKey(monthKey) || buildCurrentMonthKey()
  const store = loadDashboardGoalBlocksStore(userKey)
  const monthBlocks = normalizeGoalBlocks(store?.months?.[resolvedMonthKey])
  return monthBlocks.length ? monthBlocks : [createGoalBlock('')]
}

const saveDashboardGoalBlocks = (userKey, monthKey, blocks) => {
  if (typeof window === 'undefined') return
  try {
    const resolvedMonthKey = normalizeMonthKey(monthKey) || buildCurrentMonthKey()
    const normalizedBlocks = normalizeGoalBlocks(blocks)
    const currentStore = loadDashboardGoalBlocksStore(userKey)
    const nextMonths = {
      ...normalizeGoalBlocksByMonth(currentStore?.months),
      [resolvedMonthKey]: normalizedBlocks,
    }
    localStorage.setItem(
      buildDashboardGoalBlocksKey(userKey),
      JSON.stringify(createDashboardGoalBlocksStore(nextMonths)),
    )
  } catch {
    // noop
  }
}

const resolveGoalBlockMonthKey = (apuracaoMonths) => {
  if (apuracaoMonths?.all === false) {
    const selectedMonths = Array.isArray(apuracaoMonths?.months)
      ? apuracaoMonths.months.map(normalizeMonthKey).filter(Boolean)
      : []
    if (selectedMonths.length === 1) return selectedMonths[0]
  }
  return buildCurrentMonthKey()
}

const buildGoalMonthOptions = (userKey) => {
  const now = new Date()
  const months = new Set()
  for (let i = 0; i < 13; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  try {
    const store = loadDashboardGoalBlocksStore(userKey)
    Object.keys(store?.months || {}).forEach((key) => months.add(key))
  } catch { /* noop */ }
  return Array.from(months).sort((a, b) => b.localeCompare(a)).map((key) => ({ value: key, label: formatMonthLabel(key) }))
}

const normalizeBrokerMetaAssessorExclusions = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  Object.entries(value).forEach(([brokerRaw, assessorsRaw]) => {
    const brokerName = String(brokerRaw || '').trim()
    if (!brokerName) return
    const brokerKey = normalizeLookupKey(brokerName)
    if (!brokerKey) return
    const targetBroker = Object.keys(normalized).find((key) => normalizeLookupKey(key) === brokerKey) || brokerName
    const current = Array.isArray(normalized[targetBroker]) ? [...normalized[targetBroker]] : []
    const sourceList = Array.isArray(assessorsRaw) ? assessorsRaw : [assessorsRaw]
    const seenAssessors = new Set(current.map((item) => normalizeLookupKey(item)).filter(Boolean))
    sourceList.forEach((item) => {
      const assessorName = String(item || '').trim()
      if (!assessorName) return
      const assessorKey = normalizeLookupKey(assessorName)
      if (!assessorKey || seenAssessors.has(assessorKey)) return
      seenAssessors.add(assessorKey)
      current.push(assessorName)
    })
    if (current.length) normalized[targetBroker] = current
  })
  return normalized
}

const loadDashboardBrokerMetaAssessorExclusions = (userKey) => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(buildDashboardBrokerMetaAssessorExclusionsKey(userKey))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return normalizeBrokerMetaAssessorExclusions(parsed)
  } catch {
    return {}
  }
}

const saveDashboardBrokerMetaAssessorExclusions = (userKey, value) => {
  if (typeof window === 'undefined') return
  try {
    const normalized = normalizeBrokerMetaAssessorExclusions(value)
    localStorage.setItem(buildDashboardBrokerMetaAssessorExclusionsKey(userKey), JSON.stringify(normalized))
  } catch {
    // noop
  }
}

const loadDashboardCpfGoal = (userKey) => {
  if (typeof window === 'undefined') return ''
  try {
    const raw = localStorage.getItem(buildDashboardCpfGoalKey(userKey))
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      return String(parsed?.goal ?? '').trim()
    }
    return String(parsed ?? '').trim()
  } catch {
    return ''
  }
}

const saveDashboardCpfGoal = (userKey, rawValue) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(buildDashboardCpfGoalKey(userKey), JSON.stringify({ goal: String(rawValue ?? '').trim() }))
  } catch {
    // noop
  }
}

const loadDashboardExcludedBrokersList = (storageKeyFn, userKey) => {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(storageKeyFn(userKey))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

const saveDashboardExcludedBrokersList = (storageKeyFn, userKey, list) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(storageKeyFn(userKey), JSON.stringify(Array.from(list)))
  } catch {
    // noop
  }
}

let compactCurrencyFormatter = null

try {

  compactCurrencyFormatter = new Intl.NumberFormat('pt-BR', {

    style: 'currency',

    currency: 'BRL',

    notation: 'compact',

    maximumFractionDigits: 1,

  })

} catch {

  compactCurrencyFormatter = null

}

const formatCurrencyCompact = (value) => {

  const safeValue = Number.isFinite(value) ? value : 0

  if (compactCurrencyFormatter) {

    return compactCurrencyFormatter.format(safeValue)

  }

  const abs = Math.abs(safeValue)

  if (abs < 1000) return formatCurrency(safeValue)

  const sign = safeValue < 0 ? '-' : ''

  if (abs >= 1000000000) return `${sign}R$ ${(abs / 1000000000).toFixed(1)}B`

  if (abs >= 1000000) return `${sign}R$ ${(abs / 1000000).toFixed(1)}M`

  return `${sign}R$ ${(abs / 1000).toFixed(1)}k`

}

const interpolateValue = (start, end, ratio) => start + ((end - start) * ratio)

const interpolateHeatmapTone = (from, to, ratioRaw) => {
  const ratio = clamp(ratioRaw, 0, 1)
  return {
    hue: interpolateValue(from.hue, to.hue, ratio),
    saturation: interpolateValue(from.saturation, to.saturation, ratio),
    lightness: interpolateValue(from.lightness, to.lightness, ratio),
    alpha: interpolateValue(from.alpha, to.alpha, ratio),
  }
}

const formatHeatmapTone = (tone) => (
  `hsla(${tone.hue.toFixed(1)}, ${tone.saturation.toFixed(1)}%, ${tone.lightness.toFixed(1)}%, ${tone.alpha.toFixed(2)})`
)

const HEATMAP_TONE_LOW = { hue: 4, saturation: 82, lightness: 43, alpha: 0.3 }
const HEATMAP_TONE_MID = { hue: 48, saturation: 90, lightness: 54, alpha: 0.6 }
const HEATMAP_TONE_GOOD = { hue: 130, saturation: 60, lightness: 36, alpha: 0.72 }
const HEATMAP_TONE_BEST = { hue: 144, saturation: 78, lightness: 28, alpha: 0.92 }

const buildChartScale = (values, tickCount = 5) => {

  const safeValues = values.filter((value) => Number.isFinite(value))

  const domainMin = safeValues.length ? Math.min(0, ...safeValues) : 0

  const domainMax = safeValues.length ? Math.max(0, ...safeValues) : 0

  const range = domainMax - domainMin || 1

  const normalizedTickCount = Math.max(tickCount, 4)

  const ticks = Array.from({ length: normalizedTickCount }, (_, index) => {

    const ratio = normalizedTickCount === 1 ? 0 : index / (normalizedTickCount - 1)

    return {

      value: domainMin + ratio * range,

      percent: ratio * 100,

    }

  })

  return { domainMin, domainMax, range, ticks }

}

const normalizeSeries = (values, scale) =>

  values.map((value) => {

    const safeValue = Number.isFinite(value) ? value : 0

    const percent = ((safeValue - scale.domainMin) / scale.range) * 100

    return clamp(percent, 0, 100)

  })

const getEntryDateKey = (entry) => {

  const key = normalizeDateKey(entry?.dataEntrada || entry?.data || entry?.vencimento)

  return key || ''

}

const resolveLatestDateKey = (entries) => {
  let latest = ''
  ;(Array.isArray(entries) ? entries : []).forEach((entry) => {
    const key = getEntryDateKey(entry)
    if (key && key > latest) latest = key
  })
  return latest || ''
}

const formatDateKeyPtBr = (value) => {
  const key = String(value || '').trim()
  if (!key) return '-'
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return key
  return `${match[3]}/${match[2]}/${match[1]}`
}

const formatPercentLabel = (value) => {
  const safeValue = Number(value)
  if (!Number.isFinite(safeValue)) return '-'
  return `${safeValue.toFixed(1).replace('.', ',')}%`
}

const getEntryValue = (entry) => {

  const value = entry?.receita ?? entry?.comissao ?? entry?.valor ?? entry?.value

  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : 0

}

const isEntryExcludedFromBrokerMeta = (entry, brokerMetaLookup) => {
  if (!(brokerMetaLookup instanceof Map) || !brokerMetaLookup.size) return false
  const broker = String(entry?.broker || '').trim() || 'Sem broker'
  const brokerKey = normalizeLookupKey(broker)
  if (!brokerKey) return false
  const excludedAssessors = brokerMetaLookup.get(brokerKey)
  if (!excludedAssessors?.size) return false
  const assessorKey = normalizeLookupKey(entry?.assessor)
  return Boolean(assessorKey && excludedAssessors.has(assessorKey))
}

const getMetaAdjustedEntryValue = (entry, brokerMetaLookup) => (
  isEntryExcludedFromBrokerMeta(entry, brokerMetaLookup) ? 0 : getEntryValue(entry)
)

const buildCurrentMonthKey = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

const parseMonthKey = (monthKey) => {
  const [yearRaw, monthRaw] = String(monthKey || '').split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null
  return { year, month }
}

const countBusinessDaysBetween = (startDate, endDate) => {
  if (!(startDate instanceof Date) || !(endDate instanceof Date)) return 0
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0
  if (startDate > endDate) return 0
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
  let count = 0
  while (cursor <= end) {
    const day = cursor.getDay()
    if (day !== 0 && day !== 6) count += 1
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

const countBusinessDaysInMonth = (monthKey) => {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return 0
  const start = new Date(parsed.year, parsed.month - 1, 1)
  const end = new Date(parsed.year, parsed.month, 0)
  return countBusinessDaysBetween(start, end)
}

const countBusinessDaysRemainingInMonth = (monthKey, referenceDate = new Date()) => {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return 0
  const now = referenceDate instanceof Date ? referenceDate : new Date()
  const currentMonthKey = buildCurrentMonthKey()
  if (monthKey < currentMonthKey) return 0
  if (monthKey > currentMonthKey) return countBusinessDaysInMonth(monthKey)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(parsed.year, parsed.month, 0)
  return countBusinessDaysBetween(start, end)
}

const normalizeKey = (value) => normalizeLookupKey(value)

const aggregateByKey = (entries, keyFn, valueFn = getEntryValue) => {

  const map = new Map()

  entries.forEach((entry) => {

    const key = keyFn(entry)

    if (!key) return

    const value = Number(valueFn(entry))

    if (!Number.isFinite(value) || value === 0) return

    map.set(key, (map.get(key) || 0) + value)

  })

  return map

}

const collectUniqueClients = (entries) => {

  const set = new Set()

  entries.forEach((entry) => {

    const code = entry?.codigoCliente ?? entry?.cliente ?? entry?.codigo ?? ''

    const normalized = String(code || '').trim()

    if (normalized) set.add(normalized)

  })

  return set

}

const normalizeOriginKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const buildDashboardRevenueSnapshot = () => {
  const manualEntries = loadManualRevenue()
  const manualBovespa = manualEntries.filter((entry) => normalizeOriginKey(entry?.origem) === 'bovespa')
  const manualBmf = manualEntries.filter((entry) => normalizeOriginKey(entry?.origem) === 'bmf')
  const manualStructured = manualEntries.filter((entry) => {
    const origin = normalizeOriginKey(entry?.origem)
    return origin === 'estruturadas' || origin === 'estruturada'
  })

  return {
    structured: buildEffectiveStructuredEntries([...loadStructuredRevenue(), ...manualStructured]),
    bovespa: buildEffectiveBovespaEntries([...loadRevenueList('bovespa'), ...manualBovespa]),
    bmf: buildEffectiveBmfEntries([...loadRevenueList('bmf'), ...manualBmf]),
  }
}

const Dashboard = () => {

  const { tagsIndex, selectedBroker, selectedAssessor, apuracaoMonths } = useGlobalFilters()
  const { notify } = useToast()

  const [granularity, setGranularity] = useState('monthly')

  const [originFilter, setOriginFilter] = useState('all')

  const [activeIndex, setActiveIndex] = useState(null)

  const [isExportingPdf, setIsExportingPdf] = useState(false)

  const [tooltip, setTooltip] = useState({ open: false, index: null, x: 0, y: 0, flip: false })

  const chartRef = useRef(null)
  const overviewExportRef = useRef(null)
  const goalsExportRef = useRef(null)
  const userKey = useMemo(() => getCurrentUserKey(), [])
  const [goalBlocksManualMonthKey, setGoalBlocksManualMonthKey] = useState(() => buildCurrentMonthKey())
  const goalMonthKey = goalBlocksManualMonthKey || buildCurrentMonthKey()
  const goalMonthLabel = useMemo(() => formatMonthLabel(goalMonthKey), [goalMonthKey])
  const isSingleGoalMonthSelected = true
  const [goalBlocks, setGoalBlocks] = useState(() => loadDashboardGoalBlocks(userKey, goalMonthKey))
  const [loadedGoalMonthKey, setLoadedGoalMonthKey] = useState(goalMonthKey)
  const [cpfGoalInput, setCpfGoalInput] = useState(() => loadDashboardCpfGoal(userKey))
  const [newGoalBlockInput, setNewGoalBlockInput] = useState('')
  const [goalBlockEditing, setGoalBlockEditing] = useState({})
  const [goalBlockDraft, setGoalBlockDraft] = useState({})
  const [goalBrokerIncludeDraft, setGoalBrokerIncludeDraft] = useState({})
  const [brokerMetaAssessorExclusions, setBrokerMetaAssessorExclusions] = useState(
    () => loadDashboardBrokerMetaAssessorExclusions(userKey),
  )
  const [brokerMetaAssessorDraft, setBrokerMetaAssessorDraft] = useState({})
  const [fechamentoExcludedBrokers, setFechamentoExcludedBrokers] = useState(
    () => new Set(loadDashboardExcludedBrokersList(buildDashboardFechamentoExcludedBrokersKey, userKey)),
  )
  const [heatmapExcludedBrokers, setHeatmapExcludedBrokers] = useState(
    () => new Set(loadDashboardExcludedBrokersList(buildDashboardHeatmapExcludedBrokersKey, userKey)),
  )

  const [revenueSnapshot, setRevenueSnapshot] = useState(() => buildDashboardRevenueSnapshot())

  useEffect(() => {
    const refreshSnapshot = () => setRevenueSnapshot(buildDashboardRevenueSnapshot())
    window.addEventListener('pwr:receita-updated', refreshSnapshot)
    window.addEventListener('pwr:repasse-updated', refreshSnapshot)
    return () => {
      window.removeEventListener('pwr:receita-updated', refreshSnapshot)
      window.removeEventListener('pwr:repasse-updated', refreshSnapshot)
    }
  }, [])

  useEffect(() => {
    setGoalBlocks(loadDashboardGoalBlocks(userKey, goalMonthKey))
    setLoadedGoalMonthKey(goalMonthKey)
    setNewGoalBlockInput('')
    setGoalBlockEditing({})
    setGoalBlockDraft({})
    setGoalBrokerIncludeDraft({})
  }, [goalMonthKey, userKey])

  useEffect(() => {
    if (loadedGoalMonthKey !== goalMonthKey) return
    saveDashboardGoalBlocks(userKey, goalMonthKey, goalBlocks)
  }, [goalBlocks, goalMonthKey, loadedGoalMonthKey, userKey])

  useEffect(() => {
    saveDashboardCpfGoal(userKey, cpfGoalInput)
  }, [cpfGoalInput, userKey])

  useEffect(() => {
    saveDashboardBrokerMetaAssessorExclusions(userKey, brokerMetaAssessorExclusions)
  }, [brokerMetaAssessorExclusions, userKey])

  useEffect(() => {
    saveDashboardExcludedBrokersList(buildDashboardFechamentoExcludedBrokersKey, userKey, fechamentoExcludedBrokers)
  }, [fechamentoExcludedBrokers, userKey])

  useEffect(() => {
    saveDashboardExcludedBrokersList(buildDashboardHeatmapExcludedBrokersKey, userKey, heatmapExcludedBrokers)
  }, [heatmapExcludedBrokers, userKey])

  const structuredEntries = revenueSnapshot.structured || []

  const bovespaEntries = revenueSnapshot.bovespa || []

  const bmfEntries = revenueSnapshot.bmf || []

  const bovespaVariavel = useMemo(

    () => bovespaEntries.filter((entry) => normalizeKey(entry?.tipoCorretagem) === 'variavel'),

    [bovespaEntries],

  )

  const bmfVariavel = useMemo(

    () => bmfEntries.filter((entry) => normalizeKey(entry?.tipoCorretagem) === 'variavel'),

    [bmfEntries],

  )

  const latestOperationByLine = useMemo(() => ({
    bovespa: formatDateKeyPtBr(resolveLatestDateKey(bovespaVariavel)),
    bmf: formatDateKeyPtBr(resolveLatestDateKey(bmfVariavel)),
    estruturadas: formatDateKeyPtBr(resolveLatestDateKey(structuredEntries)),
  }), [bovespaVariavel, bmfVariavel, structuredEntries])

  const structuredScoped = useMemo(

    () => filterByApuracaoMonths(structuredEntries, apuracaoMonths, (entry) => entry.dataEntrada || entry.data),

    [structuredEntries, apuracaoMonths],

  )

  const bovespaScoped = useMemo(

    () => filterByApuracaoMonths(bovespaVariavel, apuracaoMonths, (entry) => entry.data || entry.dataEntrada),

    [bovespaVariavel, apuracaoMonths],

  )

  const bmfScoped = useMemo(

    () => filterByApuracaoMonths(bmfVariavel, apuracaoMonths, (entry) => entry.data || entry.dataEntrada),

    [bmfVariavel, apuracaoMonths],

  )

  const structuredEnriched = useMemo(

    () => structuredScoped.map((entry) => enrichRow(entry, tagsIndex)),

    [structuredScoped, tagsIndex],

  )

  const bovespaEnriched = useMemo(

    () => bovespaScoped.map((entry) => enrichRow(entry, tagsIndex)),

    [bovespaScoped, tagsIndex],

  )

  const bmfEnriched = useMemo(

    () => bmfScoped.map((entry) => enrichRow(entry, tagsIndex)),

    [bmfScoped, tagsIndex],

  )

  const normalizedAssessorFilter = useMemo(() => {
    const values = selectedAssessor.map(normalizeKey).filter(Boolean)
    return values.length ? new Set(values) : null
  }, [selectedAssessor])

  const structuredFiltered = useMemo(() => {
    return structuredEnriched.filter((entry) => {
      if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
      if (normalizedAssessorFilter?.size) {
        const assessorKey = normalizeKey(entry?.assessor)
        if (!normalizedAssessorFilter.has(assessorKey)) return false
      }
      return true
    })
  }, [structuredEnriched, selectedBroker, normalizedAssessorFilter])

  const bovespaFiltered = useMemo(() => {
    return bovespaEnriched.filter((entry) => {
      if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
      if (normalizedAssessorFilter?.size) {
        const assessorKey = normalizeKey(entry?.assessor)
        if (!normalizedAssessorFilter.has(assessorKey)) return false
      }
      return true
    })
  }, [bovespaEnriched, selectedBroker, normalizedAssessorFilter])

  const bmfFiltered = useMemo(() => {
    return bmfEnriched.filter((entry) => {
      if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
      if (normalizedAssessorFilter?.size) {
        const assessorKey = normalizeKey(entry?.assessor)
        if (!normalizedAssessorFilter.has(assessorKey)) return false
      }
      return true
    })
  }, [bmfEnriched, selectedBroker, normalizedAssessorFilter])

  const includeStructured = originFilter === 'all' || originFilter === 'estruturadas'

  const includeBovespa = originFilter === 'all' || originFilter === 'bovespa'

  const includeBmf = originFilter === 'all' || originFilter === 'bmf'

  const structuredActive = useMemo(
    () => (includeStructured ? structuredFiltered : []),
    [includeStructured, structuredFiltered],
  )

  const bovespaActive = useMemo(
    () => (includeBovespa ? bovespaFiltered : []),
    [includeBovespa, bovespaFiltered],
  )

  const bmfActive = useMemo(
    () => (includeBmf ? bmfFiltered : []),
    [includeBmf, bmfFiltered],
  )

  const brokerMetaAssessorLookup = useMemo(() => {
    const normalized = normalizeBrokerMetaAssessorExclusions(brokerMetaAssessorExclusions)
    const lookup = new Map()
    Object.entries(normalized).forEach(([brokerName, assessors]) => {
      const brokerKey = normalizeLookupKey(brokerName)
      if (!brokerKey) return
      const assessorSet = new Set((Array.isArray(assessors) ? assessors : [])
        .map((item) => normalizeLookupKey(item))
        .filter(Boolean))
      if (assessorSet.size) lookup.set(brokerKey, assessorSet)
    })
    return lookup
  }, [brokerMetaAssessorExclusions])

  const dailyAllowed = !apuracaoMonths.all && apuracaoMonths.months.length === 1

  const resolvedGranularity = dailyAllowed ? granularity : 'monthly'


  const keyFn = useMemo(() => {

    if (resolvedGranularity === 'daily') return (entry) => getEntryDateKey(entry)

    return (entry) => String(getEntryDateKey(entry)).slice(0, 7)

  }, [resolvedGranularity])

  const structuredMapAll = useMemo(
    () => aggregateByKey(
      structuredFiltered,
      keyFn,
      (entry) => getMetaAdjustedEntryValue(entry, brokerMetaAssessorLookup),
    ),
    [structuredFiltered, keyFn, brokerMetaAssessorLookup],
  )

  const bovespaMapAll = useMemo(
    () => aggregateByKey(
      bovespaFiltered,
      keyFn,
      (entry) => getMetaAdjustedEntryValue(entry, brokerMetaAssessorLookup),
    ),
    [bovespaFiltered, keyFn, brokerMetaAssessorLookup],
  )

  const bmfMapAll = useMemo(
    () => aggregateByKey(
      bmfFiltered,
      keyFn,
      (entry) => getMetaAdjustedEntryValue(entry, brokerMetaAssessorLookup),
    ),
    [bmfFiltered, keyFn, brokerMetaAssessorLookup],
  )

  const allKeys = useMemo(() => {

    const keys = new Set([...structuredMapAll.keys(), ...bovespaMapAll.keys(), ...bmfMapAll.keys()])

    return Array.from(keys).sort()

  }, [structuredMapAll, bovespaMapAll, bmfMapAll])

  const windowedKeys = useMemo(() => {

    const max = resolvedGranularity === 'daily' ? 31 : 24

    return allKeys.slice(-max)

  }, [allKeys, resolvedGranularity])

  const series = useMemo(() => {

    return windowedKeys.map((key) => ({

      key,

      estruturadas: structuredMapAll.get(key) || 0,

      bovespa: bovespaMapAll.get(key) || 0,

      bmf: bmfMapAll.get(key) || 0,

    }))

  }, [windowedKeys, structuredMapAll, bovespaMapAll, bmfMapAll])

  const totalsByOriginAll = useMemo(() => {

    return series.reduce(

      (acc, item) => {

        acc.estruturadas += item.estruturadas

        acc.bovespa += item.bovespa

        acc.bmf += item.bmf

        return acc

      },

      { estruturadas: 0, bovespa: 0, bmf: 0 },

    )

  }, [series])

  const totalsByOrigin = useMemo(() => {

    if (originFilter === 'bovespa') return { estruturadas: 0, bovespa: totalsByOriginAll.bovespa, bmf: 0 }

    if (originFilter === 'bmf') return { estruturadas: 0, bovespa: 0, bmf: totalsByOriginAll.bmf }

    if (originFilter === 'estruturadas') return { estruturadas: totalsByOriginAll.estruturadas, bovespa: 0, bmf: 0 }

    return totalsByOriginAll

  }, [originFilter, totalsByOriginAll])

  const totalOverall = totalsByOrigin.estruturadas + totalsByOrigin.bovespa + totalsByOrigin.bmf

  const visibleTotals = totalOverall

  const goalMonthCount = useMemo(() => {
    if (apuracaoMonths?.all === false) {
      const selectedMonths = Array.isArray(apuracaoMonths?.months) ? apuracaoMonths.months.filter(Boolean) : []
      return selectedMonths.length || 1
    }
    const scopedKeys = new Set(windowedKeys.map((key) => String(key || '').slice(0, 7)).filter(Boolean))
    return scopedKeys.size || 1
  }, [apuracaoMonths, windowedKeys])

  const uniqueBovespa = useMemo(() => collectUniqueClients(bovespaActive), [bovespaActive])

  const uniqueEstruturadas = useMemo(() => collectUniqueClients(structuredActive), [structuredActive])
  const uniqueEstruturadasCount = uniqueEstruturadas.size

  const cpfGoalEnabled = goalMonthCount <= 1

  const cpfGoalBase = useMemo(() => {
    if (!cpfGoalEnabled) return null
    const parsed = toNumber(cpfGoalInput)
    if (parsed == null || parsed <= 0) return null
    return Math.round(parsed)
  }, [cpfGoalEnabled, cpfGoalInput])

  const cpfGoal130 = cpfGoalBase != null ? Math.round(cpfGoalBase * 1.3) : null
  const brokerCpfGoal = cpfGoalBase != null ? Math.round(cpfGoalBase * 0.15) : null

  const cpfProgressBase = cpfGoalBase ? clamp((uniqueEstruturadasCount / cpfGoalBase) * 100, 0, 9999) : null
  const cpfProgress130 = cpfGoal130 ? clamp((uniqueEstruturadasCount / cpfGoal130) * 100, 0, 9999) : null
  const cpfRemainingBase = cpfGoalBase != null ? Math.max(cpfGoalBase - uniqueEstruturadasCount, 0) : null
  const cpfRemaining130 = cpfGoal130 != null ? Math.max(cpfGoal130 - uniqueEstruturadasCount, 0) : null

  const cpfReferenceMonthKey = useMemo(() => {
    if (apuracaoMonths?.all === false) {
      const selectedMonths = Array.isArray(apuracaoMonths?.months)
        ? apuracaoMonths.months.filter(Boolean)
        : []
      if (selectedMonths.length === 1) return selectedMonths[0]
    }
    return buildCurrentMonthKey()
  }, [apuracaoMonths])

  const cpfBusinessDaysInMonth = useMemo(
    () => countBusinessDaysInMonth(cpfReferenceMonthKey),
    [cpfReferenceMonthKey],
  )
  const cpfBusinessDaysRemaining = useMemo(
    () => countBusinessDaysRemainingInMonth(cpfReferenceMonthKey, new Date()),
    [cpfReferenceMonthKey],
  )

  const cpfRequiredPerBusinessDayBase = useMemo(() => {
    if (cpfRemainingBase == null) return null
    if (cpfRemainingBase <= 0) return 0
    if (cpfBusinessDaysRemaining <= 0) return null
    return Math.ceil(cpfRemainingBase / cpfBusinessDaysRemaining)
  }, [cpfBusinessDaysRemaining, cpfRemainingBase])

  const cpfRequiredPerBusinessDay130 = useMemo(() => {
    if (cpfRemaining130 == null) return null
    if (cpfRemaining130 <= 0) return 0
    if (cpfBusinessDaysRemaining <= 0) return null
    return Math.ceil(cpfRemaining130 / cpfBusinessDaysRemaining)
  }, [cpfBusinessDaysRemaining, cpfRemaining130])

  const uniqueByBroker = useMemo(() => {

    const map = new Map()

    structuredActive.forEach((entry) => {

      const broker = String(entry?.broker || '').trim() || '—'

      const code = String(entry?.codigoCliente || '').trim()

      if (!code) return

      if (!map.has(broker)) map.set(broker, new Set())

      map.get(broker).add(code)

    })

    return Array.from(map.entries())

      .map(([broker, set]) => ({ broker, count: set.size }))

      .sort((a, b) => b.count - a.count)

  }, [structuredActive])

  const maxBrokerCount = uniqueByBroker.reduce((max, row) => Math.max(max, row.count), 1)

  const totalSeries = series.map((item) => item.estruturadas + item.bovespa + item.bmf)

  const estrutSeries = series.map((item) => item.estruturadas)

  const bovespaSeries = series.map((item) => item.bovespa)

  const bmfSeries = series.map((item) => item.bmf)

  const barSeries = useMemo(() => {

    if (originFilter === 'bovespa') return bovespaSeries

    if (originFilter === 'bmf') return bmfSeries

    if (originFilter === 'estruturadas') return estrutSeries

    return totalSeries

  }, [originFilter, totalSeries, bovespaSeries, bmfSeries, estrutSeries])

  const chartScale = buildChartScale(barSeries, 5)

  const barScaled = normalizeSeries(barSeries, chartScale)

  const chartTicks = barSeries.length

    ? chartScale.ticks.map((tick) => ({ ...tick, label: formatCurrency(tick.value) }))

    : []

  const hasChartData = barSeries.length > 0

  const brokerRevenueAll = useMemo(

    () => {

      const map = new Map()

      const allEntries = [...structuredActive, ...bovespaActive, ...bmfActive]

      allEntries.forEach((entry) => {

        const broker = String(entry?.broker || '').trim() || '—'

        if (!map.has(broker)) {

          map.set(broker, { receita: 0, assessores: new Set(), clientes: new Set() })

        }

        const record = map.get(broker)

        record.receita += getEntryValue(entry)

        const assessor = String(entry?.assessor || '').trim()

        if (assessor) record.assessores.add(assessor)

        const client = String(entry?.codigoCliente || entry?.cliente || entry?.conta || '').trim()

        if (client) record.clientes.add(client)

      })

      return Array.from(map.entries())

        .map(([broker, data]) => ({

          broker,

          receita: data.receita,

          assessores: data.assessores.size,

          clientes: data.clientes.size,

        }))

        .sort((a, b) => b.receita - a.receita)

    },

    [structuredActive, bovespaActive, bmfActive],

  )

  const brokerRevenueRank = useMemo(
    () => brokerRevenueAll.slice(0, 10),
    [brokerRevenueAll],
  )

  const brokerRevenueGoalRows = useMemo(() => {
    const map = new Map()
    const allEntries = [...structuredActive, ...bovespaActive, ...bmfActive]

    allEntries.forEach((entry) => {
      const broker = String(entry?.broker || '').trim() || 'Sem broker'
      const brokerKey = normalizeLookupKey(broker)
      if (!brokerKey) return

      if (!map.has(brokerKey)) {
        map.set(brokerKey, {
          broker,
          receitaMeta: 0,
          receitaAbsoluta: 0,
          assessores: new Set(),
          assessoresMeta: new Set(),
          clientes: new Set(),
        })
      }

      const record = map.get(brokerKey)
      const value = getEntryValue(entry)
      const assessor = String(entry?.assessor || '').trim()
      const assessorKey = normalizeLookupKey(assessor)
      const excludedAssessors = brokerMetaAssessorLookup.get(brokerKey)
      const excludedFromMeta = assessorKey && excludedAssessors?.has(assessorKey)

      record.receitaAbsoluta += value
      if (!excludedFromMeta) {
        record.receitaMeta += value
        if (assessor) record.assessoresMeta.add(assessor)
      }
      if (assessor) record.assessores.add(assessor)

      const client = String(entry?.codigoCliente || entry?.cliente || entry?.conta || '').trim()
      if (client) record.clientes.add(client)
    })

    return Array.from(map.values())
      .map((record) => ({
        broker: record.broker,
        receita: record.receitaMeta,
        receitaMeta: record.receitaMeta,
        receitaAbsoluta: record.receitaAbsoluta,
        assessores: record.assessores.size,
        assessoresMeta: record.assessoresMeta.size,
        clientes: record.clientes.size,
      }))
      .sort((a, b) => (
        b.receitaMeta - a.receitaMeta
        || b.receitaAbsoluta - a.receitaAbsoluta
        || a.broker.localeCompare(b.broker, 'pt-BR')
      ))
  }, [structuredActive, bovespaActive, bmfActive, brokerMetaAssessorLookup])

  const brokerRevenueGoalByKey = useMemo(() => {
    const map = new Map()
    brokerRevenueGoalRows.forEach((item) => {
      const key = normalizeLookupKey(item?.broker)
      if (!key || map.has(key)) return
      map.set(key, item)
    })
    return map
  }, [brokerRevenueGoalRows])

  const totalOverallAbsolute = useMemo(
    () => brokerRevenueAll.reduce((sum, item) => sum + (Number(item?.receita) || 0), 0),
    [brokerRevenueAll],
  )

  const brokerMetaAssessorConfigRows = useMemo(() => {
    const brokerLabelByKey = new Map()
    const assessorsByBroker = new Map()
    const revenueByBroker = new Map()
    const allEntries = [...structuredActive, ...bovespaActive, ...bmfActive]

    const ensureBroker = (brokerNameRaw) => {
      const brokerName = String(brokerNameRaw || '').trim() || 'Sem broker'
      const brokerKey = normalizeLookupKey(brokerName)
      if (!brokerKey) return ''
      if (!brokerLabelByKey.has(brokerKey)) brokerLabelByKey.set(brokerKey, brokerName)
      if (!assessorsByBroker.has(brokerKey)) assessorsByBroker.set(brokerKey, new Map())
      return brokerKey
    }

    const addAssessor = (brokerNameRaw, assessorNameRaw) => {
      const brokerKey = ensureBroker(brokerNameRaw)
      if (!brokerKey) return
      const assessorName = String(assessorNameRaw || '').trim()
      if (!assessorName) return
      const assessorKey = normalizeLookupKey(assessorName)
      if (!assessorKey) return
      const assessorMap = assessorsByBroker.get(brokerKey)
      if (!assessorMap.has(assessorKey)) assessorMap.set(assessorKey, assessorName)
    }

    brokerRevenueGoalRows.forEach((row) => {
      const brokerKey = ensureBroker(row?.broker)
      if (!brokerKey) return
      revenueByBroker.set(brokerKey, {
        receitaMeta: Number(row?.receitaMeta) || 0,
        receitaAbsoluta: Number(row?.receitaAbsoluta) || 0,
      })
    })

    allEntries.forEach((entry) => {
      const brokerName = String(entry?.broker || '').trim() || 'Sem broker'
      ensureBroker(brokerName)
      addAssessor(brokerName, entry?.assessor)
    })

    Object.entries(normalizeBrokerMetaAssessorExclusions(brokerMetaAssessorExclusions)).forEach(([brokerName, list]) => {
      ensureBroker(brokerName)
      ;(Array.isArray(list) ? list : []).forEach((assessorName) => addAssessor(brokerName, assessorName))
    })

    return Array.from(brokerLabelByKey.entries())
      .map(([brokerKey, broker]) => {
        const excludedSet = brokerMetaAssessorLookup.get(brokerKey) || new Set()
        const assessorMap = assessorsByBroker.get(brokerKey) || new Map()
        const assessors = Array.from(assessorMap.values())
          .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        const excludedAssessors = assessors
          .filter((assessorName) => excludedSet.has(normalizeLookupKey(assessorName)))
        const includedAssessors = assessors
          .filter((assessorName) => !excludedSet.has(normalizeLookupKey(assessorName)))
        const rawDraft = String(
          brokerMetaAssessorDraft[broker]
          ?? brokerMetaAssessorDraft[brokerKey]
          ?? '',
        ).trim()
        const selectedAssessor = includedAssessors.find(
          (assessorName) => normalizeLookupKey(assessorName) === normalizeLookupKey(rawDraft),
        ) || includedAssessors[0] || ''
        const revenue = revenueByBroker.get(brokerKey) || { receitaMeta: 0, receitaAbsoluta: 0 }
        return {
          broker,
          brokerKey,
          receitaMeta: revenue.receitaMeta,
          receitaAbsoluta: revenue.receitaAbsoluta,
          assessors,
          excludedAssessors,
          includedAssessors,
          selectedAssessor,
          includedAssessorsCount: includedAssessors.length,
          excludedAssessorsCount: excludedAssessors.length,
        }
      })
      .filter((row) => (
        row.assessors.length
        || row.excludedAssessors.length
        || row.receitaMeta !== 0
        || row.receitaAbsoluta !== 0
      ))
      .sort((a, b) => (
        b.receitaAbsoluta - a.receitaAbsoluta
        || b.receitaMeta - a.receitaMeta
        || a.broker.localeCompare(b.broker, 'pt-BR')
      ))
  }, [
    structuredActive,
    bovespaActive,
    bmfActive,
    brokerRevenueGoalRows,
    brokerMetaAssessorExclusions,
    brokerMetaAssessorLookup,
    brokerMetaAssessorDraft,
  ])

  const goalBlocksView = useMemo(() => {
    const brokers = brokerRevenueGoalRows.map((item) => ({
      broker: String(item.broker || '').trim(),
      receita: Number(item.receitaMeta) || 0,
      receitaMeta: Number(item.receitaMeta) || 0,
      receitaAbsoluta: Number(item.receitaAbsoluta) || 0,
      assessores: Number(item.assessores) || 0,
      assessoresMeta: Number(item.assessoresMeta) || 0,
      clientes: Number(item.clientes) || 0,
    }))

    const normalizedBlocks = normalizeGoalBlocks(goalBlocks)
    const effectiveBlocks = normalizedBlocks.length ? normalizedBlocks : [createGoalBlock('')]

    return effectiveBlocks.map((block, blockIndex) => buildGoalBlockViewModel(block, brokers, blockIndex + 1))
  }, [brokerRevenueGoalRows, goalBlocks])

  const brokerMetaAssessorVisibleRows = useMemo(() => {
    const visibleBrokerKeys = new Set()
    goalBlocksView.forEach((block) => {
      ;(Array.isArray(block?.rows) ? block.rows : []).forEach((row) => {
        const brokerKey = normalizeLookupKey(row?.broker)
        if (brokerKey) visibleBrokerKeys.add(brokerKey)
      })
    })
    return brokerMetaAssessorConfigRows.filter((row) => visibleBrokerKeys.has(row.brokerKey))
  }, [brokerMetaAssessorConfigRows, goalBlocksView])

  const assessorRank = useMemo(() => {

    const map = new Map()

    const allEntries = [...structuredActive, ...bovespaActive, ...bmfActive]

    allEntries.forEach((entry) => {

      const assessor = String(entry?.assessor || '').trim() || 'Sem assessor'

      map.set(assessor, (map.get(assessor) || 0) + getEntryValue(entry))

    })

    return Array.from(map.entries())

      .map(([assessor, value]) => ({ assessor, value }))

      .sort((a, b) => b.value - a.value)

      .slice(0, ASSESSOR_RANK_LIMIT)

  }, [structuredActive, bovespaActive, bmfActive])

  const maxAssessorValue = assessorRank.reduce((max, item) => Math.max(max, item.value), 1)
  const brokerRevenueCornerRank = useMemo(
    () => brokerRevenueGoalRows.slice(0, 5),
    [brokerRevenueGoalRows],
  )

  const monthCloseSummary = useMemo(() => {
    const blocks = goalBlocksView.map((block) => {
      const rowsByBrokerKey = new Map()
      ;(Array.isArray(block?.rows) ? block.rows : []).forEach((row) => {
        const brokerKey = normalizeLookupKey(row?.broker)
        if (!brokerKey || rowsByBrokerKey.has(brokerKey)) return
        rowsByBrokerKey.set(brokerKey, row)
      })
      return {
        id: block.id,
        order: block.order,
        label: block.name || `Bloco ${block.order}`,
        goalDefault: block.goalDefault,
        totals: block.totals,
        rowsByBrokerKey,
      }
    })

    const rows = brokerRevenueGoalRows.map((brokerRow) => {
      const brokerKey = normalizeLookupKey(brokerRow?.broker)
      return {
        broker: brokerRow?.broker || 'Sem broker',
        receitaMeta: Number(brokerRow?.receitaMeta) || 0,
        receitaAbsoluta: Number(brokerRow?.receitaAbsoluta) || 0,
        assessores: Number(brokerRow?.assessores) || 0,
        clientes: Number(brokerRow?.clientes) || 0,
        blockValues: blocks.map((block) => block.rowsByBrokerKey.get(brokerKey) || null),
      }
    })

    return {
      blocks,
      rows,
      totals: {
        receitaMeta: rows.reduce((sum, row) => sum + row.receitaMeta, 0),
        receitaAbsoluta: rows.reduce((sum, row) => sum + row.receitaAbsoluta, 0),
      },
    }
  }, [brokerRevenueGoalRows, goalBlocksView])

  const highestMonthCloseTotalIndex = monthCloseSummary.blocks.reduce(
    (max, block, index) => (block?.totals?.reached ? index : max),
    -1,
  )


  const formatLabel = (key) => {

    if (!key) return ''

    if (resolvedGranularity === 'daily') {

      const [, month, day] = String(key).split('-')

      return `${day}/${month}`

    }

    return formatMonthLabel(String(key).slice(0, 7))

  }

  const isDaily = resolvedGranularity === 'daily'

  const heatmapData = useMemo(() => {

    if (!isDaily || !windowedKeys.length) return null

    const windowSet = new Set(windowedKeys)
    const excludedLookup = new Set(
      [...heatmapExcludedBrokers].map((brokerName) => normalizeLookupKey(brokerName)).filter(Boolean),
    )

    const allEntries = [...structuredActive, ...bovespaActive, ...bmfActive]

    const brokerDayMap = new Map()

    allEntries.forEach((entry) => {

      const dayKey = getEntryDateKey(entry)

      if (!windowSet.has(dayKey)) return

      const value = getMetaAdjustedEntryValue(entry, brokerMetaAssessorLookup)

      if (!value) return

      const broker = String(entry?.broker || '').trim() || '—'

      if (excludedLookup.has(normalizeLookupKey(broker))) return
      if (!brokerDayMap.has(broker)) brokerDayMap.set(broker, new Map())

      const dm = brokerDayMap.get(broker)

      dm.set(dayKey, (dm.get(dayKey) || 0) + value)

    })

    const brokers = Array.from(brokerDayMap.entries())

      .map(([broker, dm]) => ({

        broker,

        days: dm,

        total: Array.from(dm.values()).reduce((a, b) => a + b, 0),

      }))

      .sort((a, b) => b.total - a.total)

      .slice(0, 12)

    const dayStats = new Map(
      windowedKeys.map((day) => {
        const values = brokers
          .map(({ days }) => Number(days.get(day) || 0))
          .filter((value) => Number.isFinite(value) && value !== 0)
        const positiveValues = values.filter((value) => value > 0)
        const negativeValues = values.filter((value) => value < 0)
        const totalPositive = positiveValues.reduce((sum, value) => sum + value, 0)
        return [day, {
          average: positiveValues.length ? (totalPositive / positiveValues.length) : 0,
          minPositive: positiveValues.length ? Math.min(...positiveValues) : 0,
          maxPositive: positiveValues.length ? Math.max(...positiveValues) : 0,
          minNegative: negativeValues.length ? Math.min(...negativeValues) : 0,
        }]
      }),
    )

    return { brokers, dayStats }

  }, [
    bmfActive,
    bovespaActive,
    brokerMetaAssessorLookup,
    heatmapExcludedBrokers,
    isDaily,
    structuredActive,
    windowedKeys,
  ])

  const heatmapCellColor = (value, dayStats) => {

    const numericValue = Number(value) || 0

    if (!numericValue) return 'transparent'

    if (numericValue < 0) {
      const minNegative = Number(dayStats?.minNegative) || numericValue
      const intensity = clamp(Math.abs(numericValue) / Math.max(Math.abs(minNegative), 1), 0.15, 1)
      return formatHeatmapTone({
        hue: HEATMAP_TONE_LOW.hue,
        saturation: HEATMAP_TONE_LOW.saturation,
        lightness: interpolateValue(44, 28, intensity),
        alpha: interpolateValue(0.28, 0.9, intensity),
      })
    }

    const average = Number(dayStats?.average) || 0
    const minPositive = Number(dayStats?.minPositive) || numericValue
    const maxPositive = Number(dayStats?.maxPositive) || numericValue

    if (maxPositive <= 0) return 'transparent'

    if (Math.abs(maxPositive - minPositive) < 0.0001) {
      return formatHeatmapTone(HEATMAP_TONE_GOOD)
    }

    if (numericValue >= average && average > 0) {
      const topRange = Math.max(maxPositive - average, 0)
      const intensity = topRange > 0 ? clamp((numericValue - average) / topRange, 0, 1) : 1
      return formatHeatmapTone(interpolateHeatmapTone(HEATMAP_TONE_GOOD, HEATMAP_TONE_BEST, intensity))
    }

    const baseRange = average > minPositive ? (average - minPositive) : (maxPositive - minPositive)
    const ratio = baseRange > 0 ? clamp((numericValue - minPositive) / baseRange, 0, 1) : 0
    if (ratio <= 0.65) {
      return formatHeatmapTone(interpolateHeatmapTone(HEATMAP_TONE_LOW, HEATMAP_TONE_MID, ratio / 0.65))
    }
    return formatHeatmapTone(interpolateHeatmapTone(HEATMAP_TONE_MID, HEATMAP_TONE_GOOD, (ratio - 0.65) / 0.35))

  }

  const gridColumns = Math.max(barSeries.length, 1)

  const chartGridStyle = { '--chart-columns': gridColumns }

  const dailyLabelStep = isDaily

    ? (barSeries.length >= 26 ? 3 : barSeries.length >= 16 ? 2 : 1)

    : 1

  const valueLabelStep = 1

  const shouldShowValueLabel = (index) => {

    if (valueLabelStep === 1) return true

    return index === 0 || index === barSeries.length - 1 || index % valueLabelStep === 0

  }

  const formatDailyLabel = (key, index) => {

    if (!isDaily) return formatLabel(key)

    if (dailyLabelStep === 1) return formatLabel(key)

    if (index === 0 || index === barSeries.length - 1 || index % dailyLabelStep === 0) {

      return formatLabel(key)

    }

    return ''

  }

  const handleGranularityChange = (next) => {

    setGranularity(next)

    setTooltip({ open: false, index: null, x: 0, y: 0, flip: false })

    setActiveIndex(null)

  }

  const handleBarEnter = (index, event) => {

    setActiveIndex(index)

    const target = event?.currentTarget

    const chartNode = chartRef.current

    if (!target || !chartNode) return

    const chartRect = chartNode.getBoundingClientRect()

    const targetRect = target.getBoundingClientRect()

    const rawX = targetRect.left + targetRect.width / 2 - chartRect.left

    const rawY = targetRect.top - chartRect.top

    const minX = 120

    const maxX = Math.max(chartRect.width - 120, minX)

    const x = clamp(rawX, minX, maxX)

    const flip = rawY < 90

    const y = flip ? rawY + 12 : rawY - 8

    setTooltip({ open: true, index, x, y, flip })

  }

  const handleBarLeave = () => {

    setActiveIndex(null)

    setTooltip({ open: false, index: null, x: 0, y: 0, flip: false })

  }

  const goalMonthEditWarning = `Selecione apenas um mes de apuracao para editar as metas. A configuracao atual salva em ${goalMonthLabel}.`
  const ensureGoalMonthEditable = () => {
    if (isSingleGoalMonthSelected) return true
    notify(goalMonthEditWarning, 'warning')
    return false
  }

  const handleStartGoalBlockEdit = (blockId, currentName, currentGoalRaw) => {
    if (!ensureGoalMonthEditable()) return
    const targetId = String(blockId || '').trim()
    if (!targetId) return
    const sourceBlock = (Array.isArray(goalBlocks) ? goalBlocks : []).find((block) => String(block?.id || '').trim() === targetId) || {
      id: targetId,
      name: currentName,
      goalRaw: currentGoalRaw,
    }
    setGoalBlockEditing((prev) => ({ ...prev, [targetId]: true }))
    setGoalBlockDraft((prev) => ({
      ...prev,
      [targetId]: buildGoalBlockDraftValue({
        ...sourceBlock,
        name: String(currentName ?? sourceBlock?.name ?? ''),
        goalRaw: String(currentGoalRaw ?? sourceBlock?.goalRaw ?? ''),
      }),
    }))
  }

  const handleCancelGoalBlockEdit = (blockId) => {
    const targetId = String(blockId || '').trim()
    if (!targetId) return
    setGoalBlockEditing((prev) => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
    setGoalBlockDraft((prev) => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
    setGoalBrokerIncludeDraft((prev) => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
  }

  const handleSaveGoalBlockEdit = (blockId) => {
    if (!ensureGoalMonthEditable()) return
    const targetId = String(blockId || '').trim()
    if (!targetId) return
    const draft = buildGoalBlockDraftValue(goalBlockDraft[targetId] || {})
    setGoalBlocks((prev) => (Array.isArray(prev) ? prev : [])
      .map((block) => (
        String(block?.id || '').trim() === targetId
          ? {
            ...block,
            name: draft.name,
            goalRaw: draft.goalRaw,
            brokerGoals: draft.brokerGoals,
            excludedBrokers: draft.excludedBrokers,
            excludedFromTotalBrokers: draft.excludedFromTotalBrokers,
          }
          : block
      )))
    handleCancelGoalBlockEdit(targetId)
  }

  const handleGoalBrokerDraftChange = (blockId, brokerName, value) => {
    if (!ensureGoalMonthEditable()) return
    const targetId = String(blockId || '').trim()
    const brokerKey = String(brokerName || '').trim()
    if (!targetId || !brokerKey) return
    setGoalBlockDraft((prev) => {
      const currentDraft = buildGoalBlockDraftValue(prev[targetId] || {})
      const nextRaw = String(value ?? '')
      const nextBrokerGoals = {
        ...normalizeGoalBlockBrokerGoals(currentDraft.brokerGoals),
      }
      if (nextRaw.trim() && nextRaw.trim() !== String(currentDraft.goalRaw || '').trim()) nextBrokerGoals[brokerKey] = nextRaw
      else delete nextBrokerGoals[brokerKey]
      return {
        ...prev,
        [targetId]: {
          ...currentDraft,
          brokerGoals: nextBrokerGoals,
        },
      }
    })
  }

  const handleRemoveBrokerFromBlock = (blockId, brokerName) => {
    if (!ensureGoalMonthEditable()) return
    const targetId = String(blockId || '').trim()
    const brokerKey = String(brokerName || '').trim()
    if (!targetId || !brokerKey) return
    setGoalBlockDraft((prev) => {
      const currentDraft = buildGoalBlockDraftValue(prev[targetId] || {})
      const nextDraft = applyBrokerExclusionToGoalBlock(currentDraft, brokerKey)
      if (nextDraft === currentDraft) return prev
      return {
        ...prev,
        [targetId]: {
          ...nextDraft,
        },
      }
    })
  }

  const handleRemoveBrokerFromAllBlocks = (brokerName) => {
    if (!ensureGoalMonthEditable()) return
    const brokerLabel = String(brokerName || '').trim()
    const brokerLookup = normalizeLookupKey(brokerLabel)
    if (!brokerLookup) return

    const affectedBlocks = goalBlocksView.reduce((count, block) => (
      (Array.isArray(block?.rows) ? block.rows : []).some((row) => normalizeLookupKey(row?.broker) === brokerLookup)
        ? count + 1
        : count
    ), 0)

    if (!affectedBlocks) {
      notify('Este broker ja foi retirado de todos os blocos atuais.', 'warning')
      return
    }

    setGoalBlocks((prev) => {
      const current = Array.isArray(prev) ? normalizeGoalBlocks(prev) : []
      return current.map((block) => applyBrokerExclusionToGoalBlock(block, brokerLabel))
    })

    setGoalBlockDraft((prev) => {
      const next = { ...prev }
      Object.keys(next).forEach((blockId) => {
        next[blockId] = applyBrokerExclusionToGoalBlock(buildGoalBlockDraftValue(next[blockId] || {}), brokerLabel)
      })
      return next
    })

    setBrokerMetaAssessorDraft((prev) => {
      const next = { ...prev }
      delete next[brokerLabel]
      return next
    })

    notify(
      `${brokerLabel} retirado de ${formatNumber(affectedBlocks)} bloco(s) de meta.`,
      'success',
    )
  }

  const handleRemoveBrokerFromFechamento = (brokerName) => {
    const name = String(brokerName || '').trim()
    if (!name) return
    setFechamentoExcludedBrokers((prev) => new Set([...prev, name]))
  }

  const handleAddBrokerToFechamento = (brokerName) => {
    const name = String(brokerName || '').trim()
    if (!name) return
    setFechamentoExcludedBrokers((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }

  const handleRemoveBrokerFromHeatmap = (brokerName) => {
    const name = String(brokerName || '').trim()
    if (!name) return
    setHeatmapExcludedBrokers((prev) => new Set([...prev, name]))
  }

  const handleAddBrokerToHeatmap = (brokerName) => {
    const name = String(brokerName || '').trim()
    if (!name) return
    setHeatmapExcludedBrokers((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }

  const handleIncludeBrokerInBlock = (blockId, brokerName) => {
    if (!ensureGoalMonthEditable()) return
    const targetId = String(blockId || '').trim()
    const brokerKey = String(brokerName || '').trim()
    if (!targetId || !brokerKey) return
    setGoalBlockDraft((prev) => {
      const currentDraft = buildGoalBlockDraftValue(prev[targetId] || {})
      const excluded = normalizeGoalBlockExcludedBrokers(currentDraft.excludedBrokers)
      return {
        ...prev,
        [targetId]: {
          ...currentDraft,
          excludedBrokers: excluded.filter((item) => item !== brokerKey),
        },
      }
    })
  }

  const handleToggleBrokerTotalContribution = (blockId, brokerName, shouldCount) => {
    if (!ensureGoalMonthEditable()) return
    const targetId = String(blockId || '').trim()
    const brokerKey = String(brokerName || '').trim()
    if (!targetId || !brokerKey) return
    setGoalBlockDraft((prev) => {
      const currentDraft = buildGoalBlockDraftValue(prev[targetId] || {})
      const excludedFromTotal = normalizeGoalBlockExcludedFromTotalBrokers(currentDraft.excludedFromTotalBrokers)
      const nextExcludedFromTotal = shouldCount
        ? excludedFromTotal.filter((item) => item !== brokerKey)
        : (excludedFromTotal.includes(brokerKey) ? excludedFromTotal : [...excludedFromTotal, brokerKey])
      return {
        ...prev,
        [targetId]: {
          ...currentDraft,
          excludedFromTotalBrokers: nextExcludedFromTotal,
        },
      }
    })
  }

  const handleBrokerMetaAssessorDraftChange = (brokerName, value) => {
    const brokerLabel = String(brokerName || '').trim()
    if (!brokerLabel) return
    setBrokerMetaAssessorDraft((prev) => ({
      ...prev,
      [brokerLabel]: String(value ?? ''),
    }))
  }

  const handleExcludeAssessorFromBrokerMeta = (brokerName, assessorName) => {
    const brokerLabel = String(brokerName || '').trim()
    const assessorLabel = String(assessorName || '').trim()
    if (!brokerLabel || !assessorLabel) return

    setBrokerMetaAssessorExclusions((prev) => {
      const current = normalizeBrokerMetaAssessorExclusions(prev)
      const existingBrokerKey = findNormalizedObjectKey(current, brokerLabel)
      const targetBroker = existingBrokerKey || brokerLabel
      const list = Array.isArray(current[targetBroker]) ? [...current[targetBroker]] : []
      const assessorLookup = normalizeLookupKey(assessorLabel)
      if (!assessorLookup) return current
      if (list.some((item) => normalizeLookupKey(item) === assessorLookup)) return current
      return {
        ...current,
        [targetBroker]: [...list, assessorLabel],
      }
    })

    setBrokerMetaAssessorDraft((prev) => {
      const next = { ...prev }
      delete next[brokerLabel]
      return next
    })
  }

  const handleIncludeAssessorInBrokerMeta = (brokerName, assessorName) => {
    const brokerLabel = String(brokerName || '').trim()
    const assessorLabel = String(assessorName || '').trim()
    if (!brokerLabel || !assessorLabel) return

    setBrokerMetaAssessorExclusions((prev) => {
      const current = normalizeBrokerMetaAssessorExclusions(prev)
      const targetBroker = findNormalizedObjectKey(current, brokerLabel)
      if (!targetBroker) return current
      const assessorLookup = normalizeLookupKey(assessorLabel)
      const nextList = (Array.isArray(current[targetBroker]) ? current[targetBroker] : [])
        .filter((item) => normalizeLookupKey(item) !== assessorLookup)
      if (nextList.length === (Array.isArray(current[targetBroker]) ? current[targetBroker] : []).length) return current
      if (nextList.length) {
        return {
          ...current,
          [targetBroker]: nextList,
        }
      }
      const next = { ...current }
      delete next[targetBroker]
      return next
    })
  }

  const handleAddGoalBlock = () => {
    if (!ensureGoalMonthEditable()) return
    const goalRaw = String(newGoalBlockInput || '').trim()
    setGoalBlocks((prev) => {
      const current = Array.isArray(prev) ? normalizeGoalBlocks(prev) : []
      return [...current, createGoalBlock(goalRaw)]
    })
    setNewGoalBlockInput('')
  }

  const handleRemoveGoalBlock = (blockId) => {
    if (!ensureGoalMonthEditable()) return
    const targetId = String(blockId || '').trim()
    if (!targetId) return
    setGoalBlocks((prev) => {
      const current = Array.isArray(prev) ? normalizeGoalBlocks(prev) : []
      const next = current.filter((block) => String(block?.id || '').trim() !== targetId)
      return next.length ? next : [createGoalBlock('')]
    })
    setGoalBrokerIncludeDraft((prev) => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
    setGoalBlockEditing((prev) => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
    setGoalBlockDraft((prev) => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
  }

  const resolveGoalBlockRuntime = (block) => {
    const isBlockEditing = Boolean(goalBlockEditing[block.id])
    const blockDraft = goalBlockDraft[block.id] || buildGoalBlockDraftValue(block)
    const activeBlock = isBlockEditing
      ? buildGoalBlockViewModel({
        ...block,
        ...blockDraft,
      }, brokerRevenueGoalRows, block.order)
      : block
    const includeOptions = Array.isArray(activeBlock.availableBrokers) ? activeBlock.availableBrokers : []
    const includeDraft = String(goalBrokerIncludeDraft[block.id] || '').trim()
    const includeBrokerValue = includeOptions.includes(includeDraft) ? includeDraft : (includeOptions[0] || '')
    return {
      isBlockEditing,
      blockDraft,
      activeBlock,
      includeOptions,
      includeBrokerValue,
    }
  }

  const handleExportPdf = async () => {
    if (isExportingPdf) return
    if (!overviewExportRef.current || !goalsExportRef.current) {
      notify('Nao foi possivel localizar a dashboard para exportacao.', 'warning')
      return
    }

    setIsExportingPdf(true)
    try {
      setActiveIndex(null)
      setTooltip({ open: false, index: null, x: 0, y: 0, flip: false })
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
      const result = await exportDashboardPdf({
        overviewNode: overviewExportRef.current,
        goalsNode: goalsExportRef.current,
      })
      notify(`Dashboard exportada: ${result.fileName}`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao exportar PDF: ${error.message}` : 'Falha ao exportar PDF da dashboard.', 'warning')
    } finally {
      setIsExportingPdf(false)
    }
  }

  const safeTooltipIndex = tooltip.index !== null && tooltip.index < barSeries.length ? tooltip.index : null

  const tooltipOpen = tooltip.open && safeTooltipIndex !== null

  const tooltipData = safeTooltipIndex !== null ? series[safeTooltipIndex] : null

  const tooltipTotal = safeTooltipIndex !== null ? totalSeries[safeTooltipIndex] : 0

  const tooltipLabel = safeTooltipIndex !== null ? formatLabel(windowedKeys[safeTooltipIndex]) : ''

  return (

    <div className="dashboard">

      <div className="dashboard-export-bar">
        <button
          className="btn btn-secondary"
          type="button"
          onClick={handleExportPdf}
          disabled={isExportingPdf}
        >
          {isExportingPdf ? 'Exportando PDF...' : 'Exportar dashboard'}
        </button>
      </div>

      <div className="dashboard-export-page" ref={overviewExportRef}>

        <section className="kpi-grid">

        <div className="card kpi-card">

          <div className="kpi-label">Receita total</div>

          <div className="kpi-value">{formatCurrency(visibleTotals)}</div>

        </div>

        <div className="card kpi-card">

          <div className="kpi-label">Clientes unicos em Bovespa</div>

          <div className="kpi-value">{formatNumber(uniqueBovespa.size)}</div>

        </div>

        <div className="card kpi-card">

          <div className="kpi-label">Clientes unicos em Estruturas</div>

          <div className="kpi-value">{formatNumber(uniqueEstruturadasCount)}</div>

        </div>

      </section>

      <p className="muted">Apuracao considera apenas Variavel. Exclusoes de assessor afetam a receita de meta da dashboard; o rank de receita por broker continua absoluto.</p>

      <section className="mini-grid">

        <div className="card mini-card">

          <div className="mini-label">Bovespa</div>

          <div className="mini-value">{formatCurrency(totalsByOrigin.bovespa)}</div>

        </div>

        <div className="card mini-card">

          <div className="mini-label">BMF</div>

          <div className="mini-value">{formatCurrency(totalsByOrigin.bmf)}</div>

        </div>

        <div className="card mini-card">

          <div className="mini-label">Estruturadas</div>

          <div className="mini-value">{formatCurrency(totalsByOrigin.estruturadas)}</div>

        </div>

      </section>

      <section className="dashboard-bottom">

        <div className="card chart-card">

          <div className="card-head">

            <div>

              <h3>Fluxo operacional</h3>

              <p className="muted">Movimento consolidado por periodo</p>

              <div className="chart-last-updates muted">
                <span>Bovespa: {latestOperationByLine.bovespa}</span>
                <span>BMF: {latestOperationByLine.bmf}</span>
                <span>Estruturadas: {latestOperationByLine.estruturadas}</span>
              </div>

            </div>

            <div className="page-list">

              <button

                className={`page-number ${resolvedGranularity === 'monthly' ? 'active' : ''}`}

                type="button"

                onClick={() => handleGranularityChange('monthly')}

              >

                Mensal

              </button>

              <button

                className={`page-number ${resolvedGranularity === 'daily' ? 'active' : ''}`}

                type="button"

                onClick={() => handleGranularityChange('daily')}

                disabled={!dailyAllowed}

              >

                Diario

              </button>

            </div>

          </div>

          <div className={`chart flow-chart ${isDaily ? 'is-daily' : ''}`} ref={chartRef}>

            {chartTicks.length ? (

              <>

                <div className="chart-lines">

                  {chartTicks.map((tick, index) => (

                    <span key={`line-${index}`} className="chart-line" style={{ bottom: `${tick.percent}%` }} />

                  ))}

                </div>

                <div className="chart-ticks">

                  {chartTicks.map((tick, index) => (

                    <span key={`tick-${index}`} className="chart-tick" style={{ bottom: `${tick.percent}%` }}>

                      {tick.label}

                    </span>

                  ))}

                </div>

              </>

            ) : null}

            {hasChartData ? (

              <>

                <div className="chart-grid" style={chartGridStyle}>

                  {barSeries.map((value, index) => {

                    const key = windowedKeys[index] || `${value}-${index}`

                    const isActive = activeIndex === index

                    const height = barScaled[index] || 0

                    const dayData = series[index] || { bovespa: 0, bmf: 0, estruturadas: 0 }

                    const columnStyle = { '--bar-height': `${height}%` }

                    const valueLabel = shouldShowValueLabel(index) ? formatCurrency(value) : ''

                    const dateLabel = formatDailyLabel(windowedKeys[index], index)

                    const ariaLabel = `${formatLabel(windowedKeys[index])} - Valor ${formatCurrency(value)}; bovespa ${formatCurrency(dayData.bovespa)}; BMF ${formatCurrency(dayData.bmf)}; Estrutura ${formatCurrency(dayData.estruturadas)}`

                    return (

                      <div key={key} className="chart-col" style={columnStyle}>

                        <span className="chart-value-label">{valueLabel}</span>

                        <button

                          type="button"

                          className={`chart-bar ${isActive ? 'is-active' : ''}`}

                          style={{ height: `${height}%` }}

                          onMouseEnter={(event) => handleBarEnter(index, event)}

                          onMouseLeave={handleBarLeave}

                          onFocus={(event) => handleBarEnter(index, event)}

                          onBlur={handleBarLeave}

                          aria-label={ariaLabel}

                        />

                        <span className="chart-date-label">{dateLabel}</span>

                      </div>

                    )

                  })}

                </div>

                {tooltipOpen ? (

                  <div className={`chart-tooltip ${tooltip.flip ? 'is-flipped' : ''}`} style={{ left: tooltip.x, top: tooltip.y }}>

                    <div className="chart-tooltip-title">{tooltipLabel || 'Periodo indisponivel'}</div>

                    <div className="chart-tooltip-row chart-tooltip-row--total">

                      <span>Total</span>

                      <strong>{formatCurrency(tooltipTotal)}</strong>

                    </div>

                    <div className="chart-tooltip-row chart-tooltip-row--bovespa">

                      <span>Bovespa</span>

                      <strong>{formatCurrency(tooltipData?.bovespa ?? 0)}</strong>

                    </div>

                    <div className="chart-tooltip-row chart-tooltip-row--bmf">

                      <span>BMF</span>

                      <strong>{formatCurrency(tooltipData?.bmf ?? 0)}</strong>

                    </div>

                    <div className="chart-tooltip-row chart-tooltip-row--estrutura">

                      <span>Estrutura</span>

                      <strong>{formatCurrency(tooltipData?.estruturadas ?? 0)}</strong>

                    </div>

                  </div>

                ) : null}

              </>

            ) : (

              <div className="chart-empty">Sem dados</div>

            )}

          </div>

<div className="chart-footer">

            <div>

              <span className="muted">Total</span>

              <strong>{formatCurrency(totalOverall)}</strong>

            </div>

          </div>

          {heatmapData && (

            <div className="broker-heatmap">

              <div className="broker-heatmap-head">

                <strong>Receita por broker / dia</strong>
                <span>Mapa de calor pela media do dia.</span>

              </div>

              <div className="broker-heatmap-scroll">

                <table className="broker-heatmap-table">

                  <thead>

                    <tr>

                      <th className="broker-heatmap-label">Broker</th>

                      {windowedKeys.map((day) => (

                        <th key={day} className="broker-heatmap-day">

                          {formatLabel(day).split('/').slice(0, 2).join('/')}

                        </th>

                      ))}

                      <th className="broker-heatmap-total">Total</th>

                    </tr>

                  </thead>

                  <tbody>

                    {heatmapData.brokers.map(({ broker, days, total }) => (

                      <tr key={broker}>

                        <td className="broker-heatmap-label" title={broker}>
                          <div className="broker-heatmap-broker-cell">
                            <span className="broker-heatmap-broker-name">{broker}</span>
                            <button
                              type="button"
                              className="broker-heatmap-remove"
                              onClick={() => handleRemoveBrokerFromHeatmap(broker)}
                              title="Ocultar broker do heatmap"
                            >
                              Remover
                            </button>
                          </div>
                        </td>

                        {windowedKeys.map((day) => {

                          const v = days.get(day) || 0
                          const dayStats = heatmapData.dayStats.get(day)

                          return (

                            <td

                              key={day}

                              className="broker-heatmap-cell"

                              style={{ background: heatmapCellColor(v, dayStats) }}

                              title={`${broker} — ${formatLabel(day)}: ${formatCurrency(v)}`}

                            >

                              {v ? formatCurrencyCompact(v) : ''}

                            </td>

                          )

                        })}

                        <td className="broker-heatmap-total">{formatCurrency(total)}</td>

                      </tr>

                    ))}

                  </tbody>

                  <tfoot>

                    <tr>

                      <td className="broker-heatmap-label">Total</td>

                      {windowedKeys.map((day, i) => (

                        <td key={day} className="broker-heatmap-cell broker-heatmap-cell--total">

                          {barSeries[i] ? formatCurrencyCompact(barSeries[i]) : ''}

                        </td>

                      ))}

                      <td className="broker-heatmap-total">{formatCurrency(totalOverall)}</td>

                    </tr>

                  </tfoot>

                </table>

              </div>

              {heatmapExcludedBrokers.size > 0 ? (
                <div className="broker-heatmap-excluded">
                  <small className="muted">Brokers ocultos:</small>
                  {[...heatmapExcludedBrokers].sort((left, right) => left.localeCompare(right)).map((broker) => (
                    <button
                      key={`heatmap-excluded-${broker}`}
                      type="button"
                      className="badge badge-violet"
                      style={{ cursor: 'pointer', border: 'none', background: 'none' }}
                      onClick={() => handleAddBrokerToHeatmap(broker)}
                      title="Clique para incluir de volta no heatmap"
                    >
                      + {broker}
                    </button>
                  ))}
                </div>
              ) : null}

            </div>

          )}

          <div className="assessor-rank">

            <div className="assessor-rank-head">

              <strong>Ranking de assessores</strong>

              <span className="muted">Top {ASSESSOR_RANK_LIMIT}</span>

            </div>

            {assessorRank.length ? (

              <div className="assessor-rank-list">

                {assessorRank.map((item) => (

                  <div key={item.assessor} className="assessor-rank-item">

                    <div className="assessor-rank-main">

                      <span className="assessor-name" title={item.assessor}>{item.assessor}</span>

                      <span className="assessor-value">{formatCurrency(item.value)}</span>

                    </div>

                    <div className="assessor-bar">

                      <span style={{ width: `${maxAssessorValue ? (item.value / maxAssessorValue) * 100 : 0}%` }} />

                    </div>

                  </div>

                ))}

              </div>

            ) : (

              <div className="assessor-rank-empty">Sem dados de assessores.</div>

            )}

          </div>

        </div>

        <div className="card segment-card">

          <div className="card-head">

            <h3>Distribuicao por origem</h3>

            <div className="page-list">

              <button

                className={`page-number ${originFilter === 'all' ? 'active' : ''}`}

                type="button"

                onClick={() => setOriginFilter('all')}

              >

                Todas

              </button>

              <button

                className={`page-number ${originFilter === 'bovespa' ? 'active' : ''}`}

                type="button"

                onClick={() => setOriginFilter('bovespa')}

              >

                Bovespa

              </button>

              <button

                className={`page-number ${originFilter === 'bmf' ? 'active' : ''}`}

                type="button"

                onClick={() => setOriginFilter('bmf')}

              >

                BMF

              </button>

              <button

                className={`page-number ${originFilter === 'estruturadas' ? 'active' : ''}`}

                type="button"

                onClick={() => setOriginFilter('estruturadas')}

              >

                Estruturadas

              </button>

            </div>

          </div>

          <div className="segment-list">

            {[

              { label: 'Bovespa', value: totalsByOrigin.bovespa, tone: 'cyan' },

              { label: 'BMF', value: totalsByOrigin.bmf, tone: 'violet' },

              { label: 'Estruturadas', value: totalsByOrigin.estruturadas, tone: 'amber' },

            ].map((segment) => {

              const percent = totalOverall ? (segment.value / totalOverall) * 100 : 0

              return (

                <div key={segment.label} className="segment-row">

                  <div className={`segment-dot ${segment.tone}`} />

                  <div className="segment-info">

                    <strong>{segment.label}</strong>

                    <span>{percent.toFixed(1)}% do volume</span>

                  </div>

                  <div className="segment-bar">

                    <span style={{ width: `${percent}%` }} className={segment.tone} />

                  </div>

                </div>

              )

            })}

          </div>

          <div className="segment-total">

            <div>

              <span className="muted">Total consolidado</span>

              <strong>{formatCurrency(totalOverall)}</strong>

            </div>

          </div>

          <div className="segment-total">

            <div>

              <span className="muted">Distribuicao de CPFs por broker (Estruturas)</span>

              <div className="cpf-goal-editor">
                <label className="cpf-goal-field">
                  <span className="muted">Meta CPF (base)</span>
                  <input
                    className="input cpf-goal-input"
                    type="text"
                    inputMode="numeric"
                    value={cpfGoalInput}
                    onChange={(event) => setCpfGoalInput(event.target.value)}
                    placeholder="Ex: 800"
                    aria-label="Meta de CPF base"
                  />
                </label>

                <div className="cpf-goal-badges">
                  <span className="badge badge-cyan">Atual: {formatNumber(uniqueEstruturadasCount)}</span>
                  <span className="badge badge-violet">
                    Meta base: {cpfGoalBase != null ? formatNumber(cpfGoalBase) : '-'}
                  </span>
                  <span className="badge badge-amber">
                    Meta 130%: {cpfGoal130 != null ? formatNumber(cpfGoal130) : '-'}
                  </span>
                  <span className="badge badge-green">
                    Meta broker (15%): {brokerCpfGoal != null ? formatNumber(brokerCpfGoal) : '-'}
                  </span>
                  {!cpfGoalEnabled ? (
                    <span className="badge badge-amber">
                      Meta CPF desconsiderada para periodo com mais de 1 mes
                    </span>
                  ) : null}
                  {cpfProgressBase != null ? (
                    <span className={`badge ${cpfProgressBase >= 100 ? 'badge-green' : 'badge-amber'}`}>
                      Base: {cpfProgressBase.toFixed(1).replace('.', ',')}%
                    </span>
                  ) : null}
                  {cpfProgress130 != null ? (
                    <span className={`badge ${cpfProgress130 >= 100 ? 'badge-green' : 'badge-amber'}`}>
                      130%: {cpfProgress130.toFixed(1).replace('.', ',')}%
                    </span>
                  ) : null}
                </div>

                {cpfGoalEnabled && cpfGoalBase != null ? (
                  <>
                    <div className="cpf-goal-calendar muted">
                      Mes de referencia: {formatMonthLabel(cpfReferenceMonthKey)} • Dias uteis: {formatNumber(cpfBusinessDaysInMonth)} • Restantes: {formatNumber(cpfBusinessDaysRemaining)}
                    </div>
                    <div className="cpf-goal-progress-list">
                      <div className="segment-row cpf-goal-progress-row">
                        <div className="segment-dot cyan" />
                        <div className="segment-info">
                          <strong>Meta geral (100%): {formatNumber(cpfGoalBase)}</strong>
                          <span>
                            Atual {formatNumber(uniqueEstruturadasCount)} • {cpfProgressBase != null ? `${cpfProgressBase.toFixed(1).replace('.', ',')}%` : '-'}
                            {cpfRemainingBase != null ? ` • Faltam ${formatNumber(cpfRemainingBase)}` : ''}
                            {cpfRequiredPerBusinessDayBase != null
                              ? ` • ${formatNumber(cpfRequiredPerBusinessDayBase)}/dia util`
                              : ' • Sem dias uteis restantes'}
                          </span>
                        </div>
                        <div className="segment-bar">
                          <span
                            style={{ width: `${clamp(cpfProgressBase || 0, 0, 100)}%` }}
                            className={cpfProgressBase != null && cpfProgressBase >= 100 ? 'green' : 'cyan'}
                          />
                        </div>
                      </div>
                      <div className="segment-row cpf-goal-progress-row">
                        <div className="segment-dot amber" />
                        <div className="segment-info">
                          <strong>Meta 130%: {cpfGoal130 != null ? formatNumber(cpfGoal130) : '-'}</strong>
                          <span>
                            Atual {formatNumber(uniqueEstruturadasCount)} • {cpfProgress130 != null ? `${cpfProgress130.toFixed(1).replace('.', ',')}%` : '-'}
                            {cpfRemaining130 != null ? ` • Faltam ${formatNumber(cpfRemaining130)}` : ''}
                            {cpfRequiredPerBusinessDay130 != null
                              ? ` • ${formatNumber(cpfRequiredPerBusinessDay130)}/dia util`
                              : ' • Sem dias uteis restantes'}
                          </span>
                        </div>
                        <div className="segment-bar">
                          <span
                            style={{ width: `${clamp(cpfProgress130 || 0, 0, 100)}%` }}
                            className={cpfProgress130 != null && cpfProgress130 >= 100 ? 'green' : 'amber'}
                          />
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>

              <div className="segment-list">

                {uniqueByBroker.map((item) => {
                  const brokerProgress = brokerCpfGoal ? ((item.count / brokerCpfGoal) * 100) : null
                  const barWidth = brokerCpfGoal
                    ? clamp(brokerProgress || 0, 0, 100)
                    : ((item.count / maxBrokerCount) * 100)
                  return (

                  <div key={item.broker} className="segment-row">

                    <div className="segment-dot cyan" />

                    <div className="segment-info">

                      <strong>{item.broker}</strong>

                      <span>
                        {item.count} clientes unicos
                        {brokerProgress != null ? ` • ${brokerProgress.toFixed(1).replace('.', ',')}% da meta broker` : ''}
                      </span>

                    </div>

                    <div className="segment-bar">

                      <span style={{ width: `${barWidth}%` }} className="cyan" />

                    </div>

                  </div>

                  )
                })}

              </div>

            </div>

          </div>

          <div className="segment-total">

            <div>

              <span className="muted">Rank Receita por Broker (todas origens)</span>

              <div className="segment-list">

                {brokerRevenueRank.map((item) => {
                  const brokerGoalRow = brokerRevenueGoalByKey.get(normalizeLookupKey(item.broker))
                  const receitaMeta = Number(brokerGoalRow?.receitaMeta ?? item.receita) || 0
                  const receitaAbsoluta = Number(brokerGoalRow?.receitaAbsoluta ?? item.receita) || 0
                  return (
                    <div key={item.broker} className="segment-row">

                      <div className="segment-dot violet" />

                      <div className="segment-info">

                        <strong>{item.broker}</strong>

                        <span>
                          Meta: {formatCurrency(receitaMeta)} / Absoluta: {formatCurrency(receitaAbsoluta)} / {item.assessores} assessores / {item.clientes} clientes
                        </span>

                      </div>

                      <div className="segment-bar">

                        <span style={{ width: `${totalOverallAbsolute ? (receitaAbsoluta / totalOverallAbsolute) * 100 : 0}%` }} className="violet" />

                      </div>

                    </div>
                  )
                })}

              </div>

            </div>

          </div>

        </div>

      </section>

      <section className="card month-close-card">
        <div className="card-head">
          <div>
            <h3>Fechamento do mes</h3>
            <p className="muted">
              Resumo consolidado por broker e bloco no modelo atual da dashboard.
              {' '}O valor do bloco mostra a receita usada para meta; as colunas finais mostram a receita meta e a receita total do broker no periodo.
              {' '}Use <strong>Editar brokers</strong> nos blocos abaixo para decidir quem entra na soma do total de cada bloco.
            </p>
          </div>
          <div className="goals-head-side month-close-head-side">
            <span className="badge badge-violet">Mes: {goalMonthLabel}</span>
            <span className="badge badge-cyan">Brokers: {formatNumber(monthCloseSummary.rows.length)}</span>
            <span className="badge badge-amber">Blocos: {formatNumber(monthCloseSummary.blocks.length)}</span>
          </div>
        </div>

        {monthCloseSummary.blocks.length && monthCloseSummary.rows.length ? (
          <>
            <div className="table-wrap month-close-table-wrap">
              <table className="data-table month-close-table">
                <thead>
                  <tr>
                    <th>Broker</th>
                    {monthCloseSummary.blocks.map((block) => (
                      <th key={`month-close-head-${block.id}`}>
                        <div className="month-close-col-head">
                          <strong>{block.label}</strong>
                          <small>
                            {block.goalDefault != null ? `Meta broker ${formatCurrency(block.goalDefault)}` : 'Sem meta padrao'}
                          </small>
                        </div>
                      </th>
                    ))}
                    <th>Receita meta</th>
                    <th>Receita total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {monthCloseSummary.rows.filter((row) => !fechamentoExcludedBrokers.has(row.broker)).map((row) => {
                    const highestReachedIndex = row.blockValues.reduce((max, c, i) => (c?.reached ? i : max), -1)
                    return (
                    <tr key={`month-close-row-${row.broker}`}>
                      <td>
                        <div className="month-close-broker-cell">
                          <strong>{row.broker}</strong>
                          <small className="muted">
                            {formatNumber(row.assessores)} assessor(es) / {formatNumber(row.clientes)} cliente(s)
                          </small>
                        </div>
                      </td>
                      {row.blockValues.map((cell, index) => (
                        <td key={`month-close-cell-${row.broker}-${monthCloseSummary.blocks[index]?.id}`}>
                          {cell ? (
                            <div
                              className={`month-close-cell${cell.reached && index === highestReachedIndex ? ' is-hit' : ''}${cell.countsInTotal ? '' : ' is-out-total'}`}
                            >
                              <strong>{cell.goalValue != null ? formatCurrency(cell.goalValue) : '—'}</strong>
                              <small>
                                {cell.countsInTotal ? 'Entra no total' : 'Fora do total'}
                                {cell.progress != null ? ` • ${formatPercentLabel(cell.progress)}` : ''}
                              </small>
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      ))}
                      <td>
                        <strong>{formatCurrency(row.receitaMeta)}</strong>
                      </td>
                      <td>
                        <strong>{formatCurrency(row.receitaAbsoluta)}</strong>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => handleRemoveBrokerFromFechamento(row.broker)}
                          title="Ocultar broker do fechamento"
                        >
                          Remover
                        </button>
                      </td>
                    </tr>
                  )})}
                  <tr className="month-close-total-row">
                    <td><strong>Total</strong></td>
                    {monthCloseSummary.blocks.map((block, index) => (
                      <td key={`month-close-total-${block.id}`}>
                        <div
                          className={`month-close-cell month-close-total-cell${block.totals.reached && index === highestMonthCloseTotalIndex ? ' is-hit' : ''}`}
                        >
                          <strong>{formatCurrency(block.totals.totalRevenue)}</strong>
                          <small>
                            {block.totals.hasTarget
                              ? `${block.totals.reached ? 'Meta atingida' : `Meta ${formatCurrency(block.totals.totalTarget)}`}`
                              : 'Sem meta'}
                            {block.totals.progress != null ? ` • ${formatPercentLabel(block.totals.progress)}` : ''}
                          </small>
                        </div>
                      </td>
                    ))}
                    <td><strong>{formatCurrency(monthCloseSummary.totals.receitaMeta)}</strong></td>
                    <td><strong>{formatCurrency(monthCloseSummary.totals.receitaAbsoluta)}</strong></td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="month-close-legend">
              <span className="badge badge-green">Verde = ultima faixa de meta atingida</span>
              <span className="badge badge-cyan">Fora do total = broker nao entra na soma do bloco</span>
            </div>

            {fechamentoExcludedBrokers.size > 0 ? (
              <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <small className="muted">Brokers ocultos:</small>
                {[...fechamentoExcludedBrokers].map((broker) => (
                  <button
                    key={`fechamento-excluded-${broker}`}
                    type="button"
                    className="badge badge-violet"
                    style={{ cursor: 'pointer', border: 'none', background: 'none' }}
                    onClick={() => handleAddBrokerToFechamento(broker)}
                    title="Clique para incluir de volta no fechamento"
                  >
                    + {broker}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <span className="muted">Sem blocos ou brokers com receita no periodo atual.</span>
        )}
      </section>

      </div>

      <div className="dashboard-export-page" ref={goalsExportRef}>

        <section className="card goals-card">

        <div className="card-head goals-head">

          <div>

            <h3>Grade de metas</h3>

            <p className="muted">Escadas de meta por faixa, com configuracao individual por broker e definicao de quem entra no total.</p>

          </div>

          <div className="goals-head-side">
            {brokerRevenueCornerRank.length ? (
              <div className="goals-broker-corner">
                <small>Rank receita broker (meta)</small>
                {brokerRevenueCornerRank.map((item, index) => (
                  <div key={`corner-${item.broker}`} className="goals-broker-corner-item">
                    <span>{index + 1}. {item.broker}</span>
                    <strong>{formatCurrency(item.receitaMeta)}</strong>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

        </div>

        <div className="broker-goal-month-selector">
          <label htmlFor="goal-month-select">Mês de referência dos blocos:</label>
          <select
            id="goal-month-select"
            className="input"
            value={goalBlocksManualMonthKey}
            onChange={(event) => setGoalBlocksManualMonthKey(event.target.value)}
            style={{ width: 'auto', minWidth: 140 }}
          >
            {buildGoalMonthOptions(userKey).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <p className="muted">
          Blocos por meta com edicao individual por broker.
          {' '}A meta da tabela e mensal (nao multiplica por meses de apuracao) e o total do bloco soma apenas os brokers marcados para entrar no total.
          {' '}Configuracao ativa: <strong>{goalMonthLabel}</strong>.
        </p>

        <div className="broker-goal-toolbar">
          <label className="broker-goal-add-field">
            <span>Nova escada de meta (R$)</span>
            <input
              className="input"
              type="text"
              value={newGoalBlockInput}
              onChange={(event) => setNewGoalBlockInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleAddGoalBlock()
                }
              }}
              placeholder="Ex: 100000"
              aria-label="Adicionar escada de meta"
              disabled={!isSingleGoalMonthSelected}
            />
          </label>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={handleAddGoalBlock}
            disabled={!isSingleGoalMonthSelected}
            title={!isSingleGoalMonthSelected ? goalMonthEditWarning : ''}
          >
            Adicionar bloco
          </button>
        </div>

        <div className="broker-meta-config">
          <div className="broker-meta-config-head">
            <strong>Configuracao global de assessores para meta do broker</strong>
            <small className="muted">
              Esta configuracao vale para todos os blocos atuais e futuros na exclusao de assessores.
              {' '}O botao "Retirar broker" remove o broker dos blocos atuais.
              {' '}A receita absoluta do broker nao muda; apenas a receita usada para meta.
            </small>
          </div>

          {brokerMetaAssessorVisibleRows.length ? (
            <div className="broker-meta-config-list">
              {brokerMetaAssessorVisibleRows.map((row) => (
                <div key={`meta-assessor-${row.brokerKey}`} className="broker-meta-config-item">
                  <div className="broker-meta-config-card-head">
                    <div className="broker-meta-config-title">
                      <strong>{row.broker}</strong>
                      <span className="muted">
                        Receita meta: {formatCurrency(row.receitaMeta)} / Receita absoluta: {formatCurrency(row.receitaAbsoluta)}
                      </span>
                      <small className="muted">
                        {formatNumber(row.includedAssessorsCount)} assessor(es) ativos / {formatNumber(row.excludedAssessorsCount)} excluido(s)
                      </small>
                    </div>
                    <button
                      className="btn btn-danger broker-meta-config-remove-btn"
                      type="button"
                      onClick={() => handleRemoveBrokerFromAllBlocks(row.broker)}
                    >
                      Retirar broker
                    </button>
                  </div>

                  <div className="broker-meta-config-main">
                    <div className="broker-meta-config-actions">
                      <label className="broker-meta-config-field">
                        <span>Excluir assessor da receita de meta</span>
                        <select
                          className="input"
                          value={row.selectedAssessor}
                          onChange={(event) => handleBrokerMetaAssessorDraftChange(row.broker, event.target.value)}
                          disabled={!row.includedAssessors.length}
                        >
                          {row.includedAssessors.length ? null : (
                            <option value="">Sem assessores disponiveis</option>
                          )}
                          {row.includedAssessors.map((assessorName) => (
                            <option key={`${row.brokerKey}-include-${assessorName}`} value={assessorName}>
                              {assessorName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="btn btn-secondary broker-meta-config-btn"
                        type="button"
                        onClick={() => handleExcludeAssessorFromBrokerMeta(row.broker, row.selectedAssessor)}
                        disabled={!row.selectedAssessor}
                      >
                        Excluir da meta
                      </button>
                    </div>
                  </div>

                  {row.excludedAssessors.length ? (
                    <div className="broker-meta-excluded-list">
                      {row.excludedAssessors.map((assessorName) => (
                        <div key={`${row.brokerKey}-excluded-${assessorName}`} className="broker-meta-excluded-item">
                          <span className="broker-meta-assessor-name">{assessorName}</span>
                          <button
                            className="btn btn-secondary broker-meta-assessor-include-btn"
                            type="button"
                            onClick={() => handleIncludeAssessorInBrokerMeta(row.broker, assessorName)}
                          >
                            Considerar na meta
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">Nenhum assessor excluido da receita de meta para este broker.</span>
                  )}
                </div>
              ))}
            </div>
          ) : brokerMetaAssessorConfigRows.length ? (
            <span className="muted">Todos os brokers desta configuracao ja foram retirados dos blocos atuais.</span>
          ) : (
            <span className="muted">Sem brokers para configurar no periodo atual.</span>
          )}
        </div>

        <div className="broker-goals-grid">
          {goalBlocksView.map((block) => {
            const {
              isBlockEditing,
              blockDraft,
              activeBlock,
              includeOptions,
              includeBrokerValue,
            } = resolveGoalBlockRuntime(block)
            return (
            <article key={block.id} className="broker-goal-scenario">
              <div className="broker-goal-head">
                <div>
                  <strong>{activeBlock.name || `Bloco ${activeBlock.order}`}</strong>
                  <small className="muted">
                    {isBlockEditing
                      ? 'Edicao liberada para metas, remocao e definicao de quem entra no total do bloco.'
                      : 'Clique em editar para incluir/remover brokers, ajustar metas e definir quem entra no total.'}
                  </small>
                </div>
                <div className="goal-actions-cell">
                  {activeBlock.totals.progress != null ? (
                    <span className={`badge ${activeBlock.totals.reached ? 'badge-green' : 'badge-amber'}`}>
                      {activeBlock.totals.reached ? 'Atingida' : `${activeBlock.totals.progress.toFixed(1)}%`}
                    </span>
                  ) : (
                    <span className="badge badge-violet">Sem meta</span>
                  )}
                  <div className="goal-row-actions">
                    {isBlockEditing ? (
                      <>
                        <button
                          className="btn btn-secondary goal-row-action-btn"
                          type="button"
                          onClick={() => handleSaveGoalBlockEdit(block.id)}
                        >
                          Salvar brokers
                        </button>
                        <button
                          className="btn btn-secondary goal-row-action-btn"
                          type="button"
                          onClick={() => handleCancelGoalBlockEdit(block.id)}
                        >
                          Cancelar
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-secondary goal-row-action-btn"
                        type="button"
                        onClick={() => handleStartGoalBlockEdit(block.id, block.name, block.goalRaw)}
                        disabled={!isSingleGoalMonthSelected}
                        title={!isSingleGoalMonthSelected ? goalMonthEditWarning : ''}
                      >
                        Editar brokers
                      </button>
                    )}
                    <button
                      className="btn btn-danger goal-remove-btn"
                      type="button"
                      onClick={() => handleRemoveGoalBlock(block.id)}
                      disabled={!isSingleGoalMonthSelected}
                      title={!isSingleGoalMonthSelected ? goalMonthEditWarning : ''}
                    >
                      Remover
                    </button>
                  </div>
                </div>
              </div>

              {isBlockEditing ? (
                <div className="broker-goal-edit-grid">
                  <label className="broker-goal-input-field">
                    <span>Nome do bloco</span>
                    <input
                      className="input goals-target-input"
                      type="text"
                      value={String(blockDraft.name ?? '')}
                      onChange={(event) => setGoalBlockDraft((prev) => ({
                        ...prev,
                        [block.id]: {
                          ...prev[block.id],
                          name: event.target.value,
                        },
                      }))}
                      placeholder={`Ex: Bloco ${activeBlock.order} - Mesa A`}
                      aria-label={`Nome do bloco ${activeBlock.order}`}
                    />
                  </label>

                  <label className="broker-goal-input-field">
                    <span>Meta mensal por broker (R$)</span>
                    <input
                      className="input goals-target-input"
                      type="text"
                      inputMode="decimal"
                      value={String(blockDraft.goalRaw ?? '')}
                      onChange={(event) => setGoalBlockDraft((prev) => ({
                        ...prev,
                        [block.id]: {
                          ...prev[block.id],
                          goalRaw: event.target.value,
                        },
                      }))}
                      placeholder="Ex: 100000"
                      aria-label={`Meta mensal do bloco ${activeBlock.order}`}
                    />
                  </label>
                </div>
              ) : (
                <div className="broker-goal-metrics broker-goal-summary-grid">
                  <div className="broker-goal-metric">
                    <span>Nome do bloco</span>
                    <strong>{activeBlock.name || `Bloco ${activeBlock.order}`}</strong>
                  </div>
                  <div className="broker-goal-metric">
                    <span>Meta mensal por broker</span>
                    <strong>{activeBlock.goalDefault != null ? formatCurrency(activeBlock.goalDefault) : 'Sem meta'}</strong>
                  </div>
                </div>
              )}

              {isBlockEditing ? (
                <div className="goal-broker-include-bar">
                  <label className="goal-broker-include-field">
                    <span>Incluir broker no bloco</span>
                    <select
                      className="input"
                      value={includeBrokerValue}
                      onChange={(event) => setGoalBrokerIncludeDraft((prev) => ({
                        ...prev,
                        [block.id]: event.target.value,
                      }))}
                      disabled={!includeOptions.length}
                    >
                      {includeOptions.length ? null : (
                        <option value="">Sem brokers removidos</option>
                      )}
                      {includeOptions.map((broker) => (
                        <option key={`${block.id}-add-${broker}`} value={broker}>{broker}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn btn-secondary goal-broker-include-btn"
                    type="button"
                    onClick={() => handleIncludeBrokerInBlock(block.id, includeBrokerValue)}
                    disabled={!includeBrokerValue}
                  >
                    Incluir broker
                  </button>
                </div>
              ) : null}

              <div className="table-wrap goals-table-wrap broker-goal-table-wrap">
                <table className="data-table goals-table">
                  <thead>
                    <tr>
                      <th>Broker</th>
                      <th>Meta broker mensal (R$)</th>
                      <th>Receita broker (meta)</th>
                      <th>Receita total do broker</th>
                      <th>Gap</th>
                      <th>Atingimento</th>
                      <th>Soma no total</th>
                      <th>Acoes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeBlock.rows.length ? activeBlock.rows.map((row) => (
                      <tr key={`${block.id}-${row.broker}`} className={row.reached ? 'broker-goal-hit-row' : ''}>
                        <td>{row.broker}</td>
                        <td>
                          {!isBlockEditing ? (
                            <div className="broker-goal-row-display-wrap">
                              <strong>{row.goalValue != null ? formatCurrency(row.goalValue) : '-'}</strong>
                              {!row.hasCustomGoal && activeBlock.goalRaw ? (
                                <small className="muted">Usando padrao do bloco</small>
                              ) : null}
                            </div>
                          ) : (
                            <div className="broker-goal-row-input-wrap">
                              <input
                                className="input goals-target-input broker-goal-row-input"
                                type="text"
                                inputMode="decimal"
                                value={String(activeBlock.brokerGoals[row.broker] ?? row.goalRawInput ?? '')}
                                onChange={(event) => handleGoalBrokerDraftChange(block.id, row.broker, event.target.value)}
                                placeholder={activeBlock.goalRaw || 'Ex: 100000'}
                                aria-label={`Meta mensal de ${row.broker} no bloco ${activeBlock.order}`}
                              />
                            </div>
                          )}
                        </td>
                        <td>{formatCurrency(row.receitaMeta)}</td>
                        <td>{formatCurrency(row.receitaAbsoluta)}</td>
                        <td>
                          {row.goalValue != null ? (
                            row.reached ? (
                              <span className="goal-gap-hit">Superou {formatCurrency(row.gapAbs)}</span>
                            ) : (
                              <span className="goal-gap-open">Faltam {formatCurrency(row.gapAbs)}</span>
                            )
                          ) : (
                            <span className="muted">Sem meta</span>
                          )}
                        </td>
                        <td>
                          {row.progress != null ? (
                            <div className="goal-progress-wrap">
                              <span className={`badge ${row.reached ? 'badge-green' : 'badge-amber'}`}>
                                {row.reached ? 'Atingida' : `${row.progress.toFixed(1)}%`}
                              </span>
                              <div className="segment-bar">
                                <span
                                  style={{ width: `${clamp(row.progress || 0, 0, 100)}%` }}
                                  className={row.reached ? 'green' : 'amber'}
                                />
                              </div>
                            </div>
                          ) : (
                            <span className="muted">Sem calculo</span>
                          )}
                        </td>
                        <td>
                          {isBlockEditing ? (
                            <label
                              className={`goal-broker-total-toggle${row.countsInTotal ? ' active' : ''}`}
                              title={row.countsInTotal ? 'Este broker entra no total do bloco' : 'Este broker nao entra no total do bloco'}
                            >
                              <input
                                type="checkbox"
                                checked={row.countsInTotal}
                                onChange={(event) => handleToggleBrokerTotalContribution(block.id, row.broker, event.target.checked)}
                                aria-label={`Contar ${row.broker} no total do bloco ${activeBlock.order}`}
                              />
                              <span>{row.countsInTotal ? 'No total' : 'Fora do total'}</span>
                            </label>
                          ) : (
                            <span className={`badge ${row.countsInTotal ? 'badge-cyan' : 'badge-violet'}`}>
                              {row.countsInTotal ? 'No total' : 'Fora do total'}
                            </span>
                          )}
                        </td>
                        <td>
                          {isBlockEditing ? (
                            <div className="goal-row-actions">
                              <button
                                className="btn btn-danger goal-row-action-btn goal-row-remove-broker-btn"
                                type="button"
                                onClick={() => handleRemoveBrokerFromBlock(block.id, row.broker)}
                                aria-label={`Remover ${row.broker} do bloco ${activeBlock.order}`}
                              >
                                X
                              </button>
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={8}>
                          <span className="muted">Sem brokers com receita no periodo.</span>
                        </td>
                      </tr>
                    )}
                    <tr className={`broker-goal-total-row${activeBlock.totals.reached ? ' broker-goal-total-hit-row' : ''}`}>
                      <td><strong>Total bloco</strong></td>
                      <td><strong>{activeBlock.totals.hasTarget ? formatCurrency(activeBlock.totals.totalTarget) : '-'}</strong></td>
                      <td><strong>{formatCurrency(activeBlock.totals.totalRevenue)}</strong></td>
                      <td><strong>{formatCurrency(activeBlock.totals.totalRevenueAbsolute)}</strong></td>
                      <td>
                        {activeBlock.totals.hasTarget ? (
                          <strong className={activeBlock.totals.reached ? 'goal-gap-hit' : 'goal-gap-open'}>
                            {activeBlock.totals.reached
                              ? `Superou ${formatCurrency(activeBlock.totals.gapAbs)}`
                              : `Faltam ${formatCurrency(activeBlock.totals.gapAbs)}`}
                          </strong>
                        ) : (
                          <span className="muted">Sem meta</span>
                        )}
                      </td>
                      <td>
                        {activeBlock.totals.progress != null ? (
                          <span className={`badge ${activeBlock.totals.reached ? 'badge-green' : 'badge-amber'}`}>
                            {activeBlock.totals.reached ? 'Atingida' : `${activeBlock.totals.progress.toFixed(1)}%`}
                          </span>
                        ) : (
                          <span className="muted">Sem calculo</span>
                        )}
                      </td>
                      <td>
                        <span className="muted">
                          {formatNumber(activeBlock.rows.filter((row) => row.countsInTotal).length)} de {formatNumber(activeBlock.rows.length)} broker(s)
                        </span>
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </article>
            )
          })}
        </div>

      </section>

      </div>

    </div>

  )

}

export default Dashboard


