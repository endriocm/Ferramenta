import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import MultiSelect from '../components/MultiSelect'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { useToast } from '../hooks/useToast'
import useImportedFileBinding from '../hooks/useImportedFileBinding'
import { loadStructuredRevenue, saveStructuredRevenue } from '../services/revenueStructured'
import { readImportedFileAsArrayBuffer } from '../services/importCatalog'
import { loadManualRevenueByOrigin } from '../services/revenueStore'
import { parseStructuredReceitasFile } from '../services/revenueImport'
import { enrichRow } from '../services/tags'
import { getTagIndex } from '../lib/tagsStore'
import { getCurrentUserKey } from '../services/currentUser'
import { normalizeDateKey } from '../utils/dateKey'
import { formatDate, formatNumber } from '../utils/format'
import { buildMultiOptions } from '../utils/spreadsheet'

const MONTH_WINDOW_SIZE = 6
const PAGE_SIZE = 100
const STATUS_ALL = 'all'
const STATUS_ACTIVE = 'active'
const STATUS_INACTIVE = 'inactive'
const CLIENTES_OPERANDO_STATE_VERSION = 1
const CLIENTES_OPERANDO_STATE_PREFIX = 'pwr.clientes-operando.state'
const DEFAULT_SORT_BY = 'mesesAtivos'
const DEFAULT_SORT_DIRECTION = 'desc'
const VALID_SORT_DIRECTIONS = new Set(['asc', 'desc'])

const SORT_OPTIONS = [
  { value: 'mesesAtivos', label: 'Pontuacao 6M' },
  { value: 'codigoCliente', label: 'Conta' },
  { value: 'broker', label: 'Broker' },
  { value: 'assessor', label: 'Assessor' },
  { value: 'ultimaOperacao', label: 'Ultima operacao' },
]

const normalizeText = (value) => String(value || '').trim()

const normalizeSearchToken = (value) => normalizeText(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const buildMonthKey = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const buildMonthLabel = (monthKey) => {
  const [year, month] = String(monthKey || '').split('-').map(Number)
  if (!year || !month) return monthKey
  const monthText = new Date(year, month - 1, 1)
    .toLocaleDateString('pt-BR', { month: 'short' })
    .replace('.', '')
    .toUpperCase()
  return `${monthText}/${String(year).slice(-2)}`
}

const buildMonthWindow = (size = MONTH_WINDOW_SIZE, baseDate = new Date()) => {
  const normalizedSize = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : MONTH_WINDOW_SIZE
  const months = []
  for (let offset = normalizedSize - 1; offset >= 0; offset -= 1) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth() - offset, 1)
    const key = buildMonthKey(date)
    months.push({ key, label: buildMonthLabel(key) })
  }
  return months
}

const loadStructuredActivityEntries = () => [
  ...loadStructuredRevenue(),
  ...loadManualRevenueByOrigin('estruturadas'),
]

const clearableFilters = {
  search: '',
  broker: [],
  assessor: [],
  score: [],
  status: STATUS_ALL,
}

const resolveStorageKey = () => {
  const userKey = String(getCurrentUserKey() || 'guest').trim() || 'guest'
  return `${CLIENTES_OPERANDO_STATE_PREFIX}.${userKey}`
}

const normalizePersistedFilters = (filters) => {
  if (!filters || typeof filters !== 'object') return { ...clearableFilters }
  return {
    search: normalizeText(filters.search),
    broker: Array.isArray(filters.broker) ? filters.broker.map((value) => normalizeText(value)).filter(Boolean) : [],
    assessor: Array.isArray(filters.assessor) ? filters.assessor.map((value) => normalizeText(value)).filter(Boolean) : [],
    score: Array.isArray(filters.score)
      ? filters.score.map((value) => normalizeText(value)).filter(Boolean)
      : [],
    status: [STATUS_ALL, STATUS_ACTIVE, STATUS_INACTIVE].includes(filters.status) ? filters.status : STATUS_ALL,
  }
}

const normalizeUploadSummary = (summary) => {
  if (!summary || typeof summary !== 'object') return null
  const importedCount = Number(summary.importedCount)
  const rejectedCount = Number(summary.rejectedCount)
  const duplicateCount = Number(summary.duplicateCount)
  const months = Array.isArray(summary.months)
    ? summary.months.map((month) => normalizeText(month)).filter(Boolean)
    : []
  return {
    importedCount: Number.isFinite(importedCount) ? importedCount : 0,
    rejectedCount: Number.isFinite(rejectedCount) ? rejectedCount : 0,
    duplicateCount: Number.isFinite(duplicateCount) ? duplicateCount : 0,
    months,
  }
}

const normalizeSortBy = (value) => {
  const normalized = normalizeText(value)
  const match = SORT_OPTIONS.find((option) => option.value === normalized)
  return match ? match.value : DEFAULT_SORT_BY
}

const normalizeSortDirection = (value) => {
  const normalized = normalizeText(value).toLowerCase()
  return VALID_SORT_DIRECTIONS.has(normalized) ? normalized : DEFAULT_SORT_DIRECTION
}

const resolveInitialClientesOperandoState = () => {
  const storageKey = resolveStorageKey()
  const fallback = {
    storageKey,
    filters: { ...clearableFilters },
    uploadSummary: null,
    sortBy: DEFAULT_SORT_BY,
    sortDirection: DEFAULT_SORT_DIRECTION,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      storageKey,
      filters: normalizePersistedFilters(parsed.filters),
      uploadSummary: normalizeUploadSummary(parsed.uploadSummary),
      sortBy: normalizeSortBy(parsed.sortBy),
      sortDirection: normalizeSortDirection(parsed.sortDirection),
    }
  } catch {
    return fallback
  }
}

const ClientesOperando = () => {
  const { notify } = useToast()
  const importBinding = useImportedFileBinding('clientes-operando')
  const initialPersistedState = useMemo(() => resolveInitialClientesOperandoState(), [])
  const [storageKey] = useState(() => initialPersistedState.storageKey)
  const {
    selectedBroker,
    selectedAssessor,
    clientCodeFilter,
    tagsIndex,
  } = useGlobalFilters()
  const [filters, setFilters] = useState(() => initialPersistedState.filters)
  const [entries, setEntries] = useState(() => loadStructuredActivityEntries())
  const [uploading, setUploading] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [uploadSummary, setUploadSummary] = useState(() => initialPersistedState.uploadSummary)
  const [sortBy, setSortBy] = useState(() => initialPersistedState.sortBy)
  const [sortDirection, setSortDirection] = useState(() => initialPersistedState.sortDirection)
  const [page, setPage] = useState(1)
  const didMountRef = useRef(false)

  useEffect(() => {
    const handleReceitaUpdated = () => setEntries(loadStructuredActivityEntries())
    window.addEventListener('pwr:receita-updated', handleReceitaUpdated)
    return () => window.removeEventListener('pwr:receita-updated', handleReceitaUpdated)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const payload = {
      version: CLIENTES_OPERANDO_STATE_VERSION,
      filters: normalizePersistedFilters(filters),
      uploadSummary: normalizeUploadSummary(uploadSummary),
      sortBy: normalizeSortBy(sortBy),
      sortDirection: normalizeSortDirection(sortDirection),
      updatedAt: new Date().toISOString(),
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(payload))
    } catch {
      // ignore local persistence failures
    }
  }, [filters, sortBy, sortDirection, storageKey, uploadSummary])

  const monthWindow = useMemo(() => buildMonthWindow(MONTH_WINDOW_SIZE), [])
  const monthKeySet = useMemo(() => new Set(monthWindow.map((item) => item.key)), [monthWindow])
  const currentMonthKey = monthWindow[monthWindow.length - 1]?.key || ''
  const periodLabel = useMemo(() => {
    if (!monthWindow.length) return '-'
    const first = monthWindow[0].label
    const last = monthWindow[monthWindow.length - 1].label
    return `${first} a ${last}`
  }, [monthWindow])

  const enrichedEntries = useMemo(
    () => entries.map((entry) => enrichRow(entry, tagsIndex)),
    [entries, tagsIndex],
  )

  const activityRows = useMemo(() => {
    const byClient = new Map()

    enrichedEntries.forEach((entry) => {
      const dateKey = normalizeDateKey(entry?.dataEntrada || entry?.data)
      if (!dateKey) return
      const monthKey = dateKey.slice(0, 7)
      if (!monthKeySet.has(monthKey)) return

      const codigoCliente = normalizeText(entry?.codigoCliente || entry?.conta || entry?.clienteCodigo)
      const broker = normalizeText(entry?.broker) || '--'
      const assessor = normalizeText(entry?.assessor) || 'Sem assessor'

      if (!codigoCliente) return

      const rowId = codigoCliente
      if (!rowId) return

      let current = byClient.get(rowId)
      if (!current) {
        current = {
          id: rowId,
          codigoCliente: codigoCliente || '--',
          broker,
          assessor,
          monthMap: {},
          monthSet: new Set(),
          totalOperacoes: 0,
          lastOperationDate: '',
          operouMesAtual: false,
        }
        byClient.set(rowId, current)
      }

      if (codigoCliente && (!current.codigoCliente || current.codigoCliente === '--')) current.codigoCliente = codigoCliente
      if (broker && current.broker === '--') current.broker = broker
      if (assessor && current.assessor === 'Sem assessor') current.assessor = assessor

      current.monthSet.add(monthKey)
      current.monthMap[monthKey] = true
      current.totalOperacoes += 1
      if (monthKey === currentMonthKey) current.operouMesAtual = true
      if (dateKey > current.lastOperationDate) current.lastOperationDate = dateKey
    })

    return Array.from(byClient.values())
      .map((row) => ({
        ...row,
        operouUltimos6Meses: row.monthSet.size > 0,
        mesesAtivos: row.monthSet.size,
      }))
      .sort((left, right) => {
        if (left.operouMesAtual !== right.operouMesAtual) return left.operouMesAtual ? -1 : 1
        if (left.mesesAtivos !== right.mesesAtivos) return right.mesesAtivos - left.mesesAtivos
        return (left.codigoCliente || '').localeCompare(right.codigoCliente || '', 'pt-BR')
      })
  }, [currentMonthKey, enrichedEntries, monthKeySet])

  const brokerOptions = useMemo(
    () => buildMultiOptions(activityRows.map((row) => row.broker)),
    [activityRows],
  )

  const assessorOptions = useMemo(
    () => buildMultiOptions(activityRows.map((row) => row.assessor)),
    [activityRows],
  )

  const scoreOptions = useMemo(
    () => Array.from({ length: monthWindow.length }, (_, index) => {
      const score = index + 1
      const label = score === 1 ? '1 ponto (1 mes)' : `${score} pontos (${score} meses)`
      return { value: String(score), label }
    }),
    [monthWindow.length],
  )

  const filteredRows = useMemo(() => {
    const query = normalizeSearchToken(filters.search)
    return activityRows.filter((row) => {
      if (query) {
        const haystack = normalizeSearchToken([
          row.codigoCliente,
          row.assessor,
          row.broker,
        ].join(' '))
        if (!haystack.includes(query)) return false
      }

      if (selectedBroker.length && !selectedBroker.includes(row.broker)) return false
      if (selectedAssessor.length && !selectedAssessor.includes(row.assessor)) return false
      if (clientCodeFilter.length && !clientCodeFilter.includes(row.codigoCliente)) return false

      if (filters.broker.length && !filters.broker.includes(row.broker)) return false
      if (filters.assessor.length && !filters.assessor.includes(row.assessor)) return false
      if (filters.score.length && !filters.score.includes(String(row.mesesAtivos))) return false
      if (filters.status === STATUS_ACTIVE && !row.operouMesAtual) return false
      if (filters.status === STATUS_INACTIVE && row.operouMesAtual) return false
      return true
    })
  }, [
    activityRows,
    clientCodeFilter,
    filters.assessor,
    filters.broker,
    filters.score,
    filters.search,
    filters.status,
    selectedAssessor,
    selectedBroker,
  ])

  const resolvedSortBy = useMemo(() => normalizeSortBy(sortBy), [sortBy])
  const resolvedSortDirection = useMemo(() => normalizeSortDirection(sortDirection), [sortDirection])

  const sortedRows = useMemo(() => {
    const compareText = (left, right) => String(left || '').localeCompare(String(right || ''), 'pt-BR')

    const compareValues = (left, right) => {
      switch (resolvedSortBy) {
        case 'mesesAtivos': {
          const leftNumber = Number(left?.mesesAtivos || 0)
          const rightNumber = Number(right?.mesesAtivos || 0)
          return leftNumber - rightNumber
        }
        case 'ultimaOperacao': {
          return compareText(left?.lastOperationDate || '', right?.lastOperationDate || '')
        }
        case 'codigoCliente': {
          return compareText(left?.codigoCliente || '', right?.codigoCliente || '')
        }
        case 'broker': {
          return compareText(left?.broker || '', right?.broker || '')
        }
        case 'assessor': {
          return compareText(left?.assessor || '', right?.assessor || '')
        }
        default: {
          return compareText(left?.codigoCliente || '', right?.codigoCliente || '')
        }
      }
    }

    const sorted = [...filteredRows].sort((left, right) => {
      const comparison = compareValues(left, right)
      if (comparison !== 0) return resolvedSortDirection === 'asc' ? comparison : -comparison
      return compareText(left?.codigoCliente || '', right?.codigoCliente || '')
    })
    return sorted
  }, [filteredRows, resolvedSortBy, resolvedSortDirection])

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE)),
    [sortedRows.length],
  )
  const pageStart = (page - 1) * PAGE_SIZE
  const pagedRows = useMemo(
    () => sortedRows.slice(pageStart, pageStart + PAGE_SIZE),
    [sortedRows, pageStart],
  )

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    setPage(1)
  }, [
    filters.search,
    filters.status,
    filters.broker,
    filters.assessor,
    filters.score,
    resolvedSortBy,
    resolvedSortDirection,
    selectedBroker,
    selectedAssessor,
    clientCodeFilter,
    entries.length,
  ])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const kpis = useMemo(() => {
    const totalClientes = activityRows.length
    const clientesMesAtual = activityRows.filter((row) => row.operouMesAtual).length
    const clientesSemMesAtual = Math.max(0, totalClientes - clientesMesAtual)
    return {
      totalClientes,
      clientesMesAtual,
      clientesSemMesAtual,
      clientesFiltrados: sortedRows.length,
    }
  }, [activityRows, sortedRows.length])

  const columns = useMemo(() => {
    const fixedColumns = [
      { key: 'codigoCliente', label: 'Conta', width: '130px', render: (row) => row.codigoCliente || '--' },
      { key: 'assessor', label: 'Assessor', width: '170px', render: (row) => row.assessor || '--' },
      { key: 'broker', label: 'Broker', width: '130px', render: (row) => row.broker || '--' },
      {
        key: 'operou6m',
        label: 'Ultimos 6M',
        width: '120px',
        render: (row) => <Badge tone={row.operouUltimos6Meses ? 'green' : 'violet'}>{row.operouUltimos6Meses ? 'SIM' : 'NAO'}</Badge>,
      },
      {
        key: 'operouMesAtual',
        label: 'Mes atual',
        width: '110px',
        render: (row) => <Badge tone={row.operouMesAtual ? 'cyan' : 'amber'}>{row.operouMesAtual ? 'SIM' : 'NAO'}</Badge>,
      },
      {
        key: 'pontuacao',
        label: 'Pontuacao 6M',
        width: '120px',
        render: (row) => formatNumber(row.mesesAtivos || 0),
      },
    ]

    const monthColumns = monthWindow.map((month) => ({
      key: `m-${month.key}`,
      label: month.label,
      width: '88px',
      render: (row) => {
        const active = row.monthMap?.[month.key] === true
        return (
          <span className={`clientes-operando-cell ${active ? 'is-active' : ''}`}>
            {active ? 'X' : ''}
          </span>
        )
      },
    }))

    const tailColumns = [
      {
        key: 'ultimaOperacao',
        label: 'Ultima operacao',
        width: '130px',
        render: (row) => formatDate(row.lastOperationDate),
      },
    ]

    return [...fixedColumns, ...monthColumns, ...tailColumns]
  }, [monthWindow])

  const handleExportXlsx = useCallback(async () => {
    if (isExporting) return
    if (!sortedRows.length) {
      notify('Nenhum cliente para exportar.', 'warning')
      return
    }
    setIsExporting(true)
    try {
      const fixedLabels = ['CONTA', 'ASSESSOR', 'BROKER', 'ÚLTIMOS 6M', 'MÊS ATUAL', 'PONTUAÇÃO 6M']
      const monthLabels = monthWindow.map((m) => m.label)
      const allLabels = [...fixedLabels, ...monthLabels, 'ÚLTIMA OPERAÇÃO']

      const fixedWidths = [14, 18, 14, 12, 12, 14]
      const allWidths = [...fixedWidths, ...monthWindow.map(() => 10), 16]

      const rowsToExport = sortedRows.map((row) => [
        row.codigoCliente || '',
        row.assessor || '',
        row.broker || '',
        row.operouUltimos6Meses ? 'SIM' : 'NÃO',
        row.operouMesAtual ? 'SIM' : 'NÃO',
        row.mesesAtivos || 0,
        ...monthWindow.map((m) => (row.monthMap?.[m.key] ? 'X' : '')),
        formatDate(row.lastOperationDate) || '',
      ])

      const fileDate = new Date().toISOString().slice(0, 10)
      const { exportXlsx } = await import('../services/exportXlsx')
      const result = await exportXlsx({
        fileName: `clientes_operando_${fileDate}.xlsx`,
        sheetName: 'Clientes Operando',
        columns: allLabels,
        rows: rowsToExport,
        useStyles: true,
        columnWidths: allWidths,
        decorateWorksheet: ({ worksheet, XLSX }) => {
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
          const totalRows = rowsToExport.length + 1
          const totalCols = allLabels.length
          for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
            for (let colIndex = 0; colIndex < totalCols; colIndex += 1) {
              const ref = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })
              const cell = worksheet[ref]
              if (!cell) continue
              if (rowIndex === 0) { cell.s = headerStyle; continue }
              cell.s = buildDataStyle(rowIndex % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFD')
            }
          }
          const lastCol = XLSX.utils.encode_col(Math.max(allLabels.length - 1, 0))
          worksheet['!autofilter'] = { ref: `A1:${lastCol}1` }
        },
      })
      if (!result) { notify('Exportacao cancelada.', 'warning'); return }
      notify('Exportacao concluida.', 'success')
    } catch {
      notify('Falha ao exportar o XLSX.', 'warning')
    } finally {
      setIsExporting(false)
    }
  }, [isExporting, notify, sortedRows, monthWindow])

  const handleStructuredImport = async () => {
    if (uploading) return
    let targetFile = importBinding.selectedFile
    if (!targetFile) targetFile = await importBinding.refreshFromCatalog()
    if (!targetFile) {
      notify('Selecione o arquivo de Estruturadas (.xlsx ou .xls).', 'warning')
      return
    }

    const fileName = String(targetFile.fileName || targetFile.name || '').toLowerCase()
    if ((!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls')) || fileName.startsWith('~$')) {
      notify('Arquivo invalido. Use uma planilha .xlsx ou .xls.', 'warning')
      return
    }

    setUploading(true)
    setUploadSummary(null)
    try {
      const tagIndexForImport = await getTagIndex()
      const parseInput = targetFile?.source === 'electron'
        ? (await readImportedFileAsArrayBuffer(targetFile)) || targetFile
        : targetFile
      const result = await parseStructuredReceitasFile(parseInput, { tagIndex: tagIndexForImport })
      if (!result?.ok) {
        const missing = result?.error?.details?.missing?.length
          ? ` Colunas faltando: ${result.error.details.missing.join(', ')}`
          : ''
        notify(`${result?.error?.message || 'Falha ao importar planilha.'}${missing}`, 'warning')
        return
      }

      const importedEntries = Array.isArray(result.entries) ? result.entries : []
      const summary = result.summary || {}
      const stats = summary.stats || {}
      const importedCount = stats.savedRows ?? importedEntries.length
      const rejectedCount = stats.rejectedRows ?? summary.rowsSkipped ?? 0
      const duplicateCount = stats.duplicatedRows ?? 0
      const months = Array.isArray(summary.months) ? summary.months : []

      // A importacao da aba Clientes Operando substitui a base de Estruturadas
      // para que o mapa reflita exatamente o arquivo enviado.
      saveStructuredRevenue(importedEntries)
      setEntries(loadStructuredActivityEntries())
      setUploadSummary({
        importedCount,
        rejectedCount,
        duplicateCount,
        months,
      })
      notify(`Planilha importada com sucesso. ${importedCount} linhas validas.`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar planilha.', 'warning')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Clientes operando"
        subtitle="Mapa de atividade com base no relatorio de Estruturadas, destacando os ultimos 6 meses e o mes atual."
        meta={[
          { label: 'Clientes (6 meses)', value: formatNumber(kpis.totalClientes) },
          { label: 'Operando no mes atual', value: formatNumber(kpis.clientesMesAtual) },
          { label: 'Sem operar no mes atual', value: formatNumber(kpis.clientesSemMesAtual) },
          { label: 'Visiveis no filtro', value: formatNumber(kpis.clientesFiltrados) },
        ]}
        actions={[
          { label: isExporting ? 'Exportando...' : 'Exportar', icon: 'download', variant: 'btn-secondary', onClick: handleExportXlsx, disabled: isExporting || !sortedRows.length },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Mapa de atividade mensal</h3>
            <p className="muted">
              Periodo exibido: {periodLabel}.
              {' '}
              O mapa considera apenas operacoes encontradas nesse intervalo.
            </p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar conta, assessor ou broker"
                value={filters.search}
                onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
              />
            </div>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setFilters(clearableFilters)}
            >
              Limpar filtros
            </button>
          </div>
        </div>

        <div className="filter-grid clientes-operando-filter-grid">
          <label className="clientes-operando-upload-field">
            <span>Arquivo importado de Estruturadas</span>
            <select
              className="input"
              value={importBinding.value || ''}
              onChange={(event) => importBinding.setValue(event.target.value)}
              disabled={!importBinding.options.length || uploading}
            >
              {!importBinding.options.length ? <option value="">Sem arquivos disponiveis</option> : null}
              {importBinding.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <small className="muted">
              {importBinding.options.find((option) => option.value === importBinding.value)?.description
                || importBinding.emptyMessage
                || 'Nenhum arquivo selecionado'}
            </small>
          </label>
          <button
            className="btn btn-secondary clientes-operando-upload-btn"
            type="button"
            onClick={handleStructuredImport}
            disabled={uploading}
          >
            {uploading ? 'Importando...' : 'Subir estruturadas'}
          </button>
          <MultiSelect
            value={filters.broker}
            options={brokerOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, broker: value }))}
            placeholder="Broker"
          />
          <MultiSelect
            value={filters.assessor}
            options={assessorOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, assessor: value }))}
            placeholder="Assessor"
          />
          <MultiSelect
            value={filters.score}
            options={scoreOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, score: value }))}
            placeholder="Pontuacao 6M"
          />
          <label className="clientes-operando-status-field">
            <span>Status no mes atual</span>
            <select
              className="input"
              value={filters.status}
              onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))}
            >
              <option value={STATUS_ALL}>Todos</option>
              <option value={STATUS_ACTIVE}>Operou no mes atual</option>
              <option value={STATUS_INACTIVE}>Nao operou no mes atual</option>
            </select>
          </label>
          <label className="antecipacao-sort-field">
            <span>Ordenar por</span>
            <select
              className="input"
              value={resolvedSortBy}
              onChange={(event) => setSortBy(event.target.value)}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="antecipacao-sort-field">
            <span>Ordem</span>
            <select
              className="input"
              value={resolvedSortDirection}
              onChange={(event) => setSortDirection(event.target.value)}
            >
              <option value="desc">Decrescente</option>
              <option value="asc">Crescente</option>
            </select>
          </label>
        </div>

        {uploadSummary ? (
          <p className="muted clientes-operando-upload-summary">
            Importados: {formatNumber(uploadSummary.importedCount)}
            {' '}• Rejeitados: {formatNumber(uploadSummary.rejectedCount)}
            {' '}• Duplicados: {formatNumber(uploadSummary.duplicateCount)}
            {uploadSummary.months.length ? ` • Meses: ${uploadSummary.months.join(', ')}` : ''}
          </p>
        ) : null}

        <div className="clientes-operando-table-wrap">
          <DataTable
            rows={pagedRows}
            columns={columns}
            emptyMessage="Sem clientes operando para o periodo e filtros selecionados."
          />
        </div>
        <div className="table-footer">
          <div className="table-pagination">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPage((prev) => Math.max(prev - 1, 1))}
              disabled={page <= 1}
            >
              Anterior
            </button>
            <span className="muted">Pagina {page} de {totalPages}</span>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPage((prev) => Math.min(prev + 1, totalPages))}
              disabled={page >= totalPages}
            >
              Proxima
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

export default ClientesOperando
