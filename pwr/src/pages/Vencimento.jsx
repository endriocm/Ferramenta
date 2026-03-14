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
import { apiFetch } from '../services/apiBase'
import { fetchYahooMarketData, normalizeYahooSymbol } from '../services/marketData'
import { buildDividendKey, clearDividendsCache, fetchDividend, fetchDividendsBatch } from '../services/dividends'
import { buildBonusKey, clearBonusCache, fetchBonus, fetchBonusesBatch, inferBonusQuantities } from '../services/bonus'
import {
  applyOverridesToOperation,
  computeBarrierStatus,
  computeResult,
  getEffectiveLegs,
  getLegOverrideKey,
  resolveOperationQuantities,
} from '../services/settlement'
import { loadOverrides, saveOverrides, updateOverride } from '../services/overrides'
import { parseWorkbook, parseWorkbookBuffer } from '../services/excel'
import { getCurrentUserKey } from '../services/currentUser'
import { enrichRow } from '../services/tags'
import { clearLink, ensurePermission, isValidElectronPath, loadLink, saveLink } from '../services/vencimentoLink'
import { clearLastImported, loadLastImported, saveLastImported } from '../services/vencimentoCache'
import { annotateSettlementMarket, mergeRowsPreservingExpired, shouldLoadSettlementClose } from '../services/vencimentoRows'
import { buildClientFilterMatchSet, buildClientFilterOptions, collectClientFilterTokens, matchesClientFilter } from '../services/clientFilter'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { debugLog } from '../services/debug'
import useGlobalFolderMenu from '../hooks/useGlobalFolderMenu'
import {
  DADOS_EXPORT_COLUMNS,
  DADOS_EXPORT_KEYS,
  DADOS_EXPORT_LABELS,
  HISTORICO_ORIGIN_VENCIMENTO,
  buildHistoricalQuoteKey,
  buildHistoricalRowFromVencimentoRow,
  fetchHistoricalCloseMap,
  formatDatePtBr,
  formatHistoricalMonthLabel,
  loadHistoricoOperacoesState,
  normalizeHistoricalMonthKey,
  recalculateHistoricalWorkbookValues,
  serializeHistoricalRowForExport,
  toOptionalNumber,
  upsertHistoricoMonthlyBatch,
} from '../services/historicoOperacoes'

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
  const clienteLabel = row.codigoCliente || row.cliente || '-'
  return [
    `Conta: ${clienteLabel}`,
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

const SPOT_CONCURRENCY = 8
const PAGE_SIZE = 15
const RESUMO_EXPORT_COLUMNS = [
  { key: 'chave', label: 'CHAVE' },
  { key: 'assessor', label: 'ASSESSOR' },
  { key: 'broker', label: 'BROKER' },
  { key: 'cliente', label: 'CLIENTE' },
  { key: 'dataEntrada', label: 'DATA DE ENTRADA' },
  { key: 'ativo', label: 'ATIVO' },
  { key: 'estrutura', label: 'ESTRUTURA' },
  { key: 'dataVencimento', label: 'DATA DE VENCIMENTO' },
  { key: 'entrou', label: 'ENTROU' },
  { key: 'dividendos', label: 'DIVIDENDOS' },
  { key: 'cupom', label: 'CUPOM' },
  { key: 'financeiroFinal', label: 'FINANCEIRO FINAL' },
  { key: 'ganhoPrejuizo', label: 'GANHO / PREJUÍZO' },
  { key: 'lucroPercentual', label: 'LUCRO %' },
]

const RESUMO_EXPORT_KEYS = RESUMO_EXPORT_COLUMNS.map((column) => column.key)
const RESUMO_EXPORT_LABELS = RESUMO_EXPORT_COLUMNS.map((column) => column.label)
const RESUMO_CURRENCY_KEYS = new Set(['entrou', 'dividendos', 'cupom', 'financeiroFinal', 'ganhoPrejuizo'])
const RESUMO_PERCENT_KEYS = new Set(['lucroPercentual'])
const RESUMO_DATE_KEYS = new Set(['dataEntrada', 'dataVencimento'])
const RESUMO_RESULT_TONE_KEYS = new Set(['financeiroFinal', 'ganhoPrejuizo', 'lucroPercentual'])

const DADOS_CURRENCY_KEYS = new Set([
  'valorCompra', 'callComprada', 'callVendida', 'putComprada', 'putComprada2',
  'putVendida', 'barreiraKi', 'barreiraKo', 'spot',
  'ganhoPrejuizo', 'financeiroFinal', 'vendaAtivoMercado',
  'debito', 'dividendos', 'ganhosOpcoes', 'ganhoPut', 'ganhoCall', 'cupom', 'pagou',
])
const DADOS_PERCENT_KEYS = new Set(['lucroPercentual'])
const DADOS_DATE_KEYS = new Set(['dataRegistro', 'dataVencimento'])
const DADOS_RESULT_TONE_KEYS = new Set(['ganhoPrejuizo', 'financeiroFinal', 'lucroPercentual'])
const DADOS_EXPORT_COL_WIDTHS = [
  20, 14, 20, 16, 10, 20, 16, 18, 12, 14,
  14, 14, 14, 14, 14, 14, 14, 12, 18, 18,
  22, 12, 14, 14, 18, 14, 14, 12, 14,
]

// Converte "DD/MM/YYYY" para serial de data do Excel (número de dias desde 30/12/1899).
// Permite que o Excel reconheça a célula como data real e habilite filtro por data.
const parsePtBrDateToExcelSerial = (text) => {
  if (!text || typeof text !== 'string') return null
  const parts = text.split('/')
  if (parts.length !== 3) return null
  const d = Number(parts[0])
  const m = Number(parts[1])
  const y = Number(parts[2])
  if (!d || !m || !y || y < 1900) return null
  const excelEpoch = Date.UTC(1899, 11, 30)
  const serial = (Date.UTC(y, m - 1, d) - excelEpoch) / 86400000
  return Number.isFinite(serial) ? serial : null
}

const resolveResumoValorEntrada = (row) => {
  if (row?.result?.valorEntradaIncomplete) return null
  return toOptionalNumber(row?.result?.valorEntrada ?? row?.result?.pagou ?? row?.result?.custoTotal)
}

const buildResumoExportEntry = (row) => {
  const lucroPercentual = toOptionalNumber(row?.result?.percent)
  const entradaKey = normalizeDateKey(row?.dataRegistro) || ''
  const vencimentoKey = normalizeDateKey(row?.vencimento) || ''
  const clienteCodigo = String(row?.codigoCliente || row?.cliente || '').replace(/\D/g, '')
  const chave = [
    clienteCodigo || String(row?.codigoCliente || row?.cliente || '').trim(),
    entradaKey.replace(/-/g, ''),
    String(row?.ativo || '').trim(),
    String(row?.estrutura || '').trim(),
    vencimentoKey.replace(/-/g, ''),
  ]
    .filter(Boolean)
    .join('')
  return {
    chave: chave || String(row?.id || '').trim() || `${row?.codigoCliente || ''}-${row?.ativo || ''}-${vencimentoKey}`,
    assessor: row?.assessor || '',
    broker: row?.broker || '',
    cliente: row?.codigoCliente || row?.cliente || '',
    dataEntrada: formatDatePtBr(entradaKey),
    ativo: row?.ativo || '',
    estrutura: row?.estrutura || '',
    dataVencimento: formatDatePtBr(vencimentoKey),
    entrou: resolveResumoValorEntrada(row),
    dividendos: toOptionalNumber(row?.result?.dividends),
    cupom: toOptionalNumber(row?.result?.cupomTotal),
    financeiroFinal: toOptionalNumber(row?.result?.financeiroFinal),
    ganhoPrejuizo: toOptionalNumber(row?.result?.ganho),
    lucroPercentual,
    _sortEntrada: entradaKey,
    _sortVencimento: vencimentoKey,
  }
}

const compareResumoRows = (left, right) => {
  const leftVencimento = String(left?._sortVencimento || '')
  const rightVencimento = String(right?._sortVencimento || '')
  if (leftVencimento !== rightVencimento) return leftVencimento.localeCompare(rightVencimento)

  const leftEntrada = String(left?._sortEntrada || '')
  const rightEntrada = String(right?._sortEntrada || '')
  if (leftEntrada !== rightEntrada) return leftEntrada.localeCompare(rightEntrada)

  const leftAssessor = String(left?.assessor || '')
  const rightAssessor = String(right?.assessor || '')
  if (leftAssessor !== rightAssessor) return leftAssessor.localeCompare(rightAssessor, 'pt-BR')

  const leftBroker = String(left?.broker || '')
  const rightBroker = String(right?.broker || '')
  if (leftBroker !== rightBroker) return leftBroker.localeCompare(rightBroker, 'pt-BR')

  const leftCliente = String(left?.cliente || '')
  const rightCliente = String(right?.cliente || '')
  if (leftCliente !== rightCliente) return leftCliente.localeCompare(rightCliente, 'pt-BR')

  return String(left?.chave || '').localeCompare(String(right?.chave || ''), 'pt-BR')
}

const resolveResumoTone = (value) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return ''
  if (numeric > 0) return 'positive'
  if (numeric < 0) return 'negative'
  return 'neutral'
}

const resolveToneRgb = (tone) => {
  if (tone === 'positive') return 'FF137333'
  if (tone === 'negative') return 'FFB42318'
  return 'FF374151'
}

const resolveToneFillRgb = (tone) => {
  if (tone === 'positive') return 'FFE7F6EC'
  if (tone === 'negative') return 'FFFBE9EB'
  return 'FFF3F4F6'
}

const resolveResumoCellDisplayValue = (entry, key) => {
  const value = entry?.[key]
  if (value == null || value === '') return ''
  if (RESUMO_CURRENCY_KEYS.has(key) || RESUMO_PERCENT_KEYS.has(key)) {
    return Number.isFinite(Number(value)) ? Number(value) : ''
  }
  return value
}

const resolveResumoCellFormat = (key) => {
  if (RESUMO_CURRENCY_KEYS.has(key)) return '[$R$-416] #,##0.00'
  if (RESUMO_PERCENT_KEYS.has(key)) return '0.00%'
  return ''
}

const resolveResumoCellTone = (entry, key) => {
  if (!RESUMO_RESULT_TONE_KEYS.has(key)) return ''
  return resolveResumoTone(entry?.[key])
}

const buildResumoPdfRow = (entry) => {
  const cells = RESUMO_EXPORT_KEYS.map((key) => {
    if (RESUMO_CURRENCY_KEYS.has(key)) return formatCurrency(entry?.[key] ?? 0)
    if (RESUMO_PERCENT_KEYS.has(key)) {
      const value = Number(entry?.[key])
      return Number.isFinite(value) ? `${(value * 100).toFixed(2).replace('.', ',')}%` : '-'
    }
    return String(entry?.[key] ?? '-')
  })
  const tones = {}
  RESUMO_EXPORT_KEYS.forEach((key, index) => {
    const tone = resolveResumoCellTone(entry, key)
    if (tone) tones[index] = tone
  })
  return {
    cells,
    tones,
  }
}

const buildDadosExportEntry = (row) => serializeHistoricalRowForExport(buildHistoricalRowFromVencimentoRow(row))

const resolveDadosCellDisplayValue = (entry, key) => {
  const value = entry?.[key]
  if (value == null || value === '') return ''
  if (DADOS_CURRENCY_KEYS.has(key) || DADOS_PERCENT_KEYS.has(key)) {
    return Number.isFinite(Number(value)) ? Number(value) : ''
  }
  return value
}

const resolveDadosCellFormat = (key) => {
  if (DADOS_CURRENCY_KEYS.has(key)) return '[$R$-416] #,##0.00'
  if (DADOS_PERCENT_KEYS.has(key)) return '0.00%'
  return ''
}

const resolveDadosCellTone = (entry, key) => {
  if (!DADOS_RESULT_TONE_KEYS.has(key)) return ''
  return resolveResumoTone(entry?.[key])
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

const normalizeMatchLabel = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()

const isRubiStructureLabel = (value) => normalizeMatchLabel(value).includes('rubi')

const getBarrierDirectionsFromLegs = (legs) => {
  let hasHigh = false
  let hasLow = false
  ;(legs || []).forEach((leg) => {
    if (leg?.barreiraValor == null) return
    const type = normalizeBarrierTypeInput(leg?.barreiraTipo)
    if (type === 'UI' || type === 'UO') hasHigh = true
    if (type === 'KI' || type === 'KO') hasLow = true
  })
  return { hasHigh, hasLow }
}

const statusHasBarrierDirection = (status, direction) => {
  const list = Array.isArray(status?.list) ? status.list : []
  return list.some((item) => item?.direction === direction)
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
  manualDividendBRL: '',
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
  qtyBaseOverride: '',
  bonusAutoDisabled: false,
  bonusDate: '',
  bonusNote: '',
}

const EMPTY_OVERRIDE_VALUE = {
  schemaVersion: 2,
  high: 'auto',
  low: 'auto',
  stickyHighHit: false,
  stickyLowHit: false,
  stickyHighHitAt: null,
  stickyLowHitAt: null,
  manualCouponBRL: null,
  manualCouponPct: null,
  manualOptionsGainBRL: null,
  manualDividendBRL: null,
  optionQtyOverride: null,
  optionExpiryDateOverride: null,
  strikeOverride: null,
  barrierValueOverride: null,
  barrierTypeOverride: null,
  optionSide: null,
  legKey: null,
  legacyBarrierType: false,
  qtyBonus: 0,
  qtyBaseOverride: null,
  bonusAutoDisabled: false,
  bonusDate: '',
  bonusNote: '',
}

const applyStickyBarrierHitOverride = (overridesMap, operationId, { high = false, low = false, hitDate = null } = {}) => {
  if (!operationId) return { overrides: overridesMap, changed: false }
  const current = overridesMap?.[operationId] || EMPTY_OVERRIDE_VALUE
  const patch = {}
  const normalizedHitDate = normalizeDateInput(hitDate)

  if (high && current.stickyHighHit !== true) patch.stickyHighHit = true
  if (low && current.stickyLowHit !== true) patch.stickyLowHit = true

  if (high && normalizedHitDate && !current.stickyHighHitAt) {
    patch.stickyHighHitAt = normalizedHitDate
  }
  if (low && normalizedHitDate && !current.stickyLowHitAt) {
    patch.stickyLowHitAt = normalizedHitDate
  }

  if (!Object.keys(patch).length) return { overrides: overridesMap, changed: false }
  return {
    overrides: updateOverride(overridesMap, operationId, patch),
    changed: true,
  }
}

const inferRemovedRubiBarrierHits = ({ previousRows = [], nextRows = [], overridesMap = {}, hitDate = null } = {}) => {
  if (!Array.isArray(previousRows) || !previousRows.length) {
    return { overrides: overridesMap, changed: false, inferredCount: 0 }
  }
  const nextIds = new Set((nextRows || []).map((row) => row?.id).filter(Boolean))
  let nextOverrides = overridesMap
  let changed = false
  let inferredCount = 0

  previousRows.forEach((row) => {
    if (!row?.id) return
    if (nextIds.has(row.id)) return
    if (!isRubiStructureLabel(row?.estrutura)) return
    const directions = getBarrierDirectionsFromLegs(row?.pernas)
    if (!directions.hasHigh && !directions.hasLow) return

    const result = applyStickyBarrierHitOverride(nextOverrides, row.id, {
      high: directions.hasHigh,
      low: directions.hasLow,
      hitDate,
    })
    if (!result.changed) return
    nextOverrides = result.overrides
    changed = true
    inferredCount += 1
  })

  return { overrides: nextOverrides, changed, inferredCount }
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

const buildBonusRequest = (operation, reportDate) => {
  const ticker = normalizeYahooSymbol(operation?.ativo)
  const from = normalizeDateKey(operation?.dataRegistro)
  const to = normalizeDateKey(reportDate)
  if (!ticker || !from || !to || from > to) return null
  return {
    key: buildBonusKey(ticker, from, to),
    ticker,
    from,
    to,
  }
}

const normalizeDividendInfo = (dividend) => {
  if (!dividend) return null
  const total = Number(dividend?.total || 0)
  return {
    ...dividend,
    total: Number.isFinite(total) ? total : 0,
    source: dividend?.source || null,
    events: Array.isArray(dividend?.events) ? dividend.events : [],
  }
}

const normalizeBonusInfo = (bonus, operation) => {
  if (!bonus) return null
  const factor = Number(bonus?.factor || 1)
  const events = Array.isArray(bonus?.events) ? bonus.events : []
  const currentQty = Number(operation?.quantidadeAtual ?? operation?.quantidade)
  const inferred = inferBonusQuantities(currentQty, events)
  return {
    ...bonus,
    factor: Number.isFinite(factor) && factor > 0 ? factor : 1,
    totalPct: Number.isFinite(Number(bonus?.totalPct)) ? Number(bonus.totalPct) : ((Number.isFinite(factor) ? factor : 1) - 1) * 100,
    source: bonus?.source || null,
    events,
    inferredQtyBase: inferred?.canInfer ? inferred.qtyBase : null,
    inferredQtyBonus: inferred?.canInfer ? inferred.qtyBonus : 0,
    inferredFactor: inferred?.factor || 1,
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
  const globalFolderMenu = useGlobalFolderMenu('vencimento')
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
  const [bonusAdjustments, setBonusAdjustments] = useState(new Map())
  const [bonusStatus, setBonusStatus] = useState({ loading: false, error: '' })
  const [bonusRefreshToken, setBonusRefreshToken] = useState(0)
  const [linkMeta, setLinkMeta] = useState(null)
  const [cacheMeta, setCacheMeta] = useState(null)
  const [restoreStatus, setRestoreStatus] = useState({ state: 'idle', message: '' })
  const [permissionState, setPermissionState] = useState(null)
  const [pendingFile, setPendingFile] = useState(null)
  const [isParsing, setIsParsing] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isRefreshingAll, setIsRefreshingAll] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isExportingDados, setIsExportingDados] = useState(false)
  const [isPushingHistorico, setIsPushingHistorico] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const rowCacheRef = useRef(new Map())
  const broadcastRef = useRef(null)
  const tabIdRef = useRef(Math.random().toString(36).slice(2))
  const restoreRef = useRef({ running: false })
  const stickyBarrierTimerRef = useRef(null)
  const optionSettlementTimerRef = useRef(null)
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides
  const cacheMetaRef = useRef(cacheMeta)
  cacheMetaRef.current = cacheMeta
  const reportDateRef = useRef(reportDate)
  reportDateRef.current = reportDate
  const initialRestoreRef = useRef(false)

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
  const globalDirectoryOptions = useMemo(
    () => globalFolderMenu.directoryOptions.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.directory?.folderPath || '',
    })),
    [globalFolderMenu.directoryOptions],
  )
  const globalDirectoryEmptyMessage = useMemo(() => {
    if (globalFolderMenu.loading) return ''
    return globalFolderMenu.emptyMessage
  }, [globalFolderMenu.emptyMessage, globalFolderMenu.loading])

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
          const response = await apiFetch('/api/vencimentos/parse', {
            method: 'POST',
            body: formData,
          }, { retries: 0, timeoutMs: 45000 })
          if (!response.ok) throw new Error('api-failed')
          const data = await response.json()
          if (!Array.isArray(data?.rows)) throw new Error('api-invalid')
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
      const previousRows = Array.isArray(cacheMetaRef.current?.rows) ? cacheMetaRef.current.rows : []
      const currentReportDate = reportDateRef.current
      let inferredCount = 0
      setOverrides((prev) => {
        const result = inferRemovedRubiBarrierHits({
          previousRows,
          nextRows: parsedRows,
          overridesMap: prev,
          hitDate: currentReportDate,
        })
        inferredCount = result.inferredCount || 0
        return result.changed ? result.overrides : prev
      })
      const mergedRows = mergeRowsPreservingExpired({
        previousRows,
        nextRows: parsedRows,
        referenceDate: currentReportDate || new Date(),
      })
      debugLog('vencimento.restore.parse', { rows: parsedRows.length, source: parseSource })
      setMarketMap({})
      setOperations(mergedRows)
      const storedCache = saveLastImported(userKey, {
        rows: mergedRows,
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
      if (inferredCount > 0 && !silent) {
        notify(
          `${inferredCount} rubi(s) sairam do relatorio e foram marcadas como barreira batida no historico.`,
          'warning',
        )
      }
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
        setRestoreStatus({ state: 'idle', message: cacheMetaRef.current?.rows?.length ? '' : 'Cache local pronto para uso.' })
      }
    } finally {
      restoreRef.current.running = false
      setIsRestoring(false)
    }
  }, [applyPendingFile])

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
    if (initialRestoreRef.current) return
    initialRestoreRef.current = true
    restoreFromStorage({ reparse: true })
  }, [restoreFromStorage, userKey])

  // Spot nao atualiza automaticamente: apenas pelos botoes de atualizacao manual.

  // Stable fingerprint of override fields that actually affect settlement close requests
  // (only optionExpiryDate overrides per operation/leg). Avoids re-fetching on unrelated override changes.
  const overrideExpiryFingerprint = useMemo(() => {
    const parts = []
    for (const operation of operations) {
      const ovr = overrides[operation?.id]
      if (!ovr) continue
      const legs = ovr.legs || ovr.structureByLeg
      if (legs && typeof legs === 'object') {
        for (const [key, leg] of Object.entries(legs)) {
          const expiry = leg?.optionExpiryDateOverride ?? leg?.optionExpiryDate ?? leg?.vencimentoOpcaoOverride ?? leg?.vencimentoOpcao
          if (expiry) parts.push(`${operation.id}:${key}:${expiry}`)
        }
      }
      const globalExpiry = ovr.optionExpiryDateOverride ?? ovr.optionExpiryDate
      if (globalExpiry) parts.push(`${operation.id}:_:${globalExpiry}`)
    }
    return parts.join('|')
  }, [operations, overrides])

  useEffect(() => {
    let active = true
    if (optionSettlementTimerRef.current) clearTimeout(optionSettlementTimerRef.current)
    optionSettlementTimerRef.current = setTimeout(() => {
    const currentOverrides = overridesRef.current
    const loadOptionSettlementCloses = async () => {
      const requests = []
      const marketRequests = new Map()

      operations.forEach((operation) => {
        const override = currentOverrides[operation?.id] || EMPTY_OVERRIDE_VALUE
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
    }, 200)
    return () => {
      active = false
      if (optionSettlementTimerRef.current) clearTimeout(optionSettlementTimerRef.current)
    }
  }, [operations, overrideExpiryFingerprint])

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
          const item = normalizeDividendInfo(resultMap.get(req.key))
          next.set(req.id, item || { total: 0, source: null, events: [] })
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

  useEffect(() => {
    let active = true
    const run = async () => {
      if (!reportDate) {
        setBonusAdjustments(new Map())
        setBonusStatus({ loading: false, error: '' })
        return
      }
      clearBonusCache()
      const requests = operations
        .map((operation) => {
          const request = buildBonusRequest(operation, reportDate)
          if (!request) return null
          return {
            id: operation.id,
            ...request,
          }
        })
        .filter(Boolean)

      if (!requests.length) {
        setBonusAdjustments(new Map())
        setBonusStatus({ loading: false, error: '' })
        return
      }

      setBonusStatus({ loading: true, error: '' })
      try {
        const results = await fetchBonusesBatch(requests.map(({ ticker, from, to }) => ({ ticker, from, to })))
        const resultMap = new Map(results.filter(Boolean).map((item) => [item.key, item]))
        const next = new Map()
        requests.forEach((req) => {
          const operation = operations.find((item) => item.id === req.id) || null
          const item = normalizeBonusInfo(resultMap.get(req.key), operation)
          next.set(req.id, item || {
            factor: 1,
            totalPct: 0,
            source: null,
            events: [],
            inferredQtyBase: null,
            inferredQtyBonus: 0,
            inferredFactor: 1,
          })
        })
        if (active) {
          setBonusAdjustments(next)
          setBonusStatus({ loading: false, error: '' })
        }
      } catch {
        if (active) {
          setBonusAdjustments(new Map())
          setBonusStatus({ loading: false, error: 'Falha ao recalcular bonificacoes.' })
        }
      }
    }
    run()
    return () => {
      active = false
    }
  }, [bonusRefreshToken, operations, reportDate])

  useEffect(() => {
    let active = true
    const referenceDate = new Date()
    const pendingOperations = operations.filter((operation) => (
      shouldLoadSettlementClose(operation, marketMap[operation?.id], referenceDate)
    ))

    if (!pendingOperations.length) return () => {
      active = false
    }

    const run = async () => {
      const updates = await mapWithConcurrency(
        pendingOperations,
        SPOT_CONCURRENCY,
        async (operation) => {
          try {
            const market = await fetchYahooMarketData({
              symbol: operation.ativo,
              startDate: operation.dataRegistro,
              endDate: operation.vencimento,
              includeSeries: true,
            })
            const dividendInfo = dividendAdjustments.get(operation.id) || null
            return {
              id: operation.id,
              market: annotateSettlementMarket(
                operation,
                applyDividendsToMarket(market, dividendInfo),
                referenceDate,
              ),
            }
          } catch {
            return null
          }
        },
      )

      if (!active) return

      setMarketMap((prev) => {
        let changed = false
        const next = { ...prev }
        updates.forEach((update) => {
          if (!update?.id || !update.market) return
          next[update.id] = update.market
          changed = true
        })
        return changed ? next : prev
      })
    }

    run()
    return () => {
      active = false
    }
  }, [dividendAdjustments, marketMap, operations])

  const enrichedOperations = useMemo(
    () => operations.map((operation) => enrichRow(operation, tagsIndex)),
    [operations, tagsIndex],
  )

  // Single-pass option extraction from enrichedOperations (replaces 5 separate .map() passes)
  const { brokerOptions, ativoOptions, assessorOptions, clienteOptions } = useMemo(() => {
    const brokers = new Set()
    const ativos = new Set()
    const assessors = new Set()
    for (const item of enrichedOperations) {
      if (item.broker) brokers.add(item.broker)
      if (item.ativo) ativos.add(item.ativo)
      if (item.assessor) assessors.add(item.assessor)
    }
    const toOpts = (set) => Array.from(set).sort().map((v) => ({ value: v, label: v }))
    return {
      brokerOptions: toOpts(brokers),
      ativoOptions: toOpts(ativos),
      assessorOptions: toOpts(assessors),
      clienteOptions: buildClientFilterOptions(enrichedOperations),
    }
  }, [enrichedOperations])

  const operationsByPeriod = useMemo(() => {
    if (!filters.vencimentos.length) return enrichedOperations
    const set = new Set(filters.vencimentos)
    return enrichedOperations.filter((item) => set.has(normalizeDateKey(item?.vencimento)))
  }, [enrichedOperations, filters.vencimentos])
  const estruturaOptions = useMemo(() => buildMultiOptions(operationsByPeriod.map((item) => item.estrutura)), [operationsByPeriod])
  const { tree: vencimentoTree, allValues: vencimentoValues } = useMemo(
    () => buildVencimentoTree(enrichedOperations),
    [enrichedOperations],
  )

  const handleRefreshData = useCallback(async (operation) => {
    try {
      const referenceDate = new Date()
      const market = await fetchYahooMarketData({
        symbol: operation.ativo,
        startDate: operation.dataRegistro,
        endDate: operation.vencimento,
        includeSeries: true,
      })
      let dividend = null
      const dividendRequest = buildDividendRequest(operation, reportDate)
      if (dividendRequest) {
        try {
          dividend = normalizeDividendInfo(await fetchDividend(dividendRequest))
        } catch {
          dividend = null
        }
        setDividendAdjustments((prev) => {
          const next = new Map(prev)
          next.set(operation.id, dividend || { total: 0, source: null, events: [] })
          return next
        })
      }
      const bonusRequest = buildBonusRequest(operation, reportDate)
      if (bonusRequest) {
        let bonus = null
        try {
          bonus = normalizeBonusInfo(await fetchBonus(bonusRequest), operation)
        } catch {
          bonus = null
        }
        setBonusAdjustments((prev) => {
          const next = new Map(prev)
          next.set(operation.id, bonus || {
            factor: 1,
            totalPct: 0,
            source: null,
            events: [],
            inferredQtyBase: null,
            inferredQtyBonus: 0,
            inferredFactor: 1,
          })
          return next
        })
      }
      const marketWithDividends = applyDividendsToMarket(market, dividend)
      const nextMarket = shouldLoadSettlementClose(operation, null, referenceDate)
        ? annotateSettlementMarket(operation, marketWithDividends, referenceDate)
        : marketWithDividends
      setMarketMap((prev) => ({ ...prev, [operation.id]: nextMarket }))
      notify('Dados atualizados.', 'success')
    } catch (error) {
      notify(formatUpdateError(error), 'warning')
    }
  }, [notify, reportDate])

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

  // buildRow is now a plain function (not useCallback) — it receives all deps as params
  // so it does NOT close over marketMap/overrides/etc. This avoids invalidating
  // the mappedRows memo on every marketMap or overrides reference change.
  const buildRowDirect = (operation, market, dividendInfo, bonusInfo, override, settlementMap) => {
    const manualBonus = parseQuantity(override.qtyBonus ?? 0)
    const manualQtyBase = override.qtyBaseOverride != null && override.qtyBaseOverride !== ''
      ? parseQuantity(override.qtyBaseOverride)
      : null
    const bonusAutoDisabled = override?.bonusAutoDisabled === true
    const autoBonus = !bonusAutoDisabled
      ? normalizeBonusInfo(bonusInfo, operation)
      : null
    const overrideBonus = manualBonus > 0 ? manualBonus : Number(autoBonus?.inferredQtyBonus || 0)
    const overrideQtyBase = manualQtyBase != null ? manualQtyBase : (autoBonus?.inferredQtyBase ?? null)
    const {
      displayQtyBase: qtyBase,
      displayQtyAtual: qtyAtual,
      displayQtyBonus: qtyBonus,
      settlementQtyBase,
      settlementQtyAtual,
      settlementQtyBonus,
    } = resolveOperationQuantities(operation, overrideBonus, overrideQtyBase)
    const spotBase = resolveSpotBase(operation, market)
    const adjustedLegs = applyDividendAdjustments(operation.pernas, dividendInfo?.total)
    const operationWithSpot = spotBase != null
      ? {
        ...operation,
        spotInicial: spotBase,
        qtyBase: settlementQtyBase,
        qtyBonus: settlementQtyBonus,
        qtyAtual: settlementQtyAtual,
        pernas: adjustedLegs,
      }
      : {
        ...operation,
        qtyBase: settlementQtyBase,
        qtyBonus: settlementQtyBonus,
        qtyAtual: settlementQtyAtual,
        pernas: adjustedLegs,
      }
    const operationEffectiveRaw = applyOverridesToOperation(operationWithSpot, override)
    const operationEffective = withLegSettlementSpots(operationEffectiveRaw, settlementMap)
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
      dividendEvents: Array.isArray(dividendInfo?.events) ? dividendInfo.events : [],
      bonusSource: autoBonus?.source || bonusInfo?.source || null,
      bonusEvents: Array.isArray(autoBonus?.events) ? autoBonus.events : (Array.isArray(bonusInfo?.events) ? bonusInfo.events : []),
      bonusAutoQtyBase: autoBonus?.inferredQtyBase ?? null,
      bonusAutoQtyBonus: autoBonus?.inferredQtyBonus ?? 0,
      bonusAutoFactor: autoBonus?.inferredFactor ?? autoBonus?.factor ?? 1,
      bonusAutoApplied: !bonusAutoDisabled && ((autoBonus?.inferredQtyBonus || 0) > 0 || autoBonus?.inferredQtyBase != null),
      bonusAutoDisabled,
      status: getStatus(operation.vencimento),
    }
  }

  const mappedRows = useMemo(() => {
    const previousCache = rowCacheRef.current
    const nextCache = new Map()

    const rowsList = enrichedOperations.map((operation) => {
      const overrideRef = overrides[operation.id] || EMPTY_OVERRIDE_VALUE
      const marketRef = marketMap[operation.id] || null
      const dividendRef = dividendAdjustments.get(operation.id) || null
      const bonusRef = bonusAdjustments.get(operation.id) || null
      const settlementRef = optionSettlementCloseMap
      const cached = previousCache.get(operation.id)

      if (
        cached
        && cached.operationRef === operation
        && cached.overrideRef === overrideRef
        && cached.marketRef === marketRef
        && cached.dividendRef === dividendRef
        && cached.bonusRef === bonusRef
        && cached.settlementRef === settlementRef
      ) {
        nextCache.set(operation.id, cached)
        return cached.row
      }

      const row = buildRowDirect(operation, marketRef, dividendRef, bonusRef, overrideRef, settlementRef)
      const nextEntry = {
        row,
        operationRef: operation,
        overrideRef,
        marketRef,
        dividendRef,
        bonusRef,
        settlementRef,
      }
      nextCache.set(operation.id, nextEntry)
      return row
    })

    rowCacheRef.current = nextCache
    return rowsList
  }, [applyDividendAdjustments, bonusAdjustments, dividendAdjustments, enrichedOperations, marketMap, optionSettlementCloseMap, overrides])

  useEffect(() => {
    if (!mappedRows.length) return
    if (stickyBarrierTimerRef.current) clearTimeout(stickyBarrierTimerRef.current)
    stickyBarrierTimerRef.current = setTimeout(() => {
      const hitDate = normalizeDateInput(reportDate)
      setOverrides((prev) => {
        let next = prev
        let changed = false

        for (let i = 0; i < mappedRows.length; i++) {
          const row = mappedRows[i]
          if (!row?.id || !row?.barrierStatus) continue
          const currentOvr = next[row.id] || EMPTY_OVERRIDE_VALUE
          if (currentOvr.stickyHighHit && currentOvr.stickyLowHit) continue
          const hasHighBarrier = statusHasBarrierDirection(row.barrierStatus, 'high')
          const hasLowBarrier = statusHasBarrierDirection(row.barrierStatus, 'low')
          const hitHigh = hasHighBarrier && row.barrierStatus.high === true && !currentOvr.stickyHighHit
          const hitLow = hasLowBarrier && row.barrierStatus.low === true && !currentOvr.stickyLowHit
          if (!hitHigh && !hitLow) continue

          const result = applyStickyBarrierHitOverride(next, row.id, {
            high: hitHigh,
            low: hitLow,
            hitDate,
          })
          if (!result.changed) continue
          next = result.overrides
          changed = true
        }

        return changed ? next : prev
      })
    }, 100)
    return () => {
      if (stickyBarrierTimerRef.current) clearTimeout(stickyBarrierTimerRef.current)
    }
  }, [mappedRows, reportDate])

  const rows = useMemo(() => {
    const vencimentoSet = filters.vencimentos.length ? new Set(filters.vencimentos) : null
    const localBrokerSet = filters.broker.length ? new Set(filters.broker) : null
    const localAssessorSet = filters.assessores?.length ? new Set(filters.assessores) : null
    const estruturaSet = filters.estruturas?.length ? new Set(filters.estruturas) : null
    const ativoSet = filters.ativos?.length ? new Set(filters.ativos) : null
    const query = filters.search ? filters.search.toLowerCase() : ''
    const statusKey = filters.status || ''
    // Single-pass: build availability sets
    const availableBrokerSet = new Set()
    const availableAssessorSet = new Set()
    const availableClientSet = new Set()
    for (let i = 0; i < mappedRows.length; i++) {
      const entry = mappedRows[i]
      const broker = String(entry.broker || '').trim()
      const assessor = String(entry.assessor || '').trim()
      if (broker) availableBrokerSet.add(broker)
      if (assessor) availableAssessorSet.add(assessor)
      collectClientFilterTokens(entry).forEach((token) => availableClientSet.add(token))
    }
    const effectiveBroker = selectedBroker
      .map((value) => String(value || '').trim())
      .filter((value) => availableBrokerSet.has(value))
    const effectiveAssessor = selectedAssessor
      .map((value) => String(value || '').trim())
      .filter((value) => availableAssessorSet.has(value))
    const brokerSet = effectiveBroker.length ? new Set(effectiveBroker) : null
    const assessorSet = effectiveAssessor.length ? new Set(effectiveAssessor) : null
    const clientSet = buildClientFilterMatchSet(clientCodeFilter, availableClientSet)
    return mappedRows.filter((entry) => {
      if (query) {
        const searchBase = `${entry.codigoCliente || ''} ${entry.cliente || ''} ${entry.ativo || ''} ${entry.estrutura || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase()
        if (!searchBase.includes(query)) return false
      }
      if (brokerSet && !brokerSet.has(String(entry.broker || '').trim())) return false
      if (assessorSet && !assessorSet.has(String(entry.assessor || '').trim())) return false
      if (localBrokerSet && !localBrokerSet.has(String(entry.broker || '').trim())) return false
      if (localAssessorSet && !localAssessorSet.has(entry.assessor)) return false
      if (clientSet.size && !matchesClientFilter(entry, clientSet)) return false
      if (estruturaSet && !estruturaSet.has(entry.estrutura)) return false
      if (ativoSet && !ativoSet.has(entry.ativo)) return false
      if (vencimentoSet && !vencimentoSet.has(normalizeDateKey(entry.vencimento))) return false
      if (statusKey && entry.status.key !== statusKey) return false
      return true
    })
  }, [clientCodeFilter, filters, mappedRows, selectedBroker, selectedAssessor])

  const resumoExportRows = useMemo(() => {
    return rows
      .map((row) => buildResumoExportEntry(row))
      .sort(compareResumoRows)
  }, [rows])

  const dadosExportRows = useMemo(() => rows.map((row) => buildDadosExportEntry(row)), [rows])

  const historicoPushContext = useMemo(() => {
    const todayKey = normalizeDateKey(new Date().toISOString())
    const eligibleRows = rows.filter((row) => {
      const vencimentoKey = normalizeDateKey(row?.vencimento)
      return Boolean(vencimentoKey && todayKey && vencimentoKey <= todayKey)
    })
    const monthKeys = Array.from(new Set(
      eligibleRows
        .map((row) => normalizeHistoricalMonthKey(row?.vencimento))
        .filter(Boolean),
    ))
    const monthKey = monthKeys.length === 1 ? monthKeys[0] : ''
    let disabledReason = ''
    if (!eligibleRows.length) {
      disabledReason = 'Nenhuma operacao vencida no recorte atual.'
    } else if (monthKeys.length > 1) {
      disabledReason = 'Selecione apenas um mes de vencimento para enviar ao historico.'
    }
    return {
      eligibleRows,
      monthKeys,
      monthKey,
      monthLabel: monthKey ? formatHistoricalMonthLabel(monthKey) : '-',
      canPush: Boolean(eligibleRows.length && monthKeys.length === 1),
      disabledReason,
    }
  }, [rows])

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

  // O(1) lookup map for syncing modal state with row updates
  const rowById = useMemo(() => {
    const map = new Map()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row?.id) map.set(row.id, row)
    }
    return map
  }, [rows])

  useEffect(() => {
    if (!selectedReport) return
    const updated = rowById.get(selectedReport.id)
    if (updated && updated !== selectedReport) setSelectedReport(updated)
  }, [rowById, selectedReport])

  useEffect(() => {
    if (!selectedOverride) return
    const updated = rowById.get(selectedOverride.id)
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
              includeSeries: true,
            })
            return { id: operation.id, market }
          } catch (error) {
            return { id: operation.id, error }
          }
        },
      )
      setMarketMap((prev) => {
        const next = { ...prev }
        const referenceDate = new Date()
        updates.forEach((update) => {
          if (update?.id && update.market) {
            const operation = operationMap.get(update.id)
            const dividendRequest = operation ? buildDividendRequest(operation, reportDate) : null
            const dividend = dividendRequest ? dividendMap.get(dividendRequest.key) : null
            const marketWithDividends = applyDividendsToMarket(update.market, dividend)
            next[update.id] = shouldLoadSettlementClose(operation, null, referenceDate)
              ? annotateSettlementMarket(operation, marketWithDividends, referenceDate)
              : marketWithDividends
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
  }, [visibleRows, notify, reportDate])

  const totals = useMemo(() => {
    let criticos = 0
    let alertas = 0
    for (let i = 0; i < rows.length; i++) {
      const key = rows[i].status.key
      if (key === 'critico') criticos++
      else if (key === 'alerta') alertas++
    }
    return { total: rows.length, criticos, alertas }
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

  const handleUseAutoBonus = useCallback(() => {
    if (!selectedOverride) return
    const autoQtyBase = Number(selectedOverride?.bonusAutoQtyBase)
    const autoQtyBonus = Number(selectedOverride?.bonusAutoQtyBonus)
    if ((!Number.isFinite(autoQtyBase) || autoQtyBase <= 0) && (!Number.isFinite(autoQtyBonus) || autoQtyBonus <= 0)) {
      return
    }
    const latestBonusDate = Array.isArray(selectedOverride?.bonusEvents) && selectedOverride.bonusEvents.length
      ? [...selectedOverride.bonusEvents]
        .sort((left, right) => String(left?.dataCom || '').localeCompare(String(right?.dataCom || '')))
        .at(-1)?.dataCom || ''
      : ''
    setOverrideDraft((prev) => ({
      ...prev,
      qtyBaseOverride: Number.isFinite(autoQtyBase) && autoQtyBase > 0 ? String(autoQtyBase) : prev.qtyBaseOverride,
      qtyBonus: Number.isFinite(autoQtyBonus) && autoQtyBonus > 0 ? String(autoQtyBonus) : prev.qtyBonus,
      bonusAutoDisabled: false,
      bonusDate: prev.bonusDate || latestBonusDate || '',
      bonusNote: prev.bonusNote || (selectedOverride?.bonusSource ? `Auto ${selectedOverride.bonusSource}` : 'Auto bonificacao'),
    }))
  }, [selectedOverride])

  const handleExportXlsx = useCallback(async () => {
    if (isExporting) return
    if (!resumoExportRows.length) {
      notify('Nenhuma estrutura para exportar.', 'warning')
      return
    }
    setIsExporting(true)
    try {
      const rowsToExport = resumoExportRows.map((entry) => (
        RESUMO_EXPORT_KEYS.map((key) => resolveResumoCellDisplayValue(entry, key))
      ))
      const fileDate = new Date().toISOString().slice(0, 10)
      const { exportXlsx } = await import('../services/exportXlsx')
      const result = await exportXlsx({
        fileName: `estruturas_resumo_${fileDate}.xlsx`,
        sheetName: 'Resumo',
        columns: RESUMO_EXPORT_LABELS,
        rows: rowsToExport,
        useStyles: true,
        columnWidths: [40, 24, 18, 20, 16, 12, 24, 16, 14, 14, 12, 16, 16, 12],
        decorateWorksheet: ({ worksheet, XLSX, firstDataRowIndex }) => {
          const centerAlignment = { horizontal: 'center', vertical: 'center', wrapText: true }
          const border = {
            top: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
            right: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
            bottom: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
            left: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
          }
          const buildDataStyle = (fillRgb = 'FFFFFFFF') => ({
            alignment: centerAlignment,
            border,
            fill: { patternType: 'solid', fgColor: { rgb: fillRgb } },
            font: { color: { rgb: 'FF0F172A' } },
          })
          const headerStyle = {
            ...buildDataStyle('FF0F172A'),
            font: { bold: true, color: { rgb: 'FFFFFFFF' } },
          }
          const buildToneStyle = (tone) => ({
            ...buildDataStyle(resolveToneFillRgb(tone)),
            font: { bold: true, color: { rgb: resolveToneRgb(tone) } },
          })

          const totalRows = rowsToExport.length + 1
          const totalCols = RESUMO_EXPORT_LABELS.length
          for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
            for (let colIndex = 0; colIndex < totalCols; colIndex += 1) {
              const ref = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })
              const cell = worksheet[ref]
              if (!cell) continue
              if (rowIndex === 0) {
                cell.s = headerStyle
                continue
              }
              const dataFill = rowIndex % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFD'
              cell.s = buildDataStyle(dataFill)
            }
          }

          RESUMO_EXPORT_KEYS.forEach((key, colIndex) => {
            const formatMask = resolveResumoCellFormat(key)
            const isDate = RESUMO_DATE_KEYS.has(key)
            if (!formatMask && !isDate) return
            for (let rowIndex = 0; rowIndex < rowsToExport.length; rowIndex += 1) {
              const excelRow = firstDataRowIndex + rowIndex
              const ref = XLSX.utils.encode_cell({ r: excelRow, c: colIndex })
              const cell = worksheet[ref]
              if (!cell) continue
              if (isDate) {
                const serial = parsePtBrDateToExcelSerial(String(cell.v || ''))
                if (serial != null) {
                  cell.t = 'n'
                  cell.v = serial
                  cell.z = 'DD/MM/YYYY'
                  delete cell.w
                }
              } else {
                cell.z = formatMask
              }
            }
          })

          for (let rowIndex = 0; rowIndex < resumoExportRows.length; rowIndex += 1) {
            const source = resumoExportRows[rowIndex]
            RESUMO_EXPORT_KEYS.forEach((key, colIndex) => {
              const tone = resolveResumoCellTone(source, key)
              if (!tone) return
              const excelRow = firstDataRowIndex + rowIndex
              const ref = XLSX.utils.encode_cell({ r: excelRow, c: colIndex })
              const cell = worksheet[ref]
              if (!cell) return
              cell.s = buildToneStyle(tone)
            })
          }

          const lastColumnRef = XLSX.utils.encode_col(Math.max(RESUMO_EXPORT_LABELS.length - 1, 0))
          worksheet['!autofilter'] = { ref: `A1:${lastColumnRef}1` }
        },
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
  }, [isExporting, notify, resumoExportRows])

  const handleExportDados = useCallback(async () => {
    if (isExportingDados) return
    if (!dadosExportRows.length) {
      notify('Nenhuma estrutura para exportar.', 'warning')
      return
    }
    setIsExportingDados(true)
    try {
      const rowsToExport = dadosExportRows.map((entry) => (
        DADOS_EXPORT_KEYS.map((key) => resolveDadosCellDisplayValue(entry, key))
      ))
      const fileDate = new Date().toISOString().slice(0, 10)
      const { exportXlsx } = await import('../services/exportXlsx')
      const result = await exportXlsx({
        fileName: `estruturas_dados_${fileDate}.xlsx`,
        sheetName: 'Dados',
        columns: DADOS_EXPORT_LABELS,
        rows: rowsToExport,
        useStyles: true,
        columnWidths: DADOS_EXPORT_COL_WIDTHS,
        decorateWorksheet: ({ worksheet, XLSX, firstDataRowIndex }) => {
          const centerAlignment = { horizontal: 'center', vertical: 'center', wrapText: true }
          const border = {
            top: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
            right: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
            bottom: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
            left: { style: 'thin', color: { rgb: 'FFD9E2EC' } },
          }
          const buildDataStyle = (fillRgb = 'FFFFFFFF') => ({
            alignment: centerAlignment,
            border,
            fill: { patternType: 'solid', fgColor: { rgb: fillRgb } },
            font: { color: { rgb: 'FF0F172A' } },
          })
          const headerStyle = {
            ...buildDataStyle('FF0F172A'),
            font: { bold: true, color: { rgb: 'FFFFFFFF' } },
          }
          const buildToneStyle = (tone) => ({
            ...buildDataStyle(resolveToneFillRgb(tone)),
            font: { bold: true, color: { rgb: resolveToneRgb(tone) } },
          })

          const totalRows = rowsToExport.length + 1
          const totalCols = DADOS_EXPORT_LABELS.length
          for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
            for (let colIndex = 0; colIndex < totalCols; colIndex += 1) {
              const ref = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })
              const cell = worksheet[ref]
              if (!cell) continue
              if (rowIndex === 0) {
                cell.s = headerStyle
                continue
              }
              const dataFill = rowIndex % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFD'
              cell.s = buildDataStyle(dataFill)
            }
          }

          DADOS_EXPORT_KEYS.forEach((key, colIndex) => {
            const formatMask = resolveDadosCellFormat(key)
            const isDate = DADOS_DATE_KEYS.has(key)
            if (!formatMask && !isDate) return
            for (let rowIndex = 0; rowIndex < rowsToExport.length; rowIndex += 1) {
              const excelRow = firstDataRowIndex + rowIndex
              const ref = XLSX.utils.encode_cell({ r: excelRow, c: colIndex })
              const cell = worksheet[ref]
              if (!cell) continue
              if (isDate) {
                const serial = parsePtBrDateToExcelSerial(String(cell.v || ''))
                if (serial != null) {
                  cell.t = 'n'
                  cell.v = serial
                  cell.z = 'DD/MM/YYYY'
                  delete cell.w
                }
              } else {
                cell.z = formatMask
              }
            }
          })

          for (let rowIndex = 0; rowIndex < dadosExportRows.length; rowIndex += 1) {
            const source = dadosExportRows[rowIndex]
            DADOS_EXPORT_KEYS.forEach((key, colIndex) => {
              const tone = resolveDadosCellTone(source, key)
              if (!tone) return
              const excelRow = firstDataRowIndex + rowIndex
              const ref = XLSX.utils.encode_cell({ r: excelRow, c: colIndex })
              const cell = worksheet[ref]
              if (!cell) return
              cell.s = buildToneStyle(tone)
            })
          }

          const lastColumnRef = XLSX.utils.encode_col(Math.max(DADOS_EXPORT_LABELS.length - 1, 0))
          worksheet['!autofilter'] = { ref: `A1:${lastColumnRef}1` }
        },
      })
      if (!result) {
        notify('Exportacao cancelada.', 'warning')
        return
      }
      notify('Exportacao concluida.', 'success')
    } catch {
      notify('Falha ao exportar o XLSX.', 'warning')
    } finally {
      setIsExportingDados(false)
    }
  }, [isExportingDados, notify, dadosExportRows])

  const handlePushToHistorico = useCallback(async () => {
    if (isPushingHistorico) return
    if (!historicoPushContext.canPush) {
      notify(historicoPushContext.disabledReason || 'Selecione um unico mes vencido para enviar ao historico.', 'warning')
      return
    }

    setIsPushingHistorico(true)
    const pushedAt = new Date().toISOString()
    const monthKey = historicoPushContext.monthKey
    try {
      const currentState = loadHistoricoOperacoesState(userKey)
      const replaced = Boolean(currentState.monthlyBatches?.[monthKey])
      const seedRows = historicoPushContext.eligibleRows.map((row) => buildHistoricalRowFromVencimentoRow(row, {
        origin: HISTORICO_ORIGIN_VENCIMENTO,
        batchMonth: monthKey,
        pushedAt,
      }))
      const closeMap = await fetchHistoricalCloseMap(seedRows)
      const frozenRows = seedRows.map((row) => {
        const quoteKey = buildHistoricalQuoteKey(row)
        const quote = quoteKey ? closeMap?.[quoteKey] : null
        return recalculateHistoricalWorkbookValues(row, quote?.close ?? row.spot, {
          origin: HISTORICO_ORIGIN_VENCIMENTO,
          batchMonth: monthKey,
          pushedAt,
          spotSource: quote?.source || row.spotSource || 'vencimento',
        })
      })

      upsertHistoricoMonthlyBatch({
        monthKey,
        monthLabel: formatHistoricalMonthLabel(monthKey),
        origin: HISTORICO_ORIGIN_VENCIMENTO,
        pushedAt,
        rows: frozenRows,
      }, userKey)

      notify(
        replaced
          ? `Historico de ${formatHistoricalMonthLabel(monthKey)} substituido com ${formatNumber(frozenRows.length)} operacoes.`
          : `Historico de ${formatHistoricalMonthLabel(monthKey)} enviado com ${formatNumber(frozenRows.length)} operacoes.`,
        'success',
      )
    } catch (error) {
      notify(error?.message ? `Falha ao enviar ao historico: ${error.message}` : 'Falha ao enviar ao historico.', 'warning')
    } finally {
      setIsPushingHistorico(false)
    }
  }, [historicoPushContext, isPushingHistorico, notify, userKey])

  const handleGenerateReport = useCallback(async () => {
    if (!resumoExportRows.length) {
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
    filterItems.push({ label: 'Linhas no recorte', value: formatNumber(resumoExportRows.length) })

    const totalFinanceiro = resumoExportRows.reduce((sum, row) => sum + (Number(row.financeiroFinal) || 0), 0)
    const totalGanho = resumoExportRows.reduce((sum, row) => sum + (Number(row.ganhoPrejuizo) || 0), 0)
    const totalEntrou = resumoExportRows.reduce((sum, row) => sum + (Number(row.entrou) || 0), 0)

    const summaryItems = [
      { label: 'Operacoes no recorte', value: formatNumber(resumoExportRows.length) },
      { label: 'Entrou (soma)', value: formatCurrency(totalEntrou) },
      { label: 'Financeiro final (soma)', value: formatCurrency(totalFinanceiro) },
      { label: 'Ganho/Prejuizo (soma)', value: formatCurrency(totalGanho) },
    ]

    const columns = RESUMO_EXPORT_LABELS
    const rows = resumoExportRows.map((entry) => buildResumoPdfRow(entry))

    const generatedAt = new Date().toLocaleString('pt-BR')
    const { exportVencimentosReportPdf } = await import('../services/pdf')
    exportVencimentosReportPdf(
      {
        title: 'Relatorio de Vencimentos',
        generatedAt,
        filters: filterItems,
        summary: summaryItems,
        columns,
        rows,
      },
      `vencimentos_resumo_${new Date().toISOString().slice(0, 10)}`,
    )
  }, [clientCodeFilter, filters, notify, resumoExportRows, selectedAssessor, selectedBroker])

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
        label: 'Conta',
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
        label: 'Valor de saida',
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
        render: (row) => {
          const norm = String(row.estrutura || '').trim().toLowerCase()
          const isRec = norm === 'cupom recorrente' || norm === 'cupom recorrente europeia'
          return isRec ? <span className="muted">—</span> : formatCurrency(row.result.debito ?? 0)
        },
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

  const handleUseGlobalFolder = useCallback(async () => {
    try {
      const resolved = await globalFolderMenu.refreshFile()
      if (!resolved?.filePath) {
        notify('Nenhum arquivo importado vinculado para este modulo.', 'warning')
        return
      }

      const nextPending = { source: 'electron', ...resolved }
      setPendingFile(nextPending)
      const applied = await applyPendingFile(nextPending, { save: true, silent: false })
      if (!applied) setPendingFile(null)
    } catch {
      notify('Falha ao carregar arquivo importado.', 'warning')
    }
  }, [applyPendingFile, globalFolderMenu, notify])

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
    clearBonusCache()
    setDividendsRefreshToken((prev) => prev + 1)
    setBonusRefreshToken((prev) => prev + 1)
  }, [])

  const handleExportPdf = async (row) => {
    const barrierBadge = getBarrierBadge(row.barrierStatus)
    const clienteLabel = row.codigoCliente || row.cliente || 'Conta'
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
        { label: 'Valor de saida', value: formatCurrency(row.result.vendaAtivo) },
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
    const { exportReportPdf } = await import('../services/pdf')
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
          {
            label: isPushingHistorico ? 'Enviando historico...' : 'Enviar vencidas ao historico',
            icon: 'upload',
            variant: 'btn-secondary',
            onClick: handlePushToHistorico,
            disabled: isPushingHistorico || !historicoPushContext.canPush,
          },
          { label: 'Gerar relatorio', icon: 'doc', onClick: handleGenerateReport, disabled: !visibleRows.length },
          { label: isExportingDados ? 'Exportando...' : 'Exportar dados', icon: 'download', variant: 'btn-secondary', onClick: handleExportDados, disabled: isExportingDados },
          { label: isExporting ? 'Exportando...' : 'Exportar', icon: 'download', variant: 'btn-secondary', onClick: handleExportXlsx, disabled: isExporting },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Fonte de dados</h3>
            <p className="muted">Use o arquivo importado para vincular automaticamente a planilha de posicao.</p>
          </div>
          <div className="panel-actions">
            {showReauthorize ? (
              <button className="btn btn-secondary" type="button" onClick={handleReauthorize} disabled={isBusy}>
                <Icon name="sync" size={16} />
                Reautorizar
              </button>
            ) : null}
            {hasLink ? (
              <button className="btn btn-secondary" type="button" onClick={handleUnlink} disabled={isBusy}>
                <Icon name="close" size={16} />
                Desvincular
              </button>
            ) : null}
          </div>
        </div>
        <div className="sync-folder-filter">
          <label className="sync-folder-filter-field">
            <span>Arquivo importado</span>
            <select
              className="input"
              value={globalFolderMenu.directoryValue || ''}
              onChange={(event) => globalFolderMenu.onDirectoryChange(event.target.value)}
              disabled={!globalDirectoryOptions.length || globalFolderMenu.loading || isBusy}
            >
              {!globalDirectoryOptions.length ? (
                <option value="">
                  {globalFolderMenu.loading ? 'Carregando arquivos...' : 'Sem arquivos disponiveis'}
                </option>
              ) : null}
              {globalDirectoryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={handleUseGlobalFolder}
            disabled={!globalDirectoryOptions.length || globalFolderMenu.loading || isBusy}
          >
            Usar arquivo importado
          </button>
          {globalDirectoryEmptyMessage ? <div className="muted">{globalDirectoryEmptyMessage}</div> : null}
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
              disabled={!reportDate || dividendStatus.loading || bonusStatus.loading}
            >
              <Icon name="sync" size={16} />
              {(dividendStatus.loading || bonusStatus.loading) ? 'Recalculando...' : 'Recalcular proventos e bonificacoes'}
            </button>
          </div>
        </div>
        {dividendStatus.error ? <div className="muted">{dividendStatus.error}</div> : null}
        {bonusStatus.error ? <div className="muted">{bonusStatus.error}</div> : null}
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
                placeholder="Buscar conta, ativo ou estrutura"
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
            placeholder="Conta"
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
            <p className="muted">Exportacao, auditoria e envio do consolidado mensal em um clique.</p>
          </div>
          <button className="btn btn-secondary" type="button">Gerar CSV</button>
        </div>
        <div className="sync-result">
          <div>
            <strong>{historicoPushContext.monthLabel}</strong>
            <span className="muted">Competencia elegivel</span>
          </div>
          <div>
            <strong>{formatNumber(historicoPushContext.eligibleRows.length)}</strong>
            <span className="muted">Operacoes vencidas no recorte</span>
          </div>
          <div>
            <strong>{historicoPushContext.canPush ? 'Pronto para enviar' : 'Recorte invalido'}</strong>
            <span className="muted">{historicoPushContext.canPush ? 'O lote substitui o mes atual no historico.' : (historicoPushContext.disabledReason || 'Selecione um unico mes vencido.')}</span>
          </div>
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
        dividendEvents={selectedOverride?.dividendEvents}
        autoDividendBRL={selectedOverride?.result?.dividends}
        dividendSource={selectedOverride?.dividendSource}
        bonusEvents={selectedOverride?.bonusEvents}
        autoBonusQty={selectedOverride?.bonusAutoQtyBonus}
        autoBonusQtyBase={selectedOverride?.bonusAutoQtyBase}
        bonusSource={selectedOverride?.bonusSource}
        bonusFactor={selectedOverride?.bonusAutoFactor}
        onClose={() => {
          setSelectedOverride(null)
          setOverrideErrors({})
        }}
        onChange={setOverrideDraft}
        onApply={handleApplyOverride}
        onReset={handleResetOverride}
        onClearStructureOverrides={handleClearStructureOverrides}
        onUseQtyBase={handleUseQtyBase}
        onUseAutoBonus={handleUseAutoBonus}
        onAddStructureEntry={handleAddStructureEntry}
        onRemoveStructureEntry={handleRemoveStructureEntry}
        onStructureEntryChange={handleStructureEntryChange}
      />
    </div>
  )
}

export default Vencimento
