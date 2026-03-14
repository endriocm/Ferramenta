import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { formatNumber } from '../utils/format'
import { toNumber } from '../utils/number'
import { normalizeDateKey } from '../utils/dateKey'
import { normalizeAssessorName } from '../utils/assessor'
import { enrichRow, normalizeAssessorOverrideKey, normalizeSeniorityLabel } from '../services/tags'
import { loadStructuredRevenue } from '../services/revenueStructured'
import { loadManualRevenue, loadRevenueList } from '../services/revenueStore'
import {
  buildEffectiveBmfEntries,
  buildEffectiveBovespaEntries,
  buildEffectiveStructuredEntries,
} from '../services/revenueXpCommission'

const GAP_STATE_PREFIX = 'pwr.gap.state.'
const TIMES_PROFILE_PREFIX = 'pwr.times.profiles.'
const DASHBOARD_GOAL_BLOCKS_STORAGE_PREFIX = 'pwr.dashboard.goal-blocks.'

const FUNDED_CORRETAGEM_RATE = 0.005
const FUNDED_FIXED_REVENUE = 25.21

const GAP_REVENUE_MODE_BOVESPA = 'bovespa'
const GAP_REVENUE_MODE_BOVESPA_PLUS_FEE = 'bovespa_plus_fee'
const GAP_REVENUE_MODE_FEE = 'fee'

const OPERATION_TYPE_STRUCTURED = 'structured'
const OPERATION_TYPE_PREMIUM = 'premium'

const DEFAULT_PRODUCT_FEE_RAW = '0,16'

const DEFAULT_SENIORITY_GOALS = {
  Acad: 5000,
  Junior: 5000,
  'Junior Acad': 5000,
  Pleno: 8000,
  Senior: 13000,
}

const normalizeKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const normalizeText = (value) => String(value || '').trim()

let gapProductIdSequence = 0

const createGapProductId = () => {
  gapProductIdSequence += 1
  return `gap-product-${Date.now()}-${gapProductIdSequence}`
}

const normalizeRevenueMode = (value) => {
  const normalized = normalizeKey(value)
  if (normalized === GAP_REVENUE_MODE_BOVESPA) return GAP_REVENUE_MODE_BOVESPA
  if (normalized === GAP_REVENUE_MODE_BOVESPA_PLUS_FEE) return GAP_REVENUE_MODE_BOVESPA_PLUS_FEE
  if (normalized === GAP_REVENUE_MODE_FEE) return GAP_REVENUE_MODE_FEE
  if (normalized === OPERATION_TYPE_PREMIUM || normalized.includes('premio')) return GAP_REVENUE_MODE_FEE
  if (normalized === OPERATION_TYPE_STRUCTURED || normalized.includes('estrutur')) return GAP_REVENUE_MODE_BOVESPA_PLUS_FEE
  if (normalized.includes('bovespa') && normalized.includes('fee')) return GAP_REVENUE_MODE_BOVESPA_PLUS_FEE
  if (normalized.includes('bovespa')) return GAP_REVENUE_MODE_BOVESPA
  if (normalized.includes('fee')) return GAP_REVENUE_MODE_FEE
  return GAP_REVENUE_MODE_BOVESPA_PLUS_FEE
}

const createGapProductRow = (overrides = {}) => ({
  id: normalizeText(overrides.id) || createGapProductId(),
  name: normalizeText(overrides.name || overrides.structureName),
  revenueMode: normalizeRevenueMode(overrides.revenueMode || overrides.operationType),
  feeRaw: normalizeText(overrides.feeRaw) || DEFAULT_PRODUCT_FEE_RAW,
})

const normalizeGapProducts = (value) => {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      return createGapProductRow(item)
    })
    .filter(Boolean)
}

const buildDefaultPageState = () => ({
  selectedAssessor: '',
  products: [createGapProductRow()],
})

const buildGapStateKey = (userKey) => `${GAP_STATE_PREFIX}${String(userKey || 'guest').trim() || 'guest'}`
const buildTimesProfileKey = (userKey) => `${TIMES_PROFILE_PREFIX}${String(userKey || 'guest').trim() || 'guest'}`
const buildDashboardGoalBlocksKey = (userKey) => `${DASHBOARD_GOAL_BLOCKS_STORAGE_PREFIX}${String(userKey || 'guest').trim() || 'guest'}`

const normalizeGoalBlockBrokerGoals = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  Object.entries(value).forEach(([broker, rawValue]) => {
    const brokerName = normalizeText(broker)
    if (!brokerName) return
    normalized[brokerName] = normalizeText(rawValue)
  })
  return normalized
}

const normalizeGoalBlockExcludedBrokers = (value) => {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .map((item) => normalizeText(item))
      .filter(Boolean),
  ))
}

const normalizeGoalBlocks = (value) => {
  if (!Array.isArray(value)) return []
  return value
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null
      return {
        id: normalizeText(item.id) || `gap-block-${index + 1}`,
        name: normalizeText(item.name || item.title),
        goalRaw: normalizeText(item.goalRaw ?? item.goal),
        brokerGoals: normalizeGoalBlockBrokerGoals(item.brokerGoals),
        excludedBrokers: normalizeGoalBlockExcludedBrokers(item.excludedBrokers),
      }
    })
    .filter(Boolean)
}

const loadGapState = (userKey) => {
  const fallbackState = buildDefaultPageState()
  if (typeof window === 'undefined') return fallbackState
  try {
    const raw = window.localStorage.getItem(buildGapStateKey(userKey))
    if (!raw) return fallbackState
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallbackState

    const products = normalizeGapProducts(parsed.products)
    const legacyProduct = (!products.length && (
      parsed.structureName != null
      || parsed.feeRaw != null
      || parsed.operationType != null
    ))
      ? [createGapProductRow({
          name: parsed.structureName,
          feeRaw: parsed.feeRaw,
          operationType: parsed.operationType,
        })]
      : []

    return {
      selectedAssessor: normalizeText(parsed.selectedAssessor),
      products: products.length ? products : (legacyProduct.length ? legacyProduct : fallbackState.products),
    }
  } catch {
    return fallbackState
  }
}

const loadTimesProfiles = (userKey) => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(buildTimesProfileKey(userKey))
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const loadDashboardGoalBlocks = (userKey) => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(buildDashboardGoalBlocksKey(userKey))
    const parsed = raw ? JSON.parse(raw) : null
    return normalizeGoalBlocks(parsed)
  } catch {
    return []
  }
}

const parseFeeRate = (value) => {
  const raw = normalizeText(value)
  const parsed = toNumber(raw)
  if (parsed == null) return null
  if (raw.includes('%') || Math.abs(parsed) >= 1) return parsed / 100
  return parsed
}

const formatPercent = (value) => {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return '-'
  return `${(numericValue * 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`
}

const currencyDetailedFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const formatCurrencyDetailed = (value) => {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return '-'
  return currencyDetailedFormatter.format(numericValue)
}

const buildCurrentMonthKey = (referenceDate = new Date()) => {
  const year = referenceDate.getFullYear()
  const month = String(referenceDate.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const buildCurrentMonthLabel = (referenceDate = new Date()) => (
  referenceDate.toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
  })
)

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

const countBusinessDaysRemainingInMonth = (referenceDate = new Date()) => {
  const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate())
  const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0)
  return countBusinessDaysBetween(start, end)
}

const resolveWeeksRemaining = (businessDaysRemaining) => {
  if (!(businessDaysRemaining > 0)) return 0
  return Math.max(1, Math.ceil(businessDaysRemaining / 5))
}

const resolveEntryValue = (entry) => {
  const parsed = Number(entry?.receita ?? entry?.comissao ?? entry?.valor ?? entry?.value)
  return Number.isFinite(parsed) ? parsed : 0
}

const resolveEntryDateKey = (entry) => normalizeDateKey(entry?.dataEntrada || entry?.data || entry?.vencimento || '')
const resolveEntryMonthKey = (entry) => resolveEntryDateKey(entry).slice(0, 7)

const resolveManualLine = (entry) => {
  const origin = normalizeKey(entry?.origem || entry?.line || '')
  if (origin.includes('estrutur')) return 'Estruturadas'
  if (origin.includes('bmf') || origin.includes('futuro')) return 'BMF'
  if (origin.includes('bovespa') || origin === 'bov') return 'Bovespa'
  return 'Manual'
}

const revenueModeUsesBovespa = (revenueMode) => (
  revenueMode === GAP_REVENUE_MODE_BOVESPA
  || revenueMode === GAP_REVENUE_MODE_BOVESPA_PLUS_FEE
)

const revenueModeUsesFee = (revenueMode) => (
  revenueMode === GAP_REVENUE_MODE_FEE
  || revenueMode === GAP_REVENUE_MODE_BOVESPA_PLUS_FEE
)

const canEstimateAllocation = (revenueMode, feeRate) => {
  if (revenueMode === GAP_REVENUE_MODE_BOVESPA) return true
  const fee = Number(feeRate)
  return Number.isFinite(fee) && fee > 0
}

const estimateAllocation = (targetRevenue, revenueMode, feeRate) => {
  const target = Number(targetRevenue)
  if (!Number.isFinite(target) || target <= 0) return 0

  if (revenueMode === GAP_REVENUE_MODE_BOVESPA) {
    return Math.max((target - FUNDED_FIXED_REVENUE) / FUNDED_CORRETAGEM_RATE, 0)
  }

  const fee = Number(feeRate)
  if (!Number.isFinite(fee) || fee <= 0) return null

  if (revenueMode === GAP_REVENUE_MODE_FEE) {
    return target / fee
  }

  const variableRate = fee + FUNDED_CORRETAGEM_RATE
  if (!(variableRate > 0)) return null
  return Math.max((target - FUNDED_FIXED_REVENUE) / variableRate, 0)
}

const resolveAllocationRevenueBreakdown = (allocation, revenueMode, feeRate) => {
  const amount = Number(allocation)
  if (!Number.isFinite(amount) || amount < 0) return null

  const fee = Number(feeRate)
  const bovespaRevenue = revenueModeUsesBovespa(revenueMode)
    ? (amount * FUNDED_CORRETAGEM_RATE) + FUNDED_FIXED_REVENUE
    : 0
  const feeRevenue = revenueModeUsesFee(revenueMode) && Number.isFinite(fee) && fee > 0
    ? amount * fee
    : 0

  return {
    bovespaRevenue,
    feeRevenue,
    totalRevenue: bovespaRevenue + feeRevenue,
  }
}

const resolveRevenueModeLabel = (revenueMode) => {
  if (revenueMode === GAP_REVENUE_MODE_BOVESPA) return 'Receita Bovespa'
  if (revenueMode === GAP_REVENUE_MODE_FEE) return 'Fee'
  return 'Receita Bovespa + fee'
}

const resolveRevenueModeFormulaLabel = (revenueMode) => {
  if (revenueMode === GAP_REVENUE_MODE_BOVESPA) {
    return 'Receita Bovespa = (alocacao x 0,5%) + 25,21'
  }
  if (revenueMode === GAP_REVENUE_MODE_FEE) {
    return 'Fee = alocacao x fee'
  }
  return 'Receita total = (alocacao x (0,5% + fee)) + 25,21'
}

const resolveMostRecentLabel = (dateKey) => {
  const normalized = normalizeText(dateKey)
  if (!normalized) return '-'
  const [year, month, day] = normalized.split('-').map(Number)
  if (!year || !month || !day) return normalized
  return new Date(year, month - 1, day).toLocaleDateString('pt-BR')
}

const Gap = () => {
  const { userKey, selectedAssessor, tagsIndex } = useGlobalFilters()
  const [pageState, setPageState] = useState(() => loadGapState(userKey))
  const [reloadTick, setReloadTick] = useState(0)
  const now = useMemo(() => new Date(), [])
  const currentMonthKey = useMemo(() => buildCurrentMonthKey(now), [now])
  const currentMonthLabel = useMemo(() => buildCurrentMonthLabel(now), [now])
  const businessDaysRemaining = useMemo(() => countBusinessDaysRemainingInMonth(now), [now])
  const weeksRemaining = useMemo(() => resolveWeeksRemaining(businessDaysRemaining), [businessDaysRemaining])

  useEffect(() => {
    setPageState(loadGapState(userKey))
  }, [userKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(buildGapStateKey(userKey), JSON.stringify({
        selectedAssessor: normalizeText(pageState.selectedAssessor),
        products: (Array.isArray(pageState.products) ? pageState.products : []).map((product) => ({
          id: normalizeText(product.id) || createGapProductId(),
          name: normalizeText(product.name),
          revenueMode: normalizeRevenueMode(product.revenueMode),
          feeRaw: normalizeText(product.feeRaw),
        })),
      }))
    } catch {
      // noop
    }
  }, [pageState, userKey])

  useEffect(() => {
    const handleRefresh = () => setReloadTick((previous) => previous + 1)
    window.addEventListener('pwr:receita-updated', handleRefresh)
    window.addEventListener('pwr:tags-updated', handleRefresh)
    window.addEventListener('storage', handleRefresh)
    return () => {
      window.removeEventListener('pwr:receita-updated', handleRefresh)
      window.removeEventListener('pwr:tags-updated', handleRefresh)
      window.removeEventListener('storage', handleRefresh)
    }
  }, [])

  const timesProfiles = useMemo(() => loadTimesProfiles(userKey), [reloadTick, userKey])
  const goalBlocks = useMemo(() => loadDashboardGoalBlocks(userKey), [reloadTick, userKey])

  const currentMonthEntries = useMemo(() => {
    const rows = []
    const pushRows = (entries, line) => {
      ;(Array.isArray(entries) ? entries : []).forEach((entry, index) => {
        if (resolveEntryMonthKey(entry) !== currentMonthKey) return
        const enriched = enrichRow(entry, tagsIndex)
        rows.push({
          ...enriched,
          id: `${line}-${index}-${normalizeText(enriched?.id || enriched?.codigoCliente || enriched?.cliente || '')}`,
          line,
          value: resolveEntryValue(enriched),
          dateKey: resolveEntryDateKey(enriched),
        })
      })
    }

    pushRows(buildEffectiveStructuredEntries(loadStructuredRevenue()), 'Estruturadas')
    pushRows(buildEffectiveBovespaEntries(loadRevenueList('bovespa')), 'Bovespa')
    pushRows(buildEffectiveBmfEntries(loadRevenueList('bmf')), 'BMF')
    ;(loadManualRevenue() || []).forEach((entry, index) => {
      if (resolveEntryMonthKey(entry) !== currentMonthKey) return
      const enriched = enrichRow(entry, tagsIndex)
      rows.push({
        ...enriched,
        id: `manual-${index}-${normalizeText(enriched?.id || enriched?.codigoCliente || enriched?.cliente || '')}`,
        line: resolveManualLine(enriched),
        value: resolveEntryValue(enriched),
        dateKey: resolveEntryDateKey(enriched),
      })
    })

    return rows
  }, [currentMonthKey, reloadTick, tagsIndex])

  const assessorSummaries = useMemo(() => {
    const map = new Map()
    currentMonthEntries.forEach((entry) => {
      const assessor = normalizeAssessorName(entry?.assessor, '')
      if (!assessor) return
      const assessorKey = normalizeAssessorOverrideKey(assessor)
      if (!assessorKey) return
      const current = map.get(assessorKey) || {
        assessor,
        key: assessorKey,
        broker: '',
        team: '',
        seniority: '',
        totalRevenue: 0,
        bovespa: 0,
        bmf: 0,
        estruturadas: 0,
        manual: 0,
        latestDate: '',
      }
      current.totalRevenue += entry.value
      if (entry.line === 'Bovespa') current.bovespa += entry.value
      else if (entry.line === 'BMF') current.bmf += entry.value
      else if (entry.line === 'Estruturadas') current.estruturadas += entry.value
      else current.manual += entry.value

      if (!current.latestDate || (entry.dateKey && entry.dateKey >= current.latestDate)) {
        current.latestDate = entry.dateKey || current.latestDate
        if (normalizeText(entry?.broker)) current.broker = normalizeText(entry.broker)
        if (normalizeText(entry?.time)) current.team = normalizeText(entry.time)
        if (normalizeText(entry?.seniority)) current.seniority = normalizeText(entry.seniority)
      }
      map.set(assessorKey, current)
    })
    return map
  }, [currentMonthEntries])

  const brokerRevenueMap = useMemo(() => {
    const map = new Map()
    currentMonthEntries.forEach((entry) => {
      const broker = normalizeText(entry?.broker) || '--'
      map.set(broker, (map.get(broker) || 0) + entry.value)
    })
    return map
  }, [currentMonthEntries])

  const availableAssessors = useMemo(() => {
    const set = new Set()
    ;(Array.isArray(tagsIndex?.assessors) ? tagsIndex.assessors : []).forEach((item) => {
      const normalized = normalizeAssessorName(item, '')
      if (normalized) set.add(normalized)
    })
    assessorSummaries.forEach((item) => {
      if (item?.assessor) set.add(item.assessor)
    })
    return Array.from(set).sort((left, right) => left.localeCompare(right, 'pt-BR'))
  }, [assessorSummaries, tagsIndex?.assessors])

  const effectiveSelectedAssessor = useMemo(() => {
    const localAssessor = normalizeAssessorName(pageState.selectedAssessor, '')
    if (localAssessor) return localAssessor
    if (Array.isArray(selectedAssessor) && selectedAssessor.length === 1) {
      return normalizeAssessorName(selectedAssessor[0], '')
    }
    return ''
  }, [pageState.selectedAssessor, selectedAssessor])

  const assessorGapSummary = useMemo(() => {
    const assessor = normalizeAssessorName(effectiveSelectedAssessor, '')
    if (!assessor) return null
    const assessorKey = normalizeAssessorOverrideKey(assessor)
    const monthSummary = assessorSummaries.get(assessorKey) || null
    const tagRow = assessorKey ? tagsIndex?.byAssessor?.get(assessorKey) : null

    const baseTeam = normalizeText(monthSummary?.team || tagRow?.time)
    const profileKey = `${normalizeKey(baseTeam)}::${normalizeKey(assessor)}`
    const profile = (profileKey && timesProfiles && typeof timesProfiles === 'object') ? (timesProfiles[profileKey] || {}) : {}

    const resolvedTeam = normalizeText(profile?.team || monthSummary?.team || tagRow?.time) || 'Sem time'
    const resolvedBroker = normalizeText(monthSummary?.broker || tagRow?.broker) || '--'
    const resolvedSeniority = normalizeSeniorityLabel(profile?.seniority || monthSummary?.seniority || tagRow?.seniority || '')
    const goalOverride = toNumber(profile?.goalRaw)
    const goal = goalOverride != null && goalOverride > 0
      ? goalOverride
      : (DEFAULT_SENIORITY_GOALS[resolvedSeniority] || 0)
    const revenue = Number(monthSummary?.totalRevenue) || 0
    const gap = Math.max(goal - revenue, 0)
    const overGoal = Math.max(revenue - goal, 0)
    const revenuePerWeek = weeksRemaining > 0 ? gap / weeksRemaining : gap
    const revenuePerDay = businessDaysRemaining > 0 ? gap / businessDaysRemaining : gap

    return {
      assessor,
      key: assessorKey,
      broker: resolvedBroker,
      team: resolvedTeam,
      seniority: resolvedSeniority || 'Sem nivel',
      revenue,
      bovespa: Number(monthSummary?.bovespa) || 0,
      bmf: Number(monthSummary?.bmf) || 0,
      estruturadas: Number(monthSummary?.estruturadas) || 0,
      manual: Number(monthSummary?.manual) || 0,
      goal,
      gap,
      overGoal,
      latestDate: monthSummary?.latestDate || '',
      revenuePerMonth: gap,
      revenuePerWeek,
      revenuePerDay,
    }
  }, [assessorSummaries, businessDaysRemaining, effectiveSelectedAssessor, tagsIndex, timesProfiles, weeksRemaining])

  const productPlans = useMemo(() => (
    (Array.isArray(pageState.products) ? pageState.products : []).map((product, index) => {
      const revenueMode = normalizeRevenueMode(product.revenueMode)
      const feeRate = parseFeeRate(product.feeRaw)
      const usesBovespa = revenueModeUsesBovespa(revenueMode)
      const usesFee = revenueModeUsesFee(revenueMode)
      const canCalculate = canEstimateAllocation(revenueMode, feeRate)
      const monthAllocation = assessorGapSummary
        ? estimateAllocation(assessorGapSummary.revenuePerMonth, revenueMode, feeRate)
        : null
      const weekAllocation = assessorGapSummary
        ? estimateAllocation(assessorGapSummary.revenuePerWeek, revenueMode, feeRate)
        : null
      const dayAllocation = assessorGapSummary
        ? estimateAllocation(assessorGapSummary.revenuePerDay, revenueMode, feeRate)
        : null

      return {
        id: product.id,
        name: normalizeText(product.name) || `Produto ${index + 1}`,
        revenueMode,
        revenueModeLabel: resolveRevenueModeLabel(revenueMode),
        formulaLabel: resolveRevenueModeFormulaLabel(revenueMode),
        feeRate,
        usesBovespa,
        usesFee,
        canCalculate,
        monthAllocation,
        weekAllocation,
        dayAllocation,
        monthRevenue: monthAllocation == null
          ? null
          : resolveAllocationRevenueBreakdown(monthAllocation, revenueMode, feeRate),
      }
    })
  ), [assessorGapSummary, pageState.products])

  const blockRows = useMemo(() => {
    if (!assessorGapSummary?.broker) return []
    const broker = assessorGapSummary.broker
    const brokerRevenue = brokerRevenueMap.get(broker) || 0

    return goalBlocks
      .map((block, index) => {
        const excluded = new Set(block.excludedBrokers || [])
        if (excluded.has(broker)) return null

        const blockDefaultGoal = toNumber(block.goalRaw)
        const customGoal = toNumber(block.brokerGoals?.[broker])
        const goalValue = customGoal != null && customGoal > 0
          ? customGoal
          : (blockDefaultGoal != null && blockDefaultGoal > 0 ? blockDefaultGoal : null)
        if (goalValue == null) return null

        const gap = Math.max(goalValue - brokerRevenue, 0)
        const surplus = Math.max(brokerRevenue - goalValue, 0)
        const revenuePerWeek = weeksRemaining > 0 ? gap / weeksRemaining : gap
        const revenuePerDay = businessDaysRemaining > 0 ? gap / businessDaysRemaining : gap

        return {
          id: `${block.id}-${broker}`,
          blockName: block.name || `Bloco ${index + 1}`,
          broker,
          target: goalValue,
          revenue: brokerRevenue,
          gap,
          surplus,
          revenuePerWeek,
          revenuePerDay,
          reached: gap <= 0,
        }
      })
      .filter(Boolean)
  }, [assessorGapSummary?.broker, brokerRevenueMap, businessDaysRemaining, goalBlocks, weeksRemaining])

  const pageMeta = useMemo(() => ([
    { label: 'Periodo', value: currentMonthLabel },
    { label: 'Dias uteis restantes', value: formatNumber(businessDaysRemaining) },
    { label: 'Semanas restantes', value: formatNumber(weeksRemaining) },
    { label: 'Produtos simulados', value: formatNumber(pageState.products.length) },
  ]), [businessDaysRemaining, currentMonthLabel, pageState.products.length, weeksRemaining])

  const blockColumns = useMemo(() => ([
    { key: 'blockName', label: 'Bloco' },
    { key: 'target', label: 'Meta broker', render: (row) => formatCurrencyDetailed(row.target) },
    { key: 'revenue', label: 'Receita broker', render: (row) => formatCurrencyDetailed(row.revenue) },
    { key: 'gap', label: 'Gap', render: (row) => formatCurrencyDetailed(row.gap) },
    { key: 'revenuePerWeek', label: 'Gap/semana', render: (row) => formatCurrencyDetailed(row.revenuePerWeek) },
    { key: 'revenuePerDay', label: 'Gap/dia', render: (row) => formatCurrencyDetailed(row.revenuePerDay) },
    {
      key: 'status',
      label: 'Status',
      render: (row) => (
        <span className={row.reached ? 'text-positive' : 'text-negative'}>
          {row.reached ? 'Meta batida' : 'Em aberto'}
        </span>
      ),
    },
  ]), [])

  const headerActions = useMemo(() => ([
    {
      label: 'Atualizar',
      icon: 'sync',
      variant: 'btn-secondary',
      onClick: () => setReloadTick((previous) => previous + 1),
    },
  ]), [])

  const handleProductFieldChange = (productId, field, value) => {
    setPageState((previous) => ({
      ...previous,
      products: previous.products.map((product) => (
        product.id === productId
          ? { ...product, [field]: value }
          : product
      )),
    }))
  }

  const handleAddProduct = () => {
    setPageState((previous) => ({
      ...previous,
      products: [...previous.products, createGapProductRow()],
    }))
  }

  const handleRemoveProduct = (productId) => {
    setPageState((previous) => {
      if (previous.products.length <= 1) return previous
      return {
        ...previous,
        products: previous.products.filter((product) => product.id !== productId),
      }
    })
  }

  return (
    <div className="page gap-page">
      <PageHeader
        title="Gap"
        subtitle="Calcula o gap de receita do assessor e simula, por produto, quanto precisa ser alocado para fechar a meta."
        meta={pageMeta}
        actions={headerActions}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Configuracao do gap</h3>
            <p className="muted">Selecione o assessor e monte as linhas de produtos para comparar alocacao por tipo de receita.</p>
          </div>
        </div>

        <div className="filter-grid gap-config-grid">
          <label className="gap-field">
            <span>Assessor</span>
            <select
              className="input"
              value={effectiveSelectedAssessor}
              onChange={(event) => setPageState((previous) => ({
                ...previous,
                selectedAssessor: event.target.value,
              }))}
            >
              <option value="">Selecione um assessor</option>
              {availableAssessors.map((assessor) => (
                <option key={assessor} value={assessor}>{assessor}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="gap-products-toolbar">
          <div>
            <h4>Produtos para simular</h4>
            <p className="muted">Use uma linha por produto. O fee aceita `0,16`, `1` ou `1%`.</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleAddProduct}
          >
            Adicionar produto
          </button>
        </div>

        <div className="gap-products-list">
          {pageState.products.map((product, index) => {
            const productPlan = productPlans[index] || null
            return (
              <article key={product.id} className="gap-product-row">
                <div className="gap-product-row-grid">
                  <label className="gap-field">
                    <span>Produto {index + 1}</span>
                    <input
                      className="input"
                      type="text"
                      value={product.name}
                      onChange={(event) => handleProductFieldChange(product.id, 'name', event.target.value)}
                      placeholder="Ex.: Call Spread, Rubi, Collar"
                    />
                  </label>

                  <label className="gap-field">
                    <span>Receita usada</span>
                    <select
                      className="input"
                      value={normalizeRevenueMode(product.revenueMode)}
                      onChange={(event) => handleProductFieldChange(product.id, 'revenueMode', event.target.value)}
                    >
                      <option value={GAP_REVENUE_MODE_BOVESPA}>Receita Bovespa</option>
                      <option value={GAP_REVENUE_MODE_BOVESPA_PLUS_FEE}>Receita Bovespa + fee</option>
                      <option value={GAP_REVENUE_MODE_FEE}>Fee</option>
                    </select>
                  </label>

                  <label className="gap-field">
                    <span>Fee da operacao</span>
                    <input
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={product.feeRaw}
                      onChange={(event) => handleProductFieldChange(product.id, 'feeRaw', event.target.value)}
                      placeholder="Ex.: 1 ou 1%"
                    />
                  </label>

                  <div className="gap-product-actions">
                    <span>Linha</span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleRemoveProduct(product.id)}
                      disabled={pageState.products.length <= 1}
                    >
                      Remover
                    </button>
                  </div>
                </div>

                <div className="gap-helper-row gap-product-helper-row">
                  <span className="gap-helper-pill">{productPlan?.formulaLabel || resolveRevenueModeFormulaLabel(product.revenueMode)}</span>
                  <span className="gap-helper-pill">
                    {productPlan?.usesFee
                      ? `Fee interpretado: ${productPlan?.canCalculate ? formatPercent(productPlan.feeRate) : 'preencha um fee valido'}`
                      : 'Fee nao entra neste calculo'}
                  </span>
                  {productPlan?.usesBovespa ? (
                    <span className="gap-helper-pill">Base Bovespa: 0,5% + {formatCurrencyDetailed(FUNDED_FIXED_REVENUE)}</span>
                  ) : null}
                </div>

                {assessorGapSummary ? (
                  <div className="gap-product-result-grid">
                    <article className="gap-product-stat">
                      <small>Aloc. mes</small>
                      <strong>{productPlan?.monthAllocation == null ? '—' : formatCurrencyDetailed(productPlan.monthAllocation)}</strong>
                      <span>
                        {productPlan?.monthAllocation == null
                          ? 'Informe um fee valido para calcular.'
                          : `Gap do mes: ${formatCurrencyDetailed(assessorGapSummary.revenuePerMonth)}`}
                      </span>
                    </article>

                    <article className="gap-product-stat">
                      <small>Aloc. semana</small>
                      <strong>{productPlan?.weekAllocation == null ? '—' : formatCurrencyDetailed(productPlan.weekAllocation)}</strong>
                      <span>
                        {productPlan?.weekAllocation == null
                          ? 'Sem simulacao semanal.'
                          : `Gap semanal: ${formatCurrencyDetailed(assessorGapSummary.revenuePerWeek)}`}
                      </span>
                    </article>

                    <article className="gap-product-stat">
                      <small>Aloc. dia</small>
                      <strong>{productPlan?.dayAllocation == null ? '—' : formatCurrencyDetailed(productPlan.dayAllocation)}</strong>
                      <span>
                        {productPlan?.dayAllocation == null
                          ? 'Sem simulacao diaria.'
                          : `Gap diario: ${formatCurrencyDetailed(assessorGapSummary.revenuePerDay)}`}
                      </span>
                    </article>

                    <article className="gap-product-stat gap-product-preview">
                      <small>{productPlan?.name || `Produto ${index + 1}`}</small>
                      <strong>{productPlan?.monthRevenue == null ? '—' : formatCurrencyDetailed(productPlan.monthRevenue.totalRevenue)}</strong>
                      <span>{productPlan?.revenueModeLabel || resolveRevenueModeLabel(product.revenueMode)}</span>
                      {productPlan?.monthRevenue && productPlan.usesBovespa ? (
                        <span>Bovespa {formatCurrencyDetailed(productPlan.monthRevenue.bovespaRevenue)}</span>
                      ) : null}
                      {productPlan?.monthRevenue && productPlan.usesFee ? (
                        <span>Fee {formatCurrencyDetailed(productPlan.monthRevenue.feeRevenue)}</span>
                      ) : null}
                    </article>
                  </div>
                ) : (
                  <div className="gap-product-empty">
                    <p className="muted">Selecione um assessor para calcular a alocacao desta linha.</p>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </section>

      {assessorGapSummary ? (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Gap do assessor</h3>
                <p className="muted">
                  {assessorGapSummary.assessor}
                  {' • '}
                  {assessorGapSummary.team}
                  {' • '}
                  Broker {assessorGapSummary.broker}
                  {' • '}
                  {assessorGapSummary.seniority}
                </p>
              </div>
            </div>

            <div className="gap-kpi-grid">
              <article className="gap-kpi-card">
                <small>Receita atual</small>
                <strong>{formatCurrencyDetailed(assessorGapSummary.revenue)}</strong>
                <span className="muted">Atualizado ate {resolveMostRecentLabel(assessorGapSummary.latestDate)}</span>
              </article>

              <article className="gap-kpi-card">
                <small>Meta do Times</small>
                <strong>{formatCurrencyDetailed(assessorGapSummary.goal)}</strong>
                <span className="muted">Meta mensal do assessor</span>
              </article>

              <article className="gap-kpi-card">
                <small>Gap da meta</small>
                <strong>{formatCurrencyDetailed(assessorGapSummary.gap)}</strong>
                <span className="muted">{assessorGapSummary.gap <= 0 ? 'Meta batida' : 'Falta para atingir a meta'}</span>
              </article>

              <article className="gap-kpi-card">
                <small>Acima da meta</small>
                <strong>{formatCurrencyDetailed(assessorGapSummary.overGoal)}</strong>
                <span className="muted">Sobra no mes atual</span>
              </article>
            </div>

            <div className="gap-breakdown-grid">
              <article className="gap-breakdown-card">
                <small>Receita por linha</small>
                <strong>Bovespa {formatCurrencyDetailed(assessorGapSummary.bovespa)}</strong>
                <span>Estruturadas {formatCurrencyDetailed(assessorGapSummary.estruturadas)}</span>
                <span>BMF {formatCurrencyDetailed(assessorGapSummary.bmf)}</span>
                <span>Manual {formatCurrencyDetailed(assessorGapSummary.manual)}</span>
              </article>

              <article className="gap-breakdown-card">
                <small>Receita necessaria</small>
                <strong>Mes {formatCurrencyDetailed(assessorGapSummary.revenuePerMonth)}</strong>
                <span>Semana {formatCurrencyDetailed(assessorGapSummary.revenuePerWeek)}</span>
                <span>Dia {formatCurrencyDetailed(assessorGapSummary.revenuePerDay)}</span>
              </article>

              <article className="gap-breakdown-card">
                <small>Simulacao por linha</small>
                <strong>{formatNumber(pageState.products.length)} produto(s)</strong>
                <span>As alocacoes ficam calculadas acima, uma linha por produto.</span>
                <span>Compare Bovespa, Bovespa + fee ou somente fee.</span>
              </article>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Gap por bloco do broker</h3>
                <p className="muted">
                  Cada bloco usa a meta da Dashboard para o broker {assessorGapSummary.broker}. A alocacao fica na simulacao por produto acima.
                </p>
              </div>
            </div>

            {blockRows.length ? (
              <div className="gap-block-table">
                <DataTable
                  columns={blockColumns}
                  rows={blockRows}
                  visibleRows={6}
                />
              </div>
            ) : (
              <div className="gap-empty-inline">
                <h4>Nenhum bloco com meta para este broker.</h4>
                <p className="muted">Cadastre ou ajuste os blocos na Dashboard para visualizar o gap por bloco aqui.</p>
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="panel">
          <div className="gap-empty-inline">
            <h4>Selecione um assessor para calcular o gap.</h4>
            <p className="muted">O calculo usa a meta mensal da aba de Times e a receita do mes atual ({currentMonthLabel}).</p>
          </div>
        </section>
      )}
    </div>
  )
}

export default Gap
