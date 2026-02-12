import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import ReportModal from '../components/ReportModal'
import OverrideModal from '../components/OverrideModal'
import SelectMenu from '../components/SelectMenu'
import MultiSelect from '../components/MultiSelect'
import TreeSelect from '../components/TreeSelect'
import { vencimentos } from '../data/vencimento'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { fetchYahooMarketData, normalizeYahooSymbol } from '../services/marketData'
import { exportXlsx } from '../services/exportXlsx'
import { buildDividendKey, clearDividendsCache, fetchDividend, fetchDividendsBatch } from '../services/dividends'
import { applyOverridesToOperation, computeBarrierStatus, computeResult, getEffectiveLegs, getLegOverrideKey } from '../services/settlement'
import { loadOverrides, saveOverrides, updateOverride } from '../services/overrides'
import { parseWorkbook, parseWorkbookBuffer } from '../services/excel'
import { exportReportPdf, exportVencimentosReportPdf } from '../services/pdf'
import { getCurrentUserKey } from '../services/currentUser'
import { enrichRow } from '../services/tags'
import { clearLink, ensurePermission, isValidElectronPath, loadLink, saveLink } from '../services/vencimentoLink'
import { clearLastImported, loadLastImported, saveLastImported } from '../services/vencimentoCache'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { debugLog } from '../services/debug'

const getStatus = (date) => {
  const target = new Date(date)
  const diff = Math.ceil((target.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (diff <= 0) return { key: 'critico', days: diff }
  if (diff <= 7) return { key: 'alerta', days: diff }
  return { key: 'ok', days: diff }
}

const getBarrierBadge = (status) => {
  if (!status) return { label: 'N/A', tone: 'cyan' }
  const high = status.high
  const low = status.low
  if (high && low) return { label: 'Alta + Baixa', tone: 'red' }
  if (high) return { label: 'Bateu alta', tone: 'amber' }
  if (low) return { label: 'Bateu baixa', tone: 'amber' }
  if (high === false || low === false) return { label: 'Nao bateu', tone: 'green' }
  return { label: 'N/A', tone: 'cyan' }
}

const buildCopySummary = (row) => {
  const clienteLabel = row.nomeCliente || row.codigoCliente || row.cliente || '-'
  return [
    `Cliente: ${clienteLabel}`,
    `Ativo: ${row.ativo}`,
    `Estrutura: ${row.estrutura}`,
    `Resultado: ${formatCurrency(row.result.financeiroFinal)}`,
    `Barreira: ${getBarrierBadge(row.barrierStatus).label}`,
  ].join('\n')
}

const normalizeFileName = (name) => String(name || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const pickPreferredFile = (files) => {
  const candidates = files.filter((file) => {
    if (!file || !file.name) return false
    const lower = file.name.toLowerCase()
    return (lower.endsWith('.xlsx') || lower.endsWith('.xls')) && !file.name.startsWith('~$')
  })
  if (!candidates.length) return null
  const preferred = candidates.find((file) => {
    const normalized = normalizeFileName(file.name)
    return normalized.includes('relatorio') && normalized.includes('posicao')
  })
  if (preferred) return preferred
  return candidates.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))[0]
}

const toArrayBuffer = (data) => {
  if (!data) return null
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  return null
}

const spotCache = new Map()
const SPOT_CONCURRENCY = 8
const PAGE_SIZE = 15
const EXPORT_COLUMNS = [
  'ASSESSOR',
  'BROKER',
  'CLIENTE',
  'DATA DE REGISTRO',
  'ATIVO',
  'ESTRUTURA',
  'VALOR DE COMPRA',
  'DATA DE VENCIMENTO',
  'QUANTIDADE',
  'CUSTO UNITÁRIO',
  'CALL COMPRADA',
  'CALL VENDIDA',
  'PUT COMPRADA',
  'PUT COMPRADA 2',
  'PUT VENDIDA',
  'BARREIRA KI',
  'BARREIRA KO',
  'SPOT',
  'GANHO / PREJUÍZO',
  'FINANCEIRO FINAL',
  'VENDA DO ATIVO A MERCADO',
  'LUCRO %',
  'DÉBITO DIVIDENDOS',
  'GANHOS NAS OPÇÕES',
  'GANHO NA PUT',
  'GANHO NA CALL',
  'CUPOM',
  'PAGOU',
]

const toOptionalNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const resolveStrikeValue = (leg) => {
  const raw = leg?.strikeAjustado ?? leg?.strikeAdjusted ?? leg?.strike ?? leg?.precoStrike
  return toOptionalNumber(raw)
}

const pickOptionStrikes = (legs) => {
  const callsLong = []
  const callsShort = []
  const putsLong = []
  const putsShort = []
  ;(legs || []).forEach((leg) => {
    const tipo = String(leg?.tipo || '').toUpperCase()
    if (tipo !== 'CALL' && tipo !== 'PUT') return
    const strike = resolveStrikeValue(leg)
    if (strike == null) return
    const isShort = String(leg?.side || '').toLowerCase() === 'short' || Number(leg?.quantidade || 0) < 0
    if (tipo === 'CALL') {
      if (isShort) callsShort.push(strike)
      else callsLong.push(strike)
    }
    if (tipo === 'PUT') {
      if (isShort) putsShort.push(strike)
      else putsLong.push(strike)
    }
  })
  return {
    callComprada: callsLong[0] ?? null,
    callVendida: callsShort[0] ?? null,
    putComprada: putsLong[0] ?? null,
    putComprada2: putsLong[1] ?? null,
    putVendida: putsShort[0] ?? null,
  }
}

const resolveBarrierLevels = (legs, hasBarrier = true) => {
  if (!hasBarrier) return { ki: null, ko: null }
  let ki = null
  let ko = null
  ;(legs || []).forEach((leg) => {
    if (leg?.barreiraValor == null) return
    const type = normalizeBarrierTypeInput(leg?.barreiraTipo)
    const value = toOptionalNumber(leg.barreiraValor)
    if (value == null) return
    const isKi = type === 'KI' || type === 'UI'
    const isKo = type === 'KO' || type === 'UO'
    if (isKi && ki == null) ki = value
    if (isKo && ko == null) ko = value
  })
  return { ki, ko }
}

const buildSpotKey = (row) => {
  const symbol = normalizeYahooSymbol(row?.ativo)
  const startDate = normalizeDateKey(row?.dataRegistro)
  const endDate = normalizeDateKey(row?.vencimento)
  if (!symbol || !startDate || !endDate) return null
  return `${symbol}:${startDate}:${endDate}`
}

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index
      index += 1
      if (current >= items.length) break
      results[current] = await mapper(items[current], current)
    }
  })
  await Promise.all(workers)
  return results
}

const formatSpotValue = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—'
  return formatNumber(value)
}

const formatUpdateError = (error, prefix = 'Falha ao atualizar') => {
  const provider = error?.provider || error?.payload?.source || error?.source
  const status = error?.status || error?.payload?.status
  const detail = error?.detail || error?.message || 'erro desconhecido'
  const providerLabel = provider ? ` (${provider}${status ? ` ${status}` : ''})` : ''
  return `${prefix}${providerLabel}: ${detail}`
}

const parseQuantity = (value) => {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const cleaned = String(value).trim().replace(/\s+/g, '').replace(',', '.')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

const parseLocaleNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeDateInput = (value) => {
  if (value == null) return null
  const normalized = normalizeDateKey(String(value).trim())
  return normalized || null
}

const normalizeBarrierTypeInput = (value) => {
  if (value == null) return null
  const raw = String(value).trim().toUpperCase()
  if (!raw || raw === 'AUTO') return null
  if (raw === 'NONE' || raw === 'SEM BARREIRA' || raw === 'SEM_BARRERA' || raw === 'NO_BARRIER') return 'NONE'
  if (raw === 'UI' || raw === 'UO' || raw === 'KI' || raw === 'KO') return raw
  if (raw === 'DI') return 'KI'
  if (raw === 'DO') return 'KO'
  const isUp = raw.includes('UP') || raw.startsWith('U')
  const isDown = raw.includes('DOWN') || raw.startsWith('D')
  const isOut = raw.includes('OUT') || raw.endsWith('O')
  const isIn = raw.includes('IN') || raw.endsWith('I')
  if (isUp && isOut) return 'UO'
  if (isUp && isIn) return 'UI'
  if (isDown && isOut) return 'KO'
  if (isDown && isIn) return 'KI'
  if (raw === 'OUT' || isOut) return 'KO'
  if (raw === 'IN' || isIn) return 'KI'
  return null
}

const normalizeOptionSideInput = (value) => {
  if (value == null) return null
  const raw = String(value).trim().toUpperCase()
  if (raw === 'CALL' || raw === 'PUT') return raw
  return null
}

const isExplicitBarrierTypeInput = (value) => {
  const normalized = normalizeBarrierTypeInput(value)
  return normalized === 'UI' || normalized === 'UO' || normalized === 'KI' || normalized === 'KO'
}

const describeBarrierType = (value) => {
  const normalized = normalizeBarrierTypeInput(value)
  if (!normalized) return { key: 'auto', label: 'Sem alteracao (importado)', direction: null, mode: null }
  if (normalized === 'NONE') return { key: 'none', label: 'Sem barreira', direction: null, mode: null }
  if (normalized === 'UI') return { key: 'UI', label: 'Alta • Ativação (UI)', direction: 'high', mode: 'in' }
  if (normalized === 'UO') return { key: 'UO', label: 'Alta • Desativação (UO)', direction: 'high', mode: 'out' }
  if (normalized === 'KI') return { key: 'KI', label: 'Queda • Ativação (KI)', direction: 'low', mode: 'in' }
  return { key: 'KO', label: 'Queda • Desativação (KO)', direction: 'low', mode: 'out' }
}

const getLegStrike = (leg) => {
  return toOptionalNumber(leg?.strikeAjustado ?? leg?.strikeAdjusted ?? leg?.strike ?? leg?.precoStrike)
}

let structureEntrySeq = 0

const nextStructureEntryId = () => {
  structureEntrySeq += 1
  return `se-${structureEntrySeq}`
}

const toDraftFieldValue = (value) => {
  if (value == null) return ''
  return String(value)
}

const createStructureEntryDraft = (input = {}) => {
  const normalizedType = normalizeBarrierTypeInput(input?.barrierTypeOverride)
  const normalizedExpiry = normalizeDateInput(input?.optionExpiryDateOverride)
  return {
    id: input?.id || nextStructureEntryId(),
    legKey: input?.legKey != null ? String(input.legKey) : '',
    optionSide: normalizeOptionSideInput(input?.optionSide) || '',
    optionQtyOverride: toDraftFieldValue(input?.optionQtyOverride),
    strikeOverride: toDraftFieldValue(input?.strikeOverride),
    barrierTypeOverride: normalizedType || '',
    barrierValueOverride: toDraftFieldValue(input?.barrierValueOverride),
    optionExpiryDateOverride: normalizedExpiry || '',
  }
}

const hasStructureEntryInput = (entry) => {
  if (!entry || typeof entry !== 'object') return false
  return Boolean(
    String(entry.optionQtyOverride ?? '').trim()
    || String(entry.strikeOverride ?? '').trim()
    || String(entry.barrierTypeOverride ?? '').trim()
    || String(entry.barrierValueOverride ?? '').trim()
    || String(entry.optionExpiryDateOverride ?? '').trim()
  )
}

const resolveStructureEntryTarget = (structureMeta, entry) => {
  const rawLegKey = String(entry?.legKey ?? '').trim()
  const defaultLegKey = !rawLegKey && !structureMeta?.requiresLegSelection ? (structureMeta?.defaultLegKey || '') : ''
  const legKey = rawLegKey || defaultLegKey
  const legMetaByKey = structureMeta?.legMetaByKey && typeof structureMeta.legMetaByKey === 'object'
    ? structureMeta.legMetaByKey
    : {}
  const legMeta = legKey ? legMetaByKey[legKey] || null : null
  return { legKey, legMeta }
}

const pickNextStructureLegKey = (structureMeta, entries = []) => {
  const options = Array.isArray(structureMeta?.legOptions) ? structureMeta.legOptions : []
  if (!options.length) return ''
  const used = new Set(
    (entries || [])
      .map((entry) => String(entry?.legKey || '').trim())
      .filter(Boolean),
  )
  const next = options.find((option) => !used.has(option.value)) || options[0]
  return next?.value || ''
}

const buildEmptyStructureEntry = (structureMeta, entries = []) => {
  const legKey = pickNextStructureLegKey(structureMeta, entries)
  const optionSide = legKey
    ? normalizeOptionSideInput(structureMeta?.legMetaByKey?.[legKey]?.optionSide)
    : normalizeOptionSideInput(structureMeta?.defaultOptionSide)
  return createStructureEntryDraft({
    legKey,
    optionSide: optionSide || '',
  })
}

const normalizeStructureDraftEntries = (entries, structureMeta) => {
  const list = Array.isArray(entries)
    ? entries.map((entry) => createStructureEntryDraft(entry))
    : []
  if (list.length) return list
  return structureMeta?.hasStructureFields ? [buildEmptyStructureEntry(structureMeta)] : []
}

const buildStructureEntriesFromOverride = (override, structureMeta) => {
  const entries = []
  const pushEntry = (value, keyHint = null) => {
    if (!value || typeof value !== 'object') return
    const structure = value.structure && typeof value.structure === 'object' ? value.structure : null
    const legKeyRaw = value.legKey ?? structure?.target?.legKey ?? keyHint
    const legKey = legKeyRaw != null ? String(legKeyRaw).trim() : ''
    const optionSide = normalizeOptionSideInput(
      value.optionSide
      ?? value.optionType
      ?? value.tipo
      ?? structure?.target?.side
      ?? structure?.side
      ?? structureMeta?.legMetaByKey?.[legKey]?.optionSide,
    )
    const optionQtyOverride = value.optionQtyOverride
      ?? value.optionQty
      ?? value.quantidadeOpcaoOverride
      ?? structure?.optionQty
      ?? structure?.qty
    const strikeOverride = value.strikeOverride ?? value.strike ?? structure?.strike
    const barrierTypeOverride = normalizeBarrierTypeInput(
      value.barrierTypeOverride
      ?? value.barreiraTipoOverride
      ?? value.barreiraTipo
      ?? structure?.barrierType
      ?? structure?.tipoBarreira,
    )
    const barrierValueOverride = value.barrierValueOverride
      ?? value.barreiraValorOverride
      ?? structure?.barrierValue
      ?? structure?.barreiraValor
    const optionExpiryDateOverride = normalizeDateInput(
      value.optionExpiryDateOverride
      ?? value.optionExpiryDate
      ?? value.vencimentoOpcaoOverride
      ?? value.vencimentoOpcao
      ?? structure?.optionExpiryDate
      ?? structure?.vencimentoOpcao,
    )
    const entry = createStructureEntryDraft({
      legKey,
      optionSide: optionSide || '',
      optionQtyOverride,
      strikeOverride,
      barrierTypeOverride: barrierTypeOverride || '',
      barrierValueOverride,
      optionExpiryDateOverride: optionExpiryDateOverride || '',
    })
    if (hasStructureEntryInput(entry)) {
      entries.push(entry)
    }
  }

  const legsOverride = override?.legs && typeof override.legs === 'object' ? override.legs : null
  if (legsOverride) {
    Object.entries(legsOverride).forEach(([key, value]) => pushEntry(value, key))
  }

  const structureByLeg = !entries.length && override?.structureByLeg && typeof override.structureByLeg === 'object'
    ? override.structureByLeg
    : null
  if (structureByLeg) {
    Object.entries(structureByLeg).forEach(([key, value]) => pushEntry(value, key))
  }

  if (!entries.length) {
    pushEntry(override)
  }

  if (entries.length) return entries
  return normalizeStructureDraftEntries([], structureMeta)
}

const buildStructureMeta = (row) => {
  const legs = Array.isArray(row?.pernas) ? row.pernas : []
  const optionLegs = legs.filter((leg) => {
    const tipo = normalizeOptionSideInput(leg?.tipo)
    return tipo === 'CALL' || tipo === 'PUT'
  })
  const sourceLegs = optionLegs.length ? optionLegs : legs
  const qtyBaseHint = row?.qtyBase != null && Number.isFinite(Number(row.qtyBase)) && Number(row.qtyBase) > 0
    ? Number(row.qtyBase)
    : null
  const sideCount = new Map()

  const legOptions = sourceLegs.map((leg, fallbackIndex) => {
    const absoluteIndex = legs.indexOf(leg)
    const safeIndex = absoluteIndex >= 0 ? absoluteIndex : fallbackIndex
    const optionSide = normalizeOptionSideInput(leg?.tipo)
    const sideKey = optionSide || 'LEG'
    const nextCount = (sideCount.get(sideKey) || 0) + 1
    sideCount.set(sideKey, nextCount)
    const optionQtyCurrentRaw = leg?.quantidade
    const optionQtyCurrent = optionQtyCurrentRaw != null && Number.isFinite(Number(optionQtyCurrentRaw))
      ? Math.abs(Number(optionQtyCurrentRaw))
      : null
    const strikeCurrent = getLegStrike(leg)
    const hasBarrierField = (
      leg?.barreiraValor != null
      || String(leg?.barreiraTipo || '').trim() !== ''
      || optionSide === 'CALL'
      || optionSide === 'PUT'
    )
    const barrierValueCurrent = leg?.barreiraValor != null ? toOptionalNumber(leg?.barreiraValor) : null
    const barrierTypeCurrent = normalizeBarrierTypeInput(leg?.barreiraTipo) || null
    const barrierTypeCurrentLabel = describeBarrierType(barrierTypeCurrent).label
    const optionExpiryDateCurrent = normalizeDateInput(
      leg?.optionExpiryDateOverride
      ?? leg?.optionExpiryDate
      ?? leg?.vencimentoOpcao
      ?? row?.vencimento,
    )
    const legKey = getLegOverrideKey(leg, safeIndex)
    const baseLabel = optionSide || 'PERNA'
    const label = nextCount > 1 ? `${baseLabel} ${nextCount}` : baseLabel
    const optionQtySuggestion = qtyBaseHint != null ? qtyBaseHint : optionQtyCurrent
    return {
      value: legKey,
      label,
      legKey,
      optionSide: optionSide || null,
      hasOptionQty: optionSide === 'CALL' || optionSide === 'PUT',
      hasStrike: strikeCurrent != null || optionSide === 'CALL' || optionSide === 'PUT',
      hasBarrierValue: hasBarrierField,
      hasBarrierType: hasBarrierField,
      optionQtyCurrent,
      optionQtySuggestion,
      strikeCurrent,
      barrierValueCurrent,
      barrierTypeCurrent,
      barrierTypeCurrentLabel,
      optionExpiryDateCurrent,
    }
  })

  const legMetaByKey = legOptions.reduce((acc, option) => {
    acc[option.legKey] = option
    return acc
  }, {})

  const sideMap = legOptions.reduce((acc, option) => {
    const side = normalizeOptionSideInput(option.optionSide)
    if (!side) return acc
    acc.set(side, (acc.get(side) || 0) + 1)
    return acc
  }, new Map())
  const sideOptions = Array.from(sideMap.entries()).map(([value, count]) => ({
    value,
    label: count > 1 ? `${value} (${count})` : value,
  }))
  const requiresLegSelection = legOptions.length > 1
  const defaultLegKey = legOptions.length === 1 ? legOptions[0].value : ''
  const defaultOptionSide = legOptions.length === 1 ? normalizeOptionSideInput(legOptions[0].optionSide) : null
  const selectedLeg = defaultLegKey ? legMetaByKey[defaultLegKey] : null

  return {
    hasStructureFields: legOptions.length > 0,
    hasOptionQty: legOptions.some((option) => option.hasOptionQty),
    hasStrike: legOptions.some((option) => option.hasStrike),
    hasBarrierValue: legOptions.some((option) => option.hasBarrierValue),
    hasBarrierType: legOptions.some((option) => option.hasBarrierType),
    optionQtyCurrent: selectedLeg?.optionQtyCurrent ?? null,
    optionQtySuggestion: selectedLeg?.optionQtySuggestion ?? null,
    strikeCurrent: selectedLeg?.strikeCurrent ?? null,
    barrierValueCurrent: selectedLeg?.barrierValueCurrent ?? null,
    barrierTypeCurrent: selectedLeg?.barrierTypeCurrent ?? null,
    barrierTypeCurrentLabel: selectedLeg?.barrierTypeCurrentLabel || 'Sem alteracao (importado)',
    legOptions,
    legMetaByKey,
    requiresLegSelection,
    defaultLegKey,
    sideOptions,
    requiresOptionSide: sideOptions.length > 1,
    defaultOptionSide,
    targetLegKey: defaultLegKey || null,
  }
}

const hasStructureParamOverride = (override) => {
  if (!override || typeof override !== 'object') return false
  if (
    override?.optionQtyOverride != null
    || override?.optionExpiryDateOverride != null
    || override?.strikeOverride != null
    || override?.barrierValueOverride != null
    || override?.barrierTypeOverride != null
  ) {
    return true
  }
  if (
    override?.structure?.optionQty != null
    || override?.structure?.optionExpiryDate != null
    || override?.structure?.strike != null
    || override?.structure?.barrierValue != null
    || (override?.structure?.barrierType && String(override.structure.barrierType).toLowerCase() !== 'auto')
  ) {
    return true
  }
  const legs = override?.legs && typeof override.legs === 'object' ? Object.values(override.legs) : []
  if (legs.some((entry) => entry?.optionQtyOverride != null || entry?.optionExpiryDateOverride != null || entry?.strikeOverride != null || entry?.barrierValueOverride != null || entry?.barrierTypeOverride != null)) {
    return true
  }
  const structureByLeg = override?.structureByLeg && typeof override.structureByLeg === 'object'
    ? Object.values(override.structureByLeg)
    : []
  return structureByLeg.some((entry) => entry?.optionQty != null || entry?.optionExpiryDate != null || entry?.strike != null || entry?.barrierValue != null || entry?.barrierType != null)
}

const EMPTY_OVERRIDE_DRAFT = {
  schemaVersion: 2,
  high: 'auto',
  low: 'auto',
  manualCouponBRL: '',
  manualOptionsGainBRL: '',
  structureEntries: [],
  optionQtyOverride: '',
  optionExpiryDateOverride: '',
  strikeOverride: '',
  barrierValueOverride: '',
  barrierTypeOverride: '',
  optionSide: '',
  legKey: '',
  legacyBarrierType: false,
  qtyBonus: 0,
  bonusDate: '',
  bonusNote: '',
}

const EMPTY_OVERRIDE_VALUE = {
  schemaVersion: 2,
  high: 'auto',
  low: 'auto',
  manualCouponBRL: null,
  manualCouponPct: null,
  manualOptionsGainBRL: null,
  optionQtyOverride: null,
  optionExpiryDateOverride: null,
  strikeOverride: null,
  barrierValueOverride: null,
  barrierTypeOverride: null,
  optionSide: null,
  legKey: null,
  legacyBarrierType: false,
  qtyBonus: 0,
  bonusDate: '',
  bonusNote: '',
}

const formatMonthName = (year, month) => {
  const date = new Date(Number(year), Number(month) - 1, 1)
  if (Number.isNaN(date.getTime())) return `${month}/${year}`
  const label = date.toLocaleDateString('pt-BR', { month: 'long' })
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
}

const formatDayLabel = (key) => {
  const [year, month, day] = String(key || '').split('-')
  if (!year || !month || !day) return String(key || '')
  return day
}

const addDays = (dateKey, delta) => {
  const key = normalizeDateKey(dateKey)
  if (!key) return ''
  const date = new Date(`${key}T00:00:00`)
  if (Number.isNaN(date.getTime())) return ''
  date.setDate(date.getDate() + delta)
  return date.toISOString().slice(0, 10)
}

const buildFolderLabel = (link, cache) => {
  if (link) {
    if (link.source === 'electron') {
      if (link.folderPath && link.fileName) return `${link.folderPath} • ${link.fileName}`
      if (link.folderPath) return link.folderPath
    }
    if (link.source === 'browser') {
      const folder = link.folderName || 'Pasta'
      const file = link.fileName || cache?.fileName
      return file ? `${folder} • ${file}` : folder
    }
    if (link.fileName) return link.fileName
  }
  if (cache?.fileName) return `${cache.fileName} • cache`
  return 'Nenhuma pasta vinculada'
}

const pickFileFromDirectoryHandle = async (handle) => {
  if (!handle) return null
  const files = []
  for await (const entry of handle.values()) {
    const lowerName = entry.name.toLowerCase()
    if (entry.kind === 'file' && (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) && !entry.name.startsWith('~$')) {
      const file = await entry.getFile()
      files.push(file)
    }
  }
  const pickedFile = pickPreferredFile(files)
  if (!pickedFile) return null
  return { file: pickedFile, folderName: handle.name, fileName: pickedFile.name }
}

const buildVencimentoTree = (items) => {
  const years = new Map()
  const allValues = new Set()

  items.forEach((item) => {
    const key = normalizeDateKey(item?.vencimento)
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
            label: formatDayLabel(key),
            value: key,
            values: [key],
          }))
          return {
            key: `${year}-${month}`,
            label: `${formatMonthName(year, month)} (${month})`,
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

const buildMultiOptions = (values) => {
  const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return unique.map((value) => ({ value, label: value }))
}

const getResultTone = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number === 0) return ''
  return number > 0 ? 'text-positive' : 'text-negative'
}

const buildPagination = (current, total) => {
  if (total <= 1) return [1]
  const delta = 1
  const range = []
  for (let page = 1; page <= total; page += 1) {
    if (page === 1 || page === total || (page >= current - delta && page <= current + delta)) {
      range.push(page)
    }
  }
  const items = []
  let previous = 0
  range.forEach((page) => {
    if (page - previous > 1) items.push('ellipsis')
    items.push(page)
    previous = page
  })
  return items
}

const buildDividendRequest = (operation, reportDate) => {
  const ticker = normalizeYahooSymbol(operation?.ativo)
  const baseFrom = normalizeDateKey(reportDate || operation?.dataRegistro)
  const from = baseFrom ? addDays(baseFrom, 1) : ''
  const to = normalizeDateKey(operation?.vencimento)
  if (!ticker || !from || !to) return null
  return {
    key: buildDividendKey(ticker, from, to),
    ticker,
    from,
    to,
  }
}

const applyDividendsToMarket = (market, dividend) => {
  if (!dividend) return market
  const total = Number(dividend.total ?? 0)
  return {
    ...market,
    dividendsTotal: Number.isFinite(total) ? total : market?.dividendsTotal ?? 0,
    dividendsSource: dividend.source || market?.dividendsSource,
    dividendsCached: dividend.cached ?? market?.dividendsCached,
  }
}

const fetchSpotPrice = async (ticker, { force = false } = {}) => {
  const key = String(ticker || '').trim().toUpperCase()
  if (!key) return null
  if (!force && spotCache.has(key)) return spotCache.get(key)
  try {
    const r = await fetch(`/api/spot?symbol=${encodeURIComponent(key)}`)
    if (!r.ok) return null
    const data = await r.json()
    const price = Number(data?.price)
    if (!Number.isFinite(price)) return null
    spotCache.set(key, price)
    return price
  } catch {
    return null
  }
}

const attachSpotPrices = async (rows) => {
  if (!Array.isArray(rows) || !rows.length) return rows
  spotCache.clear()
  const pendingTickers = Array.from(new Set(
    rows
      .filter((row) => row?.ativo)
      .map((row) => String(row.ativo || '').trim().toUpperCase())
      .filter(Boolean),
  ))

  if (!pendingTickers.length) return rows

  const results = await mapWithConcurrency(
    pendingTickers,
    SPOT_CONCURRENCY,
    async (ticker) => [ticker, await fetchSpotPrice(ticker, { force: true })],
  )

  const priceMap = new Map(results.filter(([, price]) => price != null))
  if (!priceMap.size) return rows

  return rows.map((row) => {
    if (!row?.ativo) return row
    const price = priceMap.get(String(row.ativo || '').trim().toUpperCase())
    if (price == null) return row
    return { ...row, spotInicial: price }
  })
}

const resolveSpotBase = (operation, market) => {
  const close = market?.close
  if (close != null && Number.isFinite(Number(close))) return Number(close)
  const spot = operation?.spotInicial
  if (spot != null && Number.isFinite(Number(spot))) return Number(spot)
  return null
}

const buildLegSettlementLookupKey = (operationId, legKey, expiryDate) => `${operationId}:${legKey}:${expiryDate}`

const resolveLegExpiryDate = (leg) => normalizeDateInput(
  leg?.optionExpiryDateOverride
  ?? leg?.optionExpiryDate
  ?? leg?.vencimentoOpcaoOverride
  ?? leg?.vencimentoOpcao,
)

const withLegSettlementSpots = (operation, optionSettlementCloseMap) => {
  if (!operation || typeof operation !== 'object') return operation
  const legs = Array.isArray(operation?.pernas) ? operation.pernas : []
  if (!legs.length) return operation
  let changed = false
  const nextLegs = legs.map((leg, index) => {
    if (!leg || typeof leg !== 'object') return leg
    const expiryDate = resolveLegExpiryDate(leg)
    const legKey = getLegOverrideKey(leg, index)
    const lookupKey = expiryDate ? buildLegSettlementLookupKey(operation?.id, legKey, expiryDate) : null
    const settlementSpot = lookupKey ? toOptionalNumber(optionSettlementCloseMap?.[lookupKey]) : null
    const currentSpot = toOptionalNumber(leg?.settlementSpotOverride)

    if (settlementSpot == null) {
      if (currentSpot != null) {
        changed = true
        const nextLeg = { ...leg }
        delete nextLeg.settlementSpotOverride
        return nextLeg
      }
      return leg
    }

    if (currentSpot == null || Math.abs(currentSpot - settlementSpot) > 1e-9) {
      changed = true
      return { ...leg, settlementSpotOverride: settlementSpot }
    }

    return leg
  })

  if (!changed) return operation
  return {
    ...operation,
    pernas: nextLegs,
  }
}

const Vencimento = () => {
  const { notify } = useToast()
  const { selectedBroker, selectedAssessor, clientCodeFilter, setClientCodeFilter, tagsIndex } = useGlobalFilters()
  const [userKey] = useState(() => getCurrentUserKey())
  const [filters, setFilters] = useState({
    search: '',
    broker: [],
    status: '',
    vencimentos: [],
    estruturas: [],
    ativos: [],
    assessores: [],
  })
  const [operations, setOperations] = useState(vencimentos)
  const [marketMap, setMarketMap] = useState({})
  const [optionSettlementCloseMap, setOptionSettlementCloseMap] = useState({})
  const [overrides, setOverrides] = useState(() => loadOverrides(userKey))
  const [selectedReport, setSelectedReport] = useState(null)
  const [selectedOverride, setSelectedOverride] = useState(null)
  const [overrideDraft, setOverrideDraft] = useState(EMPTY_OVERRIDE_DRAFT)
  const [overrideErrors, setOverrideErrors] = useState({})
  const [reportDate, setReportDate] = useState('')
  const [dividendAdjustments, setDividendAdjustments] = useState(new Map())
  const [dividendStatus, setDividendStatus] = useState({ loading: false, error: '' })
  const [dividendsRefreshToken, setDividendsRefreshToken] = useState(0)
  const [linkMeta, setLinkMeta] = useState(null)
  const [cacheMeta, setCacheMeta] = useState(null)
  const [restoreStatus, setRestoreStatus] = useState({ state: 'idle', message: '' })
  const [permissionState, setPermissionState] = useState(null)
  const [pendingFile, setPendingFile] = useState(null)
  const [isParsing, setIsParsing] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isRefreshingAll, setIsRefreshingAll] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const fileInputRef = useRef(null)
  const rowCacheRef = useRef(new Map())
  const broadcastRef = useRef(null)
  const tabIdRef = useRef(Math.random().toString(36).slice(2))
  const restoreRef = useRef({ running: false })

  const folderLabel = useMemo(() => {
    if (pendingFile) {
      if (pendingFile.source === 'electron') {
        if (pendingFile.folderPath && pendingFile.fileName) return `${pendingFile.folderPath} • ${pendingFile.fileName}`
        if (pendingFile.folderPath) return pendingFile.folderPath
      }
      if (pendingFile.source === 'browser') {
        const folder = pendingFile.folderName || pendingFile.handle?.name || 'Pasta'
        const fileName = pendingFile.fileName || pendingFile.file?.name
        return fileName ? `${folder} • ${fileName}` : folder
      }
      if (pendingFile.file?.name) return pendingFile.file.name
    }
    return buildFolderLabel(linkMeta, cacheMeta)
  }, [pendingFile, linkMeta, cacheMeta])

  useEffect(() => {
    if (!userKey) return
    setOverrides(loadOverrides(userKey))
  }, [userKey])

  useEffect(() => {
    if (!userKey) return
    saveOverrides(userKey, overrides)
  }, [overrides, userKey])

  useEffect(() => {
    if (!userKey) return
    try {
      const stored = localStorage.getItem(`pwr.vencimento.reportDate.${userKey}`)
      if (stored) setReportDate(stored)
    } catch {
      // noop
    }
  }, [userKey])

  useEffect(() => {
    if (!userKey) return
    try {
      if (reportDate) {
        localStorage.setItem(`pwr.vencimento.reportDate.${userKey}`, reportDate)
      } else {
        localStorage.removeItem(`pwr.vencimento.reportDate.${userKey}`)
      }
    } catch {
      // noop
    }
  }, [reportDate, userKey])

  const broadcastUpdate = useCallback((type, payload = {}) => {
    if (!userKey) return
    const message = {
      type,
      userKey,
      sender: tabIdRef.current,
      ts: Date.now(),
      ...payload,
    }
    if (broadcastRef.current) {
      broadcastRef.current.postMessage(message)
    } else {
      try {
        localStorage.setItem('pwr.vencimento.broadcast', JSON.stringify(message))
      } catch {
        // noop
      }
    }
  }, [userKey])

  const hydrateCache = useCallback((cache) => {
    setCacheMeta(cache || null)
    if (cache?.rows?.length) {
      setOperations(cache.rows)
    } else if (!cache) {
      setOperations(vencimentos)
    }
  }, [])

  const applyPendingFile = useCallback(async (nextPending, { save = true, silent = false } = {}) => {
    if (!nextPending) return false
    setIsParsing(true)
    let parsedRows = null
    let parseSource = nextPending?.source || 'browser'
    const fileName = nextPending?.fileName || nextPending?.file?.name || null

    try {
      if (nextPending?.source === 'electron') {
        if (!window?.electronAPI?.readFile) throw new Error('electron-unavailable')
        const raw = await window.electronAPI.readFile(nextPending.filePath)
        const buffer = toArrayBuffer(raw)
        if (!buffer) throw new Error('buffer-invalid')
        parsedRows = await parseWorkbookBuffer(buffer)
        parseSource = 'electron'
      } else {
        const file = nextPending?.file || nextPending
        try {
          const formData = new FormData()
          formData.append('file', file)
          const response = await fetch('/api/vencimentos/parse', {
            method: 'POST',
            body: formData,
          })
          if (!response.ok) throw new Error('api-failed')
          const data = await response.json()
          if (!data?.rows) throw new Error('api-invalid')
          parsedRows = data.rows
          parseSource = 'api'
        } catch {
          parsedRows = await parseWorkbook(file)
          parseSource = 'local'
          if (!silent) {
            notify('API indisponivel. Calculo local aplicado.', 'warning')
          }
        }
      }

      if (!parsedRows) throw new Error('parse-empty')
      const withSpot = await attachSpotPrices(parsedRows)
      debugLog('vencimento.restore.parse', { rows: withSpot.length, source: parseSource })
      setOperations(withSpot)
      const storedCache = saveLastImported(userKey, {
        rows: withSpot,
        fileName,
        importedAt: Date.now(),
        source: parseSource,
      })
      setCacheMeta(storedCache)

      if (save) {
        if (nextPending?.source === 'electron' && isValidElectronPath(nextPending.folderPath)) {
          const saved = await saveLink(userKey, {
            source: 'electron',
            folderPath: nextPending.folderPath,
            fileName: nextPending.fileName || fileName,
          })
          if (saved) setLinkMeta(saved)
        } else if (nextPending?.source === 'browser' && nextPending.handle) {
          const saved = await saveLink(userKey, {
            source: 'browser',
            handle: nextPending.handle,
            folderName: nextPending.folderName || nextPending.handle?.name,
            fileName,
          })
          if (saved) setLinkMeta(saved)
        } else {
          const saved = await saveLink(userKey, {
            source: 'file',
            fileName,
          })
          if (saved) setLinkMeta(saved)
        }
        broadcastUpdate('vencimento-updated', { kind: 'link' })
      }

      broadcastUpdate('vencimento-updated', { kind: 'cache' })
      if (!silent) notify('Planilha vinculada e calculada.', 'success')
      setPendingFile(null)
      return true
    } catch {
      if (!silent) notify('Falha ao calcular os dados da planilha.', 'warning')
      return false
    } finally {
      setIsParsing(false)
    }
  }, [broadcastUpdate, notify, userKey])

  const restoreFromLink = useCallback(async (link, { silent = true } = {}) => {
    if (!link || restoreRef.current.running) return
    restoreRef.current.running = true
    setIsRestoring(true)
    setRestoreStatus({ state: 'restoring', message: 'Restaurando vinculo salvo...' })
    debugLog('vencimento.restore.link', { source: link.source })
    try {
      if (link.source === 'electron') {
        if (!window?.electronAPI?.resolveFolder || !isValidElectronPath(link.folderPath)) {
          setRestoreStatus({ state: 'error', message: 'Vinculo salvo invalido.' })
          return
        }
        const meta = await window.electronAPI.resolveFolder(link.folderPath)
        if (!meta?.filePath) {
          setRestoreStatus({ state: 'error', message: 'Pasta nao encontrada ou sem permissao.' })
          return
        }
        const nextPending = { source: 'electron', ...meta }
        setPendingFile(nextPending)
        await applyPendingFile(nextPending, { save: false, silent })
        setRestoreStatus({ state: 'idle', message: '' })
        return
      }

      if (link.source === 'browser') {
        const handle = link.handle
        if (!handle) {
          setRestoreStatus({ state: 'needs-permission', message: 'Permissao pendente para a pasta.' })
          return
        }
        const permission = await ensurePermission(handle)
        setPermissionState(permission)
        if (permission !== 'granted') {
          setRestoreStatus({ state: 'needs-permission', message: 'Reautorize o acesso a pasta para restaurar.' })
          return
        }
        const picked = await pickFileFromDirectoryHandle(handle)
        if (!picked?.file) {
          setRestoreStatus({ state: 'error', message: 'Planilha nao encontrada na pasta vinculada.' })
          return
        }
        const nextPending = { source: 'browser', handle, ...picked }
        setPendingFile(nextPending)
        await applyPendingFile(nextPending, { save: false, silent })
        setRestoreStatus({ state: 'idle', message: '' })
        return
      }

      if (link.source === 'file') {
        setRestoreStatus({ state: 'idle', message: cacheMeta?.rows?.length ? '' : 'Cache local pronto para uso.' })
      }
    } finally {
      restoreRef.current.running = false
      setIsRestoring(false)
    }
  }, [applyPendingFile, cacheMeta?.rows?.length])

  const restoreFromStorage = useCallback(async ({ reparse = false } = {}) => {
    if (!userKey) return
    const cached = loadLastImported(userKey)
    hydrateCache(cached)
    const link = await loadLink(userKey)
    debugLog('vencimento.restore.storage', { hasCache: Boolean(cached?.rows?.length), linkSource: link?.source || null })
    setLinkMeta(link || null)
    setPermissionState(null)
    if (!link) {
      if (cached?.rows?.length) {
        setRestoreStatus({ state: 'idle', message: 'Dados restaurados do cache local.' })
      } else {
        setRestoreStatus({ state: 'idle', message: '' })
      }
      return
    }
    if (reparse) {
      await restoreFromLink(link, { silent: true })
    }
  }, [hydrateCache, restoreFromLink, userKey])

  useEffect(() => {
    if (!userKey) return
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('pwr:vencimento')
      broadcastRef.current = channel
      channel.onmessage = (event) => {
        const message = event?.data
        if (!message || message.sender === tabIdRef.current) return
        if (message.userKey !== userKey) return
        restoreFromStorage({ reparse: false })
      }
    }

    const handleStorage = (event) => {
      if (!event?.key) return
      if (event.key === 'pwr.vencimento.broadcast') {
        const payload = (() => {
          try {
            return JSON.parse(event.newValue || '{}')
          } catch {
            return null
          }
        })()
        if (!payload || payload.sender === tabIdRef.current) return
        if (payload.userKey !== userKey) return
        restoreFromStorage({ reparse: false })
        return
      }
      if (event.key.startsWith('pwr.vencimento.link.') || event.key.startsWith('pwr.vencimento.cache.')) {
        if (!event.key.endsWith(userKey)) return
        restoreFromStorage({ reparse: false })
      }
    }

    window.addEventListener('storage', handleStorage)

    return () => {
      window.removeEventListener('storage', handleStorage)
      if (broadcastRef.current) {
        broadcastRef.current.close()
        broadcastRef.current = null
      }
    }
  }, [restoreFromStorage, userKey])

  useEffect(() => {
    if (!userKey) return
    restoreFromStorage({ reparse: true })
  }, [restoreFromStorage, userKey])

  useEffect(() => {
    let active = true
    const loadMarket = async () => {
      const next = {}
      const dividendRequests = operations.map((operation) => buildDividendRequest(operation, reportDate)).filter(Boolean)
      let dividendMap = new Map()
      if (dividendRequests.length) {
        try {
          const results = await fetchDividendsBatch(dividendRequests.map(({ ticker, from, to }) => ({ ticker, from, to })))
          dividendMap = new Map(results.filter(Boolean).map((item) => [item.key, item]))
        } catch {
          dividendMap = new Map()
        }
      }
      for (const operation of operations) {
        if (!operation.ativo || !operation.dataRegistro || !operation.vencimento) continue
        const dividendRequest = buildDividendRequest(operation, reportDate)
        const dividend = dividendRequest ? dividendMap.get(dividendRequest.key) : null
        try {
          const market = await fetchYahooMarketData({
            symbol: operation.ativo,
            startDate: operation.dataRegistro,
            endDate: operation.vencimento,
          })
          next[operation.id] = applyDividendsToMarket(market, dividend)
        } catch {
          const fallback = {
            close: operation.spotInicial,
            high: null,
            low: null,
            dividendsTotal: 0,
            lastUpdate: Date.now(),
            source: 'fallback',
          }
          next[operation.id] = applyDividendsToMarket(fallback, dividend)
        }
      }
      if (active) setMarketMap(next)
    }
    loadMarket()
    return () => {
      active = false
    }
  }, [operations])

  useEffect(() => {
    let active = true
    const loadOptionSettlementCloses = async () => {
      const requests = []
      const marketRequests = new Map()

      operations.forEach((operation) => {
        const override = overrides[operation?.id] || EMPTY_OVERRIDE_VALUE
        if (!operation?.id || !operation?.ativo || !operation?.dataRegistro) return
        const startDate = normalizeDateKey(operation?.dataRegistro)
        if (!startDate) return

        const operationEffective = applyOverridesToOperation(operation, override)
        const legs = Array.isArray(operationEffective?.pernas) ? operationEffective.pernas : []
        legs.forEach((leg, index) => {
          const expiryDate = resolveLegExpiryDate(leg)
          if (!expiryDate) return
          if (startDate > expiryDate) return
          const legKey = getLegOverrideKey(leg, index)
          const lookupKey = buildLegSettlementLookupKey(operation.id, legKey, expiryDate)
          const marketKey = `${normalizeYahooSymbol(operation.ativo)}:${startDate}:${expiryDate}`
          requests.push({ lookupKey, marketKey })
          if (!marketRequests.has(marketKey)) {
            marketRequests.set(marketKey, {
              symbol: operation.ativo,
              startDate,
              endDate: expiryDate,
            })
          }
        })
      })

      if (!requests.length) {
        if (active) setOptionSettlementCloseMap({})
        return
      }

      const marketResponses = await mapWithConcurrency(
        Array.from(marketRequests.entries()),
        SPOT_CONCURRENCY,
        async ([marketKey, request]) => {
          try {
            const market = await fetchYahooMarketData(request)
            return [marketKey, toOptionalNumber(market?.close)]
          } catch {
            return [marketKey, null]
          }
        },
      )

      if (!active) return

      const closeByMarketKey = new Map(marketResponses)
      const next = {}
      requests.forEach(({ lookupKey, marketKey }) => {
        const close = closeByMarketKey.get(marketKey)
        if (close != null) next[lookupKey] = close
      })
      setOptionSettlementCloseMap(next)
    }

    loadOptionSettlementCloses()
    return () => {
      active = false
    }
  }, [operations, overrides])

  useEffect(() => {
    let active = true
    const run = async () => {
      if (!reportDate) {
        setDividendAdjustments(new Map())
        setDividendStatus({ loading: false, error: '' })
        return
      }
      clearDividendsCache()
      const from = addDays(reportDate, 1)
      if (!from) {
        setDividendAdjustments(new Map())
        setDividendStatus({ loading: false, error: '' })
        return
      }
      const requests = operations
        .map((operation) => {
          const to = normalizeDateKey(operation?.vencimento || operation?.dataReferencia)
          const ticker = operation?.ativo
          if (!ticker || !to || from >= to) return null
          return {
            id: operation.id,
            key: buildDividendKey(ticker, from, to),
            ticker,
            from,
            to,
          }
        })
        .filter(Boolean)

      if (!requests.length) {
        setDividendAdjustments(new Map())
        setDividendStatus({ loading: false, error: '' })
        return
      }

      setDividendStatus({ loading: true, error: '' })
      try {
        const results = await fetchDividendsBatch(requests.map(({ ticker, from, to }) => ({ ticker, from, to })))
        const resultMap = new Map(results.filter(Boolean).map((item) => [item.key, item]))
        const next = new Map()
        requests.forEach((req) => {
          const item = resultMap.get(req.key)
          next.set(req.id, {
            total: Number(item?.total || 0),
            source: item?.source || null,
          })
        })
        if (active) {
          setDividendAdjustments(next)
          setDividendStatus({ loading: false, error: '' })
        }
      } catch {
        if (active) {
          setDividendAdjustments(new Map())
          setDividendStatus({ loading: false, error: 'Falha ao recalcular proventos.' })
        }
      }
    }
    run()
    return () => {
      active = false
    }
  }, [dividendsRefreshToken, operations, reportDate])

  const enrichedOperations = useMemo(
    () => operations.map((operation) => enrichRow(operation, tagsIndex)),
    [operations, tagsIndex],
  )
  const brokerOptions = useMemo(() => buildMultiOptions(enrichedOperations.map((item) => item.broker)), [enrichedOperations])
  const operationsByPeriod = useMemo(() => {
    if (!filters.vencimentos.length) return enrichedOperations
    const set = new Set(filters.vencimentos)
    return enrichedOperations.filter((item) => set.has(normalizeDateKey(item?.vencimento)))
  }, [enrichedOperations, filters.vencimentos])
  const estruturaOptions = useMemo(() => buildMultiOptions(operationsByPeriod.map((item) => item.estrutura)), [operationsByPeriod])
  const ativoOptions = useMemo(() => buildMultiOptions(enrichedOperations.map((item) => item.ativo)), [enrichedOperations])
  const assessorOptions = useMemo(() => buildMultiOptions(enrichedOperations.map((item) => item.assessor)), [enrichedOperations])
  const clienteOptions = useMemo(
    () => buildMultiOptions(enrichedOperations.map((item) => item.codigoCliente || item.cliente)),
    [enrichedOperations],
  )
  const { tree: vencimentoTree, allValues: vencimentoValues } = useMemo(
    () => buildVencimentoTree(enrichedOperations),
    [enrichedOperations],
  )

  const handleRefreshData = useCallback(async (operation) => {
    try {
      const market = await fetchYahooMarketData({
        symbol: operation.ativo,
        startDate: operation.dataRegistro,
        endDate: operation.vencimento,
      })
      let dividend = null
      const dividendRequest = buildDividendRequest(operation, reportDate)
      if (dividendRequest) {
        try {
          dividend = await fetchDividend(dividendRequest)
        } catch {
          dividend = null
        }
      }
      const marketWithDividends = applyDividendsToMarket(market, dividend)
      setMarketMap((prev) => ({ ...prev, [operation.id]: marketWithDividends }))
      notify('Dados atualizados.', 'success')
    } catch (error) {
      notify(formatUpdateError(error), 'warning')
    }
  }, [notify])

  const applyDividendAdjustments = useCallback((legs, adjustment) => {
    if (!Array.isArray(legs) || !legs.length) return legs
    const total = Number(adjustment || 0)
    if (!reportDate || !Number.isFinite(total) || total <= 0) return legs
    return legs.map((leg) => {
      const tipo = String(leg?.tipo || '').toUpperCase()
      if (tipo !== 'CALL' && tipo !== 'PUT') return leg
      const strike = Number(leg?.strike ?? leg?.precoStrike)
      if (!Number.isFinite(strike)) return leg
      const adjusted = Math.max(0, strike - total)
      return {
        ...leg,
        strikeOriginal: strike,
        strikeAjustado: adjusted,
        dividendAdjustment: total,
      }
    })
  }, [reportDate])

  const buildRow = useCallback((operation) => {
    const market = marketMap[operation.id]
    const dividendInfo = dividendAdjustments.get(operation.id)
    const override = overrides[operation.id] || EMPTY_OVERRIDE_VALUE
    const qtyBase = parseQuantity(operation.qtyBase ?? operation.quantidade ?? 0)
    const qtyAtualRaw = operation.qtyAtual ?? operation.quantidadeAtual
    const qtyAtualSource = parseQuantity(qtyAtualRaw)
    const hasQtyAtualSource = qtyAtualRaw != null && qtyAtualSource > 0
    const overrideBonus = parseQuantity(override.qtyBonus ?? 0)
    const hasOverrideBonus = overrideBonus > 0
    const qtyBonus = hasOverrideBonus
      ? overrideBonus
      : hasQtyAtualSource
        ? Math.max(0, qtyAtualSource - qtyBase)
        : 0
    const qtyAtual = hasOverrideBonus
      ? Math.max(0, qtyBase + qtyBonus)
      : hasQtyAtualSource
        ? qtyAtualSource
        : Math.max(0, qtyBase + qtyBonus)
    const spotBase = resolveSpotBase(operation, market)
    const adjustedLegs = applyDividendAdjustments(operation.pernas, dividendInfo?.total)
    const operationWithSpot = spotBase != null
      ? { ...operation, spotInicial: spotBase, qtyBase, qtyBonus, qtyAtual, pernas: adjustedLegs }
      : { ...operation, qtyBase, qtyBonus, qtyAtual, pernas: adjustedLegs }
    const operationEffectiveRaw = applyOverridesToOperation(operationWithSpot, override)
    const operationEffective = withLegSettlementSpots(operationEffectiveRaw, optionSettlementCloseMap)
    const barrierStatus = computeBarrierStatus(operationEffective, market, override)
    const manualCouponBRL = override?.manualCouponBRL != null && Number.isFinite(Number(override.manualCouponBRL))
      ? Number(override.manualCouponBRL)
      : null
    const legacyCouponLabel = override?.manualCouponPct || null
    const cupomResolved = manualCouponBRL != null
      ? formatCurrency(manualCouponBRL)
      : (legacyCouponLabel || operation.cupom || 'N/A')
    const result = computeResult(operationEffective, market, barrierStatus, override)
    const effectiveLegs = result.effectiveLegs || getEffectiveLegs(operationEffective)
    return {
      ...operationEffective,
      qtyBase,
      qtyBonus,
      qtyAtual,
      market,
      spotBase,
      override,
      manualCouponBRL,
      legacyCouponLabel,
      cupomResolved,
      barrierStatus,
      result,
      effectiveLegs,
      dividendAdjustment: dividendInfo?.total || 0,
      dividendSource: dividendInfo?.source || null,
      status: getStatus(operation.vencimento),
    }
  }, [applyDividendAdjustments, dividendAdjustments, marketMap, optionSettlementCloseMap, overrides])

  const mappedRows = useMemo(() => {
    const previousCache = rowCacheRef.current
    const nextCache = new Map()

    const rowsList = enrichedOperations.map((operation) => {
      const overrideRef = overrides[operation.id] || EMPTY_OVERRIDE_VALUE
      const marketRef = marketMap[operation.id] || null
      const dividendRef = dividendAdjustments.get(operation.id) || null
      const cached = previousCache.get(operation.id)

      if (
        cached
        && cached.operationRef === operation
        && cached.overrideRef === overrideRef
        && cached.marketRef === marketRef
        && cached.dividendRef === dividendRef
      ) {
        nextCache.set(operation.id, cached)
        return cached.row
      }

      const row = buildRow(operation)
      const nextEntry = {
        row,
        operationRef: operation,
        overrideRef,
        marketRef,
        dividendRef,
      }
      nextCache.set(operation.id, nextEntry)
      return row
    })

    rowCacheRef.current = nextCache
    return rowsList
  }, [buildRow, dividendAdjustments, enrichedOperations, marketMap, overrides])

  const rows = useMemo(() => {
    const vencimentoSet = new Set(filters.vencimentos)
    return mappedRows.filter((entry) => {
      const query = filters.search.toLowerCase()
      const searchBase = `${entry.codigoCliente || ''} ${entry.cliente || ''} ${entry.nomeCliente || ''} ${entry.ativo || ''} ${entry.estrutura || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase()
      if (query && !searchBase.includes(query)) return false
      if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
      if (selectedAssessor.length && !selectedAssessor.includes(String(entry.assessor || '').trim())) return false
      if (filters.broker.length && !filters.broker.includes(String(entry.broker || '').trim())) return false
      if (filters.assessores?.length && !filters.assessores.includes(entry.assessor)) return false
      if (clientCodeFilter.length) {
        const clienteMatch = String(entry.codigoCliente || entry.cliente || '').trim()
        if (!clientCodeFilter.includes(clienteMatch)) return false
      }
      if (filters.estruturas?.length && !filters.estruturas.includes(entry.estrutura)) return false
      if (filters.ativos?.length && !filters.ativos.includes(entry.ativo)) return false
      if (vencimentoSet.size && !vencimentoSet.has(normalizeDateKey(entry.vencimento))) return false
      if (filters.status && entry.status.key !== filters.status) return false
      return true
    })
  }, [clientCodeFilter, filters, mappedRows, selectedBroker, selectedAssessor])

  const pageCount = useMemo(() => Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), [rows.length])
  const paginationItems = useMemo(() => buildPagination(currentPage, pageCount), [currentPage, pageCount])
  useEffect(() => {
    setCurrentPage((prev) => Math.min(Math.max(prev, 1), pageCount))
  }, [pageCount])
  useEffect(() => {
    setCurrentPage(1)
  }, [filters, operations, selectedBroker, selectedAssessor, clientCodeFilter])

  const pageStart = (currentPage - 1) * PAGE_SIZE
  const visibleRows = useMemo(() => rows.slice(pageStart, pageStart + PAGE_SIZE), [rows, pageStart])

  useEffect(() => {
    if (!selectedReport) return
    const updated = rows.find((row) => row.id === selectedReport.id)
    if (updated && updated !== selectedReport) setSelectedReport(updated)
  }, [rows, selectedReport])

  useEffect(() => {
    if (!selectedOverride) return
    const updated = rows.find((row) => row.id === selectedOverride.id)
    if (updated && updated !== selectedOverride) setSelectedOverride(updated)
  }, [rows, selectedOverride])

  const handleRefreshAll = useCallback(async () => {
    setIsRefreshingAll(true)
    try {
      const operationMap = new Map(visibleRows.map((operation) => [operation.id, operation]))
      const dividendRequests = visibleRows.map((operation) => buildDividendRequest(operation, reportDate)).filter(Boolean)
      let dividendMap = new Map()
      if (dividendRequests.length) {
        try {
          const results = await fetchDividendsBatch(dividendRequests.map(({ ticker, from, to }) => ({ ticker, from, to })))
          dividendMap = new Map(results.filter(Boolean).map((item) => [item.key, item]))
        } catch {
          dividendMap = new Map()
        }
      }
      const updates = await mapWithConcurrency(
        visibleRows,
        SPOT_CONCURRENCY,
        async (operation) => {
          if (!operation.ativo || !operation.dataRegistro || !operation.vencimento) return null
          try {
            const market = await fetchYahooMarketData({
              symbol: operation.ativo,
              startDate: operation.dataRegistro,
              endDate: operation.vencimento,
            })
            return { id: operation.id, market }
          } catch (error) {
            return { id: operation.id, error }
          }
        },
      )
      setMarketMap((prev) => {
        const next = { ...prev }
        updates.forEach((update) => {
          if (update?.id && update.market) {
            const operation = operationMap.get(update.id)
              const dividendRequest = operation ? buildDividendRequest(operation, reportDate) : null
            const dividend = dividendRequest ? dividendMap.get(dividendRequest.key) : null
            next[update.id] = applyDividendsToMarket(update.market, dividend)
          }
        })
        return next
      })
      const failures = updates.filter((update) => update?.error)
      if (failures.length) {
        notify(formatUpdateError(failures[0].error, `Falha ao atualizar ${failures.length} ativo(s)`), 'warning')
      } else {
        notify('Precos atualizados.', 'success')
      }
    } catch (error) {
      notify(formatUpdateError(error, 'Falha ao atualizar precos'), 'warning')
    } finally {
      setIsRefreshingAll(false)
    }
  }, [visibleRows, notify])

  const totals = useMemo(() => {
    const total = rows.length
    const criticos = rows.filter((row) => row.status.key === 'critico').length
    const alertas = rows.filter((row) => row.status.key === 'alerta').length
    return { total, criticos, alertas }
  }, [rows])

  const handleReportClick = useCallback((row) => {
    setSelectedReport(row)
  }, [])

  const handleOverrideClick = useCallback((row) => {
    const current = overrides[row.id] || EMPTY_OVERRIDE_DRAFT
    const structureMeta = buildStructureMeta(row)
    const structureEntries = buildStructureEntriesFromOverride(current, structureMeta)
    const primaryEntry = structureEntries[0] || null
    setOverrideDraft({
      ...EMPTY_OVERRIDE_DRAFT,
      ...current,
      manualCouponBRL: current.manualCouponBRL ?? '',
      manualOptionsGainBRL: current.manualOptionsGainBRL ?? '',
      structureEntries,
      optionQtyOverride: primaryEntry?.optionQtyOverride ?? current.optionQtyOverride ?? current.structure?.optionQty ?? '',
      optionExpiryDateOverride: primaryEntry?.optionExpiryDateOverride ?? current.optionExpiryDateOverride ?? current.structure?.optionExpiryDate ?? '',
      strikeOverride: primaryEntry?.strikeOverride ?? current.strikeOverride ?? '',
      barrierValueOverride: primaryEntry?.barrierValueOverride ?? current.barrierValueOverride ?? '',
      barrierTypeOverride: primaryEntry?.barrierTypeOverride ?? current.barrierTypeOverride ?? '',
      optionSide: primaryEntry?.optionSide ?? normalizeOptionSideInput(current.optionSide ?? current.structure?.target?.side) ?? '',
      legKey: primaryEntry?.legKey ?? current.legKey ?? '',
    })
    setOverrideErrors({})
    setSelectedOverride(row)
  }, [overrides])

  const selectedStructureMeta = useMemo(
    () => buildStructureMeta(selectedOverride),
    [selectedOverride],
  )

  const validateOverrideDraft = useCallback((draft, structureMeta) => {
    const errors = {}
    const entries = normalizeStructureDraftEntries(draft?.structureEntries, structureMeta)
    const usedTargets = new Set()

    entries.forEach((entry, index) => {
      const entryId = entry?.id || `entry-${index}`
      const errorKey = (field) => `structureEntries.${entryId}.${field}`
      const qtyRaw = String(entry?.optionQtyOverride ?? '').trim()
      const expiryRaw = String(entry?.optionExpiryDateOverride ?? '').trim()
      const strikeRaw = String(entry?.strikeOverride ?? '').trim()
      const barrierRaw = String(entry?.barrierValueOverride ?? '').trim()
      const typeRaw = String(entry?.barrierTypeOverride ?? '').trim()
      const typeNormalized = normalizeBarrierTypeInput(typeRaw)
      const hasInput = Boolean(qtyRaw || expiryRaw || strikeRaw || barrierRaw || typeRaw)
      if (!hasInput) return

      const { legKey, legMeta } = resolveStructureEntryTarget(structureMeta, entry)
      const requiresLegSelection = Boolean(structureMeta?.requiresLegSelection)
      if (requiresLegSelection && !legKey) {
        errors[errorKey('legKey')] = 'Escolhe a perna.'
      }
      if (legKey) {
        if (usedTargets.has(legKey)) {
          errors[errorKey('legKey')] = 'Perna duplicada.'
        } else {
          usedTargets.add(legKey)
        }
      }

      const canEditQty = legMeta?.hasOptionQty ?? structureMeta?.hasOptionQty
      const canEditStrike = legMeta?.hasStrike ?? structureMeta?.hasStrike
      const canEditBarrier = legMeta?.hasBarrierValue ?? structureMeta?.hasBarrierValue
      const canEditBarrierType = legMeta?.hasBarrierType ?? structureMeta?.hasBarrierType
      const requiresBarrierValue = typeNormalized === 'UI' || typeNormalized === 'UO' || typeNormalized === 'KI' || typeNormalized === 'KO'

      if (qtyRaw && !canEditQty) {
        errors[errorKey('optionQtyOverride')] = 'Qtd não aplicável.'
      } else if (qtyRaw) {
        const qty = parseLocaleNumber(qtyRaw)
        if (qty == null || qty <= 0) {
          errors[errorKey('optionQtyOverride')] = 'Qtd inválida.'
        }
      }

      if (expiryRaw) {
        const expiry = normalizeDateInput(expiryRaw)
        if (!expiry) {
          errors[errorKey('optionExpiryDateOverride')] = 'Data inválida.'
        }
      }

      if (strikeRaw && !canEditStrike) {
        errors[errorKey('strikeOverride')] = 'Strike não aplicável.'
      } else if (strikeRaw) {
        const strike = parseLocaleNumber(strikeRaw)
        if (strike == null || strike <= 0) {
          errors[errorKey('strikeOverride')] = 'Strike inválido.'
        }
      }

      if (barrierRaw && !canEditBarrier) {
        errors[errorKey('barrierValueOverride')] = 'Barreira não aplicável.'
      } else if (barrierRaw) {
        const barrierValue = parseLocaleNumber(barrierRaw)
        if (barrierValue == null || barrierValue <= 0) {
          errors[errorKey('barrierValueOverride')] = 'Barreira inválida.'
        }
      }

      if (typeRaw && !canEditBarrierType) {
        errors[errorKey('barrierTypeOverride')] = 'Tipo não aplicável.'
      } else if (typeRaw && !typeNormalized) {
        errors[errorKey('barrierTypeOverride')] = 'Tipo inválido.'
      }

      if (requiresBarrierValue && !barrierRaw) {
        errors[errorKey('barrierValueOverride')] = 'Informe o valor.'
      }
      if (!isExplicitBarrierTypeInput(typeNormalized) && barrierRaw) {
        errors[errorKey('barrierTypeOverride')] = 'Selecione o tipo.'
      }
    })

    return errors
  }, [])

  const buildStructureOverridePatch = useCallback((draft, structureMeta) => {
    const entries = normalizeStructureDraftEntries(draft?.structureEntries, structureMeta)
    const legs = {}
    const manualEntries = []

    entries.forEach((entry, index) => {
      const qtyRaw = String(entry?.optionQtyOverride ?? '').trim()
      const expiryRaw = String(entry?.optionExpiryDateOverride ?? '').trim()
      const strikeRaw = String(entry?.strikeOverride ?? '').trim()
      const barrierRaw = String(entry?.barrierValueOverride ?? '').trim()
      const typeRaw = String(entry?.barrierTypeOverride ?? '').trim()
      const hasInput = Boolean(qtyRaw || expiryRaw || strikeRaw || barrierRaw || typeRaw)
      if (!hasInput) return

      const { legKey, legMeta } = resolveStructureEntryTarget(structureMeta, entry)
      const optionSide = normalizeOptionSideInput(entry?.optionSide) || legMeta?.optionSide || null
      const optionQtyOverride = qtyRaw ? parseLocaleNumber(qtyRaw) : null
      const optionExpiryDateOverride = expiryRaw ? normalizeDateInput(expiryRaw) : null
      const strikeOverride = strikeRaw ? parseLocaleNumber(strikeRaw) : null
      const barrierTypeOverride = typeRaw ? normalizeBarrierTypeInput(typeRaw) : null
      const requiresBarrierValue = isExplicitBarrierTypeInput(barrierTypeOverride)
      const barrierValueOverride = requiresBarrierValue && barrierRaw ? parseLocaleNumber(barrierRaw) : null
      const targetLegKey = legKey || null

      const payload = {
        optionQtyOverride: optionQtyOverride != null ? optionQtyOverride : null,
        optionExpiryDateOverride,
        strikeOverride: strikeOverride != null ? strikeOverride : null,
        barrierValueOverride: barrierValueOverride != null ? barrierValueOverride : null,
        barrierTypeOverride: barrierTypeOverride != null ? barrierTypeOverride : null,
        optionSide: optionSide || null,
        legKey: targetLegKey,
      }
      payload.structure = {
        target: {
          side: payload.optionSide || null,
          legKey: targetLegKey,
        },
        optionQty: payload.optionQtyOverride != null ? payload.optionQtyOverride : null,
        optionExpiryDate: payload.optionExpiryDateOverride || null,
        strike: payload.strikeOverride != null ? payload.strikeOverride : null,
        barrierType: payload.barrierTypeOverride || 'auto',
        barrierValue: payload.barrierValueOverride != null ? payload.barrierValueOverride : null,
      }

      const mapKey = targetLegKey || payload.optionSide || `entry-${index}`
      legs[mapKey] = payload
      manualEntries.push(payload)
    })

    const hasManualStructure = manualEntries.length > 0
    const primary = hasManualStructure ? manualEntries[0] : null
    return {
      optionQtyOverride: primary?.optionQtyOverride ?? null,
      optionExpiryDateOverride: primary?.optionExpiryDateOverride ?? null,
      strikeOverride: primary?.strikeOverride ?? null,
      barrierValueOverride: primary?.barrierValueOverride ?? null,
      barrierTypeOverride: primary?.barrierTypeOverride ?? null,
      optionSide: primary?.optionSide ?? null,
      legKey: primary?.legKey ?? null,
      legacyBarrierType: false,
      structure: primary?.structure || null,
      structureByLeg: null,
      legs: hasManualStructure ? legs : null,
    }
  }, [])

  const handleApplyOverride = useCallback(() => {
    if (!selectedOverride) return
    const errors = validateOverrideDraft(overrideDraft, selectedStructureMeta)
    setOverrideErrors(errors)
    if (Object.keys(errors).length) {
      notify('Corrige os campos de parâmetros da estrutura para salvar.', 'warning')
      return
    }

    const structurePatch = buildStructureOverridePatch(overrideDraft, selectedStructureMeta)
    const nextPayload = { ...overrideDraft, ...structurePatch }
    setOverrides((prev) => updateOverride(prev, selectedOverride.id, nextPayload))
    debugLog('vencimento.override.apply', {
      id: selectedOverride.id,
      structurePatch,
      target: structurePatch.optionSide || 'GLOBAL',
      before: {
        financeiroFinal: selectedOverride.result?.financeiroFinal ?? null,
        ganho: selectedOverride.result?.ganho ?? null,
        percent: selectedOverride.result?.percent ?? null,
      },
      afterHint: {
        qty: structurePatch.optionQtyOverride,
        optionExpiryDate: structurePatch.optionExpiryDateOverride,
        strike: structurePatch.strikeOverride,
        barrierType: structurePatch.barrierTypeOverride || 'auto',
        barrierValue: structurePatch.barrierValueOverride,
      },
    })
    notify('Override aplicado.', 'success')
    setSelectedOverride(null)
    setOverrideErrors({})
  }, [buildStructureOverridePatch, notify, overrideDraft, selectedOverride, selectedStructureMeta, validateOverrideDraft])

  const handleResetOverride = useCallback(() => {
    if (!selectedOverride) return
    setOverrides((prev) => updateOverride(prev, selectedOverride.id, {
      high: 'auto',
      low: 'auto',
    }))
    setOverrideDraft((prev) => ({
      ...prev,
      high: 'auto',
      low: 'auto',
    }))
    notify('Batimento manual voltou para automático.', 'success')
    setOverrideErrors({})
  }, [notify, selectedOverride])

  const handleClearStructureOverrides = useCallback(() => {
    if (!selectedOverride) return
    const clearedEntries = normalizeStructureDraftEntries([], selectedStructureMeta)
    const primaryEntry = clearedEntries[0] || null
    setOverrides((prev) => updateOverride(prev, selectedOverride.id, {
      optionQtyOverride: null,
      optionExpiryDateOverride: null,
      strikeOverride: null,
      barrierValueOverride: null,
      barrierTypeOverride: null,
      optionSide: null,
      legKey: null,
      legacyBarrierType: false,
      structure: null,
      structureByLeg: null,
      legs: null,
    }))
    setOverrideDraft((prev) => ({
      ...prev,
      structureEntries: clearedEntries,
      optionQtyOverride: '',
      optionExpiryDateOverride: '',
      strikeOverride: '',
      barrierValueOverride: '',
      barrierTypeOverride: '',
      optionSide: primaryEntry?.optionSide || selectedStructureMeta?.defaultOptionSide || '',
      legKey: primaryEntry?.legKey || '',
      legacyBarrierType: false,
    }))
    setOverrideErrors({})
    notify('Parâmetros da estrutura limpos.', 'success')
  }, [notify, selectedOverride, selectedStructureMeta])

  const handleStructureEntryChange = useCallback((entryId, patch) => {
    setOverrideDraft((prev) => {
      const currentEntries = normalizeStructureDraftEntries(prev?.structureEntries, selectedStructureMeta)
      const nextEntries = currentEntries.map((entry) => {
        if (entry.id !== entryId) return entry
        const next = {
          ...entry,
          ...patch,
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'legKey')) {
          const legKey = String(patch.legKey || '').trim()
          next.legKey = legKey
          const nextLegMeta = legKey ? selectedStructureMeta?.legMetaByKey?.[legKey] : null
          next.optionSide = normalizeOptionSideInput(patch.optionSide ?? next.optionSide) || nextLegMeta?.optionSide || ''
        } else {
          next.optionSide = normalizeOptionSideInput(next.optionSide) || ''
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'barrierTypeOverride')) {
          const normalizedType = normalizeBarrierTypeInput(patch.barrierTypeOverride)
          next.barrierTypeOverride = normalizedType || ''
          if (!isExplicitBarrierTypeInput(normalizedType)) {
            next.barrierValueOverride = ''
          }
        }
        return createStructureEntryDraft(next)
      })
      return {
        ...prev,
        structureEntries: nextEntries,
      }
    })
  }, [selectedStructureMeta])

  const handleAddStructureEntry = useCallback(() => {
    setOverrideDraft((prev) => {
      const currentEntries = normalizeStructureDraftEntries(prev?.structureEntries, selectedStructureMeta)
      const nextEntry = buildEmptyStructureEntry(selectedStructureMeta, currentEntries)
      return {
        ...prev,
        structureEntries: [...currentEntries, nextEntry],
      }
    })
  }, [selectedStructureMeta])

  const handleRemoveStructureEntry = useCallback((entryId) => {
    setOverrideDraft((prev) => {
      const currentEntries = normalizeStructureDraftEntries(prev?.structureEntries, selectedStructureMeta)
      const filtered = currentEntries.filter((entry) => entry.id !== entryId)
      const nextEntries = filtered.length ? filtered : normalizeStructureDraftEntries([], selectedStructureMeta)
      return {
        ...prev,
        structureEntries: nextEntries,
      }
    })
    setOverrideErrors((prev) => {
      if (!prev || typeof prev !== 'object') return prev
      const needle = `structureEntries.${entryId}.`
      return Object.keys(prev).reduce((acc, key) => {
        if (!key.startsWith(needle)) acc[key] = prev[key]
        return acc
      }, {})
    })
  }, [selectedStructureMeta])

  const handleUseQtyBase = useCallback((entryId) => {
    setOverrideDraft((prev) => {
      const currentEntries = normalizeStructureDraftEntries(prev?.structureEntries, selectedStructureMeta)
      const nextEntries = currentEntries.map((entry) => {
        if (entry.id !== entryId) return entry
        const { legMeta } = resolveStructureEntryTarget(selectedStructureMeta, entry)
        const suggestion = legMeta?.optionQtySuggestion ?? selectedStructureMeta?.optionQtySuggestion
        if (suggestion == null || !Number.isFinite(Number(suggestion)) || Number(suggestion) <= 0) {
          return entry
        }
        return {
          ...entry,
          optionQtyOverride: String(suggestion),
        }
      })
      return {
        ...prev,
        structureEntries: nextEntries,
      }
    })
  }, [selectedStructureMeta])

  const fetchSpotMapForExport = useCallback(async (rowsToExport) => {
    const pending = new Map()
    rowsToExport.forEach((row) => {
      const spot = resolveSpotBase(row, row.market)
      if (spot != null) return
      const symbol = normalizeYahooSymbol(row?.ativo)
      const startDate = normalizeDateKey(row?.dataRegistro)
      const endDate = normalizeDateKey(row?.vencimento)
      if (!symbol || !startDate || !endDate) return
      const key = `${symbol}:${startDate}:${endDate}`
      if (!pending.has(key)) {
        pending.set(key, { key, symbol, startDate, endDate })
      }
    })
    if (!pending.size) return new Map()
    const results = await mapWithConcurrency(
      Array.from(pending.values()),
      SPOT_CONCURRENCY,
      async (request) => {
        try {
          const market = await fetchYahooMarketData({
            symbol: request.symbol,
            startDate: request.startDate,
            endDate: request.endDate,
          })
          return [request.key, toOptionalNumber(market?.close)]
        } catch {
          return [request.key, null]
        }
      },
    )
    return new Map(results.filter(([, value]) => value != null))
  }, [])

  const handleExportXlsx = useCallback(async () => {
    if (isExporting) return
    if (!mappedRows.length) {
      notify('Nenhuma estrutura para exportar.', 'warning')
      return
    }
    setIsExporting(true)
    try {
      const spotMap = await fetchSpotMapForExport(mappedRows)
      const rowsToExport = mappedRows.map((row) => {
        const legs = row.effectiveLegs || row.pernas || []
        const { callComprada, callVendida, putComprada, putComprada2, putVendida } = pickOptionStrikes(legs)
        const { ki, ko } = resolveBarrierLevels(row.pernas || legs, Boolean(row?.barrierStatus?.list?.length))
        const spotKey = buildSpotKey(row)
        const spotValue = toOptionalNumber(resolveSpotBase(row, row.market) ?? (spotKey ? spotMap.get(spotKey) : null))
        const valorCompra = row.result?.valorEntradaIncomplete
          ? null
          : toOptionalNumber(row.result?.valorEntrada ?? row.result?.pagou ?? row.result?.custoTotal)
        const lucroPercent = toOptionalNumber(row.result?.percent)
        const lucroPercentValue = lucroPercent != null ? lucroPercent * 100 : null
        const gainsOpcoes = row.result?.optionsSuppressed ? null : toOptionalNumber(row.result?.ganhosOpcoes)
        const ganhoPut = row.result?.optionsSuppressed ? null : toOptionalNumber(row.result?.ganhoPut)
        const ganhoCall = row.result?.optionsSuppressed ? null : toOptionalNumber(row.result?.ganhoCall)
        return [
          row.assessor || '',
          row.broker || '',
          row.nomeCliente || row.cliente || row.codigoCliente || '',
          normalizeDateKey(row.dataRegistro) || '',
          row.ativo || '',
          row.estrutura || '',
          valorCompra ?? '',
          normalizeDateKey(row.vencimento) || '',
          toOptionalNumber(row.qtyBase ?? row.quantidade) ?? '',
          toOptionalNumber(row.custoUnitario) ?? '',
          callComprada ?? '',
          callVendida ?? '',
          putComprada ?? '',
          putComprada2 ?? '',
          putVendida ?? '',
          ki ?? '',
          ko ?? '',
          spotValue ?? '',
          toOptionalNumber(row.result?.ganho) ?? '',
          toOptionalNumber(row.result?.financeiroFinal) ?? '',
          toOptionalNumber(row.result?.vendaAtivo) ?? '',
          lucroPercentValue ?? '',
          toOptionalNumber(row.result?.dividends) ?? '',
          gainsOpcoes ?? '',
          ganhoPut ?? '',
          ganhoCall ?? '',
          toOptionalNumber(row.result?.cupomTotal) ?? '',
          toOptionalNumber(row.result?.pagou) ?? '',
        ]
      })
      const fileDate = new Date().toISOString().slice(0, 10)
      const result = await exportXlsx({
        fileName: `estruturas_export_${fileDate}.xlsx`,
        sheetName: 'Estruturas',
        columns: EXPORT_COLUMNS,
        rows: rowsToExport,
      })
      if (!result) {
        notify('Exportacao cancelada.', 'warning')
        return
      }
      notify('Exportacao concluida.', 'success')
    } catch {
      notify('Falha ao exportar o XLSX.', 'warning')
    } finally {
      setIsExporting(false)
    }
  }, [fetchSpotMapForExport, isExporting, mappedRows, notify])

  const handleGenerateReport = useCallback(() => {
    if (!visibleRows.length) {
      notify('Nenhuma linha para gerar o relatorio.', 'warning')
      return
    }

    const filterItems = []
    if (selectedBroker.length) filterItems.push({ label: 'Broker global', value: selectedBroker.join(', ') })
    if (selectedAssessor.length) filterItems.push({ label: 'Assessor global', value: selectedAssessor.join(', ') })
    if (clientCodeFilter.length) filterItems.push({ label: 'Clientes', value: clientCodeFilter.join(', ') })
    if (filters.search) filterItems.push({ label: 'Busca', value: filters.search })
    if (filters.broker.length) filterItems.push({ label: 'Broker', value: filters.broker.join(', ') })
    if (filters.assessores.length) filterItems.push({ label: 'Assessor', value: filters.assessores.join(', ') })
    if (filters.estruturas.length) filterItems.push({ label: 'Estruturas', value: filters.estruturas.join(', ') })
    if (filters.ativos.length) filterItems.push({ label: 'Ativos', value: filters.ativos.join(', ') })
    if (filters.vencimentos.length) {
      const label = filters.vencimentos.map((key) => formatDate(key)).join(', ')
      filterItems.push({ label: 'Vencimentos', value: label })
    }
    if (filters.status) filterItems.push({ label: 'Status', value: filters.status })
    filterItems.push({ label: 'Pagina', value: `${currentPage} / ${pageCount}` })

    const totalFinanceiro = visibleRows.reduce((sum, row) => sum + (Number(row.result?.financeiroFinal) || 0), 0)
    const totalGanho = visibleRows.reduce((sum, row) => sum + (Number(row.result?.ganho) || 0), 0)

    const summaryItems = [
      { label: 'Operacoes na pagina', value: formatNumber(visibleRows.length) },
      { label: 'Financeiro final (soma)', value: formatCurrency(totalFinanceiro) },
      { label: 'Ganho/Prejuizo (soma)', value: formatCurrency(totalGanho) },
    ]

    const columns = ['Cliente', 'Assessor', 'Broker', 'Ativo', 'Estrutura', 'Vencimento', 'Resultado']
    const rows = visibleRows.map((row) => [
      row.nomeCliente || row.cliente || row.codigoCliente || '—',
      row.assessor || '—',
      row.broker || '—',
      row.ativo || '—',
      row.estrutura || '—',
      formatDate(row.vencimento),
      formatCurrency(row.result?.financeiroFinal ?? 0),
    ])

    const generatedAt = new Date().toLocaleString('pt-BR')
    exportVencimentosReportPdf(
      {
        title: 'Relatorio de Vencimentos',
        generatedAt,
        filters: filterItems,
        summary: summaryItems,
        columns,
        rows,
      },
      `vencimentos_pagina_${currentPage}`,
    )
  }, [clientCodeFilter, currentPage, filters, notify, pageCount, selectedAssessor, selectedBroker, visibleRows])

  const columns = useMemo(
    () => [
      {
        key: 'assessor',
        label: 'Assessor',
        render: (row) => row.assessor || '—',
      },
      {
        key: 'broker',
        label: 'Broker',
        render: (row) => row.broker || '—',
      },
      {
        key: 'codigoCliente',
        label: 'Codigo cliente',
        render: (row) => row.codigoCliente || row.cliente || '—',
      },
      {
        key: 'dataRegistro',
        label: 'Data registro',
        render: (row) => formatDate(row.dataRegistro),
      },
      { key: 'ativo', label: 'Ativo' },
      { key: 'estrutura', label: 'Estrutura' },
      {
        key: 'vencimento',
        label: 'Vencimento',
        render: (row) => formatDate(row.vencimento),
      },
      {
        key: 'spot',
        label: 'Spot',
        render: (row) => (
          <div className="spot-cell">
            <div className="cell-stack">
              <strong>{formatSpotValue(row.spotBase ?? row.spotInicial)}</strong>
            </div>
            <button
              className="icon-btn ghost"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                handleRefreshData(row)
              }}
              aria-label="Atualizar spot"
            >
              <Icon name="sync" size={14} />
            </button>
          </div>
        ),
      },
      {
        key: 'qtyBase',
        label: 'Qtd base',
        render: (row) => formatNumber(row.qtyBase),
      },
      {
        key: 'qtyBonus',
        label: 'Bonificacao',
        render: (row) => formatNumber(row.qtyBonus),
      },
      {
        key: 'qtyAtual',
        label: 'Qtd atual',
        render: (row) => formatNumber(row.qtyAtual),
      },
      {
        key: 'valorEntrada',
        label: 'Valor de entrada',
        render: (row) => {
          const valorEntrada = row.result?.valorEntrada
          if (row.result?.valorEntradaIncomplete) return <span className="muted">Dados incompletos</span>
          if (valorEntrada == null || Number.isNaN(Number(valorEntrada))) return '—'
          return formatCurrency(valorEntrada)
        },
      },
      {
        key: 'resultado',
        label: 'Resultado $',
        render: (row) => (
          <span className={getResultTone(row.result.financeiroFinal)}>
            {formatCurrency(row.result.financeiroFinal)}
          </span>
        ),
      },
      {
        key: 'vendaAtivo',
        label: 'Venda do ativo',
        render: (row) => formatCurrency(row.result.vendaAtivo),
      },
      {
        key: 'resultadoPercent',
        label: 'Resultado %',
        render: (row) => (
          <span className={getResultTone(row.result.percent)}>
            {(row.result.percent * 100).toFixed(2)}%
          </span>
        ),
      },
      {
        key: 'debito',
        label: 'Debito',
        render: (row) => formatCurrency(row.result.debito ?? 0),
      },
      {
        key: 'ganhosOpcoes',
        label: 'Ganho nas opcoes',
        render: (row) => (
          row.result.optionsSuppressed
            ? <span className="muted">N/A</span>
            : formatCurrency(row.result.ganhosOpcoes)
        ),
      },
      {
        key: 'dividendos',
        label: 'Dividendos',
        render: (row) => formatCurrency(row.result.dividends),
      },
      {
        key: 'cupom',
        label: 'Cupom',
        render: (row) => {
          const manual = row.manualCouponBRL != null
          const legacyNeedsInput = row.result.cupomLegacyNeedsInput
          const legacyConverted = row.result.cupomLegacyConverted
          const label = row.cupomResolved || row.cupom || 'N/A'
          return (
            <div className="cell-stack">
              <strong>{label}</strong>
              {legacyNeedsInput
                ? <small className="muted">Precisa reentrada</small>
                : manual
                  ? <small>Manual</small>
                  : legacyConverted
                    ? <small>Legado</small>
                    : <small>Automatico</small>}
            </div>
          )
        },
      },
      {
        key: 'barreira',
        label: 'Status barreira',
        render: (row) => {
          const badge = getBarrierBadge(row.barrierStatus)
          const manual = row.override?.high !== 'auto' || row.override?.low !== 'auto' || hasStructureParamOverride(row.override)
          return (
            <div className="cell-stack">
              <Badge tone={badge.tone}>{badge.label}</Badge>
              {manual ? <small>Manual ligado</small> : <small>Automatico</small>}
            </div>
          )
        },
      },
      {
        key: 'acoes',
        label: 'Acoes',
        render: (row) => (
          <div className="row-actions">
            <button
              className="icon-btn"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                handleReportClick(row)
              }}
              aria-label="Ver relatorio"
            >
              <Icon name="eye" size={16} />
            </button>
            <button
              className="icon-btn"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                handleOverrideClick(row)
              }}
              aria-label="Override manual"
            >
              <Icon name="sliders" size={16} />
            </button>
          </div>
        ),
      },
    ],
    [handleRefreshData, handleReportClick, handleOverrideClick],
  )

  const vencimentoChipLabel = filters.vencimentos.length
    ? (filters.vencimentos.length === 1
      ? formatDate(filters.vencimentos[0])
      : `${filters.vencimentos.length} vencimentos`)
    : ''

  const chips = [
    { key: 'broker', label: filters.broker.length ? `Broker (${filters.broker.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, broker: [] })) },
    { key: 'assessores', label: filters.assessores.length ? `Assessores (${filters.assessores.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, assessores: [] })) },
    { key: 'clientCode', label: clientCodeFilter.length ? `Clientes (${clientCodeFilter.length})` : '', onClear: () => setClientCodeFilter([]) },
    { key: 'estruturas', label: filters.estruturas.length ? `Estruturas (${filters.estruturas.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, estruturas: [] })) },
    { key: 'ativos', label: filters.ativos.length ? `Ativos (${filters.ativos.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, ativos: [] })) },
    { key: 'vencimentos', label: vencimentoChipLabel, onClear: () => setFilters((prev) => ({ ...prev, vencimentos: [] })) },
    { key: 'status', label: filters.status, onClear: () => setFilters((prev) => ({ ...prev, status: '' })) },
  ].filter((chip) => chip.label)

  const handleClearFilters = useCallback(() => {
    setFilters({
      search: '',
      broker: [],
      status: '',
      vencimentos: [],
      estruturas: [],
      ativos: [],
      assessores: [],
    })
    setClientCodeFilter([])
  }, [setClientCodeFilter])

  const handlePickFolder = useCallback(async () => {
    try {
      if (window?.electronAPI?.selectFolder) {
        const meta = await window.electronAPI.selectFolder()
        if (!meta?.filePath) {
          notify('Selecao de pasta cancelada.', 'warning')
          return
        }
        const nextPending = { source: 'electron', ...meta }
        setPendingFile(nextPending)
        if (isValidElectronPath(meta.folderPath)) {
          const saved = await saveLink(userKey, {
            source: 'electron',
            folderPath: meta.folderPath,
            fileName: meta.fileName,
          })
          if (saved) setLinkMeta(saved)
          broadcastUpdate('vencimento-updated', { kind: 'link' })
        }
        notify('Pasta vinculada. Clique em calcular.', 'success')
        return
      }
      if ('showDirectoryPicker' in window) {
        const handle = await window.showDirectoryPicker()
        const picked = await pickFileFromDirectoryHandle(handle)
        if (!picked?.file) {
          notify('Nenhuma planilha .xlsx encontrada.', 'warning')
          setPendingFile(null)
          return
        }
        const nextPending = { source: 'browser', handle, ...picked }
        setPendingFile(nextPending)
        setPermissionState('granted')
        const saved = await saveLink(userKey, {
          source: 'browser',
          handle,
          folderName: picked.folderName,
          fileName: picked.fileName,
        })
        if (saved) setLinkMeta(saved)
        broadcastUpdate('vencimento-updated', { kind: 'link' })
        notify('Pasta selecionada. Clique em vincular para calcular.', 'success')
      } else {
        fileInputRef.current?.click()
      }
    } catch {
      notify('Selecao de pasta cancelada.', 'warning')
    }
  }, [broadcastUpdate, notify, userKey])

  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files || [])
    const file = pickPreferredFile(files)
    if (!file) {
      notify('Selecione um arquivo .xlsx.', 'warning')
      return
    }
    const nextPending = { source: 'file', file, fileName: file.name }
    setPendingFile(nextPending)
    const saved = await saveLink(userKey, {
      source: 'file',
      fileName: file.name,
    })
    if (saved) setLinkMeta(saved)
    broadcastUpdate('vencimento-updated', { kind: 'link' })
    notify('Planilha pronta. Clique em vincular para calcular.', 'success')
  }

  const handleApplyFolder = useCallback(async () => {
    if (!pendingFile) {
      notify('Escolha a pasta/planilha antes de vincular.', 'warning')
      return
    }
    await applyPendingFile(pendingFile, { save: true, silent: false })
  }, [applyPendingFile, notify, pendingFile])

  const handleReauthorize = useCallback(async () => {
    if (!linkMeta?.handle) {
      notify('Nenhuma pasta para reautorizar.', 'warning')
      return
    }
    const state = await ensurePermission(linkMeta.handle, { interactive: true })
    setPermissionState(state)
    if (state === 'granted') {
      await restoreFromLink(linkMeta, { silent: false })
    } else {
      setRestoreStatus({ state: 'needs-permission', message: 'Permissao nao concedida.' })
    }
  }, [linkMeta, notify, restoreFromLink])

  const handleUnlink = useCallback(async () => {
    await clearLink(userKey)
    clearLastImported(userKey)
    setLinkMeta(null)
    setCacheMeta(null)
    setPendingFile(null)
    setPermissionState(null)
    setRestoreStatus({ state: 'idle', message: '' })
    setOperations(vencimentos)
    broadcastUpdate('vencimento-updated', { kind: 'clear' })
    notify('Vinculo removido.', 'success')
  }, [broadcastUpdate, notify, userKey])

  const handleRecalculateDividends = useCallback(() => {
    clearDividendsCache()
    setDividendsRefreshToken((prev) => prev + 1)
  }, [])

  const handleExportPdf = (row) => {
    const barrierBadge = getBarrierBadge(row.barrierStatus)
    const clienteLabel = row.nomeCliente || row.cliente || row.codigoCliente || 'Cliente'
    const payload = {
      title: `Relatorio - ${clienteLabel}`,
      header: `${row.ativo} | ${row.estrutura} | ${formatDate(row.vencimento)}`,
      summary: `<strong>${formatCurrency(row.result.financeiroFinal)}</strong> <span class="badge">${barrierBadge.label}</span>`,
      details: [
        { label: 'Spot', value: formatSpotValue(row.spotBase ?? row.spotInicial) },
        { label: 'Quantidade base', value: formatNumber(row.qtyBase) },
        { label: 'Bonificacao', value: formatNumber(row.qtyBonus) },
        { label: 'Quantidade atual', value: formatNumber(row.qtyAtual) },
        { label: 'Valor de entrada', value: row.result.valorEntradaIncomplete ? 'Dados incompletos' : formatCurrency(row.result.valorEntrada) },
        { label: 'Financeiro final', value: formatCurrency(row.result.financeiroFinal) },
        { label: 'Ganho/Prejuizo', value: formatCurrency(row.result.ganho) },
        { label: 'Ganho %', value: `${(row.result.percent * 100).toFixed(2)}%` },
        { label: 'Venda do ativo', value: formatCurrency(row.result.vendaAtivo) },
        { label: 'Ganho na Call', value: row.result.optionsSuppressed ? 'N/A' : formatCurrency(row.result.ganhoCall) },
        { label: 'Ganho na Put', value: row.result.optionsSuppressed ? 'N/A' : formatCurrency(row.result.ganhoPut) },
        { label: 'Ganhos nas opcoes', value: row.result.optionsSuppressed ? 'N/A' : formatCurrency(row.result.ganhosOpcoes) },
        { label: 'Dividendos', value: formatCurrency(row.result.dividends) },
        { label: 'Cupom', value: formatCurrency(row.result.cupomTotal) },
        { label: 'Rebates', value: formatCurrency(row.result.rebateTotal) },
      ],
      barriers: (row.barrierStatus?.list || []).map((item) => {
        const direction = item.direction === 'high' ? 'Alta' : 'Baixa'
        const hit = item.direction === 'high' ? row.barrierStatus?.high : row.barrierStatus?.low
        return {
          label: `${direction} (${item.barreiraTipo || 'N/A'})`,
          value: `${item.barreiraValor} - ${hit == null ? 'N/A' : hit ? 'Bateu' : 'Nao bateu'}`,
        }
      }),
      warnings: [
        row.market?.source !== 'yahoo' ? 'Cotacao em fallback.' : null,
        row.override?.high !== 'auto' || row.override?.low !== 'auto' ? 'Override manual aplicado.' : null,
        hasStructureParamOverride(row.override) ? 'Parâmetros manuais da estrutura aplicados.' : null,
        row.manualCouponBRL != null ? 'Cupom manual aplicado.' : null,
      ].filter(Boolean),
    }
    exportReportPdf(payload, `${clienteLabel}_${row.ativo}_${row.vencimento}`)
  }

  const handleCopy = async (row) => {
    try {
      await navigator.clipboard.writeText(buildCopySummary(row))
      notify('Resumo copiado.', 'success')
    } catch {
      notify('Nao foi possivel copiar.', 'warning')
    }
  }

  const hasLink = Boolean(linkMeta)
  const showReauthorize = Boolean(
    linkMeta?.source === 'browser'
    && (permissionState === 'prompt' || permissionState === 'denied' || restoreStatus.state === 'needs-permission'),
  )
  const isBusy = isParsing || isRestoring

  return (
    <div className="page">
      <PageHeader
        title="Vencimento de Estruturas"
        subtitle="Visao de mesa para riscos, barreiras e prazos criticos."
        meta={[
          { label: 'Total operacoes', value: totals.total },
          { label: 'Alertas', value: totals.alertas },
          { label: 'Criticos', value: totals.criticos },
        ]}
        actions={[
          { label: 'Gerar relatorio', icon: 'doc', onClick: handleGenerateReport, disabled: !visibleRows.length },
          { label: isExporting ? 'Exportando...' : 'Exportar', icon: 'download', variant: 'btn-secondary', onClick: handleExportXlsx, disabled: isExporting },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Fonte de dados</h3>
            <p className="muted">Vincule a pasta com a planilha de posicao para atualizar os calculos.</p>
          </div>
          <div className="panel-actions">
            {showReauthorize ? (
              <button className="btn btn-secondary" type="button" onClick={handleReauthorize} disabled={isBusy}>
                <Icon name="sync" size={16} />
                Reautorizar
              </button>
            ) : null}
            <button className="btn btn-secondary" type="button" onClick={handlePickFolder} disabled={isBusy}>
              <Icon name="link" size={16} />
              {hasLink ? 'Trocar pasta' : 'Vincular pasta'}
            </button>
            {hasLink ? (
              <button className="btn btn-secondary" type="button" onClick={handleUnlink} disabled={isBusy}>
                <Icon name="close" size={16} />
                Desvincular
              </button>
            ) : null}
            <button
              className="btn btn-primary"
              type="button"
              onClick={handleApplyFolder}
              disabled={!pendingFile || isBusy}
            >
              <Icon name="sync" size={16} />
              {isBusy ? 'Calculando...' : 'Vincular e calcular'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              multiple
              webkitdirectory="true"
              directory="true"
              hidden
            />
          </div>
        </div>
        <div className="muted">{folderLabel}</div>
        {restoreStatus.message ? <div className="muted">{restoreStatus.message}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Data do relatorio</h3>
            <p className="muted">Usada como corte para ajustar strikes por proventos.</p>
          </div>
          <div className="panel-actions">
            <input
              className="input"
              type="date"
              value={reportDate}
              onChange={(event) => setReportDate(event.target.value)}
            />
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleRecalculateDividends}
              disabled={!reportDate || dividendStatus.loading}
            >
              <Icon name="sync" size={16} />
              {dividendStatus.loading ? 'Recalculando...' : 'Recalcular proventos'}
            </button>
          </div>
        </div>
        {dividendStatus.error ? <div className="muted">{dividendStatus.error}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Filtros rapidos</h3>
            <p className="muted">Use chips para limpar e ajustar rapidamente.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar cliente, ativo ou estrutura"
                value={filters.search}
                onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
              />
            </div>
          </div>
        </div>
        <div className="filter-grid">
          <MultiSelect
            value={filters.broker}
            options={brokerOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, broker: value }))}
            placeholder="Broker"
          />
          <MultiSelect
            value={filters.assessores}
            options={assessorOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, assessores: value }))}
            placeholder="Assessor"
          />
          <MultiSelect
            value={filters.estruturas}
            options={estruturaOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, estruturas: value }))}
            placeholder="Estrutura"
          />
          <MultiSelect
            value={filters.ativos}
            options={ativoOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, ativos: value }))}
            placeholder="Ativo"
          />
          <TreeSelect
            value={filters.vencimentos}
            tree={vencimentoTree}
            allValues={vencimentoValues}
            onChange={(value) => setFilters((prev) => ({ ...prev, vencimentos: value }))}
            placeholder="Vencimento da estrutura"
          />
          <MultiSelect
            value={clientCodeFilter}
            options={clienteOptions}
            onChange={setClientCodeFilter}
            placeholder="Codigo do cliente"
            searchable
          />
          <SelectMenu
            value={filters.status}
            options={[
              { value: '', label: 'Status' },
              { value: 'ok', label: 'Neutro' },
              { value: 'alerta', label: 'Alerta' },
              { value: 'critico', label: 'Critico' },
            ]}
            onChange={(value) => setFilters((prev) => ({ ...prev, status: value }))}
            placeholder="Status"
          />
        </div>
        {chips.length ? (
          <div className="chip-row">
            {chips.map((chip) => (
              <button
                key={chip.key}
                className="chip"
                onClick={() => chip.onClear?.()}
                type="button"
              >
                {chip.label}
                <Icon name="close" size={12} />
              </button>
            ))}
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleClearFilters}
            >
              Limpar tudo
            </button>
          </div>
        ) : null}
        <div className="table-actions">
          <div className="table-actions-left">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleRefreshAll}
              disabled={isRefreshingAll}
            >
              <Icon name="sync" size={16} />
              {isRefreshingAll ? 'Atualizando...' : 'Atualizar spots'}
            </button>
            <span className="muted">Mostrando {visibleRows.length} de {rows.length}</span>
          </div>
        </div>
        <DataTable
          rows={visibleRows}
          columns={columns}
          emptyMessage="Nenhuma estrutura encontrada."
        />
        <div className="table-footer">
          <div className="table-pagination">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              disabled={currentPage <= 1}
            >
              Anterior
            </button>
            <div className="page-list" role="navigation" aria-label="Paginacao">
              <span className="page-label">Pagina</span>
              {paginationItems.map((item, index) => (
                item === 'ellipsis' ? (
                  <span key={`ellipsis-${index}`} className="page-ellipsis">…</span>
                ) : (
                  <button
                    key={`page-${item}`}
                    className={`page-number ${item === currentPage ? 'active' : ''}`}
                    type="button"
                    onClick={() => setCurrentPage(item)}
                    aria-current={item === currentPage ? 'page' : undefined}
                  >
                    {item}
                  </button>
                )
              ))}
            </div>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setCurrentPage((prev) => Math.min(prev + 1, pageCount))}
              disabled={currentPage >= pageCount}
            >
              Proxima
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Historico e relatorios</h3>
            <p className="muted">Exportacao e auditoria em um clique.</p>
          </div>
          <button className="btn btn-secondary" type="button">Gerar CSV</button>
        </div>
        <div className="history-grid">
          <div className="history-card">
            <strong>Relatorio semanal</strong>
            <span className="muted">Gerado em 24/01/2026</span>
            <button className="btn btn-secondary" type="button">Baixar</button>
          </div>
          <div className="history-card">
            <strong>Operacoes vencidas</strong>
            <span className="muted">Atualizado em 23/01/2026</span>
            <button className="btn btn-secondary" type="button">Baixar</button>
          </div>
        </div>
      </section>

      <ReportModal
        open={Boolean(selectedReport)}
        row={selectedReport}
        onClose={() => setSelectedReport(null)}
        onRefresh={() => selectedReport && handleRefreshData(selectedReport)}
        onCopy={() => selectedReport && handleCopy(selectedReport)}
        onExport={() => selectedReport && handleExportPdf(selectedReport)}
      />

      <OverrideModal
        open={Boolean(selectedOverride)}
        value={overrideDraft}
        qtyBase={selectedOverride?.qtyBase}
        qtyAtual={selectedOverride?.qtyAtual}
        structureMeta={selectedStructureMeta}
        errors={overrideErrors}
        onClose={() => {
          setSelectedOverride(null)
          setOverrideErrors({})
        }}
        onChange={setOverrideDraft}
        onApply={handleApplyOverride}
        onReset={handleResetOverride}
        onClearStructureOverrides={handleClearStructureOverrides}
        onUseQtyBase={handleUseQtyBase}
        onAddStructureEntry={handleAddStructureEntry}
        onRemoveStructureEntry={handleRemoveStructureEntry}
        onStructureEntryChange={handleStructureEntryChange}
      />
    </div>
  )
}

export default Vencimento
