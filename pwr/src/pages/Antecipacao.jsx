import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import MultiSelect from '../components/MultiSelect'
import PieChart from '../components/PieChart'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { toNumber } from '../utils/number'
import { buildMultiOptions } from '../utils/spreadsheet'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { parseAntecipacaoWorkbook, parseAntecipacaoWorkbookBuffer } from '../services/antecipacaoParser'
import { fetchCdiSnapshot, getDefaultCdiAnnualPct } from '../services/cdi'
import { exportXlsx } from '../services/exportXlsx'
import { getCurrentUserKey } from '../services/currentUser'
import useGlobalFolderMenu from '../hooks/useGlobalFolderMenu'

const DEFAULT_FILTERS = {
  search: '',
  codigoCliente: [],
  estrutura: [],
  assessor: [],
  broker: [],
  vencimento: [],
  tempoNaEstrutura: [],
  statusCdi: [],
  statusSaida: [],
}

const SORT_OPTIONS = [
  { value: 'resultadoBrutoAtualPct', label: 'Resultado Bruto Atual (%)' },
  { value: 'resultadoBrutoAtualBRL', label: 'Resultado Bruto Atual (R$)' },
  { value: 'cdiAcumuladoPct', label: 'CDI acumulado no periodo (%)' },
  { value: 'desembolsoEntradaBRL', label: 'Desembolso na entrada (R$)' },
  { value: 'performanceAtivoBRL', label: 'Performance Ativo (R$)' },
  { value: 'performanceEstruturaBRL', label: 'Performance da Estrutura (R$)' },
  { value: 'valorSaidaAtualBRL', label: 'Valor de saida atual (R$)' },
  { value: 'proventosBRL', label: 'Proventos (R$)' },
  { value: 'tempoMeses', label: 'Tempo na estrutura' },
  { value: 'vencimento', label: 'Vencimento' },
  { value: 'codigoCliente', label: 'Conta' },
  { value: 'estrutura', label: 'Estrutura' },
  { value: 'assessor', label: 'Assessor' },
  { value: 'broker', label: 'Broker' },
  { value: 'statusCdi', label: 'Status CDI' },
  { value: 'statusSaida', label: 'Status de saida' },
]
const PAGE_SIZE = 30

const normalizeText = (value, fallback = '') => {
  const normalized = String(value || '').trim()
  return normalized || fallback
}

const normalizeAssessor = (value) => normalizeText(value, 'Sem assessor')
const normalizeBroker = (value) => normalizeText(value, 'Sem broker')
const normalizeCodigo = (value) => normalizeText(value, 'Sem conta')
const normalizeEstrutura = (value) => normalizeText(value, 'Sem estrutura')

const formatExcelDateLabel = (value) => {
  const key = normalizeDateKey(value)
  if (!key) return 'Sem vencimento'
  const [year, month, day] = key.split('-')
  return `${day}/${month}/${year}`
}

const parsePtBrDateToExcelSerial = (text) => {
  if (!text || typeof text !== 'string') return null
  const parts = text.split('/')
  if (parts.length !== 3) return null
  const day = Number(parts[0])
  const month = Number(parts[1])
  const year = Number(parts[2])
  if (!day || !month || !year || year < 1900) return null
  const excelEpoch = Date.UTC(1899, 11, 30)
  const serial = (Date.UTC(year, month - 1, day) - excelEpoch) / 86400000
  return Number.isFinite(serial) ? serial : null
}

const parseTempoBreakdown = (rawValue) => {
  const raw = String(rawValue || '').trim()
  if (!raw) return null
  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  const yearsRegex = /(-?\d+(?:[.,]\d+)?)\s*(?:ano|anos)\b/g
  const monthsRegex = /(-?\d+(?:[.,]\d+)?)\s*(?:mes|meses)\b/g
  const daysRegex = /(-?\d+(?:[.,]\d+)?)\s*(?:dia|dias)\b/g

  let years = 0
  let months = 0
  let days = 0
  let matched = false

  for (const match of normalized.matchAll(yearsRegex)) {
    const parsed = toNumber(match[1])
    if (Number.isFinite(parsed)) {
      years += parsed
      matched = true
    }
  }
  for (const match of normalized.matchAll(monthsRegex)) {
    const parsed = toNumber(match[1])
    if (Number.isFinite(parsed)) {
      months += parsed
      matched = true
    }
  }
  for (const match of normalized.matchAll(daysRegex)) {
    const parsed = toNumber(match[1])
    if (Number.isFinite(parsed)) {
      days += parsed
      matched = true
    }
  }

  if (!matched) return null
  return { years, months, days }
}

const formatTempoNumber = (value) => {
  const rounded = Math.round(Number(value || 0) * 10) / 10
  const hasDecimal = Math.abs(rounded - Math.trunc(rounded)) > 1e-9
  return rounded.toLocaleString('pt-BR', {
    minimumFractionDigits: hasDecimal ? 1 : 0,
    maximumFractionDigits: 1,
  })
}

const formatTempoNaEstrutura = (rawTempo, tempoMeses) => {
  const parsed = parseTempoBreakdown(rawTempo)
  if (parsed) {
    const daysAsMonths = Math.round(((parsed.days / 30) * 2)) / 2
    const totalMonthsDisplay = (parsed.years * 12) + parsed.months + daysAsMonths

    if (totalMonthsDisplay > 0 && totalMonthsDisplay < 1) return '<1 mes'
    if (parsed.years > 0) {
      const yearsDisplay = totalMonthsDisplay / 12
      return `${formatTempoNumber(yearsDisplay)} anos`
    }
    return `${formatTempoNumber(totalMonthsDisplay)} meses`
  }

  const numericMonths = Number(tempoMeses)
  if (!Number.isFinite(numericMonths) || numericMonths <= 0) return '0 mes'
  if (numericMonths < 1) return '<1 mes'
  if (numericMonths >= 12) return `${formatTempoNumber(numericMonths / 12)} anos`
  return `${formatTempoNumber(numericMonths)} meses`
}

const toPercentLabel = (value, digits = 2) => {
  if (!Number.isFinite(Number(value))) return '0,00%'
  return `${(Number(value) * 100).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
}

const toPercentPointLabel = (value, digits = 2) => {
  if (!Number.isFinite(Number(value))) return '0,00%'
  return `${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
}

const formatPercentPointInput = (value, digits = 2) => {
  if (!Number.isFinite(Number(value))) return ''
  return Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: digits })
}

const pickStatusSaidaTone = (statusSaida) => {
  if (statusSaida === 'Manter') return 'red'
  if (statusSaida === 'Saida') return 'green'
  return 'amber'
}

const pickStatusCdiTone = (statusCdi) => {
  if (statusCdi === 'Acima CDI') return 'green'
  return 'red'
}

const EXPORT_COLOR_POSITIVE = 'FF16A34A'
const EXPORT_COLOR_NEGATIVE = 'FFDC2626'
const EXPORT_COLOR_WARNING = 'FFEAB308'

const ANTECIPACAO_STATE_VERSION = 2
const ANTECIPACAO_STORAGE_PREFIX = 'pwr.antecipacao.state'
const EMPTY_IMPORT_META = {
  fileName: '',
  importedAt: '',
}

/**
 * Migration: version 1 stored resultadoBrutoAtualPct values parsed with a
 * broken heuristic (Math.abs > 1 → divide by 100). This incorrectly shrank
 * values that were already raw decimals from Excel (e.g. 0.4108 → 0.004108).
 * Conversely, values that WERE already in decimal form and > 1 (e.g. 4.108
 * for 410.8%) were also divided, giving wrong results.
 *
 * Now, with version 2, numbers from Excel are ALWAYS treated as raw decimals.
 * Rows loaded from version 1 storage need to be re-imported to get correct
 * values — we simply bump the version so the user sees the correct data once
 * they reimport the spreadsheet. Existing data is kept but marked as v1.
 */
const migrateRows = (rows, fromVersion) => {
  if (!Array.isArray(rows) || !rows.length) return rows
  if (fromVersion >= ANTECIPACAO_STATE_VERSION) return rows
  // No automatic row transformation — the user needs to reimport for
  // the percentage values to be recalculated with the corrected parser.
  return rows
}

const ANTECIPACAO_EXPORT_WIDTHS = [
  16, 26, 12, 18, 16, 32, 14, 20, 22, 14, 16, 20, 20, 20, 16, 22, 22,
]

const resolveAntecipacaoStorageKey = () => {
  const userKey = String(getCurrentUserKey() || 'guest').trim() || 'guest'
  return `${ANTECIPACAO_STORAGE_PREFIX}.${userKey}`
}

const resolveInitialAntecipacaoState = () => {
  const storageKey = resolveAntecipacaoStorageKey()
  if (typeof window === 'undefined') {
    return {
      storageKey,
      rows: [],
      importMeta: EMPTY_IMPORT_META,
    }
  }

  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) {
      return {
        storageKey,
        rows: [],
        importMeta: EMPTY_IMPORT_META,
      }
    }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return {
        storageKey,
        rows: [],
        importMeta: EMPTY_IMPORT_META,
      }
    }
    const persistedVersion = Number(parsed.version) || 1
    const rows = migrateRows(Array.isArray(parsed.rows) ? parsed.rows : [], persistedVersion)
    const metaRaw = (parsed.importMeta && typeof parsed.importMeta === 'object') ? parsed.importMeta : {}
    return {
      storageKey,
      rows,
      importMeta: {
        fileName: String(metaRaw.fileName || ''),
        importedAt: String(metaRaw.importedAt || ''),
      },
    }
  } catch {
    return {
      storageKey,
      rows: [],
      importMeta: EMPTY_IMPORT_META,
    }
  }
}

const normalizeExportToken = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const resolveStatusCdiExportColor = (status) => {
  const token = normalizeExportToken(status)
  if (token.includes('acima')) return EXPORT_COLOR_POSITIVE
  if (token.includes('abaixo')) return EXPORT_COLOR_NEGATIVE
  return null
}

const resolveStatusSaidaExportColor = (status) => {
  const token = normalizeExportToken(status)
  if (token.includes('saida')) return EXPORT_COLOR_POSITIVE
  if (token.includes('manter')) return EXPORT_COLOR_NEGATIVE
  if (token.includes('averiguar')) return EXPORT_COLOR_WARNING
  return null
}

const Antecipacao = () => {
  const { notify } = useToast()
  const globalFolderMenu = useGlobalFolderMenu('antecipacao')
  const fileInputRef = useRef(null)
  const { tagsIndex } = useGlobalFilters()
  const initialPersistedState = useMemo(() => resolveInitialAntecipacaoState(), [])
  const [storageKey] = useState(() => initialPersistedState.storageKey)
  const [rows, setRows] = useState(initialPersistedState.rows)
  const [importMeta, setImportMeta] = useState(initialPersistedState.importMeta)
  const [isImporting, setIsImporting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  const [cdiAnnualInput, setCdiAnnualInput] = useState(() => String(getDefaultCdiAnnualPct()))
  const [cdiMeta, setCdiMeta] = useState({
    source: 'Manual',
    asOf: '',
    stale: false,
    warning: '',
  })
  const [loadingCdi, setLoadingCdi] = useState(true)

  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [sortBy, setSortBy] = useState('resultadoBrutoAtualPct')
  const [sortDirection, setSortDirection] = useState('desc')
  const [page, setPage] = useState(1)
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
    if (typeof window === 'undefined') return
    const payload = {
      version: ANTECIPACAO_STATE_VERSION,
      savedAt: new Date().toISOString(),
      rows,
      importMeta,
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(payload))
    } catch {
      // ignore persistence failures
    }
  }, [importMeta, rows, storageKey])

  const cdiAnnualPct = useMemo(() => {
    const parsed = toNumber(cdiAnnualInput)
    if (Number.isFinite(parsed)) return parsed
    return getDefaultCdiAnnualPct()
  }, [cdiAnnualInput])

  const cdiMonthlyPct = useMemo(() => cdiAnnualPct / 12, [cdiAnnualPct])
  const cdiMonthlyDecimal = useMemo(() => cdiMonthlyPct / 100, [cdiMonthlyPct])

  useEffect(() => {
    let canceled = false
    const loadCdi = async () => {
      setLoadingCdi(true)
      try {
        const snapshot = await fetchCdiSnapshot()
        if (canceled) return
        setCdiAnnualInput(formatPercentPointInput(snapshot.annualPct, 2))
        setCdiMeta({
          source: snapshot.source || 'API CDI',
          asOf: snapshot.asOf || '',
          stale: Boolean(snapshot.stale),
          warning: snapshot.stale
            ? 'CDI em cache local por indisponibilidade momentanea da API.'
            : '',
        })
      } catch {
        if (canceled) return
        setCdiAnnualInput(String(getDefaultCdiAnnualPct()))
        setCdiMeta({
          source: 'Fallback local',
          asOf: '',
          stale: true,
          warning: 'Nao foi possivel carregar CDI automatico. Revise o campo manualmente.',
        })
        notify('Falha ao carregar CDI automatico. Usando valor padrao.', 'warning')
      } finally {
        if (!canceled) setLoadingCdi(false)
      }
    }
    void loadCdi()
    return () => {
      canceled = true
    }
  }, [notify])

  const handleImportClick = useCallback(() => {
    if (isImporting) return
    fileInputRef.current?.click()
  }, [isImporting])

  const handleFileChange = useCallback(async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setIsImporting(true)
    try {
      const parsedRows = await parseAntecipacaoWorkbook(file)
      setRows(parsedRows)
      setImportMeta({
        fileName: file.name,
        importedAt: new Date().toISOString(),
      })
      notify(`Planilha importada com sucesso (${formatNumber(parsedRows.length)} linhas).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar planilha.', 'warning')
    } finally {
      setIsImporting(false)
      event.target.value = ''
    }
  }, [notify])

  const handleUseGlobalFolder = useCallback(async () => {
    setIsImporting(true)
    try {
      const resolved = await globalFolderMenu.refreshFile()
      if (!resolved) {
        notify('Nenhum arquivo importado vinculado para este modulo.', 'warning')
        return
      }

      let parsedRows = []
      let fileName = 'Arquivo global'

      if (resolved?.filePath) {
        if (!window?.electronAPI?.readFile) {
          notify('Leitura de arquivo indisponivel no modo atual.', 'warning')
          return
        }

        const raw = await window.electronAPI.readFile(resolved.filePath)
        const buffer = (() => {
          if (raw instanceof ArrayBuffer) return raw
          if (ArrayBuffer.isView(raw)) {
            return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
          }
          return null
        })()

        if (!buffer) {
          notify('Nao foi possivel ler o arquivo importado.', 'warning')
          return
        }

        parsedRows = await parseAntecipacaoWorkbookBuffer(buffer)
        fileName = resolved.fileName || 'Arquivo global'
      } else if (typeof resolved?.arrayBuffer === 'function') {
        parsedRows = await parseAntecipacaoWorkbook(resolved)
        fileName = resolved.name || 'Arquivo global'
      } else {
        notify('Formato de arquivo global nao suportado.', 'warning')
        return
      }

      setRows(parsedRows)
      setImportMeta({
        fileName,
        importedAt: new Date().toISOString(),
      })
      notify(`Planilha importada com sucesso (${formatNumber(parsedRows.length)} linhas).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar planilha.', 'warning')
    } finally {
      setIsImporting(false)
    }
  }, [globalFolderMenu, notify])

  const handleClearMenuData = useCallback(() => {
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm('Deseja limpar todos os dados da aba Antecipacao?')
      if (!confirmed) return
      try {
        window.localStorage.removeItem(storageKey)
      } catch {
        // noop
      }
    }

    setRows([])
    setImportMeta(EMPTY_IMPORT_META)
    setFilters(DEFAULT_FILTERS)
    setSortBy('resultadoBrutoAtualPct')
    setSortDirection('desc')
    if (fileInputRef.current) fileInputRef.current.value = ''
    notify('Dados da aba Antecipacao limpos.', 'success')
  }, [notify, storageKey])

  const baseRows = useMemo(() => {
    return rows.map((row) => {
      const tagged = enrichRow(row, tagsIndex) || row
      const codigoCliente = normalizeCodigo(tagged.codigoCliente || row.codigoCliente || tagged.cliente)
      const assessor = normalizeAssessor(tagged.assessor || row.assessor)
      const broker = normalizeBroker(tagged.broker || row.broker)
      const estrutura = normalizeEstrutura(tagged.estrutura || row.estrutura)
      const tempoNaEstruturaLabel = formatTempoNaEstrutura(row.tempoNaEstruturaRaw, row.tempoMeses)
      const vencimentoLabel = row.vencimento ? formatDate(row.vencimento) : 'Sem vencimento'
      return {
        ...row,
        codigoCliente,
        assessor,
        broker,
        estrutura,
        tempoNaEstruturaLabel,
        vencimentoLabel,
      }
    })
  }, [rows, tagsIndex])

  const globallyFilteredRows = useMemo(() => {
    return baseRows
  }, [baseRows])

  const rowsWithCdi = useMemo(() => {
    return globallyFilteredRows.map((row) => {
      const tempoMeses = Number.isFinite(Number(row.tempoMeses)) ? Number(row.tempoMeses) : 0
      const resultadoBrutoAtualPct = Number.isFinite(Number(row.resultadoBrutoAtualPct))
        ? Number(row.resultadoBrutoAtualPct)
        : 0
      const cdiAcumuladoPct = cdiMonthlyDecimal * tempoMeses
      const statusCdi = resultadoBrutoAtualPct >= cdiAcumuladoPct ? 'Acima CDI' : 'Abaixo CDI'
      let statusSaida = 'Averiguar'
      if (resultadoBrutoAtualPct < 0) statusSaida = 'Manter'
      else if (resultadoBrutoAtualPct >= cdiAcumuladoPct) statusSaida = 'Saida'
      return {
        ...row,
        cdiAcumuladoPct,
        statusCdi,
        statusSaida,
      }
    })
  }, [cdiMonthlyDecimal, globallyFilteredRows])

  const options = useMemo(() => {
    return {
      codigoCliente: buildMultiOptions(rowsWithCdi.map((row) => row.codigoCliente)),
      estrutura: buildMultiOptions(rowsWithCdi.map((row) => row.estrutura)),
      assessor: buildMultiOptions(rowsWithCdi.map((row) => row.assessor)),
      broker: buildMultiOptions(rowsWithCdi.map((row) => row.broker)),
      vencimento: buildMultiOptions(rowsWithCdi.map((row) => row.vencimentoLabel)),
      tempoNaEstrutura: buildMultiOptions(rowsWithCdi.map((row) => row.tempoNaEstruturaLabel)),
      statusCdi: buildMultiOptions(rowsWithCdi.map((row) => row.statusCdi)),
      statusSaida: buildMultiOptions(rowsWithCdi.map((row) => row.statusSaida)),
    }
  }, [rowsWithCdi])

  const sortedRows = useMemo(() => {
    const getSortValue = (row, key) => {
      switch (key) {
        case 'tempoMeses':
          return Number(row.tempoMeses) || 0
        case 'vencimento': {
          const raw = String(row.vencimento || '').trim()
          const parsed = raw ? Date.parse(raw) : Number.NaN
          return Number.isFinite(parsed) ? parsed : 0
        }
        case 'desembolsoEntradaBRL':
        case 'performanceAtivoBRL':
        case 'performanceEstruturaBRL':
        case 'valorSaidaAtualBRL':
        case 'proventosBRL':
        case 'resultadoBrutoAtualBRL':
        case 'resultadoBrutoAtualPct':
        case 'cdiAcumuladoPct':
          return Number(row[key]) || 0
        default:
          return String(row[key] || '').toLowerCase()
      }
    }

    const sorted = [...rowsWithCdi].sort((a, b) => {
      const left = getSortValue(a, sortBy)
      const right = getSortValue(b, sortBy)
      let comparison = 0
      if (typeof left === 'number' && typeof right === 'number') {
        comparison = left - right
      } else {
        comparison = String(left).localeCompare(String(right), 'pt-BR', { numeric: true })
      }
      if (comparison === 0) return String(a.id || '').localeCompare(String(b.id || ''), 'pt-BR')
      return sortDirection === 'asc' ? comparison : -comparison
    })

    return sorted
  }, [rowsWithCdi, sortBy, sortDirection])

  const filteredRows = useMemo(() => {
    const query = filters.search.trim().toLowerCase()
    return sortedRows
      .filter((row) => {
        if (query) {
          const base = [
            row.codigoCliente,
            row.estrutura,
            row.assessor,
            row.broker,
            row.vencimentoLabel,
            row.tempoNaEstruturaLabel,
            row.statusCdi,
            row.statusSaida,
          ].join(' ').toLowerCase()
          if (!base.includes(query)) return false
        }

        if (filters.codigoCliente.length && !filters.codigoCliente.includes(row.codigoCliente)) return false
        if (filters.estrutura.length && !filters.estrutura.includes(row.estrutura)) return false
        if (filters.assessor.length && !filters.assessor.includes(row.assessor)) return false
        if (filters.broker.length && !filters.broker.includes(row.broker)) return false
        if (filters.vencimento.length && !filters.vencimento.includes(row.vencimentoLabel)) return false
        if (filters.tempoNaEstrutura.length && !filters.tempoNaEstrutura.includes(row.tempoNaEstruturaLabel)) return false
        if (filters.statusCdi.length && !filters.statusCdi.includes(row.statusCdi)) return false
        if (filters.statusSaida.length && !filters.statusSaida.includes(row.statusSaida)) return false
        return true
      })
  }, [filters, sortedRows])

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
  }, [filters, sortBy, sortDirection, rows, cdiAnnualPct, tagsIndex])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const kpis = useMemo(() => {
    const total = filteredRows.length
    const positives = filteredRows.filter((row) => Number(row.resultadoBrutoAtualPct) >= 0).length
    const aboveCdi = filteredRows.filter((row) => row.statusCdi === 'Acima CDI').length
    const saidaCount = filteredRows.filter((row) => row.statusSaida === 'Saida').length
    const totalResultado = filteredRows.reduce((sum, row) => sum + (Number(row.resultadoBrutoAtualBRL) || 0), 0)
    const totalDesembolso = filteredRows.reduce((sum, row) => sum + (Number(row.desembolsoEntradaBRL) || 0), 0)
    return {
      total,
      positives,
      aboveCdi,
      saidaCount,
      totalResultado,
      totalDesembolso,
      positivePct: total ? (positives / total) * 100 : 0,
      aboveCdiPct: total ? (aboveCdi / total) * 100 : 0,
    }
  }, [filteredRows])

  const pieData = useMemo(() => {
    const positiveCount = filteredRows.filter((row) => Number(row.resultadoBrutoAtualPct) >= 0).length
    const negativeCount = filteredRows.filter((row) => Number(row.resultadoBrutoAtualPct) < 0).length
    const items = [
      { label: 'Rentabilidade positiva', value: positiveCount, count: positiveCount, color: '#34f5a4' },
      { label: 'Rentabilidade negativa', value: negativeCount, count: negativeCount, color: '#ff4d6d' },
    ]
    return items.filter((item) => item.value > 0)
  }, [filteredRows])

  const brokerRanking = useMemo(() => {
    const map = new Map()
    filteredRows.forEach((row) => {
      const broker = normalizeBroker(row.broker)
      const resultadoPct = Number(row.resultadoBrutoAtualPct) || 0
      const desembolso = Math.abs(Number(row.desembolsoEntradaBRL) || 0)
      const resultadoBrl = Number(row.resultadoBrutoAtualBRL) || 0
      const current = map.get(broker) || {
        broker,
        count: 0,
        totalDesembolso: 0,
        totalResultadoBrl: 0,
        weightedSum: 0,
        weightedBase: 0,
        simpleSum: 0,
      }
      current.count += 1
      current.totalDesembolso += desembolso
      current.totalResultadoBrl += resultadoBrl
      current.simpleSum += resultadoPct
      if (desembolso > 0) {
        current.weightedSum += resultadoPct * desembolso
        current.weightedBase += desembolso
      }
      map.set(broker, current)
    })

    return Array.from(map.values())
      .map((entry) => {
        const rentabilidadePonderadaPct = entry.weightedBase > 0
          ? entry.weightedSum / entry.weightedBase
          : (entry.count ? entry.simpleSum / entry.count : 0)
        return {
          ...entry,
          rentabilidadePonderadaPct,
        }
      })
      .sort((a, b) => b.rentabilidadePonderadaPct - a.rentabilidadePonderadaPct)
  }, [filteredRows])

  const rankingMaxAbs = useMemo(() => {
    return Math.max(
      1,
      ...brokerRanking.map((item) => Math.abs(item.rentabilidadePonderadaPct)),
    )
  }, [brokerRanking])

  const handleFilterChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const handleClearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS)
  }, [])

  const handleExportXlsx = useCallback(async () => {
    if (!filteredRows.length) {
      notify('Sem dados para exportar no recorte atual.', 'warning')
      return
    }

    setIsExporting(true)
    try {
      const now = new Date()
      const yyyy = now.getFullYear()
      const mm = String(now.getMonth() + 1).padStart(2, '0')
      const dd = String(now.getDate()).padStart(2, '0')
      const hh = String(now.getHours()).padStart(2, '0')
      const min = String(now.getMinutes()).padStart(2, '0')
      const fileName = `antecipacao_${yyyy}-${mm}-${dd}_${hh}${min}.xlsx`

      const headers = [
        'Conta',
        'Estrutura',
        'Ativo',
        'Assessor (tags)',
        'Broker (tags)',
        'Vencimento',
        'Resultado Bruto Atual (%)',
        'Resultado Bruto Atual (R$)',
        'Status CDI',
        'Status de saida',
        'Tempo na estrutura',
        'Desembolso na entrada (R$)',
        'Valor de saida atual (R$)',
        'Proventos (R$)',
        'CDI acumulado periodo (%)',
        'Performance Ativo (R$)',
        'Performance Estrutura (R$)',
      ]

      const rows = filteredRows.map((row) => ([
        row.codigoCliente,
        row.estrutura,
        row.ativo || '',
        row.assessor,
        row.broker,
        formatExcelDateLabel(row.vencimento),
        Number(row.resultadoBrutoAtualPct) || 0,
        Number(row.resultadoBrutoAtualBRL) || 0,
        row.statusCdi,
        row.statusSaida,
        row.tempoNaEstruturaLabel,
        Number(row.desembolsoEntradaBRL) || 0,
        Number(row.valorSaidaAtualBRL) || 0,
        Number(row.proventosBRL) || 0,
        Number(row.cdiAcumuladoPct) || 0,
        Number(row.performanceAtivoBRL) || 0,
        Number(row.performanceEstruturaBRL) || 0,
      ]))

      await exportXlsx({
        fileName,
        sheetName: 'Antecipacao',
        columns: headers,
        rows,
        useStyles: true,
        columnWidths: ANTECIPACAO_EXPORT_WIDTHS,
        decorateWorksheet: ({ worksheet, XLSX, firstDataRowIndex }) => {
          const centerAlignment = { horizontal: 'center', vertical: 'center', wrapText: true }
          const headerStyle = {
            font: { bold: true, color: { rgb: 'FFFFFFFF' } },
            fill: { patternType: 'solid', fgColor: { rgb: 'FF0F172A' } },
            alignment: centerAlignment,
          }
          const baseDataStyle = { alignment: centerAlignment }
          const buildToneStyle = (rgb) => ({
            alignment: centerAlignment,
            font: { bold: true, color: { rgb } },
          })

          const totalRows = rows.length + 1
          const totalCols = headers.length
          for (let r = 0; r < totalRows; r += 1) {
            for (let c = 0; c < totalCols; c += 1) {
              const ref = XLSX.utils.encode_cell({ r, c })
              const cell = worksheet[ref]
              if (!cell) continue
              cell.s = r === 0 ? headerStyle : baseDataStyle
            }
          }

          const currencyColumns = [7, 11, 12, 13, 15, 16]
          const percentColumns = [6, 14]
          const vencimentoColumn = 5
          const currencyFormat = '[$R$-416] #,##0.00'
          const percentFormat = '0.00%'

          for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            const excelRow = firstDataRowIndex + rowIndex

            const vencimentoRef = XLSX.utils.encode_cell({ r: excelRow, c: vencimentoColumn })
            const vencimentoCell = worksheet[vencimentoRef]
            if (vencimentoCell) {
              const serial = parsePtBrDateToExcelSerial(String(vencimentoCell.v || ''))
              if (serial != null) {
                vencimentoCell.t = 'n'
                vencimentoCell.v = serial
                vencimentoCell.z = 'DD/MM/YYYY'
                delete vencimentoCell.w
              }
            }

            currencyColumns.forEach((colIndex) => {
              const ref = XLSX.utils.encode_cell({ r: excelRow, c: colIndex })
              const cell = worksheet[ref]
              if (cell) cell.z = currencyFormat
            })

            percentColumns.forEach((colIndex) => {
              const ref = XLSX.utils.encode_cell({ r: excelRow, c: colIndex })
              const cell = worksheet[ref]
              if (cell) cell.z = percentFormat
            })

            const resultadoBrutoBrl = Number(rows[rowIndex]?.[7]) || 0
            const resultadoBrutoPct = Number(rows[rowIndex]?.[6]) || 0
            const statusCdi = rows[rowIndex]?.[8]
            const statusSaida = rows[rowIndex]?.[9]

            const resultadoBrlRef = XLSX.utils.encode_cell({ r: excelRow, c: 7 })
            const resultadoPctRef = XLSX.utils.encode_cell({ r: excelRow, c: 6 })
            const statusCdiRef = XLSX.utils.encode_cell({ r: excelRow, c: 8 })
            const statusSaidaRef = XLSX.utils.encode_cell({ r: excelRow, c: 9 })

            if (worksheet[resultadoBrlRef]) {
              worksheet[resultadoBrlRef].s = buildToneStyle(
                resultadoBrutoBrl >= 0 ? EXPORT_COLOR_POSITIVE : EXPORT_COLOR_NEGATIVE,
              )
            }
            if (worksheet[resultadoPctRef]) {
              worksheet[resultadoPctRef].s = buildToneStyle(
                resultadoBrutoPct >= 0 ? EXPORT_COLOR_POSITIVE : EXPORT_COLOR_NEGATIVE,
              )
            }

            const statusCdiColor = resolveStatusCdiExportColor(statusCdi)
            if (statusCdiColor && worksheet[statusCdiRef]) {
              worksheet[statusCdiRef].s = buildToneStyle(statusCdiColor)
            }

            const statusSaidaColor = resolveStatusSaidaExportColor(statusSaida)
            if (statusSaidaColor && worksheet[statusSaidaRef]) {
              worksheet[statusSaidaRef].s = buildToneStyle(statusSaidaColor)
            }
          }

          const lastColumnRef = XLSX.utils.encode_col(Math.max(headers.length - 1, 0))
          worksheet['!autofilter'] = { ref: `A1:${lastColumnRef}1` }
        },
      })

      notify(`Excel exportado (${formatNumber(rows.length)} linhas).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao exportar: ${error.message}` : 'Falha ao exportar Excel.', 'warning')
    } finally {
      setIsExporting(false)
    }
  }, [filteredRows, notify])

  const columns = useMemo(() => ([
    { key: 'codigoCliente', label: 'Conta', render: (row) => row.codigoCliente },
    { key: 'estrutura', label: 'Estrutura', render: (row) => row.estrutura },
    { key: 'ativo', label: 'Ativo', render: (row) => row.ativo || '' },
    { key: 'assessor', label: 'Assessor (tags)', render: (row) => row.assessor },
    { key: 'broker', label: 'Broker (tags)', render: (row) => row.broker },
    { key: 'vencimento', label: 'Vencimento', render: (row) => row.vencimentoLabel },
    {
      key: 'resultadoBrutoAtualPct',
      label: 'Resultado Bruto Atual (%)',
      render: (row) => {
        const tone = Number(row.resultadoBrutoAtualPct) >= 0 ? 'text-positive' : 'text-negative'
        return <strong className={tone}>{toPercentLabel(row.resultadoBrutoAtualPct)}</strong>
      },
    },
    { key: 'resultadoBrutoAtualBRL', label: 'Resultado Bruto Atual (R$)', render: (row) => formatCurrency(row.resultadoBrutoAtualBRL) },
    {
      key: 'statusCdi',
      label: 'Status CDI',
      render: (row) => <Badge tone={pickStatusCdiTone(row.statusCdi)}>{row.statusCdi}</Badge>,
    },
    {
      key: 'statusSaida',
      label: 'Status de saida',
      render: (row) => <Badge tone={pickStatusSaidaTone(row.statusSaida)}>{row.statusSaida}</Badge>,
    },
    { key: 'tempoNaEstrutura', label: 'Tempo na estrutura', render: (row) => row.tempoNaEstruturaLabel },
    { key: 'desembolsoEntradaBRL', label: 'Desembolso na entrada (R$)', render: (row) => formatCurrency(row.desembolsoEntradaBRL) },
    { key: 'valorSaidaAtualBRL', label: 'Valor de saida atual (R$)', render: (row) => formatCurrency(row.valorSaidaAtualBRL) },
    { key: 'proventosBRL', label: 'Proventos (R$)', render: (row) => formatCurrency(row.proventosBRL) },
    { key: 'cdiAcumuladoPct', label: 'CDI acumulado periodo (%)', render: (row) => toPercentLabel(row.cdiAcumuladoPct) },
    { key: 'performanceAtivoBRL', label: 'Performance Ativo (R$)', render: (row) => formatCurrency(row.performanceAtivoBRL) },
    { key: 'performanceEstruturaBRL', label: 'Performance Estrutura (R$)', render: (row) => formatCurrency(row.performanceEstruturaBRL) },
  ]), [])

  return (
    <div className="page">
      <PageHeader
        title="Antecipacao"
        subtitle="Analise de estruturas com comparativo de rentabilidade vs CDI."
        meta={[
          { label: 'Estruturas (filtro atual)', value: formatNumber(kpis.total) },
          { label: '% positivas', value: `${kpis.positivePct.toFixed(1)}%` },
          { label: '% acima CDI', value: `${kpis.aboveCdiPct.toFixed(1)}%` },
          { label: 'CDI anual', value: toPercentPointLabel(cdiAnnualPct, 2) },
        ]}
        actions={[
          {
            label: isImporting ? 'Importando...' : 'Importar Excel',
            icon: 'upload',
            onClick: handleImportClick,
            disabled: isImporting,
          },
          {
            label: isExporting ? 'Exportando...' : 'Exportar Excel',
            icon: 'download',
            variant: 'btn-secondary',
            onClick: handleExportXlsx,
            disabled: isExporting || !filteredRows.length,
          },
          {
            label: 'Limpar dados do menu',
            icon: 'x',
            variant: 'btn-danger',
            onClick: handleClearMenuData,
            disabled: isImporting || isExporting,
          },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Importacao e parametros</h3>
            <p className="muted">Importe a planilha e ajuste o CDI anual para recalcular status em tempo real.</p>
          </div>
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={handleImportClick} disabled={isImporting}>
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
            onClick={handleUseGlobalFolder}
            disabled={!globalDirectoryOptions.length || globalFolderMenu.loading || isImporting}
          >
            {isImporting ? 'Importando...' : 'Usar arquivo importado'}
          </button>
          {globalDirectoryEmptyMessage ? <div className="muted">{globalDirectoryEmptyMessage}</div> : null}
        </div>

        <div className="sync-result">
          <div>
            <strong>{importMeta.fileName || 'Nenhum arquivo'}</strong>
            <span className="muted">Arquivo importado</span>
          </div>
          <div>
            <strong>{rows.length ? formatNumber(rows.length) : '-'}</strong>
            <span className="muted">Linhas parseadas</span>
          </div>
          <div>
            <strong>{importMeta.importedAt ? formatDate(importMeta.importedAt) : '-'}</strong>
            <span className="muted">Ultima importacao</span>
          </div>
          <div>
            <strong>{loadingCdi ? 'Carregando...' : toPercentPointLabel(cdiMonthlyPct, 2)}</strong>
            <span className="muted">CDI mensal estimado</span>
          </div>
        </div>

        <div className="form-grid">
          <label>
            CDI anual (% a.a.)
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={cdiAnnualInput}
              onChange={(event) => setCdiAnnualInput(event.target.value)}
              placeholder="12,00"
            />
          </label>
          <label>
            CDI mensal (% a.m.)
            <input
              className="input"
              type="text"
              value={toPercentPointLabel(cdiMonthlyPct, 2)}
              readOnly
            />
          </label>
          <label>
            Fonte CDI
            <input className="input" type="text" value={cdiMeta.source || '-'} readOnly />
          </label>
          <label>
            Referencia CDI
            <input className="input" type="text" value={cdiMeta.asOf || '-'} readOnly />
          </label>
        </div>
        {cdiMeta.warning ? <p className="muted">{cdiMeta.warning}</p> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Resumo executivo</h3>
            <p className="muted">Visao da rentabilidade no recorte atual, com foco nas estruturas que podem sair.</p>
          </div>
        </div>

        <div className="kpi-grid antecipacao-kpi-grid">
          <div className="card kpi-card antecipacao-kpi-card">
            <div className="kpi-label">Total de estruturas</div>
            <div className="kpi-value antecipacao-kpi-value">{formatNumber(kpis.total)}</div>
          </div>
          <div className="card kpi-card antecipacao-kpi-card">
            <div className="kpi-label">Resultado bruto total</div>
            <div className={`kpi-value antecipacao-kpi-value ${kpis.totalResultado >= 0 ? 'text-positive' : 'text-negative'}`}>
              {formatCurrency(kpis.totalResultado)}
            </div>
          </div>
          <div className="card kpi-card antecipacao-kpi-card">
            <div className="kpi-label">Desembolso total</div>
            <div className="kpi-value antecipacao-kpi-value">{formatCurrency(kpis.totalDesembolso)}</div>
          </div>
          <div className="card kpi-card antecipacao-kpi-card">
            <div className="kpi-label">% acima do CDI</div>
            <div className="kpi-value antecipacao-kpi-value">{kpis.aboveCdiPct.toFixed(1)}%</div>
          </div>
          <div className="card kpi-card antecipacao-kpi-card">
            <div className="kpi-label">% rentabilidade positiva</div>
            <div className="kpi-value antecipacao-kpi-value">{kpis.positivePct.toFixed(1)}%</div>
          </div>
          <div className="card kpi-card antecipacao-kpi-card">
            <div className="kpi-label">Saida</div>
            <div className="kpi-value antecipacao-kpi-value text-positive">
              {formatNumber(kpis.saidaCount)}
            </div>
          </div>
        </div>

        <div className="pie-chart-grid">
          <PieChart data={pieData} title="Positivas x Negativas" size={220} />
          <div className="card segment-card">
            <div className="card-head">
              <h3>Ranking por broker (rentabilidade)</h3>
              <span className="muted">Ordem decrescente, ponderada por desembolso.</span>
            </div>
            <div className="segment-list">
              {brokerRanking.length ? brokerRanking.map((item) => {
                const widthPct = Math.min(100, (Math.abs(item.rentabilidadePonderadaPct) / rankingMaxAbs) * 100)
                const isPositive = item.rentabilidadePonderadaPct >= 0
                return (
                  <div key={item.broker} className="segment-row antecipacao-broker-row">
                    <div className={`segment-dot ${isPositive ? 'green' : 'amber'}`} />
                    <div className="segment-info">
                      <strong>{item.broker}</strong>
                      <span>
                        {item.count} estruturas | {formatCurrency(item.totalResultadoBrl)} | {toPercentLabel(item.rentabilidadePonderadaPct)}
                      </span>
                    </div>
                    <div className="segment-bar">
                      <span
                        className={isPositive ? 'green' : 'amber'}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                )
              }) : (
                <div className="muted">Sem dados para ranking.</div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Filtros</h3>
            <p className="muted">Busca por texto e campos categoricos.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar conta, estrutura, assessor ou broker..."
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
          <MultiSelect value={filters.codigoCliente} options={options.codigoCliente} onChange={(value) => handleFilterChange('codigoCliente', value)} placeholder="Conta" />
          <MultiSelect value={filters.estrutura} options={options.estrutura} onChange={(value) => handleFilterChange('estrutura', value)} placeholder="Estrutura" />
          <MultiSelect value={filters.assessor} options={options.assessor} onChange={(value) => handleFilterChange('assessor', value)} placeholder="Assessor" />
          <MultiSelect value={filters.broker} options={options.broker} onChange={(value) => handleFilterChange('broker', value)} placeholder="Broker" />
          <MultiSelect value={filters.vencimento} options={options.vencimento} onChange={(value) => handleFilterChange('vencimento', value)} placeholder="Vencimento" />
          <MultiSelect value={filters.tempoNaEstrutura} options={options.tempoNaEstrutura} onChange={(value) => handleFilterChange('tempoNaEstrutura', value)} placeholder="Tempo na estrutura" />
          <MultiSelect value={filters.statusCdi} options={options.statusCdi} onChange={(value) => handleFilterChange('statusCdi', value)} placeholder="Status CDI" />
          <MultiSelect value={filters.statusSaida} options={options.statusSaida} onChange={(value) => handleFilterChange('statusSaida', value)} placeholder="Status de saida" />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Tabela resumo</h3>
            <p className="muted">
              {filteredRows.length === rowsWithCdi.length
                ? `${formatNumber(rowsWithCdi.length)} estruturas no escopo atual. Mostrando ${formatNumber(filteredRows.length ? pageStart + 1 : 0)}-${formatNumber(pageEnd)}.`
                : `${formatNumber(filteredRows.length)} de ${formatNumber(rowsWithCdi.length)} estruturas apos filtros. Mostrando ${formatNumber(filteredRows.length ? pageStart + 1 : 0)}-${formatNumber(pageEnd)}.`}
            </p>
          </div>
          <div className="panel-actions">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                void handleExportXlsx()
              }}
              disabled={isExporting || !filteredRows.length}
            >
              <Icon name="download" size={16} />
              {isExporting ? 'Exportando...' : 'Exportar Excel'}
            </button>
            <label className="antecipacao-sort-field">
              <span>Ordenar por</span>
              <select
                className="input"
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="antecipacao-sort-field">
              <span>Direcao</span>
              <select
                className="input"
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value)}
              >
                <option value="desc">Decrescente</option>
                <option value="asc">Crescente</option>
              </select>
            </label>
          </div>
        </div>

        <div className="antecipacao-table-wrap">
          <DataTable rows={pagedRows} columns={columns} emptyMessage="Sem estruturas para exibir." />
        </div>
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
    </div>
  )
}

export default Antecipacao
