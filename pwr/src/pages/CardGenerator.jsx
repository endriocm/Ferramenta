import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import PayoffChart from '../components/cards/PayoffChart'
import PayoffTable from '../components/cards/PayoffTable'
import OperationsConsolidatorPreview from '../components/cards/OperationsConsolidatorPreview'
import StrategyCardPreview from '../components/cards/StrategyCardPreview'
import { useToast } from '../hooks/useToast'
import {
  buildStrategyModel,
  createStrategyOptionEntry,
  getStrategyDefaults,
  getStrategyFields,
  getStrategyOptionForm,
  inferOptionSyncForTemplate,
  strategyTemplateOptions,
} from '../services/strategyTemplates'
import { copyCardImageToClipboard, exportCardAsPdf, exportCardAsPng } from '../services/cardExport'
import { buildCardPaletteStyles, cardPalettes, getCardPaletteById } from '../services/cardPalettes'
import { extractCardDataFromImageText } from '../services/cardImageImport'
import { fetchCompanyProfile } from '../services/companyProfile'
import { getCurrentUserKey } from '../services/currentUser'
import { fetchYahooMarketData, normalizeYahooSymbol } from '../services/marketData'
import { readImageText } from '../services/ocrService'
import { formatCurrency } from '../utils/format'

const sectionOrder = ['Identificacao', 'Comercial']
const layoutOptions = [
  { value: 'payoff', label: 'Card payoff (cliente)' },
  { value: 'destaque', label: 'Ofertas destaque' },
  { value: 'consolidado', label: 'Card consolidador (operacoes)' },
]
const consolidatorGroupOrder = ['PREMIO', 'CUPOM', 'GANHO COM A ALTA', 'CARTEIRAS', 'OUTRAS']
const consolidatorTemplateGroupMap = {
  call: 'PREMIO',
  put: 'PREMIO',
  call_spread: 'PREMIO',
  put_spread: 'PREMIO',
  rubi: 'CUPOM',
  rubi_black: 'CUPOM',
  smart_coupon: 'CUPOM',
  cupom_recorrente: 'CUPOM',
  collar_ui: 'GANHO COM A ALTA',
  collar: 'GANHO COM A ALTA',
  fence_ui: 'GANHO COM A ALTA',
  collar_ui_bidirecional: 'GANHO COM A ALTA',
  booster_ko: 'GANHO COM A ALTA',
  doc_bidirecional: 'GANHO COM A ALTA',
  alocacao_protegida: 'GANHO COM A ALTA',
  pop: 'GANHO COM A ALTA',
}
const maturityMonths = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']
const CARD_GENERATOR_STATE_VERSION = 3
const CARD_GENERATOR_STORAGE_PREFIX = 'pwr.card_generator.state'
const DEFAULT_FORM_SECTIONS = Object.freeze({
  operation: false,
  options: true,
  consolidator: true,
  message: true,
})
const CAPITAL_PROTECTION_TEMPLATE_IDS = new Set([
  'collar_ui',
  'collar',
  'collar_ui_bidirecional',
  'alocacao_protegida',
  'alocacao_protegida_sob_custodia',
])
const CONSOLIDATOR_DOWNSIDE_PROTECTION_TEMPLATE_IDS = new Set([
  'doc_bidirecional',
  'rubi',
  'rubi_black',
])
const DOWNSIDE_BARRIER_EDGE_STEP = 0.01
const CONSOLIDATOR_HIDE_MAX_LOSS_TEMPLATE_IDS = new Set([
  ...CONSOLIDATOR_DOWNSIDE_PROTECTION_TEMPLATE_IDS,
])

const buildGroupedFields = (fields) => {
  const groups = new Map()
  ;(Array.isArray(fields) ? fields : []).forEach((field) => {
    const section = field.section || 'Outros'
    if (!groups.has(section)) groups.set(section, [])
    groups.get(section).push(field)
  })
  return sectionOrder
    .filter((section) => groups.has(section))
    .map((section) => ({ section, fields: groups.get(section) }))
}

const templateOptions = strategyTemplateOptions
const CALL_SPREAD_AUTOMATIC_LOT_SIZE = 100
const isStockType = (value) => String(value || '').trim().toUpperCase() === 'STOCK'
const isExplicitBarrierType = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  return raw === 'UI' || raw === 'UO' || raw === 'KI' || raw === 'KO' || raw === 'DI' || raw === 'DO'
}

const toPositiveNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  let cleaned = String(value).trim().replace(/[^\d,.-]/g, '')
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.')
  }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, '')
  }
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    cleaned = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(/,/g, '.')
      : cleaned.replace(/,/g, '')
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const formatCompactCurrency = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(number)
}

const formatOptionalNumber = (value, digits = 2) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return number.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

const formatOptionalPct = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return `${number.toFixed(2).replace('.', ',')}%`
}

const resolveCallSpreadCostPct = (values = {}) => {
  const explicitCost = toPositiveNumber(values?.optionCostPct)
  if (explicitCost != null) return Math.min(explicitCost, 100)
  const premiumCost = toPositiveNumber(values?.premiumPct)
  if (premiumCost != null) return Math.min(premiumCost, 100)
  return null
}

const parseDateLike = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split('/').map(Number)
    const date = new Date(year, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

const formatMaturityMonth = (value) => {
  const date = parseDateLike(value)
  if (!date) return '--'
  const month = maturityMonths[date.getMonth()] || '--'
  return `${month} / ${date.getFullYear()}`
}

const formatDateTimeLabel = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('pt-BR')
}

const extractTickerFromTitle = (value) => {
  const match = String(value || '').match(/\(([^)]+)\)/)
  return match?.[1] || ''
}

const compactInlineText = (value) => String(value || '')
  .replace(/\*/g, '')
  .replace(/\s+/g, ' ')
  .trim()

const summarizeConsolidatorLine = (value, maxLength = 100) => {
  const clean = compactInlineText(value)
  if (!clean) return ''
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trim()}...` : clean
}

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null)

const sanitizeFormSections = (value) => {
  const source = asObject(value)
  return {
    operation: source?.operation !== false,
    options: source?.options !== false,
    consolidator: source?.consolidator !== false,
    message: source?.message !== false,
  }
}

const sanitizeSnapshotScalarValues = (value) => {
  const source = asObject(value)
  if (!source) return {}
  return Object.entries(source).reduce((acc, [rawKey, rawValue]) => {
    const key = String(rawKey || '').trim()
    if (!key || key === 'options') return acc
    if (rawValue == null || rawValue === '') return acc
    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      acc[key] = rawValue
    }
    return acc
  }, {})
}

const sanitizeSnapshotOptionEntries = (entries) => (
  (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const source = asObject(entry)
      if (!source) return null
      return {
        id: String(source.id || `opt-${index + 1}`).trim(),
        label: String(source.label || '').trim(),
        optionType: String(source.optionType || '').trim().toUpperCase(),
        side: String(source.side || '').trim().toLowerCase(),
        quantity: String(source.quantity ?? '').trim(),
        strike: String(source.strike ?? '').trim(),
        barrierType: String(source.barrierType ?? '').trim().toUpperCase(),
        barrierValue: String(source.barrierValue ?? '').trim(),
        coupon: String(source.coupon ?? '').trim(),
      }
    })
    .filter(Boolean)
)

const sanitizeSnapshotPayoffRows = (rows) => (
  (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const source = asObject(row)
      if (!source) return null
      const underlyingVarPct = Number(source.underlyingVarPct)
      const strategyVarPct = Number(source.strategyVarPct)
      if (!Number.isFinite(underlyingVarPct) || !Number.isFinite(strategyVarPct)) return null
      return {
        underlyingVarPct,
        strategyVarPct,
        strategyTone: String(source.strategyTone || '').trim(),
      }
    })
    .filter(Boolean)
)

const sanitizeSnapshotMetrics = (metrics) => (
  (Array.isArray(metrics) ? metrics : [])
    .map((metric) => {
      const source = asObject(metric)
      if (!source) return null
      const label = String(source.label || '').trim()
      const value = String(source.value || '').trim()
      if (!label || !value) return null
      return { label, value }
    })
    .filter(Boolean)
)

const sanitizeConsolidatorSnapshot = (value) => {
  const source = asObject(value)
  if (!source) return null
  const highlights = (Array.isArray(source.highlights) ? source.highlights : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 6)
  const messageText = String(source.messageText || '').trim()
  const parsedMessage = parseEditableMessage(messageText)
  const messageBlocks = sanitizeSnapshotMessageBlocks(source.messageBlocks)
  const messageFooterLines = sanitizeSnapshotMessageFooterLines(source.messageFooterLines)
  return {
    capturedAt: String(source.capturedAt || '').trim(),
    layoutMode: String(source.layoutMode || '').trim() || 'payoff',
    tableHeadLeft: String(source.tableHeadLeft || '').trim(),
    tableHeadRight: String(source.tableHeadRight || '').trim(),
    messageText,
    messageHeaderLine: String(source.messageHeaderLine || parsedMessage.headerLine || '').trim(),
    messageBlocks: messageBlocks.length ? messageBlocks : sanitizeSnapshotMessageBlocks(parsedMessage.blocks),
    messageFooterLines: messageFooterLines.length ? messageFooterLines : sanitizeSnapshotMessageFooterLines(parsedMessage.footerLines),
    values: sanitizeSnapshotScalarValues(source.values),
    options: sanitizeSnapshotOptionEntries(source.options),
    payoffRows: sanitizeSnapshotPayoffRows(source.payoffRows),
    metrics: sanitizeSnapshotMetrics(source.metrics),
    highlights,
  }
}

const sanitizeSavedMessages = (value) => {
  const source = asObject(value)
  if (!source) return {}
  return Object.entries(source).reduce((acc, [rawTemplateId, rawMessage]) => {
    const templateId = String(rawTemplateId || '').trim()
    if (!templateId) return acc
    const message = String(rawMessage || '')
    if (!message.trim()) return acc
    acc[templateId] = message
    return acc
  }, {})
}

const getCardGeneratorStorageKey = () => {
  const userKey = String(getCurrentUserKey() || 'guest').trim() || 'guest'
  return `${CARD_GENERATOR_STORAGE_PREFIX}.${userKey}`
}

const sanitizeConsolidatedEntries = (entries) => (
  (Array.isArray(entries) ? entries : [])
    .map((entry) => asObject(entry))
    .filter(Boolean)
    .map((entry) => ({
      id: String(entry.id || `op-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
      templateId: String(entry.templateId || '').trim(),
      templateLabel: String(entry.templateLabel || '').trim(),
      group: String(entry.group || '').trim() || 'OUTRAS',
      ticker: String(entry.ticker || '').trim().toUpperCase(),
      companyName: String(entry.companyName || '').trim(),
      operationLabel: String(entry.operationLabel || '').trim(),
      maturityLabel: String(entry.maturityLabel || '').trim(),
      summary: String(entry.summary || '').trim(),
      roaInput: String(entry.roaInput ?? '').trim(),
      snapshot: sanitizeConsolidatorSnapshot(entry.snapshot),
    }))
)

const resolveInitialCardGeneratorState = (initialTemplateId) => {
  const defaults = getStrategyDefaults(initialTemplateId)
  const inferredStockQty = inferReferenceQtyFromStockEntries(defaults.options)
  const normalizedDefaults = {
    ...defaults,
    stockQuantity: String(defaults?.stockQuantity ?? '').trim() || (inferredStockQty != null ? String(inferredStockQty) : ''),
    options: removeStockEntries(defaults.options),
  }

  if (typeof window === 'undefined') {
    return {
      storageKey: `${CARD_GENERATOR_STORAGE_PREFIX}.guest`,
      templateId: initialTemplateId,
      layoutMode: 'payoff',
      paletteId: 'gold_standard',
      showCompanyLogo: true,
      values: normalizedDefaults,
      optionDraftEntries: cloneOptionEntries(normalizedDefaults.options),
      messageText: '',
      messageDirty: false,
      savedMessages: {},
      consolidatedEntries: [],
      formSections: { ...DEFAULT_FORM_SECTIONS },
    }
  }

  const storageKey = getCardGeneratorStorageKey()
  const raw = window.localStorage.getItem(storageKey)
  const parsed = safeJsonParse(raw)
  const payload = asObject(parsed)
  const validTemplateIds = new Set(templateOptions.map((option) => option.value))
  const persistedTemplateId = String(payload?.templateId || '').trim()
  const resolvedTemplateId = validTemplateIds.has(persistedTemplateId) ? persistedTemplateId : initialTemplateId
  const persistedDefaults = getStrategyDefaults(resolvedTemplateId)
  const persistedState = asObject(payload?.values)
  const mergedValues = {
    ...persistedDefaults,
    ...(persistedState || {}),
  }
  const normalizedValues = {
    ...mergedValues,
    options: removeStockEntries(mergedValues.options),
  }
  const normalizedDraft = removeStockEntries(payload?.optionDraftEntries || normalizedValues.options)
  const inferredQty = inferReferenceQtyFromStockEntries([...(normalizedValues.options || []), ...normalizedDraft])
  if (!String(normalizedValues.stockQuantity ?? '').trim() && inferredQty != null) {
    normalizedValues.stockQuantity = String(inferredQty)
  }

  const layoutModeRaw = String(payload?.layoutMode || '').trim()
  const validLayouts = new Set(layoutOptions.map((option) => option.value))
  const layoutMode = validLayouts.has(layoutModeRaw) ? layoutModeRaw : 'payoff'
  const paletteIdRaw = String(payload?.paletteId || '').trim()
  const validPaletteIds = new Set(cardPalettes.map((palette) => palette.id))
  const paletteId = validPaletteIds.has(paletteIdRaw) ? paletteIdRaw : 'gold_standard'
  const savedMessages = sanitizeSavedMessages(payload?.savedMessages)
  const savedMessageForTemplate = String(savedMessages[resolvedTemplateId] || '')
  const hasSavedMessageForTemplate = savedMessageForTemplate.trim().length > 0
  const formSections = sanitizeFormSections(payload?.formSections)

  return {
    storageKey,
    templateId: resolvedTemplateId,
    layoutMode,
    paletteId,
    showCompanyLogo: payload?.showCompanyLogo !== false,
    values: normalizedValues,
    optionDraftEntries: cloneOptionEntries(normalizedDraft),
    messageText: hasSavedMessageForTemplate ? savedMessageForTemplate : String(payload?.messageText || ''),
    messageDirty: hasSavedMessageForTemplate ? true : Boolean(payload?.messageDirty),
    savedMessages,
    consolidatedEntries: sanitizeConsolidatedEntries(payload?.consolidatedEntries),
    formSections: {
      ...formSections,
      operation: false,
    },
  }
}

const resolveConsolidatorPayoffStats = (model) => {
  const rows = Array.isArray(model?.payoffRows) ? model.payoffRows : []
  const parsedRows = rows
    .map((row) => ({
      underlyingVarPct: Number(row?.underlyingVarPct),
      strategyVarPct: Number(row?.strategyVarPct),
    }))
    .filter((row) => Number.isFinite(row.underlyingVarPct) && Number.isFinite(row.strategyVarPct))

  if (!parsedRows.length) {
    return { maxGain: null, maxLoss: null }
  }

  const rawBarrier = model?.maxGainBarrierPct
  const barrier = rawBarrier == null || rawBarrier === '' ? null : Number(rawBarrier)
  const gainRows = Number.isFinite(barrier)
    ? parsedRows.filter((row) => row.underlyingVarPct < barrier)
    : parsedRows
  const effectiveGainRows = gainRows.length ? gainRows : parsedRows

  const maxGain = effectiveGainRows.reduce(
    (best, row) => (row.strategyVarPct > best ? row.strategyVarPct : best),
    -Infinity,
  )
  const maxLoss = parsedRows.reduce(
    (best, row) => (row.strategyVarPct < best ? row.strategyVarPct : best),
    Infinity,
  )

  return {
    maxGain: Number.isFinite(maxGain) ? maxGain : null,
    maxLoss: Number.isFinite(maxLoss) ? maxLoss : null,
  }
}

const resolveConsolidatorGroup = (templateId) => {
  const key = String(templateId || '').trim().toLowerCase()
  return consolidatorTemplateGroupMap[key] || 'OUTRAS'
}

const round2 = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.round((number + Number.EPSILON) * 100) / 100
}

const normalizeSearchText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()

const DOWNSIDE_BARRIER_RISK_TOKENS = [
  'ko baixa',
  'barreira baixa',
  'barreira de baixa',
  'barreira ko de baixa',
  'gatilho de baixa',
  'ativacao baixa',
]

const resolveProtectionBeforeDownsideBarrierPct = (barrierAbsPct) => {
  const barrier = Number(barrierAbsPct)
  if (!Number.isFinite(barrier) || barrier <= 0) return null
  return round2(Math.max(barrier - DOWNSIDE_BARRIER_EDGE_STEP, 0))
}

const resolveCapitalProtectionFromOptions = (options) => {
  const safeOptions = Array.isArray(options) ? options : []
  let best = null

  safeOptions.forEach((entry) => {
    const optionType = String(entry?.optionType || '').trim().toUpperCase()
    const side = String(entry?.side || '').trim().toLowerCase()
    if (optionType !== 'PUT' || side !== 'long') return

    const barrierType = String(entry?.barrierType || '').trim().toUpperCase()
    if (isExplicitBarrierType(barrierType)) return

    const strikeFromPercent = Number(entry?.strikePercent)
    const strikeRaw = Number.isFinite(strikeFromPercent) ? strikeFromPercent : toPositiveNumber(entry?.strike)
    if (!Number.isFinite(strikeRaw)) return

    const strikePct = Math.max(0, Math.min(100, strikeRaw))
    const capitalProtectedPct = round2(strikePct)
    if (!Number.isFinite(capitalProtectedPct) || capitalProtectedPct <= 0) return

    if (!best || capitalProtectedPct > best.capitalProtectedPct) {
      best = { capitalProtectedPct, strikePct }
    }
  })

  return best
}

const resolveCapitalProtectionFromValues = (templateId, values = {}) => {
  const key = String(templateId || '').trim().toLowerCase()
  if (!key) return null

  if (key === 'collar_ui' || key === 'collar' || key === 'collar_ui_bidirecional') {
    const protectionPct = toPositiveNumber(values?.protectionPct)
    if (!Number.isFinite(protectionPct)) return null
    return {
      capitalProtectedPct: round2(Math.max(0, Math.min(100, protectionPct))),
    }
  }

  if (key === 'alocacao_protegida' || key === 'alocacao_protegida_sob_custodia') {
    const downProtectionPct = toPositiveNumber(values?.downProtectionPct)
    if (!Number.isFinite(downProtectionPct)) return null
    return {
      capitalProtectedPct: round2(Math.max(0, Math.min(100, 100 - downProtectionPct))),
    }
  }

  return null
}

const resolveBarrierMetricPart = (metrics) => {
  const safeMetrics = Array.isArray(metrics) ? metrics : []
  const barrierMetric = safeMetrics.find((metric) => {
    const label = String(metric?.label || '').toLowerCase()
    return label.includes('barreira')
  })
  if (!barrierMetric) return ''
  const label = String(barrierMetric.label || '').trim()
  const value = String(barrierMetric.value || '').trim()
  if (!label || !value) return ''
  return summarizeConsolidatorLine(`${label}: ${value}`)
}

const resolveDownsideProtectionPct = (model, values = {}) => {
  const fromValues = toPositiveNumber(values?.downKoPct)
  if (fromValues != null) return resolveProtectionBeforeDownsideBarrierPct(fromValues)
  const fromBarrierValues = toPositiveNumber(values?.downBarrierPct)
  if (fromBarrierValues != null) return resolveProtectionBeforeDownsideBarrierPct(fromBarrierValues)

  const metrics = Array.isArray(model?.metrics) ? model.metrics : []
  const lowKoMetric = metrics.find((metric) => {
    const label = String(metric?.label || '').toLowerCase()
    return label.includes('ko baixa') || label.includes('barreira baixa') || label.includes('barreira de baixa')
  })
  const rawValue = String(lowKoMetric?.value || '').trim()
  const match = rawValue.match(/-?\d+(?:[.,]\d+)?/)
  if (!match) return null
  const parsed = Number(match[0].replace(',', '.'))
  if (!Number.isFinite(parsed)) return null
  const absolute = Math.abs(parsed)
  return resolveProtectionBeforeDownsideBarrierPct(absolute)
}

const hasConsolidatorDownsideBarrierRisk = (model) => {
  const sources = [
    ...(Array.isArray(model?.metrics) ? model.metrics.flatMap((metric) => [metric?.label, metric?.value]) : []),
    ...(Array.isArray(model?.highlights) ? model.highlights : []),
    model?.subtitle,
  ]

  return sources.some((source) => {
    const normalized = normalizeSearchText(source)
    return DOWNSIDE_BARRIER_RISK_TOKENS.some((token) => normalized.includes(token))
  })
}

const buildConsolidatorSummary = (model, values = {}) => {
  const templateId = String(model?.templateId || '').trim().toLowerCase()
  const downsideProtectionPct = resolveDownsideProtectionPct(model, values)
  const hasDownsideProtectionSummary = CONSOLIDATOR_DOWNSIDE_PROTECTION_TEMPLATE_IDS.has(templateId)
    || Number.isFinite(downsideProtectionPct)
  const downsideBarrierRisk = hasConsolidatorDownsideBarrierRisk(model)
  const capitalProtection = CAPITAL_PROTECTION_TEMPLATE_IDS.has(templateId)
    ? (resolveCapitalProtectionFromOptions(values?.options) || resolveCapitalProtectionFromValues(templateId, values))
    : null
  const genericProtectionPart = Number.isFinite(capitalProtection?.capitalProtectedPct)
    ? summarizeConsolidatorLine(`Capital protegido: ${formatOptionalPct(capitalProtection.capitalProtectedPct)} do capital`)
    : ''
  const protectionPart = Number.isFinite(downsideProtectionPct)
    ? summarizeConsolidatorLine(`Capital protegido ate ${formatOptionalPct(downsideProtectionPct)} de queda`)
    : genericProtectionPart
  const barrierPart = hasDownsideProtectionSummary ? '' : resolveBarrierMetricPart(model?.metrics)
  const payoffStats = resolveConsolidatorPayoffStats(model)
  const maxGainPart = Number.isFinite(payoffStats.maxGain)
    ? summarizeConsolidatorLine(`Ganho maximo: ${formatOptionalPct(payoffStats.maxGain)}`)
    : ''
  const maxLossPart = downsideBarrierRisk
    ? summarizeConsolidatorLine('Perda maxima: -')
    : (!CONSOLIDATOR_HIDE_MAX_LOSS_TEMPLATE_IDS.has(templateId) && Number.isFinite(payoffStats.maxLoss)
      ? summarizeConsolidatorLine(`Perda maxima: ${payoffStats.maxLoss <= -100 ? '-' : formatOptionalPct(payoffStats.maxLoss)}`)
      : '')

  const metrics = Array.isArray(model?.metrics) ? model.metrics : []
  const metricParts = metrics
    .filter((metric) => {
      const label = String(metric?.label || '').toLowerCase()
      return (
        label.includes('cupom')
        || label.includes('barreira')
        || label.includes('ko')
        || label.includes('protecao')
        || label.includes('limitador')
      )
    })
    .slice(0, 2)
    .map((metric) => summarizeConsolidatorLine(`${metric.label}: ${metric.value}`))
    .filter((part) => part && part !== barrierPart)
    .filter(Boolean)

  const highlightParts = (Array.isArray(model?.highlights) ? model.highlights : [])
    .map((item) => summarizeConsolidatorLine(item))
    .filter(Boolean)

  const tokens = [protectionPart, barrierPart, maxGainPart, maxLossPart, ...highlightParts, ...metricParts]
    .filter(Boolean)
    .slice(0, 3)
  if (tokens.length) return summarizeConsolidatorLine(tokens.join(' | '), 220)

  const fallback = summarizeConsolidatorLine(model?.subtitle, 160)
  return fallback || 'Retorno conforme parametros configurados.'
}

const buildConsolidatorSnapshot = ({
  templateId,
  values,
  optionEntries,
  messageText,
  layoutMode,
}) => {
  return {
    capturedAt: new Date().toISOString(),
    templateId: String(templateId || '').trim(),
    layoutMode: String(layoutMode || '').trim() || 'payoff',
    messageText: String(messageText || '').trim(),
    values: sanitizeSnapshotScalarValues(values),
    options: sanitizeSnapshotOptionEntries(optionEntries),
  }
}

const buildConsolidatorOperationLabel = ({ templateLabel, tickerValue, companyName }) => {
  const structure = String(templateLabel || 'Estrutura').trim()
  const ticker = String(tickerValue || '').trim().toUpperCase()
  const company = String(companyName || '').trim()
  if (company && ticker) return `${structure} em ${company} (${ticker})`
  if (ticker) return `${structure} em ${ticker}`
  return structure
}

const toFirstMeaningfulSentence = (text, maxLength = 280) => {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  const sentence = raw.match(/^(.+?[.!?])(\s|$)/)?.[1] || raw
  if (sentence.length <= maxLength) return sentence
  return `${sentence.slice(0, maxLength - 1).trim()}...`
}

const buildCompanyInsights = (profile) => {
  if (!profile) return { title: '', summary: '', points: [] }
  const title = String(profile?.name || '').trim()
  const summary = toFirstMeaningfulSentence(profile?.summary, 300)
  const points = []

  if (profile?.sector || profile?.industry) {
    const sectorLine = [profile.sector, profile.industry].filter(Boolean).join(' • ')
    if (sectorLine) points.push(`Setor: ${sectorLine}`)
  }

  const marketCap = formatCompactCurrency(profile?.marketCap)
  if (marketCap) points.push(`Valor de mercado: ${marketCap}`)

  const dayChange = formatOptionalPct(profile?.regularMarketChangePercent)
  if (dayChange) points.push(`Variação diária: ${dayChange}`)

  const pe = formatOptionalNumber(profile?.priceEarnings)
  if (pe) points.push(`P/L: ${pe}`)

  const eps = formatOptionalNumber(profile?.earningsPerShare)
  if (eps) points.push(`LPA: ${eps}`)

  const low52 = formatOptionalNumber(profile?.fiftyTwoWeekLow)
  const high52 = formatOptionalNumber(profile?.fiftyTwoWeekHigh)
  if (low52 && high52) points.push(`Faixa 52 semanas: ${low52} - ${high52}`)

  return {
    title,
    summary,
    points: points.slice(0, 4),
  }
}

const removeStockEntries = (entries) => (
  Array.isArray(entries)
    ? entries.filter((entry) => !isStockType(entry?.optionType)).map((entry) => ({ ...entry }))
    : []
)

const inferReferenceQtyFromStockEntries = (entries) => {
  const quantities = (Array.isArray(entries) ? entries : [])
    .filter((entry) => isStockType(entry?.optionType))
    .map((entry) => toPositiveNumber(entry?.quantity))
    .filter((value) => value != null)
  if (!quantities.length) return null
  return Math.max(...quantities)
}

const cloneOptionEntries = (entries) => (
  Array.isArray(entries)
    ? entries.map((entry) => ({ ...entry }))
    : []
)

const stripInlineFormatting = (value) => String(value || '')
  .replace(/[*_`]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

const buildMessageBlockId = (index, label) => {
  const token = stripInlineFormatting(label || `Bloco ${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `msg-${index}-${token || 'bloco'}`
}

const parseMessageLineToBlock = (line, index) => {
  const raw = String(line || '').trim()
  if (!raw) return null

  const markdownLabelMatch = raw.match(/^\*([^*]+?):\*\s*(.*)$/)
  if (markdownLabelMatch) {
    const label = stripInlineFormatting(markdownLabelMatch[1])
    return {
      id: buildMessageBlockId(index, label),
      label: label || `Bloco ${index + 1}`,
      prefix: `*${markdownLabelMatch[1]}:*`,
      content: String(markdownLabelMatch[2] || '').trim(),
      kind: 'labeled',
    }
  }

  const plainLabelMatch = raw.match(/^([A-Za-zÀ-ÿ0-9 /()_-]{3,48}):\s*(.*)$/)
  if (plainLabelMatch) {
    const label = stripInlineFormatting(plainLabelMatch[1])
    return {
      id: buildMessageBlockId(index, label),
      label: label || `Bloco ${index + 1}`,
      prefix: `${plainLabelMatch[1]}:`,
      content: String(plainLabelMatch[2] || '').trim(),
      kind: 'labeled',
    }
  }

  const bulletMatch = raw.match(/^[-•]\s*(.*)$/)
  if (bulletMatch) {
    return {
      id: buildMessageBlockId(index, `Bloco ${index + 1}`),
      label: `Bloco ${index + 1}`,
      prefix: '-',
      content: String(bulletMatch[1] || '').trim(),
      kind: 'bullet',
    }
  }

  return {
    id: buildMessageBlockId(index, `Bloco ${index + 1}`),
    label: `Bloco ${index + 1}`,
    prefix: '',
    content: stripInlineFormatting(raw),
    kind: 'plain',
  }
}

const parseEditableMessage = (text) => {
  const rawLines = String(text || '').replace(/\r/g, '').split('\n')
  const firstContentIndex = rawLines.findIndex((line) => String(line || '').trim())
  const headerLine = firstContentIndex >= 0 ? String(rawLines[firstContentIndex] || '').trim() : ''
  const footerStartIndex = rawLines.findIndex((line, index) => (
    index > firstContentIndex && /^vencimento da estrategia:/i.test(stripInlineFormatting(line))
  ))

  const safeFooterStart = footerStartIndex >= 0 ? footerStartIndex : rawLines.length
  const bodyLines = rawLines
    .slice(Math.max(firstContentIndex + 1, 0), safeFooterStart)
    .filter((line) => String(line || '').trim())

  const blocks = bodyLines
    .map((line, index) => parseMessageLineToBlock(line, index))
    .filter(Boolean)

  const footerLines = rawLines
    .slice(safeFooterStart)
    .filter((line, index, source) => {
      const trimmed = String(line || '').trim()
      if (trimmed) return true
      return source.slice(index + 1).some((item) => String(item || '').trim())
    })

  return {
    headerLine,
    blocks,
    footerLines,
  }
}

const formatMessageBlockLine = (block) => {
  if (!block) return ''
  const prefix = String(block.prefix || '').trim()
  const content = String(block.content || '').trim()
  if (!prefix) return content
  if (prefix === '-') return content ? `- ${content}` : ''
  return content ? `${prefix} ${content}` : prefix
}

const buildMessageFromBlocks = ({ headerLine = '', blocks = [], footerLines = [] } = {}) => {
  const lines = []
  const header = String(headerLine || '').trim()
  const body = (Array.isArray(blocks) ? blocks : []).map((block) => formatMessageBlockLine(block)).filter(Boolean)
  const footer = (Array.isArray(footerLines) ? footerLines : []).filter((line) => String(line || '').trim())

  if (header) lines.push(header)
  if (body.length) {
    if (lines.length) lines.push('')
    lines.push(...body)
  }
  if (footer.length) {
    if (lines.length) lines.push('')
    lines.push(...footer)
  }
  return lines.join('\n')
}

const sanitizeSnapshotMessageBlocks = (blocks) => (
  (Array.isArray(blocks) ? blocks : [])
    .map((block, index) => {
      const source = asObject(block)
      if (!source) return null
      const label = String(source.label || `Bloco ${index + 1}`).trim() || `Bloco ${index + 1}`
      const prefix = String(source.prefix || '').trim()
      const content = String(source.content || '').trim()
      const kindRaw = String(source.kind || '').trim().toLowerCase()
      const kind = kindRaw === 'labeled' || kindRaw === 'bullet' ? kindRaw : 'plain'
      if (!label && !prefix && !content) return null
      return {
        id: String(source.id || buildMessageBlockId(index, label)).trim() || buildMessageBlockId(index, label),
        label,
        prefix,
        content,
        kind,
      }
    })
    .filter(Boolean)
)

const sanitizeSnapshotMessageFooterLines = (lines) => (
  (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || '').trim())
    .filter(Boolean)
)

const formatMessageBlockPreview = (block) => {
  if (!block) return ''
  const label = stripInlineFormatting(block.label)
  const content = String(block.content || '').trim()
  if (block.kind === 'labeled' && label && content) return `${label}: ${content}`
  return content || label
}

const MESSAGE_COMBINED_RISK_GAIN_TEMPLATES = new Set(['call_spread', 'put_spread'])

const buildCustomMessageBlock = (index, content = 'Edite este bloco.') => ({
  id: buildMessageBlockId(index, `Bloco ${index + 1}`),
  label: `Bloco ${index + 1}`,
  prefix: '',
  content,
  kind: 'plain',
})

const normalizeMessagePreview = (block) => String(formatMessageBlockPreview(block) || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const isRiskMaximumMessageBlock = (block) => {
  const preview = normalizeMessagePreview(block)
  return preview.includes('risco maximo')
}

const isGainMaximumMessageBlock = (block) => {
  const preview = normalizeMessagePreview(block)
  return preview.includes('ganho maximo') || preview.includes('lucro maximo')
}

const mergePremiumRiskAndGainBlocks = (blocks, templateId) => {
  const safeBlocks = Array.isArray(blocks) ? blocks : []
  if (!MESSAGE_COMBINED_RISK_GAIN_TEMPLATES.has(String(templateId || '').trim().toLowerCase())) {
    return safeBlocks
  }

  const merged = []
  for (let index = 0; index < safeBlocks.length; index += 1) {
    const current = safeBlocks[index]
    const next = safeBlocks[index + 1]
    const canMergeCurrent = isRiskMaximumMessageBlock(current) || isGainMaximumMessageBlock(current)
    const canMergeNext = isRiskMaximumMessageBlock(next) || isGainMaximumMessageBlock(next)
    if (canMergeCurrent && canMergeNext) {
      const orderedBlocks = [current, next].sort((left, right) => {
        const leftIsGain = isGainMaximumMessageBlock(left)
        const rightIsGain = isGainMaximumMessageBlock(right)
        if (leftIsGain === rightIsGain) return 0
        return leftIsGain ? -1 : 1
      })
      const mergedContent = orderedBlocks
        .map((block) => formatMessageBlockPreview(block))
        .filter(Boolean)
        .join(' | ')
      merged.push({
        ...buildCustomMessageBlock(merged.length, mergedContent),
        label: 'Ganho e risco maximos',
      })
      index += 1
      continue
    }
    merged.push({
      ...current,
      id: buildMessageBlockId(merged.length, current?.label),
    })
  }
  return merged
}

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  if (!file) {
    reject(new Error('Arquivo de imagem nao informado.'))
    return
  }
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result || ''))
  reader.onerror = () => reject(new Error('Nao foi possivel ler a imagem.'))
  reader.readAsDataURL(file)
})

const areOptionEntriesEquivalent = (leftEntries, rightEntries) => {
  const left = Array.isArray(leftEntries) ? leftEntries : []
  const right = Array.isArray(rightEntries) ? rightEntries : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] || {}
    const r = right[index] || {}
    if (String(l.label || '').trim() !== String(r.label || '').trim()) return false
    if (String(l.optionType || 'CALL') !== String(r.optionType || 'CALL')) return false
    if (String(l.side || 'long') !== String(r.side || 'long')) return false
    if (Boolean(l.useCustomQuantity) !== Boolean(r.useCustomQuantity)) return false
    if (String(l.quantity ?? '').trim() !== String(r.quantity ?? '').trim()) return false
    if (String(l.strike ?? '').trim() !== String(r.strike ?? '').trim()) return false
    if (String(l.barrierType ?? '').trim() !== String(r.barrierType ?? '').trim()) return false
    if (String(l.barrierValue ?? '').trim() !== String(r.barrierValue ?? '').trim()) return false
    if (String(l.coupon ?? '').trim() !== String(r.coupon ?? '').trim()) return false
  }
  return true
}

const CardGenerator = () => {
  const { notify } = useToast()
  const previewRef = useRef(null)
  const paletteMenuRef = useRef(null)
  const imageInputRef = useRef(null)
  const initialTemplateId = templateOptions[0]?.value || 'put_spread'
  const initialState = useMemo(
    () => resolveInitialCardGeneratorState(initialTemplateId),
    [initialTemplateId],
  )
  const [storageKey] = useState(() => initialState.storageKey)
  const [templateId, setTemplateId] = useState(initialState.templateId)
  const [layoutMode, setLayoutMode] = useState(initialState.layoutMode)
  const [paletteId, setPaletteId] = useState(initialState.paletteId)
  const [paletteMenuOpen, setPaletteMenuOpen] = useState(false)
  const [paletteFilter, setPaletteFilter] = useState('')
  const [showCompanyLogo, setShowCompanyLogo] = useState(initialState.showCompanyLogo)
  const [liveTickerPrice, setLiveTickerPrice] = useState(null)
  const [isTickerPriceLoading, setIsTickerPriceLoading] = useState(false)
  const [companyProfile, setCompanyProfile] = useState(null)
  const [isCompanyProfileLoading, setIsCompanyProfileLoading] = useState(false)
  const [values, setValues] = useState(initialState.values)
  const [optionDraftEntries, setOptionDraftEntries] = useState(initialState.optionDraftEntries)
  const [messageText, setMessageText] = useState(initialState.messageText)
  const [messageDirty, setMessageDirty] = useState(initialState.messageDirty)
  const [savedMessages, setSavedMessages] = useState(initialState.savedMessages)
  const [runningExport, setRunningExport] = useState('')
  const [consolidatedEntries, setConsolidatedEntries] = useState(initialState.consolidatedEntries)
  const [formSections, setFormSections] = useState(initialState.formSections || { ...DEFAULT_FORM_SECTIONS })
  const [imageImportPreview, setImageImportPreview] = useState('')
  const [isImageImportRunning, setIsImageImportRunning] = useState(false)
  const [imageImportSummary, setImageImportSummary] = useState(null)
  const [imageImportDraft, setImageImportDraft] = useState(null)
  const [importedSpotPrice, setImportedSpotPrice] = useState(null)

  const fields = useMemo(() => getStrategyFields(templateId), [templateId])
  const optionForm = useMemo(() => getStrategyOptionForm(templateId), [templateId])
  const groupedFields = useMemo(() => buildGroupedFields(fields), [fields])
  const model = useMemo(() => buildStrategyModel(templateId, values), [templateId, values])
  const messageEditor = useMemo(() => {
    const parsed = parseEditableMessage(messageText)
    return {
      ...parsed,
      blocks: mergePremiumRiskAndGainBlocks(parsed.blocks, templateId),
    }
  }, [messageText, templateId])
  const messagePreviewHighlights = useMemo(
    () => messageEditor.blocks.map((block) => formatMessageBlockPreview(block)).filter(Boolean),
    [messageEditor.blocks],
  )
  const selectedPalette = useMemo(() => getCardPaletteById(paletteId), [paletteId])
  const filteredPalettes = useMemo(() => {
    const term = String(paletteFilter || '').trim().toLowerCase()
    if (!term) return cardPalettes
    return cardPalettes.filter((palette) => {
      return palette.label.toLowerCase().includes(term) || palette.description.toLowerCase().includes(term)
    })
  }, [paletteFilter])
  const paletteStyles = useMemo(() => buildCardPaletteStyles(selectedPalette), [selectedPalette])
  const visibleOptionDraftEntries = useMemo(() => removeStockEntries(optionDraftEntries), [optionDraftEntries])
  const hasPendingOptionChanges = useMemo(() => {
    const applied = removeStockEntries(values.options)
    return !areOptionEntriesEquivalent(applied, visibleOptionDraftEntries)
  }, [values.options, visibleOptionDraftEntries])
  const manualTicketMin = useMemo(() => {
    const numeric = toPositiveNumber(values?.ticketMin)
    if (numeric != null) return formatCurrency(numeric)
    return String(values?.ticketMin || '').trim()
  }, [values?.ticketMin])
  const footerTicketMin = String(model?.footer?.ticketMin || '').trim()
  const normalizedTicker = useMemo(
    () => String(values?.ticker || '').trim().toUpperCase(),
    [values?.ticker],
  )
  const currentTickerPriceLabel = useMemo(() => {
    if (isTickerPriceLoading) return 'Carregando...'
    if (Number.isFinite(importedSpotPrice) && importedSpotPrice > 0) return formatCurrency(importedSpotPrice)
    if (Number.isFinite(liveTickerPrice) && liveTickerPrice > 0) return formatCurrency(liveTickerPrice)
    return '--'
  }, [importedSpotPrice, isTickerPriceLoading, liveTickerPrice])
  const minimumCardValue = useMemo(() => {
    if (templateId === 'call_spread' && Number.isFinite(liveTickerPrice) && liveTickerPrice > 0) {
      const optionCostPct = resolveCallSpreadCostPct(values)
      if (optionCostPct != null && optionCostPct > 0) {
        const optionUnitCost = liveTickerPrice * (optionCostPct / 100)
        const minimumValue = optionUnitCost * CALL_SPREAD_AUTOMATIC_LOT_SIZE
        if (Number.isFinite(minimumValue) && minimumValue > 0) {
          return formatCurrency(minimumValue)
        }
      }
    }
    if (manualTicketMin) return manualTicketMin
    if (footerTicketMin) return footerTicketMin
    if (Number.isFinite(liveTickerPrice) && liveTickerPrice > 0) return formatCurrency(liveTickerPrice * 100)
    return '--'
  }, [footerTicketMin, liveTickerPrice, manualTicketMin, templateId, values])
  const companyInsights = useMemo(() => buildCompanyInsights(companyProfile), [companyProfile])
  const hasCompanyInsights = Boolean(companyInsights.title || companyInsights.summary || companyInsights.points.length)
  const optionSyncPatchCount = Object.keys(model?.optionSync?.appliedPatch || {}).length

  const operationSectionSummary = useMemo(() => {
    const maturity = values?.maturityDate ? formatMaturityMonth(values.maturityDate) : '--'
    const roaValue = String(values?.feeAai ?? model?.footer?.feeAaiReal ?? '--').trim() || '--'
    return `${model.templateLabel} | ${normalizedTicker || '--'} | ${maturity} | ROA ${roaValue}`
  }, [model?.footer?.feeAaiReal, model.templateLabel, normalizedTicker, values?.feeAai, values?.maturityDate])

  const optionsSectionSummary = useMemo(() => {
    const pendingLabel = hasPendingOptionChanges ? 'pendente' : 'aplicado'
    return `${visibleOptionDraftEntries.length} opcao(oes) | ${pendingLabel} | ${optionSyncPatchCount} ajuste(s)`
  }, [hasPendingOptionChanges, optionSyncPatchCount, visibleOptionDraftEntries.length])

  const consolidatorSectionSummary = useMemo(
    () => `${consolidatedEntries.length} operacao(oes) salvas`,
    [consolidatedEntries.length],
  )

  const messageSectionSummary = useMemo(() => {
    const blockCount = messageEditor.blocks.length
    const textSize = String(messageText || '').trim().length
    return `${blockCount} bloco(s) | ${textSize} caractere(s)`
  }, [messageEditor.blocks.length, messageText])

  useEffect(() => {
    if (!messageDirty) {
      setMessageText(model.generatedMessage || '')
    }
  }, [messageDirty, model.generatedMessage])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const resolveHashPath = () => {
      const rawHash = String(window.location.hash || '').trim()
      if (!rawHash) return '/'
      const withoutPrefix = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
      const path = withoutPrefix.split('?')[0]
      return path || '/'
    }

    const collapseOperationFilter = () => {
      if (resolveHashPath() !== '/cards') return
      setFormSections((current) => {
        if (current?.operation === false) return current
        return {
          ...(current || DEFAULT_FORM_SECTIONS),
          operation: false,
        }
      })
    }

    collapseOperationFilter()
    window.addEventListener('hashchange', collapseOperationFilter)
    return () => window.removeEventListener('hashchange', collapseOperationFilter)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const payload = {
      version: CARD_GENERATOR_STATE_VERSION,
      savedAt: new Date().toISOString(),
      templateId,
      layoutMode,
      paletteId,
      showCompanyLogo,
      values,
      optionDraftEntries,
      messageText,
      messageDirty,
      savedMessages,
      consolidatedEntries,
      formSections,
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(payload))
    } catch {
      // ignore persistence failures
    }
  }, [
    consolidatedEntries,
    formSections,
    layoutMode,
    messageDirty,
    messageText,
    optionDraftEntries,
    paletteId,
    savedMessages,
    showCompanyLogo,
    storageKey,
    templateId,
    values,
  ])

  useEffect(() => {
    if (!paletteMenuOpen) return undefined
    const handleOutsideClick = (event) => {
      if (paletteMenuRef.current?.contains(event.target)) return
      setPaletteMenuOpen(false)
      setPaletteFilter('')
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setPaletteMenuOpen(false)
        setPaletteFilter('')
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [paletteMenuOpen])

  useEffect(() => {
    const appliedEntries = Array.isArray(values?.options) ? values.options : []
    const draftEntries = Array.isArray(optionDraftEntries) ? optionDraftEntries : []
    const hasStockInApplied = appliedEntries.some((entry) => isStockType(entry?.optionType))
    const hasStockInDraft = draftEntries.some((entry) => isStockType(entry?.optionType))
    const inferredStockQty = inferReferenceQtyFromStockEntries([...appliedEntries, ...draftEntries])
    const hasStockQty = String(values?.stockQuantity ?? '').trim() !== ''
    const shouldSetStockQty = !hasStockQty && inferredStockQty != null
    if (!hasStockInApplied && !hasStockInDraft && !shouldSetStockQty) return

    if (hasStockInApplied || shouldSetStockQty) {
      setValues((current) => {
        const currentOptions = Array.isArray(current?.options) ? current.options : []
        const nextOptions = hasStockInApplied ? removeStockEntries(currentOptions) : currentOptions
        const nextStockQuantity = shouldSetStockQty ? String(inferredStockQty) : current.stockQuantity
        const optionsChanged = hasStockInApplied
        const stockChanged = String(current?.stockQuantity ?? '').trim() !== String(nextStockQuantity ?? '').trim()
        if (!optionsChanged && !stockChanged) return current
        return {
          ...current,
          stockQuantity: nextStockQuantity,
          options: optionsChanged ? nextOptions : currentOptions,
        }
      })
    }

    if (hasStockInDraft) {
      setOptionDraftEntries((current) => removeStockEntries(current))
    }
  }, [optionDraftEntries, values?.options, values?.stockQuantity])

  useEffect(() => {
    const rawTicker = normalizedTicker
    if (!rawTicker) {
      setLiveTickerPrice(null)
      setIsTickerPriceLoading(false)
      return undefined
    }

    let cancelled = false
    setIsTickerPriceLoading(true)
    const timerId = setTimeout(async () => {
      try {
        const symbol = normalizeYahooSymbol(rawTicker)
        const end = new Date()
        const start = new Date(end)
        start.setDate(start.getDate() - 14)
        const market = await fetchYahooMarketData({
          symbol,
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
        })
        const close = Number(market?.close)
        if (!cancelled) {
          setLiveTickerPrice(Number.isFinite(close) && close > 0 ? close : null)
          setIsTickerPriceLoading(false)
        }
      } catch {
        if (!cancelled) {
          setLiveTickerPrice(null)
          setIsTickerPriceLoading(false)
        }
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timerId)
    }
  }, [normalizedTicker])

  useEffect(() => {
    const rawTicker = normalizedTicker
    if (!rawTicker) {
      setCompanyProfile(null)
      setIsCompanyProfileLoading(false)
      return undefined
    }

    let cancelled = false
    setIsCompanyProfileLoading(true)
    const timerId = setTimeout(async () => {
      try {
        const profile = await fetchCompanyProfile(rawTicker)
        if (!cancelled) {
          setCompanyProfile(profile)
          setIsCompanyProfileLoading(false)
        }
      } catch {
        if (!cancelled) {
          setCompanyProfile(null)
          setIsCompanyProfileLoading(false)
        }
      }
    }, 320)

    return () => {
      cancelled = true
      clearTimeout(timerId)
    }
  }, [normalizedTicker])

  const handleTemplateChange = useCallback((event) => {
    const nextId = event.target.value
    const nextDefaults = getStrategyDefaults(nextId)
    const inferredStockQty = inferReferenceQtyFromStockEntries(nextDefaults.options)
    const stockQuantity = String(nextDefaults?.stockQuantity ?? '').trim() || (inferredStockQty != null ? String(inferredStockQty) : '')
    const sanitizedOptions = removeStockEntries(nextDefaults.options)
    setTemplateId(nextId)
    setValues({
      ...nextDefaults,
      stockQuantity,
      options: sanitizedOptions,
    })
    setOptionDraftEntries(cloneOptionEntries(sanitizedOptions))
    const savedMessage = String(savedMessages[nextId] || '')
    setMessageText(savedMessage)
    setMessageDirty(savedMessage.trim().length > 0)
  }, [savedMessages])

  const handleValueChange = useCallback((key, nextValue) => {
    if (key === 'ticker') {
      setImportedSpotPrice(null)
    }
    setValues((current) => ({
      ...current,
      [key]: nextValue,
    }))
  }, [])

  const handleMessageBlockChange = useCallback((blockId, nextContent) => {
    const nextBlocks = messageEditor.blocks.map((block) => (
      block.id === blockId
        ? { ...block, content: nextContent }
        : block
    ))
    const nextMessage = buildMessageFromBlocks({
      headerLine: messageEditor.headerLine,
      blocks: nextBlocks,
      footerLines: messageEditor.footerLines,
    })
    setMessageText(nextMessage)
    setMessageDirty(true)
  }, [messageEditor.blocks, messageEditor.footerLines, messageEditor.headerLine])

  const handleAddMessageBlock = useCallback(() => {
    const nextBlocks = [...messageEditor.blocks, buildCustomMessageBlock(messageEditor.blocks.length)]
    const nextMessage = buildMessageFromBlocks({
      headerLine: messageEditor.headerLine,
      blocks: nextBlocks,
      footerLines: messageEditor.footerLines,
    })
    setMessageText(nextMessage)
    setMessageDirty(true)
  }, [messageEditor.blocks, messageEditor.footerLines, messageEditor.headerLine])

  const handleRemoveMessageBlock = useCallback((blockId) => {
    const nextBlocks = messageEditor.blocks.filter((block) => block.id !== blockId)
    const nextMessage = buildMessageFromBlocks({
      headerLine: messageEditor.headerLine,
      blocks: nextBlocks,
      footerLines: messageEditor.footerLines,
    })
    setMessageText(nextMessage)
    setMessageDirty(true)
  }, [messageEditor.blocks, messageEditor.footerLines, messageEditor.headerLine])

  const handleOptionChange = useCallback((entryId, patch) => {
    setOptionDraftEntries((current) => {
      return (Array.isArray(current) ? current : []).map((entry) => {
        if (entry?.id !== entryId) return entry
        const nextEntry = { ...entry, ...patch }
        if (!optionForm.showBarrier || !isExplicitBarrierType(nextEntry.barrierType)) {
          nextEntry.barrierValue = ''
          nextEntry.barrierPercent = null
          nextEntry.barrierRelativePct = null
        }
        if (!optionForm.showStrike) {
          nextEntry.strike = ''
          nextEntry.strikePercent = null
          nextEntry.strikeRelativePct = null
        }
        if (!optionForm.showCoupon) {
          nextEntry.coupon = ''
          nextEntry.couponPct = null
        }
        return nextEntry
      })
    })
  }, [optionForm.showBarrier, optionForm.showCoupon, optionForm.showStrike])

  const handleAddOption = useCallback(() => {
    setOptionDraftEntries((current) => {
      const currentOptions = Array.isArray(current) ? current : []
      const nextOption = createStrategyOptionEntry(templateId)
      return [...currentOptions, nextOption]
    })
  }, [templateId])

  const handleRemoveOption = useCallback((entryId) => {
    setOptionDraftEntries((current) => {
      const currentOptions = Array.isArray(current) ? current : []
      const nextOptions = currentOptions.filter((entry) => entry?.id !== entryId)
      return nextOptions.length ? nextOptions : currentOptions
    })
  }, [])

  const handleApplyOptionChanges = useCallback(() => {
    const sanitizedDraft = removeStockEntries(optionDraftEntries)
    const nextStatePreview = {
      ...values,
      options: cloneOptionEntries(sanitizedDraft),
    }
    const optionSync = inferOptionSyncForTemplate(templateId, nextStatePreview)
    const appliedPatch = optionSync?.appliedPatch || {}
    setValues((current) => {
      return {
        ...current,
        ...appliedPatch,
        options: cloneOptionEntries(sanitizedDraft),
      }
    })
    setOptionDraftEntries(cloneOptionEntries(sanitizedDraft))
    if (Array.isArray(optionSync?.warnings) && optionSync.warnings.length) {
      notify('Opcoes aplicadas com inferencia parcial. Revise os avisos no card.', 'warning')
      return
    }
    notify('Opcoes aplicadas no grafico, texto e resumo.', 'success')
  }, [notify, optionDraftEntries, templateId, values])

  const applyImportedCardData = useCallback((parsed) => {
    const nextTemplateId = String(parsed?.templateId || templateId || '').trim() || templateId
    const templateChanged = nextTemplateId !== templateId
    const templateDefaults = getStrategyDefaults(nextTemplateId)
    const baseValues = templateChanged ? templateDefaults : values
    const baseOptions = cloneOptionEntries(removeStockEntries(baseValues?.options || templateDefaults.options))
    const hasImportedOptions = Array.isArray(parsed?.options) && parsed.options.length > 0
    const importedOptions = hasImportedOptions
      ? parsed.options.map((entry) => createStrategyOptionEntry(nextTemplateId, entry))
      : baseOptions

    const nextValuesDraft = {
      ...(templateChanged ? templateDefaults : baseValues),
      ...(parsed?.valuesPatch || {}),
      options: cloneOptionEntries(importedOptions),
    }
    const optionSync = inferOptionSyncForTemplate(nextTemplateId, nextValuesDraft)
    const nextValues = {
      ...nextValuesDraft,
      ...(optionSync?.appliedPatch || {}),
    }

    setTemplateId(nextTemplateId)
    setValues(nextValues)
    setOptionDraftEntries(cloneOptionEntries(importedOptions))
    setMessageText('')
    setMessageDirty(false)
    setImportedSpotPrice(Number.isFinite(parsed?.referencePrice) ? parsed.referencePrice : null)

    return {
      templateId: nextTemplateId,
      templateChanged,
      fieldCount: Object.keys(parsed?.valuesPatch || {}).length,
      optionCount: hasImportedOptions ? parsed.options.length : 0,
    }
  }, [templateId, values])

  const handleImportImageDataUrl = useCallback(async (dataUrl, sourceLabel = 'Imagem colada') => {
    const raw = String(dataUrl || '').trim()
    if (!raw.startsWith('data:image/')) {
      notify('Cole ou selecione um arquivo de imagem valido.', 'warning')
      return
    }

    setImageImportPreview(raw)
    setIsImageImportRunning(true)

    try {
      const ocrResult = await readImageText(raw)
      if (!ocrResult?.ok) {
        const message = String(ocrResult?.error || 'Nao foi possivel ler a imagem.')
        setImageImportSummary({
          sourceLabel,
          templateLabel: '',
          fieldCount: 0,
          optionCount: 0,
          referencePrice: null,
          rawText: '',
          warnings: [message],
        })
        setImageImportPreview('')
        notify(message, 'warning')
        return
      }

      if (ocrResult.source) {
        console.log('[OCR] motor utilizado:', ocrResult.source)
      }

      const parsed = extractCardDataFromImageText({
        text: ocrResult?.text || '',
        lines: ocrResult?.lines || [],
        currentTemplateId: templateId,
      })
      console.log('[OCR DEBUG] raw text:', ocrResult?.text)
      console.log('[OCR DEBUG] raw lines:', ocrResult?.lines)
      console.log('[OCR DEBUG] parsed:', JSON.stringify(parsed, null, 2))
      const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings : []

      // Build editable draft from parsed OCR data
      const draftOptions = Array.isArray(parsed?.options)
        ? parsed.options.map((o) => ({
            optionType: o.optionType || 'CALL',
            side: o.side || 'long',
            strike: o.strike || '',
            barrierType: o.barrierType || '',
            barrierValue: o.barrierValue || '',
          }))
        : []

      setImageImportDraft({
        templateId: parsed?.templateId || templateId || '',
        ticker: parsed?.valuesPatch?.ticker || '',
        maturityDate: parsed?.valuesPatch?.maturityDate || '',
        optionCostPct: parsed?.valuesPatch?.optionCostPct || '',
        feeAai: parsed?.valuesPatch?.feeAai || '',
        protectionPct: parsed?.valuesPatch?.protectionPct || '',
        barrierUpPct: parsed?.valuesPatch?.barrierUpPct || '',
        capAfterPct: parsed?.valuesPatch?.capAfterPct || '',
        options: draftOptions,
        referencePrice: parsed?.referencePrice ?? null,
        fullParsed: parsed,
      })

      const templateLabel = templateOptions.find((o) => o.value === parsed?.templateId)?.label || ''

      setImageImportSummary({
        sourceLabel,
        templateLabel,
        fieldCount: Object.keys(parsed?.valuesPatch || {}).length,
        optionCount: draftOptions.length,
        referencePrice: Number.isFinite(parsed?.referencePrice) ? parsed.referencePrice : null,
        rawText: String(parsed?.rawText || ''),
        warnings,
      })

      notify('Imagem lida. Revise os campos e clique em Inserir para aplicar.', 'success')
    } catch (error) {
      const message = error?.message ? `Falha ao importar imagem: ${error.message}` : 'Falha ao importar imagem.'
      setImageImportSummary({
        sourceLabel,
        templateLabel: '',
        fieldCount: 0,
        optionCount: 0,
        referencePrice: null,
        rawText: '',
        warnings: [message],
      })
      setImageImportPreview('')
      notify(message, 'warning')
    } finally {
      setIsImageImportRunning(false)
    }
  }, [notify, templateId])

  const handleClearImageImport = useCallback(() => {
    setImageImportPreview('')
    setImageImportSummary(null)
    setImageImportDraft(null)
    if (imageInputRef.current) imageInputRef.current.value = ''
  }, [])

  const handleConfirmImageImport = useCallback(() => {
    if (!imageImportDraft) return
    const draft = imageImportDraft
    // Rebuild parsed object from the (possibly edited) draft
    const valuesPatch = { ...(draft.fullParsed?.valuesPatch || {}) }
    if (draft.ticker) valuesPatch.ticker = draft.ticker
    if (draft.maturityDate) valuesPatch.maturityDate = draft.maturityDate
    if (draft.optionCostPct) valuesPatch.optionCostPct = draft.optionCostPct
    if (draft.feeAai) valuesPatch.feeAai = draft.feeAai
    if (draft.protectionPct) valuesPatch.protectionPct = draft.protectionPct
    if (draft.barrierUpPct) valuesPatch.barrierUpPct = draft.barrierUpPct
    if (draft.capAfterPct) valuesPatch.capAfterPct = draft.capAfterPct

    const parsedForApply = {
      templateId: draft.templateId,
      valuesPatch,
      options: draft.options,
      referencePrice: draft.referencePrice,
    }
    const applied = applyImportedCardData(parsedForApply)

    notify(
      `Importacao aplicada: ${applied.fieldCount} campos e ${applied.optionCount} opcoes.`,
      'success',
    )

    // Clear image section after insert
    setImageImportPreview('')
    setImageImportSummary(null)
    setImageImportDraft(null)
    if (imageInputRef.current) imageInputRef.current.value = ''
  }, [applyImportedCardData, imageImportDraft, notify])

  const handleImportImageFile = useCallback(async (file) => {
    if (!file) return
    try {
      const dataUrl = await readFileAsDataUrl(file)
      await handleImportImageDataUrl(dataUrl, file.name || 'Imagem')
    } catch (error) {
      notify(error?.message || 'Nao foi possivel ler a imagem selecionada.', 'warning')
    }
  }, [handleImportImageDataUrl, notify])

  const handleImageInputChange = useCallback(async (event) => {
    const file = event.target.files?.[0]
    if (file) {
      await handleImportImageFile(file)
    }
    event.target.value = ''
  }, [handleImportImageFile])

  const handleImagePaste = useCallback(async (event) => {
    const items = Array.from(event.clipboardData?.items || [])
    const imageItem = items.find((item) => String(item?.type || '').startsWith('image/'))
    if (!imageItem) {
      // Only notify if the paste happened inside the dropzone itself
      if (event.currentTarget?.classList?.contains('cards-image-dropzone')) {
        notify('Nenhuma imagem encontrada na area de transferencia. Copie a imagem antes de colar.', 'warning')
      }
      return
    }
    event.preventDefault()
    const file = imageItem.getAsFile()
    if (!file) {
      notify('Nao foi possivel acessar a imagem colada.', 'warning')
      return
    }
    await handleImportImageFile(file)
  }, [handleImportImageFile, notify])

  // Global paste listener — intercepts Ctrl+V anywhere on the page
  // and routes image pastes to the import handler, so the user doesn't
  // need to focus the dropzone div specifically.
  useEffect(() => {
    const handleGlobalPaste = (event) => {
      // Skip if a draft is already being reviewed or import is running
      if (imageImportDraft || isImageImportRunning) return
      // Detect image first — only intercept image pastes, never text pastes
      const items = Array.from(event.clipboardData?.items || [])
      const imageItem = items.find((item) => String(item?.type || '').startsWith('image/'))
      if (!imageItem) return
      // Skip contentEditable elements (rich-text editors handle images themselves)
      // Regular INPUT/TEXTAREA/SELECT cannot receive images, so no conflict there
      if (document.activeElement?.isContentEditable) return
      event.preventDefault()
      const file = imageItem.getAsFile()
      if (!file) return
      handleImportImageFile(file)
    }
    document.addEventListener('paste', handleGlobalPaste)
    return () => document.removeEventListener('paste', handleGlobalPaste)
  }, [handleImportImageFile, imageImportDraft, isImageImportRunning])

  const handleConsolidatorEntryPatch = useCallback((entryId, patch) => {
    setConsolidatedEntries((current) => (
      (Array.isArray(current) ? current : []).map((entry) => (
        entry?.id === entryId ? { ...entry, ...patch } : entry
      ))
    ))
  }, [])

  const toggleFormSection = useCallback((sectionKey) => {
    setFormSections((current) => ({
      ...current,
      [sectionKey]: current?.[sectionKey] === false,
    }))
  }, [])

  const handleAddToConsolidator = useCallback(() => {
    if (hasPendingOptionChanges) {
      notify('Aplique as opcoes pendentes antes de adicionar ao consolidador.', 'warning')
      return
    }
    if (model.validations?.length) {
      notify('Corrija os campos invalidos antes de adicionar ao consolidador.', 'warning')
      return
    }

    const tickerValue = normalizedTicker || extractTickerFromTitle(model?.title)
    const maturityMetric = (Array.isArray(model?.metrics) ? model.metrics : [])
      .find((metric) => String(metric?.label || '').toLowerCase().includes('vencimento'))?.value
    const maturityLabel = formatMaturityMonth(values?.maturityDate || maturityMetric)
    const resolvedFeeReal = String(model?.footer?.feeAaiReal || '').trim()
    const roaInput = resolvedFeeReal && resolvedFeeReal !== '--'
      ? resolvedFeeReal
      : String(values?.feeAai ?? model?.footer?.feeAai ?? '').trim()

    const nextEntry = {
      id: `op-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      templateId: model?.templateId || templateId,
      templateLabel: model?.templateLabel || 'Estrutura',
      group: resolveConsolidatorGroup(model?.templateId || templateId),
      ticker: tickerValue,
      companyName: companyInsights.title || '',
      operationLabel: buildConsolidatorOperationLabel({
        templateLabel: model?.templateLabel,
        tickerValue,
        companyName: companyInsights.title,
      }),
      maturityLabel,
      summary: buildConsolidatorSummary(model, values),
      roaInput,
      snapshot: buildConsolidatorSnapshot({
        templateId: model?.templateId || templateId,
        values,
        optionEntries: visibleOptionDraftEntries,
        messageText,
        layoutMode,
      }),
    }

    setConsolidatedEntries((current) => [...(Array.isArray(current) ? current : []), nextEntry])
    setLayoutMode('consolidado')
    notify('Operacao adicionada ao consolidador.', 'success')
  }, [
    companyInsights.title,
    hasPendingOptionChanges,
    layoutMode,
    messageText,
    model,
    normalizedTicker,
    notify,
    templateId,
    values,
    visibleOptionDraftEntries,
  ])

  const handleRemoveConsolidatorEntry = useCallback((entryId) => {
    setConsolidatedEntries((current) => (
      (Array.isArray(current) ? current : []).filter((entry) => entry?.id !== entryId)
    ))
  }, [])

  const handleLoadConsolidatorEntry = useCallback((entryId) => {
    const entry = (Array.isArray(consolidatedEntries) ? consolidatedEntries : []).find((item) => item?.id === entryId)
    const snapshot = entry?.snapshot
    if (!entry || !snapshot) {
      notify('Configuracao da operacao nao encontrada.', 'warning')
      return
    }

    const nextTemplateId = String(entry.templateId || snapshot?.templateId || templateId).trim() || templateId
    const templateDefaults = getStrategyDefaults(nextTemplateId)
    const restoredOptions = sanitizeSnapshotOptionEntries(snapshot?.options)
      .map((option) => createStrategyOptionEntry(nextTemplateId, option))
    const nextValuesDraft = {
      ...templateDefaults,
      ...(asObject(snapshot?.values) || {}),
      options: cloneOptionEntries(restoredOptions.length ? restoredOptions : removeStockEntries(templateDefaults.options)),
    }
    const optionSync = inferOptionSyncForTemplate(nextTemplateId, nextValuesDraft)
    const nextValues = {
      ...nextValuesDraft,
      ...(optionSync?.appliedPatch || {}),
    }
    const restoredMessage = String(snapshot?.messageText || '').trim()

    setTemplateId(nextTemplateId)
    setValues(nextValues)
    setOptionDraftEntries(cloneOptionEntries(removeStockEntries(nextValues.options)))
    setMessageText(restoredMessage)
    setMessageDirty(restoredMessage.length > 0)
    setLayoutMode('payoff')
    setImportedSpotPrice(null)

    notify('Configuracao carregada no payoff.', 'success')
  }, [consolidatedEntries, notify, templateId])

  const handleClearConsolidator = useCallback(() => {
    setConsolidatedEntries([])
    notify('Consolidador limpo.', 'success')
  }, [notify])

  const handleCopyText = useCallback(async () => {
    if (!messageText.trim()) {
      notify('Sem texto para copiar.', 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(messageText)
      notify('Texto copiado para a area de transferencia.', 'success')
    } catch {
      notify('Nao foi possivel copiar o texto.', 'warning')
    }
  }, [messageText, notify])

  const handleSaveMessage = useCallback(() => {
    const text = String(messageText || '')
    if (!text.trim()) {
      notify('Sem texto para salvar.', 'warning')
      return
    }
    setSavedMessages((current) => ({
      ...(current || {}),
      [templateId]: text,
    }))
    setMessageDirty(true)
    notify('Texto salvo para esta estrutura.', 'success')
  }, [messageText, notify, templateId])

  const handleRestoreTemplate = useCallback(() => {
    setMessageText(model.generatedMessage || '')
    setMessageDirty(false)
    setSavedMessages((current) => {
      if (!current || !Object.prototype.hasOwnProperty.call(current, templateId)) return current
      const next = { ...current }
      delete next[templateId]
      return next
    })
  }, [model.generatedMessage, templateId])

  const handleExportPng = useCallback(async () => {
    if (!previewRef.current) {
      notify('Preview indisponivel para exportar.', 'warning')
      return
    }
    if (layoutMode === 'consolidado' && !consolidatedEntries.length) {
      notify('Adicione operacoes ao consolidador antes de exportar.', 'warning')
      return
    }
    if (layoutMode !== 'consolidado' && model.validations?.length) {
      notify('Corrija os campos invalidos antes de exportar.', 'warning')
      return
    }
    setRunningExport('png')
    try {
      const result = await exportCardAsPng({
        node: previewRef.current,
        templateLabel: model.templateLabel,
        ticker: values.ticker,
        maturityDate: values.maturityDate,
      })
      notify(`PNG gerado: ${result.fileName}`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha no PNG: ${error.message}` : 'Falha ao exportar PNG.', 'warning')
    } finally {
      setRunningExport('')
    }
  }, [consolidatedEntries.length, layoutMode, model.templateLabel, model.validations, notify, values.maturityDate, values.ticker])

  const handleExportPdf = useCallback(async () => {
    if (!previewRef.current) {
      notify('Preview indisponivel para exportar.', 'warning')
      return
    }
    if (layoutMode === 'consolidado' && !consolidatedEntries.length) {
      notify('Adicione operacoes ao consolidador antes de exportar.', 'warning')
      return
    }
    if (layoutMode !== 'consolidado' && model.validations?.length) {
      notify('Corrija os campos invalidos antes de exportar.', 'warning')
      return
    }
    setRunningExport('pdf')
    try {
      const result = await exportCardAsPdf({
        node: previewRef.current,
        templateLabel: model.templateLabel,
        ticker: values.ticker,
        maturityDate: values.maturityDate,
      })
      notify(`PDF gerado: ${result.fileName}`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha no PDF: ${error.message}` : 'Falha ao exportar PDF.', 'warning')
    } finally {
      setRunningExport('')
    }
  }, [consolidatedEntries.length, layoutMode, model.templateLabel, model.validations, notify, values.maturityDate, values.ticker])

  const handleCopyCardImage = useCallback(async () => {
    if (!previewRef.current) {
      notify('Preview indisponivel para copiar.', 'warning')
      return
    }
    if (layoutMode === 'consolidado' && !consolidatedEntries.length) {
      notify('Adicione operacoes ao consolidador antes de copiar.', 'warning')
      return
    }
    if (layoutMode !== 'consolidado' && model.validations?.length) {
      notify('Corrija os campos invalidos antes de copiar.', 'warning')
      return
    }
    setRunningExport('clipboard')
    try {
      await copyCardImageToClipboard({
        node: previewRef.current,
      })
      notify('Card copiado como imagem. Cole no WhatsApp com Ctrl+V.', 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao copiar imagem: ${error.message}` : 'Falha ao copiar imagem.', 'warning')
    } finally {
      setRunningExport('')
    }
  }, [consolidatedEntries.length, layoutMode, model.validations, notify])

  const hasSavedMessageForTemplate = String(savedMessages[templateId] || '').trim().length > 0

  const meta = useMemo(() => ([
    { label: 'Estrutura', value: model.templateLabel },
    { label: 'Linhas payoff', value: model.payoffRows?.length || 0 },
    { label: 'Consolidador', value: consolidatedEntries.length },
    { label: 'Modo', value: layoutOptions.find((item) => item.value === layoutMode)?.label || layoutMode },
    { label: 'Paleta', value: selectedPalette.label },
  ]), [consolidatedEntries.length, layoutMode, model.payoffRows?.length, model.templateLabel, selectedPalette.label])

  return (
    <div className="page card-generator-page">
      <PageHeader
        title="Gerador de Cards"
        meta={meta}
        actions={[
          { label: runningExport === 'clipboard' ? 'Copiando imagem...' : 'Copiar imagem (WhatsApp)', icon: 'copy', onClick: handleCopyCardImage, disabled: runningExport === 'clipboard' },
          { label: runningExport === 'png' ? 'Exportando PNG...' : 'Baixar PNG', icon: 'download', onClick: handleExportPng, disabled: runningExport === 'png' },
          { label: runningExport === 'pdf' ? 'Exportando PDF...' : 'Baixar PDF', icon: 'doc', variant: 'btn-secondary', onClick: handleExportPdf, disabled: runningExport === 'pdf' },
        ]}
      />

      <div className="cards-builder-layout">
        <section className="panel cards-builder-form">
          <div className="panel-head">
            <div>
              <h3>Configuracao do card</h3>
              <p className="muted">Escolha a estrutura, ajuste os parametros e revise a mensagem antes de exportar.</p>
            </div>
          </div>

          <div className="cards-top-actions">
            <button className="btn btn-primary" type="button" onClick={handleAddToConsolidator}>
              Adicionar ao consolidador
            </button>
            <small className="cards-options-note">
              Salva o resumo e a configuracao atual da operacao para regenerar o payoff depois.
            </small>
          </div>

          <div className="cards-form-group">
            <div className="cards-options-head">
              <h4>Colar imagem</h4>
              {!imageImportDraft ? (
              <div className="cards-options-actions">
                {imageImportPreview ? (
                  <button
                    className="btn btn-danger btn-inline"
                    type="button"
                    onClick={handleClearImageImport}
                    disabled={isImageImportRunning}
                  >
                    Remover imagem
                  </button>
                ) : null}
                <button
                  className="btn btn-secondary btn-inline"
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={isImageImportRunning}
                >
                  {isImageImportRunning ? 'Lendo imagem...' : 'Selecionar imagem'}
                </button>
              </div>
              ) : null}
            </div>
            {!imageImportDraft ? (
            <div
              className={`cards-image-dropzone ${isImageImportRunning ? 'is-loading' : ''}`}
              onPaste={handleImagePaste}
              onClick={(event) => event.currentTarget.focus()}
              role="region"
              aria-label="Area para colar imagem com Ctrl+V"
              tabIndex={0}
            >
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={handleImageInputChange}
              />
              <div className="cards-image-dropzone-copy">
                <strong>Cole um print da estrutura aqui</strong>
                <span>Use Ctrl+V com a imagem copiada ou use o botao acima para selecionar um arquivo.</span>
                <small>O sistema tenta ler ticker, vencimento, preco, fee e as pernas de opcao.</small>
              </div>
              {imageImportPreview ? (
                <img className="cards-image-preview" src={imageImportPreview} alt="Imagem importada para OCR" />
              ) : (
                <div className="cards-image-placeholder">Sem imagem carregada</div>
              )}
            </div>
            ) : null}

            {imageImportDraft ? (
              <div className="cards-image-draft">
                <div className="cards-image-draft-grid">
                  <div className="cards-field">
                    <label htmlFor="draft-templateId">Estrutura</label>
                    <select
                      id="draft-templateId"
                      className="input"
                      value={imageImportDraft.templateId}
                      onChange={(e) => setImageImportDraft((prev) => ({ ...prev, templateId: e.target.value }))}
                    >
                      <option value="">--</option>
                      {templateOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="cards-field">
                    <label htmlFor="draft-ticker">Ativo</label>
                    <input
                      id="draft-ticker"
                      className="input"
                      type="text"
                      value={imageImportDraft.ticker}
                      onChange={(e) => setImageImportDraft((prev) => ({ ...prev, ticker: e.target.value }))}
                    />
                  </div>
                  <div className="cards-field">
                    <label htmlFor="draft-maturityDate">Vencimento</label>
                    <input
                      id="draft-maturityDate"
                      className="input"
                      type="date"
                      value={imageImportDraft.maturityDate}
                      onChange={(e) => setImageImportDraft((prev) => ({ ...prev, maturityDate: e.target.value }))}
                    />
                  </div>
                  <div className="cards-field">
                    <label htmlFor="draft-optionCostPct">Custo</label>
                    <input
                      id="draft-optionCostPct"
                      className="input"
                      type="text"
                      value={imageImportDraft.optionCostPct}
                      onChange={(e) => setImageImportDraft((prev) => ({ ...prev, optionCostPct: e.target.value }))}
                    />
                  </div>
                  <div className="cards-field">
                    <label htmlFor="draft-feeAai">ROA AAI</label>
                    <input
                      id="draft-feeAai"
                      className="input"
                      type="text"
                      value={imageImportDraft.feeAai}
                      onChange={(e) => setImageImportDraft((prev) => ({ ...prev, feeAai: e.target.value }))}
                    />
                  </div>
                  {imageImportDraft.protectionPct || imageImportDraft.barrierUpPct || imageImportDraft.capAfterPct ? (
                    <>
                      <div className="cards-field">
                        <label htmlFor="draft-protectionPct">Protecao %</label>
                        <input
                          id="draft-protectionPct"
                          className="input"
                          type="text"
                          value={imageImportDraft.protectionPct}
                          onChange={(e) => setImageImportDraft((prev) => ({ ...prev, protectionPct: e.target.value }))}
                        />
                      </div>
                      <div className="cards-field">
                        <label htmlFor="draft-barrierUpPct">Barreira alta %</label>
                        <input
                          id="draft-barrierUpPct"
                          className="input"
                          type="text"
                          value={imageImportDraft.barrierUpPct}
                          onChange={(e) => setImageImportDraft((prev) => ({ ...prev, barrierUpPct: e.target.value }))}
                        />
                      </div>
                      <div className="cards-field">
                        <label htmlFor="draft-capAfterPct">Limitador %</label>
                        <input
                          id="draft-capAfterPct"
                          className="input"
                          type="text"
                          value={imageImportDraft.capAfterPct}
                          onChange={(e) => setImageImportDraft((prev) => ({ ...prev, capAfterPct: e.target.value }))}
                        />
                      </div>
                    </>
                  ) : null}
                </div>

                <div className="cards-image-draft-options">
                  <div className="cards-image-draft-options-header">
                    <label className="cards-image-draft-options-label">Opcoes</label>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      title="Adicionar opção"
                      onClick={() => setImageImportDraft((prev) => ({
                        ...prev,
                        options: [...prev.options, { optionType: 'CALL', side: 'long', strike: '', barrierType: '', barrierValue: '' }],
                      }))}
                    >
                      + Opção
                    </button>
                  </div>
                    {imageImportDraft.options.map((opt, idx) => (
                      <div key={idx} className="cards-image-draft-option-row">
                        <select
                          className="input"
                          value={opt.side}
                          onChange={(e) => setImageImportDraft((prev) => {
                            const next = [...prev.options]
                            next[idx] = { ...next[idx], side: e.target.value }
                            return { ...prev, options: next }
                          })}
                        >
                          <option value="long">Compra</option>
                          <option value="short">Venda</option>
                        </select>
                        <select
                          className="input"
                          value={opt.optionType}
                          onChange={(e) => setImageImportDraft((prev) => {
                            const next = [...prev.options]
                            next[idx] = { ...next[idx], optionType: e.target.value }
                            return { ...prev, options: next }
                          })}
                        >
                          <option value="PUT">Put</option>
                          <option value="CALL">Call</option>
                        </select>
                        <input
                          className="input"
                          type="text"
                          placeholder="Strike %"
                          value={opt.strike}
                          onChange={(e) => setImageImportDraft((prev) => {
                            const next = [...prev.options]
                            next[idx] = { ...next[idx], strike: e.target.value }
                            return { ...prev, options: next }
                          })}
                        />
                        <select
                          className="input"
                          value={opt.barrierType}
                          onChange={(e) => setImageImportDraft((prev) => {
                            const next = [...prev.options]
                            next[idx] = { ...next[idx], barrierType: e.target.value }
                            return { ...prev, options: next }
                          })}
                        >
                          <option value="">Sem barreira</option>
                          <option value="UI">UI</option>
                          <option value="UO">UO</option>
                          <option value="KI">KI</option>
                          <option value="KO">KO</option>
                          <option value="DI">DI</option>
                        </select>
                        {opt.barrierType ? (
                          <input
                            className="input"
                            type="text"
                            placeholder="Barreira %"
                            value={opt.barrierValue}
                            onChange={(e) => setImageImportDraft((prev) => {
                              const next = [...prev.options]
                              next[idx] = { ...next[idx], barrierValue: e.target.value }
                              return { ...prev, options: next }
                            })}
                          />
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost btn-danger-text"
                          title="Remover opção"
                          onClick={() => setImageImportDraft((prev) => ({
                            ...prev,
                            options: prev.options.filter((_, i) => i !== idx),
                          }))}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                {imageImportSummary?.rawText ? (
                  <details className="cards-image-ocr-text">
                    <summary>Texto reconhecido</summary>
                    <pre>{imageImportSummary.rawText}</pre>
                  </details>
                ) : null}

                <div className="cards-image-draft-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={handleConfirmImageImport}
                  >
                    Inserir
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={handleClearImageImport}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <section className={`cards-collapsible ${formSections.operation ? 'is-open' : ''}`.trim()}>
            <button
              className="cards-collapsible-trigger"
              type="button"
              onClick={() => toggleFormSection('operation')}
              aria-expanded={formSections.operation === true}
            >
              <span>Caracteristicas da operacao</span>
              <small>{operationSectionSummary}</small>
              <span className="cards-collapsible-icon">{formSections.operation ? '-' : '+'}</span>
            </button>
            {formSections.operation ? (
              <div className="cards-collapsible-body">
                <div className="cards-builder-row">
                  <div className="cards-field">
                    <label htmlFor="cards-template">Tipo de estrutura</label>
                    <select
                      id="cards-template"
                      className="input"
                      value={templateId}
                      onChange={handleTemplateChange}
                    >
                      {templateOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>

                  <div className="cards-field">
                    <label htmlFor="cards-layout">Layout do preview</label>
                    <select
                      id="cards-layout"
                      className="input"
                      value={layoutMode}
                      onChange={(event) => setLayoutMode(event.target.value)}
                    >
                      {layoutOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="cards-builder-row">
                  <div className="cards-field">
                    <label htmlFor="cards-show-logo">Icone no card</label>
                    <select
                      id="cards-show-logo"
                      className="input"
                      value={showCompanyLogo ? 'logo' : 'texto'}
                      onChange={(event) => setShowCompanyLogo(event.target.value === 'logo')}
                    >
                      <option value="logo">Logo da empresa</option>
                      <option value="texto">Texto (como antes)</option>
                    </select>
                  </div>
                </div>

                {groupedFields.map((group) => (
                  <div key={group.section} className="cards-form-group">
                    <h4>{group.section}</h4>
                    <div className="cards-grid">
                      {group.fields.map((field) => (
                        <div key={field.key} className="cards-field">
                          <label htmlFor={`field-${field.key}`}>
                            {field.label}
                            {field.required ? <span className="cards-required">*</span> : null}
                          </label>
                          <input
                            id={`field-${field.key}`}
                            className="input"
                            type={field.type === 'date' ? 'date' : 'text'}
                            inputMode={field.type === 'number' ? 'decimal' : undefined}
                            value={values[field.key] ?? ''}
                            onChange={(event) => handleValueChange(field.key, event.target.value)}
                          />
                        </div>
                      ))}
                      {group.section === 'Identificacao' ? (
                        <div className="cards-field">
                          <label htmlFor="field-live-price">Preco atual do ativo</label>
                          <input
                            id="field-live-price"
                            className="input"
                            type="text"
                            value={currentTickerPriceLabel}
                            readOnly
                            disabled
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          {optionForm.enabled ? (
            <section className={`cards-collapsible ${formSections.options ? 'is-open' : ''}`.trim()}>
              <button
                className="cards-collapsible-trigger"
                type="button"
                onClick={() => toggleFormSection('options')}
                aria-expanded={formSections.options === true}
              >
                <span>Opcoes da estrutura</span>
                <small>{optionsSectionSummary}</small>
                <span className="cards-collapsible-icon">{formSections.options ? '-' : '+'}</span>
              </button>
              {formSections.options ? (
                <div className="cards-collapsible-body">
                  <div className="cards-options-head">
                    <h4>Opcoes da estrutura</h4>
                    <div className="cards-options-actions">
                      <button className="btn btn-secondary btn-inline" type="button" onClick={handleAddOption}>
                        + Opcao
                      </button>
                      <button
                        className="btn btn-primary btn-inline"
                        type="button"
                        onClick={handleApplyOptionChanges}
                        disabled={!hasPendingOptionChanges}
                      >
                        Aplicar
                      </button>
                    </div>
                  </div>
                  {hasPendingOptionChanges ? <small className="cards-options-note">Existem alteracoes pendentes nas opcoes.</small> : null}
                  <small className="cards-options-note">
                    Sincronizacao: {model?.optionSync?.mode === 'payoff' ? 'payoff (parcial)' : 'template'}.
                    {` Patch aplicado: ${optionSyncPatchCount}.`}
                  </small>
                  {Array.isArray(model?.optionSync?.warnings) && model.optionSync.warnings.length ? (
                    <div className="warning-panel cards-warning">
                      <div>
                        <strong>Ajuste parcial por opcoes</strong>
                        <ul>
                          {model.optionSync.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : null}

                  <div className="cards-options-list">
                    {visibleOptionDraftEntries.map((entry, index) => {
                      const showBarrierValue = optionForm.showBarrier && isExplicitBarrierType(entry?.barrierType)
                      return (
                        <article key={entry?.id || `opt-${index}`} className="cards-option-row">
                          <div className="cards-option-row-head">
                            <strong>Opcao {index + 1}</strong>
                            {visibleOptionDraftEntries.length > 1 ? (
                              <button
                                className="btn btn-secondary btn-inline"
                                type="button"
                                onClick={() => handleRemoveOption(entry?.id)}
                              >
                                Remover
                              </button>
                            ) : null}
                          </div>

                          <div className="cards-option-grid">
                            <div className="cards-field">
                              <label>Tipo</label>
                              <select
                                className="input"
                                value={entry?.optionType || 'CALL'}
                                onChange={(event) => handleOptionChange(entry?.id, { optionType: event.target.value })}
                              >
                                <option value="CALL">CALL</option>
                                <option value="PUT">PUT</option>
                              </select>
                            </div>

                            <div className="cards-field">
                              <label>Lado</label>
                              <select
                                className="input"
                                value={entry?.side || 'long'}
                                onChange={(event) => handleOptionChange(entry?.id, { side: event.target.value })}
                              >
                                <option value="long">Comprada</option>
                                <option value="short">Vendida</option>
                              </select>
                            </div>

                            <div className="cards-field">
                              <label>Quantidade</label>
                              {!entry?.useCustomQuantity ? (
                                <button
                                  className="btn btn-secondary btn-inline cards-option-qty-toggle"
                                  type="button"
                                  onClick={() => handleOptionChange(entry?.id, { useCustomQuantity: true })}
                                >
                                  Escolher quantidade
                                </button>
                              ) : (
                                <div className="cards-option-qty-editor">
                                  <input
                                    className="input"
                                    type="text"
                                    inputMode="decimal"
                                    value={entry?.quantity ?? ''}
                                    onChange={(event) => handleOptionChange(entry?.id, { quantity: event.target.value })}
                                    placeholder="1000"
                                  />
                                  <button
                                    className="btn btn-secondary btn-inline"
                                    type="button"
                                    onClick={() => handleOptionChange(entry?.id, { useCustomQuantity: false, quantity: '' })}
                                  >
                                    Limpar
                                  </button>
                                </div>
                              )}
                            </div>

                            {optionForm.showStrike ? (
                              <div className="cards-field">
                                <label>Strike (%)</label>
                                <input
                                  className="input"
                                  type="text"
                                  inputMode="decimal"
                                  value={entry?.strike ?? ''}
                                  onChange={(event) => handleOptionChange(entry?.id, { strike: event.target.value })}
                                  placeholder="100,00"
                                />
                                <small className="cards-field-help">100% = 0x0 (ATM). Ex.: 90% = 10% abaixo.</small>
                              </div>
                            ) : null}

                            {optionForm.showBarrier ? (
                              <div className="cards-field">
                                <label>Tipo de barreira</label>
                                <select
                                  className="input"
                                  value={entry?.barrierType ?? ''}
                                  onChange={(event) => handleOptionChange(entry?.id, { barrierType: event.target.value })}
                                >
                                  <option value="">Sem barreira</option>
                                  <option value="UI">UI</option>
                                  <option value="UO">UO</option>
                                  <option value="KI">KI</option>
                                  <option value="KO">KO / D.O</option>
                                </select>
                              </div>
                            ) : null}

                            {showBarrierValue ? (
                              <div className="cards-field">
                                <label>Barreira (%)</label>
                                <input
                                  className="input"
                                  type="text"
                                  inputMode="decimal"
                                  value={entry?.barrierValue ?? ''}
                                  onChange={(event) => handleOptionChange(entry?.id, { barrierValue: event.target.value })}
                                  placeholder="100,00"
                                />
                                <small className="cards-field-help">Referencia em percentual do 0x0.</small>
                              </div>
                            ) : null}

                            {optionForm.showCoupon ? (
                              <div className="cards-field">
                                <label>Cupom nominal (%)</label>
                                <input
                                  className="input"
                                  type="text"
                                  inputMode="decimal"
                                  value={entry?.coupon ?? ''}
                                  onChange={(event) => handleOptionChange(entry?.id, { coupon: event.target.value })}
                                  placeholder="1,50"
                                />
                                <small className="cards-field-help">Valor de cupom vinculado a esta opcao.</small>
                              </div>
                            ) : null}
                          </div>
                        </article>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {model.validations?.length ? (
            <div className="warning-panel cards-warning">
              <div>
                <strong>Validacoes pendentes</strong>
                <ul>
                  {model.validations.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <section className={`cards-collapsible ${formSections.consolidator ? 'is-open' : ''}`.trim()}>
            <button
              className="cards-collapsible-trigger"
              type="button"
              onClick={() => toggleFormSection('consolidator')}
              aria-expanded={formSections.consolidator === true}
            >
              <span>Consolidador resumido</span>
              <small>{consolidatorSectionSummary}</small>
              <span className="cards-collapsible-icon">{formSections.consolidator ? '-' : '+'}</span>
            </button>
            {formSections.consolidator ? (
              <div className="cards-collapsible-body">
                <div className="cards-options-head">
                  <h4>Consolidador resumido</h4>
                  <div className="cards-options-actions">
                    <button
                      className="btn btn-secondary btn-inline"
                      type="button"
                      onClick={handleClearConsolidator}
                      disabled={!consolidatedEntries.length}
                    >
                      Limpar
                    </button>
                  </div>
                </div>
                <small className="cards-options-note">
                  Cada operacao salva apenas a configuracao usada no momento da inclusao. Ao carregar, o payoff e gerado novamente.
                </small>
                {consolidatedEntries.length ? (
                  <div className="cards-consolidator-list">
                    {consolidatedEntries.map((entry, index) => {
                      const snapshot = entry?.snapshot
                      const snapshotOptions = Array.isArray(snapshot?.options) ? snapshot.options.length : 0
                      const snapshotConfigCount = Object.keys(snapshot?.values || {}).length
                      return (
                        <article key={entry.id} className="cards-consolidator-row">
                          <div className="cards-consolidator-copy">
                            <strong>{entry.operationLabel || `Operacao ${index + 1}`}</strong>
                            <p>{`${entry.maturityLabel || '--'} | ${entry.summary || 'Retorno conforme parametros configurados.'}`}</p>
                            {snapshot ? (
                              <small className="muted">
                                Configuracao salva em {formatDateTimeLabel(snapshot.capturedAt)} | {snapshotOptions} opcao(oes) | {snapshotConfigCount} campo(s)
                              </small>
                            ) : null}
                          </div>
                          <div className="cards-consolidator-controls">
                            <select
                              className="input"
                              value={entry.group || 'OUTRAS'}
                              onChange={(event) => handleConsolidatorEntryPatch(entry.id, { group: event.target.value })}
                            >
                              {consolidatorGroupOrder.map((group) => (
                                <option key={group} value={group}>{group}</option>
                              ))}
                            </select>
                            <input
                              className="input"
                              type="text"
                              inputMode="decimal"
                              value={entry.roaInput ?? ''}
                              onChange={(event) => handleConsolidatorEntryPatch(entry.id, { roaInput: event.target.value })}
                              placeholder="ROA (%)"
                            />
                            <button
                              className="btn btn-primary btn-inline"
                              type="button"
                              onClick={() => handleLoadConsolidatorEntry(entry.id)}
                            >
                              Carregar
                            </button>
                            <button
                              className="btn btn-secondary btn-inline"
                              type="button"
                              onClick={() => handleRemoveConsolidatorEntry(entry.id)}
                            >
                              Remover
                            </button>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                ) : (
                  <small className="muted">Nenhuma operacao adicionada ainda.</small>
                )}
              </div>
            ) : null}
          </section>

          <section className={`cards-collapsible ${formSections.message ? 'is-open' : ''}`.trim()}>
            <button
              className="cards-collapsible-trigger"
              type="button"
              onClick={() => toggleFormSection('message')}
              aria-expanded={formSections.message === true}
            >
              <span>Mensagem pronta</span>
              <small>{messageSectionSummary}</small>
              <span className="cards-collapsible-icon">{formSections.message ? '-' : '+'}</span>
            </button>
            {formSections.message ? (
              <div className="cards-collapsible-body cards-message-block">
                <div className="cards-message-head">
                  <h4>Mensagem pronta</h4>
                  <div className="panel-actions">
                    <button className="btn btn-secondary" type="button" onClick={handleAddMessageBlock}>Adicionar bloco</button>
                    <button className="btn btn-secondary" type="button" onClick={handleRestoreTemplate}>Restaurar template</button>
                    <button className="btn btn-secondary" type="button" onClick={handleSaveMessage}>
                      {hasSavedMessageForTemplate ? 'Atualizar texto salvo' : 'Salvar texto'}
                    </button>
                    <button className="btn btn-primary" type="button" onClick={handleCopyText}>Copiar texto</button>
                  </div>
                </div>
                <div className="cards-message-section-list">
                  {messageEditor.blocks.length ? messageEditor.blocks.map((block) => (
                    <div key={block.id} className="cards-field cards-message-section-field">
                      <div className="cards-message-section-head">
                        <label>{block.label}</label>
                        <button
                          className="btn btn-secondary btn-inline"
                          type="button"
                          onClick={() => handleRemoveMessageBlock(block.id)}
                        >
                          Remover
                        </button>
                      </div>
                      <textarea
                        className="input cards-message-section-input"
                        value={block.content}
                        onChange={(event) => handleMessageBlockChange(block.id, event.target.value)}
                      />
                    </div>
                  )) : (
                    <small className="muted">Sem blocos identificados no texto atual.</small>
                  )}
                </div>
                <div className="cards-field">
                  <label>Texto completo</label>
                  <textarea
                    className="input cards-message-input cards-message-input--preview"
                    value={messageText}
                    readOnly
                  />
                </div>
              </div>
            ) : null}
          </section>
        </section>

        <section className="panel cards-builder-preview-panel">
          <div className="panel-head">
            <div>
              <h3>Preview exportavel</h3>
              <p className="muted">A exportacao usa exatamente este bloco.</p>
            </div>
            <div className="cards-palette-filter" ref={paletteMenuRef}>
              <button
                type="button"
                className={`cards-palette-trigger ${paletteMenuOpen ? 'is-open' : ''}`}
                onClick={() => {
                  setPaletteMenuOpen((current) => {
                    const next = !current
                    if (!next) setPaletteFilter('')
                    return next
                  })
                }}
                aria-haspopup="dialog"
                aria-expanded={paletteMenuOpen}
              >
                <span className="cards-palette-trigger-text">{selectedPalette.label}</span>
                <span className="cards-palette-swatches" aria-hidden="true">
                  {selectedPalette.colors.map((color) => (
                    <span key={`${selectedPalette.id}-${color}`} className="cards-palette-swatch" style={{ backgroundColor: color }} />
                  ))}
                </span>
              </button>

              {paletteMenuOpen ? (
                <div className="cards-palette-menu" role="dialog" aria-label="Filtro de paletas">
                  <input
                    className="input cards-palette-search"
                    type="text"
                    value={paletteFilter}
                    placeholder="Filtrar paletas..."
                    onChange={(event) => setPaletteFilter(event.target.value)}
                    autoFocus
                  />
                  <div className="cards-palette-list">
                    {filteredPalettes.map((palette) => (
                      <button
                        key={palette.id}
                        type="button"
                        className={`cards-palette-option ${palette.id === selectedPalette.id ? 'is-active' : ''}`}
                        onClick={() => {
                          setPaletteId(palette.id)
                          setPaletteMenuOpen(false)
                          setPaletteFilter('')
                        }}
                      >
                        <span className="cards-palette-option-main">
                          <span className="cards-palette-option-title">{palette.label}</span>
                          <span className="cards-palette-option-description">{palette.description}</span>
                        </span>
                        <span className="cards-palette-swatches" aria-hidden="true">
                          {palette.colors.map((color) => (
                            <span key={`${palette.id}-${color}`} className="cards-palette-swatch" style={{ backgroundColor: color }} />
                          ))}
                        </span>
                      </button>
                    ))}
                    {!filteredPalettes.length ? <p className="cards-palette-empty">Nenhuma paleta encontrada.</p> : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="cards-preview-capture" style={paletteStyles.preview} ref={previewRef}>
            {layoutMode === 'consolidado' ? (
              <OperationsConsolidatorPreview
                entries={consolidatedEntries}
                paletteStyle={paletteStyles.cardVars}
                showCompanyLogo={showCompanyLogo}
              />
            ) : (
              <StrategyCardPreview
                model={model}
                leftLabel={model.tableHeadLeft}
                rightLabel={model.tableHeadRight}
                layoutMode={layoutMode}
                summaryHighlights={messagePreviewHighlights}
                showCompanyLogo={showCompanyLogo}
                paletteStyle={paletteStyles.cardVars}
                minimumValue={minimumCardValue}
                companyName={companyInsights.title}
              />
            )}
          </div>

          {layoutMode !== 'consolidado' ? (
            <div className="cards-payoff-grid">
              <div className="cards-payoff-panel">
                <h4>Grafico de payoff</h4>
                <PayoffChart rows={model.payoffRows} />
              </div>
              <div className="cards-payoff-panel">
                <h4>Tabela de payoff</h4>
                <PayoffTable
                  leftLabel={model.tableHeadLeft}
                  rightLabel={model.tableHeadRight}
                  rows={model.payoffRows}
                />
              </div>
            </div>
          ) : null}

          {layoutMode !== 'consolidado' && (isCompanyProfileLoading || hasCompanyInsights) ? (
            <div className="cards-company-panel">
              <div className="cards-company-head">
                <h4>Resumo da empresa</h4>
                {companyInsights.title ? <strong>{companyInsights.title}</strong> : null}
              </div>
              {isCompanyProfileLoading ? (
                <p className="muted cards-company-summary">Carregando informacoes da empresa...</p>
              ) : (
                <>
                  {companyInsights.summary ? (
                    <p className="cards-company-summary">{companyInsights.summary}</p>
                  ) : null}
                  {companyInsights.points.length ? (
                    <ul className="cards-company-points">
                      {companyInsights.points.map((point) => (
                        <li key={point}>{point}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

export default CardGenerator
