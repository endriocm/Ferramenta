import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import MultiSelect from '../components/MultiSelect'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import ReportModal from '../components/ReportModal'
import { formatCurrency, formatDate, formatNumber, formatNumericDate } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { toNumber } from '../utils/number'
import { buildMultiOptions } from '../utils/spreadsheet'
import { parseHistoricoWorkbook, parseHistoricoWorkbookBuffer } from '../services/historicoOperacoesParser'
import {
  HISTORICO_ORIGIN_LEGACY,
  HISTORICO_ORIGIN_VENCIMENTO,
  applyHistoricalCloseMap,
  buildHistoricoBatchSummary,
  buildHistoricalRowFromParsedRow,
  composeHistoricoRows,
  fetchHistoricalCloseMap,
  formatHistoricalMonthLabel,
  loadHistoricoOperacoesState,
  recalculateHistoricalWorkbookValues,
  replaceHistoricoLegacyRows,
  subscribeHistoricoOperacoesState,
  toOptionalNumber,
  updateHistoricoRow,
} from '../services/historicoOperacoes'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import useGlobalFolderMenu from '../hooks/useGlobalFolderMenu'

const DEFAULT_FILTERS = {
  search: '',
  broker: [],
  assessor: [],
  ativo: [],
  estrutura: [],
  vencimento: [],
  competencia: [],
  resultado: [],
}

const RESULTADO_OPTIONS = [
  { value: 'positivo', label: 'Resultado positivo' },
  { value: 'negativo', label: 'Resultado negativo' },
]
const PAGE_SIZE = 20
const CALCULATION_FIELDS = [
  { key: 'quantidade', label: 'Quantidade', inputMode: 'numeric' },
  { key: 'spot', label: 'Spot final', inputMode: 'decimal' },
  { key: 'callComprada', label: 'Strike call comprada', inputMode: 'decimal' },
  { key: 'putComprada', label: 'Strike put comprada', inputMode: 'decimal' },
  { key: 'vendaAtivoMercado', label: 'Venda do ativo', inputMode: 'decimal' },
  { key: 'debito', label: 'Debito', inputMode: 'decimal' },
  { key: 'dividendos', label: 'Dividendos', inputMode: 'decimal' },
  { key: 'cupom', label: 'Cupom', inputMode: 'decimal' },
  { key: 'pagou', label: 'Valor de entrada', inputMode: 'decimal' },
]

const normalizeFileName = (name) => String(name || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const pickPreferredFile = (files) => {
  const candidates = (Array.isArray(files) ? files : [])
    .filter((file) => {
      if (!file || !file.name) return false
      const lower = file.name.toLowerCase()
      return (lower.endsWith('.xlsx') || lower.endsWith('.xls')) && !file.name.startsWith('~$')
    })
  if (!candidates.length) return null
  const preferred = candidates.find((file) => {
    const normalized = normalizeFileName(file.name)
    return normalized.includes('vencimento') || normalized.includes('historico')
  })
  if (preferred) return preferred
  return candidates.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))[0]
}

const toArrayBuffer = (value) => {
  if (!value) return null
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  }
  return null
}

const formatSpot = (value) => {
  if (!Number.isFinite(Number(value))) return '—'
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

const adaptRowForModal = (row) => ({
  ...row,
  historicoSource: row?.historicoSource || row,
  conta: row.codigoCliente,
  vencimento: row.dataVencimento,
  market: { source: row.spotSource === 'yahoo' ? 'yahoo' : row.spotSource || 'planilha' },
  result: {
    financeiroFinal: row.financeiroFinal,
    ganho: row.ganhoPrejuizo,
    percent: row.lucroPercentual,
    valorEntrada: row.pagou,
    dividends: row.dividendos,
    cupomTotal: row.cupom,
  },
})

const toDraftValue = (value) => {
  const parsed = toOptionalNumber(value)
  return parsed != null ? String(parsed) : ''
}

const buildCalculationDraft = (row) => {
  if (!row) return null
  return CALCULATION_FIELDS.reduce((acc, field) => {
    acc[field.key] = toDraftValue(row?.[field.key])
    return acc
  }, {})
}

const parseDraftNumber = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return Number.NaN
  const parsed = toNumber(raw)
  return parsed == null ? Number.NaN : parsed
}

const parseCalculationDraft = (draft) => CALCULATION_FIELDS.reduce((acc, field) => {
  acc[field.key] = parseDraftNumber(draft?.[field.key])
  return acc
}, {})

const isCalculationDraftValueInvalid = (value) => {
  const raw = String(value ?? '').trim()
  return raw ? toNumber(raw) == null : false
}

const decorateHistoricalDisplayRow = (row, { tagsIndex, todayKey, index = 0 }) => {
  const taggedRow = enrichRow({
    id: row.id,
    codigoCliente: row.cliente,
    cliente: row.cliente,
    assessor: row.assessor,
    broker: row.broker,
    ativo: row.ativo,
    estrutura: row.estrutura,
  }, tagsIndex) || {}
  const vencimentoKey = normalizeDateKey(row.dataVencimento)
  const ganhoPrejuizo = Number(row.ganhoPrejuizo || 0)
  const financeiroFinal = Number(row.financeiroFinal || 0)
  return {
    ...row,
    historicoSource: row,
    id: row.id || `hist-row-${index + 1}`,
    codigoCliente: String(row.cliente || '').trim(),
    assessor: String(taggedRow.assessor || row.assessor || '').trim() || 'Sem assessor',
    broker: String(taggedRow.broker || row.broker || '').trim() || 'Sem broker',
    dataRegistroLabel: row.dataRegistro ? formatDate(row.dataRegistro) : '-',
    dataVencimentoLabel: row.dataVencimento ? formatNumericDate(row.dataVencimento) : '-',
    competenciaLabel: row.batchMonth ? formatHistoricalMonthLabel(row.batchMonth) : '-',
    originLabel: row.origin === HISTORICO_ORIGIN_VENCIMENTO ? 'Vencimento' : 'Legado',
    originTone: row.origin === HISTORICO_ORIGIN_VENCIMENTO ? 'cyan' : 'green',
    spotLabel: formatSpot(row.spot),
    spotSourceLabel: row.spotSource === 'yahoo'
      ? 'Yahoo (vencimento)'
      : row.spotSource === 'planilha'
        ? 'Planilha'
        : row.spotSource === 'vencimento'
          ? 'Vencimento'
          : row.spotSource === 'manual'
            ? 'Manual'
            : '-',
    financeiroFinal,
    ganhoPrejuizo,
    lucroPercentual: Number(row.lucroPercentual || 0),
    resultadoStatus: ganhoPrejuizo >= 0 ? 'positivo' : 'negativo',
    encerrada: Boolean(vencimentoKey && todayKey && vencimentoKey <= todayKey),
  }
}

const buildGroupedMetrics = (rows, field, emptyLabel) => {
  const groups = new Map()
  rows.forEach((row) => {
    const rawLabel = String(row?.[field] || '').trim()
    const label = rawLabel || emptyLabel
    const current = groups.get(label) || {
      id: `${field}-${label}`,
      label,
      operacoes: 0,
      clientesSet: new Set(),
      pagou: 0,
      financeiroFinal: 0,
      ganhoPrejuizo: 0,
    }
    current.operacoes += 1
    current.clientesSet.add(String(row?.codigoCliente || row?.cliente || '').trim())
    current.pagou += Number(row?.pagou || 0)
    current.financeiroFinal += Number(row?.financeiroFinal || 0)
    current.ganhoPrejuizo += Number(row?.ganhoPrejuizo || 0)
    groups.set(label, current)
  })

  return Array.from(groups.values())
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      operacoes: entry.operacoes,
      clientes: entry.clientesSet.size,
      pagou: entry.pagou,
      financeiroFinal: entry.financeiroFinal,
      ganhoPrejuizo: entry.ganhoPrejuizo,
      lucroPercentual: entry.pagou ? (entry.financeiroFinal / entry.pagou) - 1 : 0,
    }))
    .sort((left, right) => {
      if (left.ganhoPrejuizo !== right.ganhoPrejuizo) return right.ganhoPrejuizo - left.ganhoPrejuizo
      return left.label.localeCompare(right.label, 'pt-BR')
    })
}

const buildMetricColumns = (label) => ([
  { key: 'label', label, render: (row) => row.label || '-' },
  { key: 'operacoes', label: 'Operações', render: (row) => formatNumber(row.operacoes) },
  { key: 'clientes', label: 'Clientes', render: (row) => formatNumber(row.clientes) },
  { key: 'pagou', label: 'Pagou', render: (row) => formatCurrency(row.pagou) },
  {
    key: 'financeiroFinal',
    label: 'Financeiro final',
    render: (row) => (
      <strong className={row.financeiroFinal >= 0 ? 'text-positive' : 'text-negative'}>
        {formatCurrency(row.financeiroFinal)}
      </strong>
    ),
  },
  {
    key: 'ganhoPrejuizo',
    label: 'Ganho / Prejuízo',
    render: (row) => (
      <strong className={row.ganhoPrejuizo >= 0 ? 'text-positive' : 'text-negative'}>
        {formatCurrency(row.ganhoPrejuizo)}
      </strong>
    ),
  },
  {
    key: 'lucroPercentual',
    label: 'Lucro %',
    render: (row) => (
      <strong className={row.lucroPercentual >= 0 ? 'text-positive' : 'text-negative'}>
        {`${(row.lucroPercentual * 100).toFixed(2)}%`}
      </strong>
    ),
  },
])

const HistoricoOperacoes = () => {
  const { notify } = useToast()
  const {
    selectedBroker,
    selectedAssessor,
    clientCodeFilter,
    setClientCodeFilter,
    tagsIndex,
  } = useGlobalFilters()
  const globalFolderMenu = useGlobalFolderMenu('historico-operacoes')
  const fileInputRef = useRef(null)

  const [historicoState, setHistoricoState] = useState(() => loadHistoricoOperacoesState())
  const [isImporting, setIsImporting] = useState(false)
  const [isRefreshingClose, setIsRefreshingClose] = useState(false)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [page, setPage] = useState(1)
  const [selectedRow, setSelectedRow] = useState(null)
  const [calculationDraft, setCalculationDraft] = useState(null)

  useEffect(() => subscribeHistoricoOperacoesState(setHistoricoState), [])

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

  const reprocessLegacyRows = useCallback(async (rowsToProcess, importMeta, { silent = false } = {}) => {
    const sourceRows = Array.isArray(rowsToProcess) ? rowsToProcess : historicoState.legacyRows
    if (!sourceRows.length) {
      if (!silent) notify('Nenhuma linha legada para reprocessar.', 'warning')
      return
    }
    setIsRefreshingClose(true)
    try {
      const closeMap = await fetchHistoricalCloseMap(sourceRows)
      const nextRows = applyHistoricalCloseMap(sourceRows, closeMap, {
        reprocessOrigins: [HISTORICO_ORIGIN_LEGACY],
      })
      const nextState = replaceHistoricoLegacyRows(nextRows, importMeta || historicoState.importMeta)
      setHistoricoState(nextState)
      if (!silent) {
        notify(`Spots de vencimento atualizados (${formatNumber(Object.keys(closeMap).length)} ativo/data).`, 'success')
      }
    } catch (error) {
      if (!silent) {
        notify(error?.message ? `Falha ao reprocessar spots: ${error.message}` : 'Falha ao reprocessar spots.', 'warning')
      }
    } finally {
      setIsRefreshingClose(false)
    }
  }, [historicoState.importMeta, historicoState.legacyRows, notify])

  const applyParsedRows = useCallback(async (rows, fileName) => {
    const importedAt = new Date().toISOString()
    const legacyRows = Array.isArray(rows) ? rows.map((row) => buildHistoricalRowFromParsedRow(row)) : []
    const importMeta = {
      fileName: fileName || '',
      importedAt,
    }
    const nextState = replaceHistoricoLegacyRows(legacyRows, importMeta)
    setHistoricoState(nextState)
    await reprocessLegacyRows(legacyRows, importMeta, { silent: true })
  }, [reprocessLegacyRows])

  const handleFileChange = useCallback(async (event) => {
    const file = pickPreferredFile(Array.from(event.target.files || []))
    if (!file) {
      event.target.value = ''
      return
    }
    setIsImporting(true)
    try {
      const parsedRows = await parseHistoricoWorkbook(file)
      await applyParsedRows(parsedRows, file.name)
      notify(`Histórico importado (${formatNumber(parsedRows.length)} linhas).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar planilha.', 'warning')
    } finally {
      setIsImporting(false)
      event.target.value = ''
    }
  }, [applyParsedRows, notify])

  const handleUseGlobalFolder = useCallback(async () => {
    setIsImporting(true)
    try {
      const resolved = await globalFolderMenu.refreshFile()
      if (!resolved?.filePath) {
        notify('Nenhum arquivo importado vinculado para este módulo.', 'warning')
        return
      }
      if (!window?.electronAPI?.readFile) {
        notify('Leitura de arquivo indisponível no modo atual.', 'warning')
        return
      }
      const raw = await window.electronAPI.readFile(resolved.filePath)
      const buffer = toArrayBuffer(raw)
      if (!buffer) {
        notify('Não foi possível ler o arquivo importado.', 'warning')
        return
      }
      const parsedRows = await parseHistoricoWorkbookBuffer(buffer)
      await applyParsedRows(parsedRows, resolved.fileName || 'Arquivo global')
      notify(`Histórico importado (${formatNumber(parsedRows.length)} linhas).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar planilha vinculada.', 'warning')
    } finally {
      setIsImporting(false)
    }
  }, [applyParsedRows, globalFolderMenu, notify])

  const handleRefreshClose = useCallback(async () => {
    await reprocessLegacyRows()
  }, [reprocessLegacyRows])

  const composedRows = useMemo(() => composeHistoricoRows(historicoState), [historicoState])
  const batchSummaryRows = useMemo(() => buildHistoricoBatchSummary(historicoState), [historicoState])

  const todayKey = normalizeDateKey(new Date().toISOString())
  const historyRows = useMemo(() => {
    return composedRows
      .map((row, index) => decorateHistoricalDisplayRow(row, { tagsIndex, todayKey, index }))
      .filter((row) => row.encerrada)
  }, [composedRows, tagsIndex, todayKey])

  const globallyFilteredRows = useMemo(() => {
    return historyRows.filter((row) => {
      if (selectedBroker.length && !selectedBroker.includes(row.broker)) return false
      if (selectedAssessor.length && !selectedAssessor.includes(row.assessor)) return false
      if (clientCodeFilter.length && !clientCodeFilter.includes(row.codigoCliente)) return false
      return true
    })
  }, [clientCodeFilter, historyRows, selectedAssessor, selectedBroker])

  const options = useMemo(() => ({
    broker: buildMultiOptions(globallyFilteredRows.map((row) => row.broker)),
    assessor: buildMultiOptions(globallyFilteredRows.map((row) => row.assessor)),
    ativo: buildMultiOptions(globallyFilteredRows.map((row) => row.ativo)),
    estrutura: buildMultiOptions(globallyFilteredRows.map((row) => row.estrutura)),
    vencimento: buildMultiOptions(globallyFilteredRows.map((row) => row.dataVencimentoLabel)),
    competencia: buildMultiOptions(globallyFilteredRows.map((row) => row.competenciaLabel)),
    cliente: buildMultiOptions(globallyFilteredRows.map((row) => row.codigoCliente)),
  }), [globallyFilteredRows])

  const filteredRows = useMemo(() => {
    const query = filters.search.trim().toLowerCase()
    const rows = globallyFilteredRows.filter((row) => {
      if (query) {
        const searchable = [
          row.codigoCliente,
          row.assessor,
          row.broker,
          row.ativo,
          row.estrutura,
          row.dataVencimentoLabel,
          row.competenciaLabel,
        ].join(' ').toLowerCase()
        if (!searchable.includes(query)) return false
      }
      if (filters.broker.length && !filters.broker.includes(row.broker)) return false
      if (filters.assessor.length && !filters.assessor.includes(row.assessor)) return false
      if (filters.ativo.length && !filters.ativo.includes(row.ativo)) return false
      if (filters.estrutura.length && !filters.estrutura.includes(row.estrutura)) return false
      if (filters.vencimento.length && !filters.vencimento.includes(row.dataVencimentoLabel)) return false
      if (filters.competencia.length && !filters.competencia.includes(row.competenciaLabel)) return false
      if (filters.resultado.length && !filters.resultado.includes(row.resultadoStatus)) return false
      return true
    })

    return rows.sort((left, right) => {
      const leftDate = normalizeDateKey(left.dataVencimento) || ''
      const rightDate = normalizeDateKey(right.dataVencimento) || ''
      if (leftDate !== rightDate) return rightDate.localeCompare(leftDate)
      if (left.ganhoPrejuizo !== right.ganhoPrejuizo) return right.ganhoPrejuizo - left.ganhoPrejuizo
      return String(left.id || '').localeCompare(String(right.id || ''), 'pt-BR')
    })
  }, [filters, globallyFilteredRows])

  const kpis = useMemo(() => {
    const total = filteredRows.length
    const financeiroFinal = filteredRows.reduce((sum, row) => sum + row.financeiroFinal, 0)
    const ganhoPrejuizo = filteredRows.reduce((sum, row) => sum + row.ganhoPrejuizo, 0)
    const positivos = filteredRows.filter((row) => row.ganhoPrejuizo >= 0).length
    const clientes = new Set(filteredRows.map((row) => row.codigoCliente).filter(Boolean)).size
    return {
      total,
      financeiroFinal,
      ganhoPrejuizo,
      positivosPct: total ? (positivos / total) * 100 : 0,
      clientes,
    }
  }, [filteredRows])

  const groupedMetrics = useMemo(() => ({
    broker: buildGroupedMetrics(filteredRows, 'broker', 'Sem broker'),
    assessor: buildGroupedMetrics(filteredRows, 'assessor', 'Sem assessor'),
    estrutura: buildGroupedMetrics(filteredRows, 'estrutura', 'Sem estrutura'),
    cliente: buildGroupedMetrics(filteredRows, 'codigoCliente', 'Sem conta'),
  }), [filteredRows])

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE)),
    [filteredRows.length],
  )
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * PAGE_SIZE
  const pageEnd = Math.min(pageStart + PAGE_SIZE, filteredRows.length)
  const pagedRows = useMemo(
    () => filteredRows.slice(pageStart, pageStart + PAGE_SIZE),
    [filteredRows, pageStart],
  )

  useEffect(() => {
    setPage(1)
  }, [filters, selectedBroker, selectedAssessor, clientCodeFilter, historicoState])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const calculationSourceRow = selectedRow?.historicoSource || selectedRow || null
  const calculationBaseline = useMemo(
    () => buildCalculationDraft(calculationSourceRow),
    [calculationSourceRow],
  )
  const calculationDraftInvalid = useMemo(
    () => CALCULATION_FIELDS.some((field) => isCalculationDraftValueInvalid(calculationDraft?.[field.key])),
    [calculationDraft],
  )
  const calculationDirty = useMemo(() => {
    if (!calculationBaseline || !calculationDraft) return false
    return CALCULATION_FIELDS.some((field) => {
      const currentValue = String(calculationDraft?.[field.key] ?? '').trim()
      const baselineValue = String(calculationBaseline?.[field.key] ?? '').trim()
      return currentValue !== baselineValue
    })
  }, [calculationBaseline, calculationDraft])
  const calculationPreview = useMemo(() => {
    if (!calculationSourceRow) return null
    const parsedDraft = parseCalculationDraft(calculationDraft || calculationBaseline || {})
    const spotChanged = String(calculationDraft?.spot ?? '').trim() !== String(calculationBaseline?.spot ?? '').trim()
    const vendaAtivoMercadoChanged = String(calculationDraft?.vendaAtivoMercado ?? '').trim() !== String(calculationBaseline?.vendaAtivoMercado ?? '').trim()
    return recalculateHistoricalWorkbookValues(calculationSourceRow, parsedDraft.spot, {
      ...parsedDraft,
      manualVendaAtivoMercado: vendaAtivoMercadoChanged,
      spotSource: spotChanged ? 'manual' : calculationSourceRow.spotSource || 'planilha',
    })
  }, [calculationBaseline, calculationDraft, calculationSourceRow])
  const previewRow = useMemo(() => {
    if (!selectedRow) return null
    if (!calculationPreview) return selectedRow
    return adaptRowForModal(
      decorateHistoricalDisplayRow(calculationPreview, { tagsIndex, todayKey }),
    )
  }, [calculationPreview, selectedRow, tagsIndex, todayKey])

  useEffect(() => {
    setCalculationDraft(calculationBaseline)
  }, [calculationBaseline])

  const handleFilterChange = useCallback((key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleClearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS)
  }, [])

  const handleCalculationDraftChange = useCallback((key, value) => {
    setCalculationDraft((prev) => ({
      ...(prev || {}),
      [key]: value,
    }))
  }, [])

  const handleResetCalculation = useCallback(() => {
    setCalculationDraft(calculationBaseline)
  }, [calculationBaseline])

  const handleApplyCalculation = useCallback(() => {
    if (!calculationSourceRow || !calculationPreview || calculationDraftInvalid) return
    const updated = updateHistoricoRow(calculationSourceRow.id, calculationPreview)
    if (!updated?.row || !updated?.state) {
      notify('Nao foi possivel atualizar o calculo da operacao.', 'warning')
      return
    }
    setHistoricoState(updated.state)
    const nextSelectedRow = adaptRowForModal(
      decorateHistoricalDisplayRow(updated.row, { tagsIndex, todayKey }),
    )
    setSelectedRow(nextSelectedRow)
    notify('Calculo da operacao atualizado.', 'success')
  }, [calculationDraftInvalid, calculationPreview, calculationSourceRow, notify, tagsIndex, todayKey])

  const columns = useMemo(() => ([
    { key: 'codigoCliente', label: 'Conta', render: (row) => row.codigoCliente || '-' },
    { key: 'assessor', label: 'Assessor', render: (row) => row.assessor || '-' },
    { key: 'broker', label: 'Broker', render: (row) => row.broker || '-' },
    { key: 'ativo', label: 'Ativo', render: (row) => row.ativo || '-' },
    { key: 'estrutura', label: 'Estrutura', render: (row) => row.estrutura || '-' },
    { key: 'competencia', label: 'Competência', render: (row) => row.competenciaLabel },
    { key: 'vencimento', label: 'Vencimento', render: (row) => row.dataVencimentoLabel },
    {
      key: 'spot',
      label: 'Spot vencimento',
      render: (row) => (
        <div className="cell-stack">
          <strong>{row.spotLabel}</strong>
          <small>{row.spotSourceLabel}</small>
        </div>
      ),
    },
    {
      key: 'financeiroFinal',
      label: 'Financeiro final',
      render: (row) => (
        <strong className={row.financeiroFinal >= 0 ? 'text-positive' : 'text-negative'}>
          {formatCurrency(row.financeiroFinal)}
        </strong>
      ),
    },
    {
      key: 'ganhoPrejuizo',
      label: 'Ganho / Prejuízo',
      render: (row) => (
        <strong className={row.ganhoPrejuizo >= 0 ? 'text-positive' : 'text-negative'}>
          {formatCurrency(row.ganhoPrejuizo)}
        </strong>
      ),
    },
    {
      key: 'lucroPercentual',
      label: 'Lucro %',
      render: (row) => (
        <strong className={row.lucroPercentual >= 0 ? 'text-positive' : 'text-negative'}>
          {`${(row.lucroPercentual * 100).toFixed(2)}%`}
        </strong>
      ),
    },
    {
      key: 'origin',
      label: 'Origem',
      render: (row) => <Badge tone={row.originTone}>{row.originLabel}</Badge>,
    },
  ]), [])

  const batchColumns = useMemo(() => ([
    { key: 'monthLabel', label: 'Competência', render: (row) => row.monthLabel || '-' },
    { key: 'origin', label: 'Origem', render: (row) => row.origin || '-' },
    { key: 'rows', label: 'Operações', render: (row) => formatNumber(row.rows) },
    { key: 'pushedAt', label: 'Atualizado em', render: (row) => row.pushedAt ? formatDate(row.pushedAt) : '-' },
  ]), [])

  const reportExtraContent = selectedRow ? (
    <div className="report-grid">
      <div className="report-card">
        <div>
          <h4>Editar calculo</h4>
          <p className="muted">Ajuste os campos da composicao do resultado e salve para persistir no historico.</p>
        </div>
        <div className="form-grid">
          {CALCULATION_FIELDS.map((field) => {
            const invalid = isCalculationDraftValueInvalid(calculationDraft?.[field.key])
            return (
              <label key={field.key}>
                <span>{field.label}</span>
                <input
                  className="input"
                  type="text"
                  inputMode={field.inputMode}
                  value={calculationDraft?.[field.key] ?? ''}
                  onChange={(event) => handleCalculationDraftChange(field.key, event.target.value)}
                  aria-invalid={invalid}
                  placeholder="0"
                />
                {invalid ? <small className="text-negative">Numero invalido.</small> : null}
              </label>
            )
          })}
        </div>
        <div className="modal-actions">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={handleResetCalculation}
            disabled={!calculationDirty}
          >
            Reverter
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={handleApplyCalculation}
            disabled={!calculationDirty || calculationDraftInvalid}
          >
            Salvar resultado
          </button>
        </div>
      </div>
      <div className="report-card">
        <div>
          <h4>Previa do resultado</h4>
          <p className="muted">Os valores abaixo seguem a mesma regra usada no consolidado do historico.</p>
        </div>
        <div className="report-list">
          <div>
            <span>Spot final</span>
            <strong>{Number.isFinite(Number(calculationPreview?.spot)) ? formatNumber(calculationPreview?.spot) : '-'}</strong>
          </div>
          <div>
            <span>Quantidade</span>
            <strong>{Number.isFinite(Number(calculationPreview?.quantidade)) ? formatNumber(calculationPreview?.quantidade) : '-'}</strong>
          </div>
          <div>
            <span>Ganho na put</span>
            <strong className={Number(calculationPreview?.ganhoPut || 0) >= 0 ? 'text-positive' : 'text-negative'}>
              {formatCurrency(calculationPreview?.ganhoPut || 0)}
            </strong>
          </div>
          <div>
            <span>Ganho na call</span>
            <strong className={Number(calculationPreview?.ganhoCall || 0) >= 0 ? 'text-positive' : 'text-negative'}>
              {formatCurrency(calculationPreview?.ganhoCall || 0)}
            </strong>
          </div>
          <div>
            <span>Ganhos nas opcoes</span>
            <strong className={Number(calculationPreview?.ganhosOpcoes || 0) >= 0 ? 'text-positive' : 'text-negative'}>
              {formatCurrency(calculationPreview?.ganhosOpcoes || 0)}
            </strong>
          </div>
          <div>
            <span>Financeiro final</span>
            <strong className={Number(calculationPreview?.financeiroFinal || 0) >= 0 ? 'text-positive' : 'text-negative'}>
              {formatCurrency(calculationPreview?.financeiroFinal || 0)}
            </strong>
          </div>
          <div>
            <span>Resultado</span>
            <strong className={Number(calculationPreview?.ganhoPrejuizo || 0) >= 0 ? 'text-positive' : 'text-negative'}>
              {formatCurrency(calculationPreview?.ganhoPrejuizo || 0)}
            </strong>
          </div>
          <div>
            <span>Lucro %</span>
            <strong className={Number(calculationPreview?.lucroPercentual || 0) >= 0 ? 'text-positive' : 'text-negative'}>
              {`${(Number(calculationPreview?.lucroPercentual || 0) * 100).toFixed(2)}%`}
            </strong>
          </div>
          <div>
            <span>Spot source</span>
            <strong>{previewRow?.spotSourceLabel || '-'}</strong>
          </div>
        </div>
      </div>
    </div>
  ) : null

  return (
    <div className="page">
      <PageHeader
        title="Historico de operacoes"
        subtitle="Consolidado mensal das operacoes vencidas, com lotes enviados por Vencimento e reprocesso do legado pelo fechamento do vencimento."
        meta={[
          { label: 'Operacoes encerradas', value: formatNumber(kpis.total) },
          { label: 'Financeiro final', value: formatCurrency(kpis.financeiroFinal) },
          { label: 'Ganho / prejuizo', value: formatCurrency(kpis.ganhoPrejuizo) },
          { label: '% positivas', value: `${kpis.positivosPct.toFixed(1)}%` },
          { label: 'Clientes unicos', value: formatNumber(kpis.clientes) },
        ]}
        actions={[
          {
            label: isImporting ? 'Importando...' : 'Importar Excel',
            icon: 'upload',
            onClick: () => fileInputRef.current?.click(),
            disabled: isImporting,
          },
          {
            label: isRefreshingClose ? 'Reprocessando...' : 'Reprocessar spot de vencimento',
            icon: 'sync',
            variant: 'btn-secondary',
            onClick: () => {
              void handleRefreshClose()
            },
            disabled: isRefreshingClose || !historicoState.legacyRows.length,
          },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Importacao do historico</h3>
            <p className="muted">O Excel legado alimenta apenas os meses sem push do Vencimento. Lotes mensais enviados sobrescrevem a competência correspondente.</p>
          </div>
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
              <Icon name="upload" size={16} />
              {isImporting ? 'Importando...' : 'Selecionar planilha'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={(event) => {
                void handleFileChange(event)
              }}
              hidden
            />
          </div>
        </div>

        <div className="sync-folder-filter">
          <label className="sync-folder-filter-field">
            <span>Arquivo importado</span>
            <select
              className="input"
              value={globalFolderMenu.directoryValue || ''}
              onChange={(event) => globalFolderMenu.onDirectoryChange(event.target.value)}
              disabled={!globalDirectoryOptions.length || globalFolderMenu.loading || isImporting}
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
            onClick={() => {
              void handleUseGlobalFolder()
            }}
            disabled={!globalDirectoryOptions.length || globalFolderMenu.loading || isImporting}
          >
            {isImporting ? 'Importando...' : 'Usar arquivo importado'}
          </button>
          {globalDirectoryEmptyMessage ? <div className="muted">{globalDirectoryEmptyMessage}</div> : null}
        </div>

        <div className="sync-result">
          <div>
            <strong>{historicoState.importMeta.fileName || 'Nenhum arquivo'}</strong>
            <span className="muted">Arquivo legado</span>
          </div>
          <div>
            <strong>{formatNumber(historicoState.legacyRows.length)}</strong>
            <span className="muted">Linhas legadas</span>
          </div>
          <div>
            <strong>{formatNumber(Object.keys(historicoState.monthlyBatches || {}).length)}</strong>
            <span className="muted">Lotes mensais ativos</span>
          </div>
          <div>
            <strong>{historicoState.importMeta.importedAt ? formatDate(historicoState.importMeta.importedAt) : '-'}</strong>
            <span className="muted">Ultima importacao</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Lotes mensais</h3>
            <p className="muted">Resumo das competências atualmente ativas no consolidado.</p>
          </div>
        </div>
        <DataTable rows={batchSummaryRows} columns={batchColumns} emptyMessage="Nenhum lote mensal consolidado." visibleRows={6} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Filtros</h3>
            <p className="muted">Recorte das operações encerradas e dos agrupamentos.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar conta, assessor, broker ou ativo..."
                value={filters.search}
                onChange={(event) => handleFilterChange('search', event.target.value)}
              />
            </div>
            <button className="btn btn-secondary" type="button" onClick={handleClearFilters}>
              Limpar filtros
            </button>
          </div>
        </div>

        <div className="filter-grid">
          <MultiSelect
            value={clientCodeFilter}
            options={options.cliente}
            onChange={setClientCodeFilter}
            placeholder="Conta"
            searchable
          />
          <MultiSelect value={filters.competencia} options={options.competencia} onChange={(value) => handleFilterChange('competencia', value)} placeholder="Competência" />
          <MultiSelect value={filters.estrutura} options={options.estrutura} onChange={(value) => handleFilterChange('estrutura', value)} placeholder="Estrutura" />
          <MultiSelect value={filters.assessor} options={options.assessor} onChange={(value) => handleFilterChange('assessor', value)} placeholder="Assessor" />
          <MultiSelect value={filters.broker} options={options.broker} onChange={(value) => handleFilterChange('broker', value)} placeholder="Broker" />
          <MultiSelect value={filters.ativo} options={options.ativo} onChange={(value) => handleFilterChange('ativo', value)} placeholder="Ativo" />
          <MultiSelect value={filters.vencimento} options={options.vencimento} onChange={(value) => handleFilterChange('vencimento', value)} placeholder="Vencimento" />
          <MultiSelect value={filters.resultado} options={RESULTADO_OPTIONS} onChange={(value) => handleFilterChange('resultado', value)} placeholder="Resultado" />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Tabela de historico</h3>
            <p className="muted">
              {filteredRows.length === globallyFilteredRows.length
                ? `${formatNumber(filteredRows.length)} operacoes encerradas no recorte atual. Mostrando ${formatNumber(filteredRows.length ? pageStart + 1 : 0)}-${formatNumber(pageEnd)}.`
                : `${formatNumber(filteredRows.length)} de ${formatNumber(globallyFilteredRows.length)} operacoes apos filtros. Mostrando ${formatNumber(filteredRows.length ? pageStart + 1 : 0)}-${formatNumber(pageEnd)}.`}
            </p>
          </div>
        </div>
        <DataTable rows={pagedRows} columns={columns} emptyMessage="Sem operacoes encerradas para exibir." onRowClick={(row) => setSelectedRow(adaptRowForModal(row))} />
        {totalPages > 1 ? (
          <div className="table-pagination">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={safePage <= 1}
            >
              Anterior
            </button>
            <span className="muted">Pagina {safePage} de {totalPages}</span>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={safePage >= totalPages}
            >
              Proxima
            </button>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Métricas consolidadas</h3>
            <p className="muted">Agrupamentos do recorte atual por broker, assessor, estrutura e cliente.</p>
          </div>
        </div>

        <div className="historico-summary-grid">
          <div className="historico-summary-card">
            <h4>Por broker</h4>
            <DataTable rows={groupedMetrics.broker} columns={buildMetricColumns('Broker')} emptyMessage="Sem brokers no recorte." visibleRows={7} />
          </div>
          <div className="historico-summary-card">
            <h4>Por assessor</h4>
            <DataTable rows={groupedMetrics.assessor} columns={buildMetricColumns('Assessor')} emptyMessage="Sem assessores no recorte." visibleRows={7} />
          </div>
          <div className="historico-summary-card">
            <h4>Por estrutura</h4>
            <DataTable rows={groupedMetrics.estrutura} columns={buildMetricColumns('Estrutura')} emptyMessage="Sem estruturas no recorte." visibleRows={7} />
          </div>
          <div className="historico-summary-card">
            <h4>Por cliente</h4>
            <DataTable rows={groupedMetrics.cliente} columns={buildMetricColumns('Conta')} emptyMessage="Sem clientes no recorte." visibleRows={7} />
          </div>
        </div>
      </section>
      <ReportModal
        open={Boolean(selectedRow)}
        row={previewRow}
        onClose={() => setSelectedRow(null)}
        extraContent={reportExtraContent}
      />
    </div>
  )
}

export default HistoricoOperacoes
