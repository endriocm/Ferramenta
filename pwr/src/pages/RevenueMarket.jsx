import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Icon from '../components/Icons'
import Modal from '../components/Modal'
import MultiSelect from '../components/MultiSelect'
import TreeSelect from '../components/TreeSelect'
import { formatCurrency, formatNumber } from '../utils/format'
import { buildDateTree, buildMonthLabel, getMonthKey, normalizeDateKey } from '../lib/periodTree'
import { reprocessRejected } from '../lib/reprocessRejected'
import { getTagIndex } from '../lib/tagsStore'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { loadManualRevenue, loadRevenueList, loadRevenueListWithManual, saveRevenueList } from '../services/revenueStore'
import { useToast } from '../hooks/useToast'
import useImportedFileBinding from '../hooks/useImportedFileBinding'
import { filterByApuracaoMonths } from '../services/apuracao'
import { exportXlsx } from '../services/exportXlsx'
import { readImportedFileAsArrayBuffer } from '../services/importCatalog'
import { parseBovespaReceitasFile } from '../services/revenueImport'
import { getRepasseRate, listRepasseMonths, parseRepasseInput, setRepasseRate } from '../services/revenueRepasse'
import { aggregateByKey, buildMultiOptions, normalizeFileName, filterSpreadsheetCandidates, resolveCellValue } from '../utils/spreadsheet'
import { buildEffectiveBmfEntries, buildEffectiveBovespaEntries, isXpRevenueEntry } from '../services/revenueXpCommission'
import { getCurrentUserKey } from '../services/currentUser'
import { toNumber } from '../utils/number'

const buildGlobalDirectoryOptionId = (directory, index) => {
  if (directory?.isRoot) return '__global-root__'
  if (directory?.folderPath) return `path:${directory.folderPath}`
  const name = String(directory?.folderName || '').trim()
  return `name:${name || 'dir'}:${index}`
}

const toRounded = (value, digits = 6) => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const isManualEntry = (entry) => String(entry?.source || '').trim().toLowerCase() === 'manual'

const RevenueMarket = ({ config }) => {
  const {
    key: marketKey,
    mercado,
    fatorReceita,
    label,
    subtitle,
    defaultRepasse,
    fileHint,
    contextHelp,
  } = config

  const { notify } = useToast()
  const importBinding = useImportedFileBinding(marketKey)
  const { selectedBroker, tagsIndex, apuracaoMonths } = useGlobalFilters()
  const [userKey] = useState(() => getCurrentUserKey())
  const [entries, setEntries] = useState(() => loadRevenueListWithManual(marketKey))
  const [dateFilterEnabled, setDateFilterEnabled] = useState(false)
  const [dateFilterSelection, setDateFilterSelection] = useState([])
  const [dateFilterApplied, setDateFilterApplied] = useState([])
  const [filters, setFilters] = useState({ search: '', conta: [], assessor: [], broker: [] })
  const [tipoMode, setTipoMode] = useState('variavel')
  const [granularity, setGranularity] = useState('monthly')
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [syncProgress, setSyncProgress] = useState({ processed: 0, total: 0, progress: 0 })
  const [reprocessRunning, setReprocessRunning] = useState(false)
  const [reprocessProgress, setReprocessProgress] = useState({ processed: 0, total: 0, progress: 0 })
  const [selectedFile, setSelectedFile] = useState(null)
  const [globalFolderLink, setGlobalFolderLink] = useState(null)
  const [globalDirectoryOptions, setGlobalDirectoryOptions] = useState([])
  const [selectedGlobalDirectoryId, setSelectedGlobalDirectoryId] = useState('')
  const [globalDirectoriesLoading, setGlobalDirectoriesLoading] = useState(false)
  const [fileCandidates, setFileCandidates] = useState([])
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [repasseMonth, setRepasseMonth] = useState('')
  const [repasseInput, setRepasseInput] = useState('')
  const [editingCorretagem, setEditingCorretagem] = useState({ id: '', value: '' })
  const [editingReceita, setEditingReceita] = useState({ id: '', value: '' })
  const [xpTick, setXpTick] = useState(0)
  const [lastSyncAt, setLastSyncAt] = useState(() => {
    try {
      return localStorage.getItem(`pwr.receita.${marketKey}.lastSyncAt`) || ''
    } catch {
      return ''
    }
  })
  const toastLockRef = useRef(null)
  const abortRef = useRef(null)
  const reprocessAbortRef = useRef(null)
  const globalFolderLinkRef = useRef(null)
  const globalDirectoryOptionsRef = useRef([])
  const selectedGlobalDirectoryIdRef = useRef('')

  const effectiveEntries = useMemo(() => {
    if (marketKey === 'bmf') return buildEffectiveBmfEntries(entries)
    return buildEffectiveBovespaEntries(entries)
  }, [entries, marketKey, xpTick])

  const baseEntries = useMemo(() => {
    return effectiveEntries.filter((entry) => String(entry.tipoCorretagem || '').toLowerCase() === tipoMode)
  }, [effectiveEntries, tipoMode])

  const repasseMonthOptions = useMemo(
    () => listRepasseMonths(entries.map((entry) => ({ data: entry.data || entry.dataEntrada }))),
    [entries],
  )

  const scopedEntries = useMemo(
    () => filterByApuracaoMonths(baseEntries, apuracaoMonths, (entry) => entry.data || entry.dataEntrada),
    [baseEntries, apuracaoMonths],
  )

  const enrichedEntries = useMemo(
    () => scopedEntries.map((entry) => enrichRow(entry, tagsIndex)),
    [scopedEntries, tagsIndex],
  )

  const apuracaoEntries = scopedEntries

  // Single-pass option extraction
  const { contaOptions, assessorOptions, brokerOptions } = useMemo(() => {
    const contas = new Set()
    const assessors = new Set()
    const brokers = new Set()
    for (const entry of enrichedEntries) {
      const conta = entry.codigoCliente || entry.conta
      if (conta) contas.add(String(conta).trim())
      if (entry.assessor) assessors.add(String(entry.assessor).trim())
      if (entry.broker) brokers.add(String(entry.broker).trim())
    }
    return {
      contaOptions: buildMultiOptions(Array.from(contas)),
      assessorOptions: buildMultiOptions(Array.from(assessors)),
      brokerOptions: buildMultiOptions(Array.from(brokers)),
    }
  }, [enrichedEntries])

  const selectionDiffersFromApplied = useMemo(() => {
    if (!dateFilterEnabled) return false
    const a = dateFilterSelection || []
    const b = dateFilterApplied || []
    if (a.length !== b.length) return true
    const setB = new Set(b)
    return a.some((val) => !setB.has(val))
  }, [dateFilterApplied, dateFilterEnabled, dateFilterSelection])

  const resolvedPeriodKey = useMemo(() => {
    if (!dateFilterEnabled || !dateFilterApplied.length) return ''
    const months = Array.from(new Set(dateFilterApplied.map((key) => getMonthKey(key))))
    return months.length === 1 ? months[0] : 'multi'
  }, [dateFilterApplied, dateFilterEnabled])

  const periodLabel = useMemo(() => {
    if (!dateFilterEnabled || !resolvedPeriodKey) return 'Todos'
    if (resolvedPeriodKey === 'multi') return 'Varios periodos'
    return buildMonthLabel(resolvedPeriodKey)
  }, [dateFilterEnabled, resolvedPeriodKey])

  const effectiveDays = useMemo(
    () => (dateFilterEnabled ? dateFilterApplied : []),
    [dateFilterApplied, dateFilterEnabled],
  )

  const periodEntries = useMemo(() => {
    if (!effectiveDays.length) return apuracaoEntries
    const daySet = new Set(effectiveDays)
    return apuracaoEntries.filter((entry) => daySet.has(normalizeDateKey(entry.data || entry.dataEntrada)))
  }, [apuracaoEntries, effectiveDays])

  const baseTotal = apuracaoEntries.length
  const periodTotal = periodEntries.length
  const hasApplied = dateFilterEnabled && dateFilterApplied.length > 0
  const filterLabel = useMemo(() => {
    if (!dateFilterEnabled) return 'OFF'
    if (hasApplied) return `ON — ${periodLabel}`
    return 'ON (sem selecao aplicada)'
  }, [dateFilterEnabled, hasApplied, periodLabel])

  const periodTree = useMemo(
    () => buildDateTree(enrichedEntries, (entry) => entry.data || entry.dataEntrada),
    [enrichedEntries],
  )

  const handleDateFilterToggle = useCallback((event) => {
    const enabled = event.target.checked
    setDateFilterEnabled(enabled)
    if (!enabled) {
      setDateFilterApplied([])
      return
    }
    if (dateFilterSelection.length) {
      setDateFilterApplied(dateFilterSelection)
    }
  }, [dateFilterSelection])

  const handleDateFilterApply = useCallback((next) => {
    setDateFilterSelection(next)
    if (dateFilterEnabled) {
      setDateFilterApplied(next)
    }
  }, [dateFilterEnabled])

  const filteredRows = useMemo(() => {
    const daySet = new Set(effectiveDays)
    return enrichedEntries
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.codigoCliente || entry.conta || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase().includes(query)) return false
        if (filters.conta.length && !filters.conta.includes(String(entry.codigoCliente || entry.conta || '').trim())) return false
        if (filters.assessor.length && !filters.assessor.includes(String(entry.assessor || '').trim())) return false
        if (filters.broker.length && !filters.broker.includes(String(entry.broker || '').trim())) return false
        if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
        if (effectiveDays.length && !daySet.has(normalizeDateKey(entry.data || entry.dataEntrada))) return false
        return true
      })
      .sort((a, b) => (Number(b.corretagem) || 0) - (Number(a.corretagem) || 0))
  }, [effectiveDays, enrichedEntries, filters, selectedBroker])

  const pageSize = 50
  const [page, setPage] = useState(1)
  const totalPages = useMemo(() => Math.max(1, Math.ceil(filteredRows.length / pageSize)), [filteredRows.length, pageSize])
  const pageStart = (page - 1) * pageSize
  const pagedRows = useMemo(() => filteredRows.slice(pageStart, pageStart + pageSize), [filteredRows, pageStart, pageSize])

  useEffect(() => {
    setPage(1)
  }, [filters.search, filters.conta, filters.assessor, filters.broker, tipoMode, granularity, selectedBroker, entries.length, apuracaoMonths, dateFilterApplied, dateFilterEnabled])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    if (granularity === 'daily' && (apuracaoMonths.all || apuracaoMonths.months.length !== 1)) {
      setGranularity('monthly')
    }
  }, [apuracaoMonths, granularity])

  useEffect(() => {
    setDateFilterSelection([])
    setDateFilterApplied([])
  }, [apuracaoMonths])

  useEffect(() => {
    if (!repasseMonthOptions.length) {
      setRepasseMonth('')
      setRepasseInput('')
      return
    }
    setRepasseMonth((current) => {
      if (current && repasseMonthOptions.includes(current)) return current
      return repasseMonthOptions[repasseMonthOptions.length - 1]
    })
  }, [repasseMonthOptions])

  useEffect(() => {
    if (!repasseMonth) {
      setRepasseInput('')
      return
    }
    const currentRate = getRepasseRate(marketKey, repasseMonth, null)
    setRepasseInput(currentRate == null ? '' : String(currentRate).replace('.', ','))
  }, [repasseMonth, marketKey])

  useEffect(() => {
    const handleRepasseUpdated = () => setEntries(loadRevenueListWithManual(marketKey))
    window.addEventListener('pwr:repasse-updated', handleRepasseUpdated)
    return () => window.removeEventListener('pwr:repasse-updated', handleRepasseUpdated)
  }, [marketKey])

  useEffect(() => {
    const handleReceitaUpdate = () => {
      setEntries(loadRevenueListWithManual(marketKey))
      setXpTick((prev) => prev + 1)
    }
    window.addEventListener('pwr:receita-updated', handleReceitaUpdate)
    return () => window.removeEventListener('pwr:receita-updated', handleReceitaUpdate)
  }, [marketKey])

  const totalReceita = useMemo(() => filteredRows.reduce((sum, entry) => sum + (Number(entry.receita) || 0), 0), [filteredRows])
  const totalVolume = useMemo(() => filteredRows.reduce((sum, entry) => sum + Math.abs(Number(entry.volumeNegociado) || 0), 0), [filteredRows])
  const uniqueContas = useMemo(() => new Set(filteredRows.map((entry) => String(entry.codigoCliente || entry.conta || '').trim()).filter(Boolean)), [filteredRows])

  const seriesKeys = useMemo(() => {
    const keyFn = (entry) => {
      const key = normalizeDateKey(entry.data || entry.dataEntrada)
      if (!key) return ''
      return granularity === 'daily' ? key : key.slice(0, 7)
    }
    const map = aggregateByKey(filteredRows, keyFn)
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [filteredRows, granularity])

  const maxSeriesValue = useMemo(() => Math.max(...seriesKeys.map(([, value]) => value), 1), [seriesKeys])

  const resolveEditableRate = useCallback((row) => {
    const explicitRate = Number(row?.repasse)
    if (Number.isFinite(explicitRate) && explicitRate > 0) return explicitRate
    const entryDate = row?.data || row?.dataEntrada || ''
    const resolvedRate = getRepasseRate(marketKey, entryDate, fatorReceita)
    if (Number.isFinite(resolvedRate) && resolvedRate > 0) return resolvedRate
    return 1
  }, [fatorReceita, marketKey])

  const updateStoredEntry = useCallback((row, patchEntry) => {
    if (!row?.id || typeof patchEntry !== 'function') return false
    let updated = false
    const applyPatch = (entry) => {
      if (entry?.id !== row.id) return entry
      updated = true
      return patchEntry(entry)
    }

    if (isManualEntry(row)) {
      const manualEntries = loadManualRevenue()
      const nextManual = manualEntries.map(applyPatch)
      if (!updated) return false
      saveRevenueList('manual', nextManual)
      setEntries(loadRevenueListWithManual(marketKey))
      return true
    }

    const marketEntries = loadRevenueList(marketKey)
    const nextMarket = marketEntries.map(applyPatch)
    if (!updated) return false
    saveRevenueList(marketKey, nextMarket)
    setEntries(loadRevenueListWithManual(marketKey))
    return true
  }, [marketKey])

  const handleStartCorretagemEdit = useCallback((row) => {
    if (!row?.id) return
    if (isXpRevenueEntry(row)) {
      notify('Linhas da comissao XP devem ser editadas no modulo de Comissao XP.', 'warning')
      return
    }
    const currentValue = Number(row.corretagem)
    const draft = Number.isFinite(currentValue)
      ? String(currentValue).replace('.', ',')
      : ''
    setEditingReceita({ id: '', value: '' })
    setEditingCorretagem({ id: row.id, value: draft })
  }, [notify])

  const handleCancelCorretagemEdit = useCallback(() => {
    setEditingCorretagem({ id: '', value: '' })
  }, [])

  const handleSaveCorretagem = useCallback((row) => {
    if (!row?.id) return
    if (isXpRevenueEntry(row)) {
      notify('Linhas da comissao XP devem ser editadas no modulo de Comissao XP.', 'warning')
      return
    }
    const parsed = toNumber(editingCorretagem.value)
    if (parsed == null || parsed < 0) {
      notify('Informe uma corretagem valida.', 'warning')
      return
    }
    const corretagem = toRounded(parsed, 6)
    const patchEntry = (entry) => ({
      ...entry,
      corretagem,
      receitaBrutaBase: corretagem,
      receita: corretagem,
      valor: corretagem,
    })
    if (!updateStoredEntry(row, patchEntry)) {
      notify('Nao foi possivel localizar a linha para atualizar.', 'warning')
      return
    }
    setEditingCorretagem({ id: '', value: '' })
    setEditingReceita({ id: '', value: '' })
    notify('Corretagem atualizada com sucesso.', 'success')
  }, [editingCorretagem.value, notify, updateStoredEntry])

  const handleStartReceitaEdit = useCallback((row) => {
    if (!row?.id) return
    if (isXpRevenueEntry(row)) {
      notify('Linhas da comissao XP devem ser editadas no modulo de Comissao XP.', 'warning')
      return
    }
    const currentValue = Number(row.receita)
    const draft = Number.isFinite(currentValue)
      ? String(currentValue).replace('.', ',')
      : ''
    setEditingCorretagem({ id: '', value: '' })
    setEditingReceita({ id: row.id, value: draft })
  }, [notify])

  const handleCancelReceitaEdit = useCallback(() => {
    setEditingReceita({ id: '', value: '' })
  }, [])

  const handleSaveReceita = useCallback((row) => {
    if (!row?.id) return
    if (isXpRevenueEntry(row)) {
      notify('Linhas da comissao XP devem ser editadas no modulo de Comissao XP.', 'warning')
      return
    }
    const parsed = toNumber(editingReceita.value)
    if (parsed == null || parsed < 0) {
      notify('Informe uma receita valida.', 'warning')
      return
    }
    const receitaLiquida = toRounded(parsed, 6)
    const rate = toRounded(resolveEditableRate(row), 6)
    const receitaBase = rate > 0
      ? toRounded(receitaLiquida / rate, 6)
      : receitaLiquida
    const patchEntry = (entry) => ({
      ...entry,
      corretagem: receitaBase,
      receitaBrutaBase: receitaBase,
      repasse: rate,
      receita: receitaLiquida,
      valor: receitaLiquida,
    })
    if (!updateStoredEntry(row, patchEntry)) {
      notify('Nao foi possivel localizar a linha para atualizar.', 'warning')
      return
    }
    setEditingReceita({ id: '', value: '' })
    setEditingCorretagem({ id: '', value: '' })
    notify('Receita atualizada com sucesso.', 'success')
  }, [editingReceita.value, notify, resolveEditableRate, updateStoredEntry])

  const columns = useMemo(
    () => {
      const baseColumns = [
        { key: 'conta', label: 'Conta', render: (row) => row.codigoCliente || row.conta || '?' },
        { key: 'assessor', label: 'Assessor', render: (row) => row.assessor || '?' },
        { key: 'broker', label: 'Broker', render: (row) => row.broker || '?' },
        {
          key: 'corretagem',
          label: 'Corretagem',
          exportValue: (row) => row.corretagem,
          render: (row) => {
            const isEditing = editingCorretagem.id === row.id
            const xpLocked = isXpRevenueEntry(row)
            if (isEditing) {
              return (
                <div className="revenue-edit-cell">
                  <input
                    className="revenue-edit-input"
                    type="text"
                    inputMode="decimal"
                    value={editingCorretagem.value}
                    onChange={(event) => setEditingCorretagem((prev) => ({ ...prev, value: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        handleSaveCorretagem(row)
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        handleCancelCorretagemEdit()
                      }
                    }}
                  />
                  <div className="revenue-edit-actions">
                    <button
                      className="icon-btn ghost revenue-edit-action"
                      type="button"
                      onClick={() => handleSaveCorretagem(row)}
                      aria-label="Salvar corretagem"
                    >
                      <Icon name="check" size={14} />
                    </button>
                    <button
                      className="icon-btn ghost revenue-edit-action"
                      type="button"
                      onClick={handleCancelCorretagemEdit}
                      aria-label="Cancelar edicao de corretagem"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                </div>
              )
            }
            return (
              <div className="revenue-edit-cell">
                <span>{formatCurrency(row.corretagem)}</span>
                <button
                  className="icon-btn ghost revenue-edit-action"
                  type="button"
                  onClick={() => handleStartCorretagemEdit(row)}
                  aria-label="Editar corretagem"
                  disabled={xpLocked}
                  title={xpLocked ? 'Linha vinda da comissao XP' : 'Editar corretagem'}
                >
                  <Icon name="pen" size={14} />
                </button>
              </div>
            )
          },
        },
      ]

      if (marketKey === 'bovespa') {
        baseColumns.push({
          key: 'receita',
          label: 'Receita',
          exportValue: (row) => row.receita,
          render: (row) => {
            const isEditing = editingReceita.id === row.id
            const xpLocked = isXpRevenueEntry(row)
            if (isEditing) {
              return (
                <div className="revenue-edit-cell">
                  <input
                    className="revenue-edit-input"
                    type="text"
                    inputMode="decimal"
                    value={editingReceita.value}
                    onChange={(event) => setEditingReceita((prev) => ({ ...prev, value: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        handleSaveReceita(row)
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        handleCancelReceitaEdit()
                      }
                    }}
                  />
                  <div className="revenue-edit-actions">
                    <button
                      className="icon-btn ghost revenue-edit-action"
                      type="button"
                      onClick={() => handleSaveReceita(row)}
                      aria-label="Salvar receita"
                    >
                      <Icon name="check" size={14} />
                    </button>
                    <button
                      className="icon-btn ghost revenue-edit-action"
                      type="button"
                      onClick={handleCancelReceitaEdit}
                      aria-label="Cancelar edicao de receita"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                </div>
              )
            }
            return (
              <div className="revenue-edit-cell">
                <span>{formatCurrency(row.receita)}</span>
                <button
                  className="icon-btn ghost revenue-edit-action"
                  type="button"
                  onClick={() => handleStartReceitaEdit(row)}
                  aria-label="Editar receita"
                  disabled={xpLocked}
                  title={xpLocked ? 'Linha vinda da comissao XP' : 'Editar receita'}
                >
                  <Icon name="pen" size={14} />
                </button>
              </div>
            )
          },
        })
      }

      return baseColumns
    },
    [
      editingCorretagem.id,
      editingCorretagem.value,
      editingReceita.id,
      editingReceita.value,
      handleCancelCorretagemEdit,
      handleCancelReceitaEdit,
      handleSaveCorretagem,
      handleSaveReceita,
      handleStartCorretagemEdit,
      handleStartReceitaEdit,
      marketKey,
    ],
  )

  const handleExportTable = useCallback(async () => {
    if (!pagedRows.length) {
      notify('Nenhuma linha para exportar.', 'warning')
      return
    }
    const headers = columns.map((column) => column.label || column.key || '')
    const rowsToExport = pagedRows.map((row) => columns.map((column) => resolveCellValue(row, column)))
    const periodKey = resolvedPeriodKey || 'periodo'
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const safePeriod = String(periodKey).replace(/[^0-9a-zA-Z_-]/g, '')
    await exportXlsx({
      fileName: `receita_${marketKey}_${safePeriod}_${timestamp}.xlsx`,
      sheetName: label,
      columns: headers,
      rows: rowsToExport,
    })
  }, [columns, label, marketKey, notify, pagedRows, resolvedPeriodKey])

  useEffect(() => {
    globalFolderLinkRef.current = globalFolderLink
  }, [globalFolderLink])

  useEffect(() => {
    globalDirectoryOptionsRef.current = globalDirectoryOptions
  }, [globalDirectoryOptions])

  useEffect(() => {
    selectedGlobalDirectoryIdRef.current = selectedGlobalDirectoryId
  }, [selectedGlobalDirectoryId])

  const handleApplyRepasse = useCallback(() => {
    if (!repasseMonth) {
      notify('Selecione o mes para aplicar o repasse.', 'warning')
      return
    }
    const parsed = parseRepasseInput(repasseInput)
    if (!(parsed > 0)) {
      notify(`Repasse invalido. Exemplo: ${defaultRepasse}`, 'warning')
      return
    }
    const applied = setRepasseRate(marketKey, repasseMonth, parsed)
    if (!applied) {
      notify('Nao foi possivel salvar o repasse.', 'warning')
      return
    }
    setEntries(loadRevenueListWithManual(marketKey))
    notify(`Repasse ${String(parsed.toFixed(3)).replace('.', ',')} aplicado em ${buildMonthLabel(repasseMonth)}.`, 'success')
  }, [defaultRepasse, marketKey, notify, repasseInput, repasseMonth])

  const resolveGlobalTargetFile = useCallback(async ({ showMissingWarning = false } = {}) => {
    const target = importBinding.selectedFile || await importBinding.refreshFromCatalog()
    if (target) {
      setSelectedFile(target)
      return target
    }
    setSelectedFile(null)
    if (showMissingWarning) {
      notify('Nenhuma planilha importada foi vinculada para este modulo.', 'warning')
    }
    return null
  }, [importBinding.selectedFile, importBinding.refreshFromCatalog, notify])

  useEffect(() => {
    if (syncing) return undefined
    void resolveGlobalTargetFile()
    return undefined
  }, [resolveGlobalTargetFile, syncing])

  const handleFolderSelection = useCallback((files) => {
    const candidates = filterSpreadsheetCandidates(files)
    if (!candidates.length) {
      setSelectedFile(null)
      notify('Nenhuma planilha .xlsx encontrada na pasta.', 'warning')
      return null
    }
    const hintMatches = candidates.filter((file) => normalizeFileName(file.name).includes(fileHint))
    if (hintMatches.length === 1) {
      setSelectedFile(hintMatches[0])
      return hintMatches[0]
    }
    if (candidates.length === 1) {
      setSelectedFile(candidates[0])
      return candidates[0]
    }
    const options = hintMatches.length ? hintMatches : candidates
    setSelectedFile(null)
    setFileCandidates(options)
    setIsPickerOpen(true)
    return null
  }, [fileHint, notify])

  const handlePickCandidate = useCallback((file) => {
    if (!file) return
    setSelectedFile(file)
    setFileCandidates([])
    setIsPickerOpen(false)
  }, [])

  const handleClosePicker = useCallback(() => {
    setIsPickerOpen(false)
  }, [])

  const handleCancelSync = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
  }, [])

  const handleCancelReprocess = useCallback(() => {
    if (reprocessAbortRef.current) reprocessAbortRef.current.abort()
  }, [])

  const handleReprocessRejected = useCallback(async () => {
    if (reprocessRunning || syncing) return
    const rejectedItems = syncResult?.details?.rejected || []
    if (!rejectedItems.length) {
      notify('Sem rejeitados para reprocessar.', 'warning')
      return
    }
    setReprocessRunning(true)
    setReprocessProgress({ processed: 0, total: rejectedItems.length, progress: 0 })
    const controller = new AbortController()
    reprocessAbortRef.current = controller
    try {
      const tagIndex = await getTagIndex()
      const result = await reprocessRejected({
        rejectedItems,
        baseEntries: entries,
        moduleLabel: label,
        tagIndex,
        signal: controller.signal,
        onProgress: ({ processed, total, progress }) => {
          setReprocessProgress({ processed, total, progress })
        },
      })
      const recoveredEntries = result.recoveredEntries || []
      const rejectedStill = result.rejectedStill || []
      const duplicatesCount = result.duplicatesCount || 0
      const processedCount = result.processedCount || 0
      const nextEntries = recoveredEntries.length ? [...entries, ...recoveredEntries] : entries
      if (recoveredEntries.length) {
        saveRevenueList(marketKey, nextEntries)
        setEntries(loadRevenueListWithManual(marketKey))
      }

      const prevResult = syncResult || {}
      const prevExtra = Array.isArray(prevResult.extra)
        ? prevResult.extra.filter((item) => ![
          'Reprocessados',
          'Recuperados',
          'Ainda rejeitados',
          'Duplicados no reprocess',
        ].includes(item.label))
        : []
      const recoveredSample = recoveredEntries.slice(0, 200).map((entry) => ({
        id: entry.id,
        data: entry.data || entry.dataEntrada || '',
        codigoCliente: entry.codigoCliente || entry.conta || '',
        corretagem: entry.corretagem ?? '',
        volumeNegociado: entry.volumeNegociado ?? '',
      }))
      const prevRecovered = Array.isArray(prevResult.details?.reprocessedRecovered)
        ? prevResult.details.reprocessedRecovered
        : []
      const mergedRecovered = [...prevRecovered, ...recoveredSample].slice(0, 500)

      setSyncResult({
        ...prevResult,
        importados: nextEntries.length,
        duplicados: (prevResult.duplicados || 0) + duplicatesCount,
        rejeitados: rejectedStill.length,
        details: {
          ...(prevResult.details || {}),
          rejected: rejectedStill,
          reprocessCanceled: Boolean(result.canceled),
          reprocessedRecovered: mergedRecovered,
        },
        extra: [
          ...prevExtra,
          { label: 'Reprocessados', value: processedCount },
          { label: 'Recuperados', value: recoveredEntries.length },
          { label: 'Ainda rejeitados', value: rejectedStill.length },
          { label: 'Duplicados no reprocess', value: duplicatesCount },
        ],
      })

      if (result.canceled) {
        notify('Reprocessamento cancelado.', 'warning')
      } else {
        notify(`Reprocessamento concluido. ${recoveredEntries.length} recuperados.`, 'success')
      }
    } catch (error) {
      notify(error?.message ? `Falha ao reprocessar: ${error.message}` : 'Falha ao reprocessar.', 'warning')
    } finally {
      setReprocessRunning(false)
      reprocessAbortRef.current = null
    }
  }, [entries, label, marketKey, notify, reprocessRunning, syncResult, syncing])

  const handleSync = useCallback(async (file) => {
    if (syncing) return
    let targetFile = file || selectedFile
    const globalTarget = await resolveGlobalTargetFile()
    if (globalTarget) targetFile = globalTarget
    const attemptId = `${Date.now()}-${Math.random()}`
    toastLockRef.current = attemptId
    const notifyOnce = (message, tone) => {
      if (toastLockRef.current !== attemptId) return
      toastLockRef.current = null
      notify(message, tone)
    }
    if (!targetFile) {
      notifyOnce('Selecione um arquivo importado para este modulo.', 'warning')
      return
    }
    const fileName = String(targetFile?.name || targetFile?.fileName || '')
    const name = fileName.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      notifyOnce('Formato invalido. Use .xlsx.', 'warning')
      return
    }
    setSyncing(true)
    setSyncResult(null)
    setSyncProgress({ processed: 0, total: 0, progress: 0 })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      let parserInput = targetFile
      if (targetFile?.source === 'electron') {
        parserInput = await readImportedFileAsArrayBuffer(targetFile)
        if (!parserInput) {
          notifyOnce('Nao foi possivel ler o arquivo importado.', 'warning')
          return
        }
      }

      const tagIndex = await getTagIndex()
      const result = await parseBovespaReceitasFile(parserInput, {
        mercado,
        fatorReceita,
        signal: controller.signal,
        tagIndex,
        onProgress: ({ processed, rawRows, progress }) => {
          setSyncProgress({ processed, total: rawRows || 0, progress: progress || 0 })
        },
      })
      if (!result.ok) {
        if (result.error?.code === 'CANCELLED') {
          const stats = result.summary?.stats || {}
          const integrity = stats.integrity || {}
          const warnings = stats.warnings || []
          const details = stats.details || {}
          setSyncResult({
            moduleLabel: label,
            importados: stats.savedRows ?? 0,
            duplicados: stats.duplicatedRows ?? 0,
            rejeitados: stats.rejectedRows ?? 0,
            avisos: warnings.length,
            warnings,
            details,
            extra: [
              { label: 'Linhas no Excel', value: integrity.estimatedDataRows ?? 0 },
              { label: 'Linhas lidas (raw)', value: integrity.rawRows ?? stats.rawRows ?? 0 },
              { label: 'Processadas', value: integrity.processedRows ?? stats.processedRows ?? 0 },
              { label: 'Salvas', value: integrity.savedRows ?? stats.savedRows ?? 0 },
              { label: 'Divergencia', value: integrity.mismatch ?? 0 },
              { label: 'Enriquecidas (Tags)', value: stats.enrichedRows ?? 0 },
              { label: 'Auto-corrigidas', value: stats.autoFixedRows ?? 0 },
            ],
          })
          notifyOnce('Importacao cancelada.', 'warning')
          return
        }
        const missing = result.error?.details?.missing?.length
          ? ` Colunas faltando: ${result.error.details.missing.join(', ')}`
          : ''
        const message = result.error?.message
          ? `${result.error.message}${missing}`
          : 'Falha ao importar a planilha.'
        notifyOnce(message, 'warning')
        return
      }
      const nextEntries = Array.isArray(result.entries) ? result.entries : []
      saveRevenueList(marketKey, nextEntries)
      setEntries(loadRevenueListWithManual(marketKey))
      const stats = result.summary || {}
      const finalStats = stats.stats || {}
      const dateKeys = nextEntries
        .map((entry) => normalizeDateKey(entry.data || entry.dataEntrada))
        .filter(Boolean)
      if (dateKeys.length) {
        const monthKeys = Array.from(new Set(dateKeys.map((key) => getMonthKey(key)))).sort()
        const monthFromStats = monthKeys[monthKeys.length - 1] || ''
        if (monthFromStats) {
          const nextDays = dateKeys.filter((key) => getMonthKey(key) === monthFromStats)
          const uniqueDays = Array.from(new Set(nextDays))
          setDateFilterSelection(uniqueDays)
          if (dateFilterEnabled) {
            setDateFilterApplied(uniqueDays)
          }
        }
      }
      const rawRows = finalStats.rawRows ?? stats.rowsRead ?? 0
      const savedRows = finalStats.savedRows ?? nextEntries.length
      const integrity = finalStats.integrity || {}
      const warnings = finalStats.warnings || []
      const details = finalStats.details || {}
      setSyncResult({
        moduleLabel: label,
        importados: savedRows,
        duplicados: finalStats.duplicatedRows ?? 0,
        rejeitados: finalStats.rejectedRows ?? stats.rowsFiltered ?? 0,
        avisos: warnings.length,
        warnings,
        details,
        extra: [
          { label: 'Linhas no Excel', value: integrity.estimatedDataRows ?? 0 },
          { label: 'Linhas lidas (raw)', value: integrity.rawRows ?? rawRows },
          { label: 'Processadas', value: integrity.processedRows ?? finalStats.processedRows ?? 0 },
          { label: 'Salvas', value: integrity.savedRows ?? savedRows },
          { label: 'Divergencia', value: integrity.mismatch ?? 0 },
          { label: 'Enriquecidas (Tags)', value: finalStats.enrichedRows ?? 0 },
          { label: 'Auto-corrigidas', value: finalStats.autoFixedRows ?? 0 },
        ],
      })
      const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
      setLastSyncAt(now)
      try {
        localStorage.setItem(`pwr.receita.${marketKey}.lastSyncAt`, now)
      } catch {
        // noop
      }
      notifyOnce(`Importacao concluida. ${nextEntries.length} linhas validas.`, 'success')
    } catch (error) {
      notifyOnce(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar a planilha.', 'warning')
    } finally {
      setSyncing(false)
      abortRef.current = null
    }
  }, [dateFilterEnabled, fatorReceita, label, marketKey, mercado, notify, resolveGlobalTargetFile, selectedFile, syncing])

  const directoryFilterOptions = useMemo(() => {
    return importBinding.options.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description || '',
    }))
  }, [importBinding.options])

  const directoryOptionsEmptyMessage = useMemo(() => {
    return importBinding.emptyMessage
  }, [importBinding.emptyMessage])

  return (
    <div className="page">
      <PageHeader
        title={`Receita ${label}`}
        subtitle={subtitle}
        meta={[
          { label: 'Periodo selecionado', value: periodLabel },
          { label: 'Filtro', value: filterLabel },
          { label: 'Entradas do periodo', value: periodTotal },
          { label: 'Base total', value: baseTotal },
          { label: 'Ultima sync', value: lastSyncAt || '?' },
          { label: 'Total do mes', value: formatCurrency(totalReceita) },
        ]}
        actions={[{ label: 'Exportar', icon: 'download', variant: 'btn-secondary', onClick: handleExportTable }]}
      />

      <SyncPanel
        label={`Importacao ${label}`}
        helper="Use um arquivo ja importado no catalogo central."
        onSync={handleSync}
        onCancel={handleCancelSync}
        onReprocessRejected={handleReprocessRejected}
        reprocessRunning={reprocessRunning}
        reprocessProgress={reprocessProgress.total ? { processed: reprocessProgress.processed, total: reprocessProgress.total } : null}
        onCancelReprocess={handleCancelReprocess}
        running={syncing}
        result={syncResult}
        progress={syncProgress.progress}
        progressInfo={syncProgress.total ? { processed: syncProgress.processed, total: syncProgress.total } : null}
        selectedFile={selectedFile || importBinding.selectedFile}
        onSelectedFileChange={setSelectedFile}
        linkedFileOptions={directoryFilterOptions}
        linkedFileValue={importBinding.value}
        onLinkedFileChange={(value) => {
          setSelectedFile(null)
          importBinding.setValue(value)
        }}
        linkedFileLabel={`Arquivo importado ${label}`}
        linkedFileEmptyMessage={directoryOptionsEmptyMessage}
        hideLocalPicker
        contextHelp={contextHelp}
      />

      <Modal
        open={isPickerOpen}
        onClose={handleClosePicker}
        title="Escolher arquivo"
        subtitle="Encontramos mais de um arquivo valido na pasta."
      >
        <div className="file-picker-list">
          {fileCandidates.map((file) => (
            <button
              key={`${file.name}-${file.lastModified}`}
              className="file-picker-item"
              type="button"
              onClick={() => handlePickCandidate(file)}
            >
              <div>
                <strong>{file.name}</strong>
                {file.webkitRelativePath ? <div className="muted">{file.webkitRelativePath}</div> : null}
              </div>
              <span className="muted">{new Date(file.lastModified || Date.now()).toLocaleDateString('pt-BR')}</span>
            </button>
          ))}
        </div>
      </Modal>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Dashboard do periodo</h3>
            <p className="muted">Resumo baseado no recorte filtrado da tabela.</p>
          </div>
          <div className="page-list">
            <button className={`page-number ${tipoMode === 'variavel' ? 'active' : ''}`} type="button" onClick={() => setTipoMode('variavel')}>
              Variavel
            </button>
            <button className={`page-number ${tipoMode === 'independente' ? 'active' : ''}`} type="button" onClick={() => setTipoMode('independente')}>
              Independente
            </button>
          </div>
        </div>
        <div className="repasse-toolbar">
          <label className="repasse-field">
            <span>Mes do repasse</span>
            <select
              className="input"
              value={repasseMonth}
              onChange={(event) => setRepasseMonth(event.target.value)}
              disabled={!repasseMonthOptions.length}
            >
              {!repasseMonthOptions.length ? <option value="">Sem meses</option> : null}
              {repasseMonthOptions.map((monthKey) => (
                <option key={monthKey} value={monthKey}>
                  {buildMonthLabel(monthKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="repasse-field">
            <span>Repasse</span>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              placeholder={defaultRepasse}
              value={repasseInput}
              onChange={(event) => setRepasseInput(event.target.value)}
            />
          </label>
          <button className="btn btn-secondary" type="button" onClick={handleApplyRepasse}>
            Aplicar repasse
          </button>
        </div>
        <p className="repasse-help">Use decimal em proporcao: {defaultRepasse} = {(Number(defaultRepasse.replace(',', '.')) * 100).toFixed(1).replace('.', ',')}%.</p>
        <div className="kpi-grid">
          <div className="card kpi-card">
            <div className="kpi-label">Receita total</div>
            <div className="kpi-value">{formatCurrency(totalReceita)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">Volume movimentado</div>
            <div className="kpi-value">{formatCurrency(totalVolume)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">CPFs unicos</div>
            <div className="kpi-value">{formatNumber(uniqueContas.size)}</div>
          </div>
        </div>
        <div className="chart-card">
          <div className="card-head">
            <div>
              <h3>Receita por periodo</h3>
              <p className="muted">Agrupado por {granularity === 'daily' ? 'dia' : 'mes'}.</p>
            </div>
            <div className="page-list">
              <button className={`page-number ${granularity === 'monthly' ? 'active' : ''}`} type="button" onClick={() => setGranularity('monthly')}>
                Mensal
              </button>
              <button className={`page-number ${granularity === 'daily' ? 'active' : ''}`} type="button" onClick={() => setGranularity('daily')}>
                Diario
              </button>
            </div>
          </div>
          <div className="chart">
            <div className="chart-grid">
              {seriesKeys.map(([key, value]) => (
                <div key={key} style={{ height: `${(value / maxSeriesValue) * 100}%` }} className="chart-bar" />
              ))}
            </div>
          </div>
          <div className="chart-footer">
            {seriesKeys.map(([key]) => {
              if (granularity === 'daily') {
                const [, month, day] = key.split('-')
                return <span key={key} className="muted">{day}/{month}</span>
              }
              const [year, month] = key.split('-')
              return <span key={key} className="muted">{month}/{year.slice(2)}</span>
            })}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Entradas {label}</h3>
            <p className="muted">{filteredRows.length} registros no recorte atual.</p>
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
          </div>
        </div>
        <div className="filter-grid">
          <MultiSelect
            value={filters.conta}
            options={contaOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, conta: value }))}
            placeholder="Conta"
          />
          <MultiSelect
            value={filters.assessor}
            options={assessorOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, assessor: value }))}
            placeholder="Assessor"
          />
          <MultiSelect
            value={filters.broker}
            options={brokerOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, broker: value }))}
            placeholder="Broker"
          />
          <label className={`filter-toggle ${dateFilterEnabled ? 'active' : ''}`}>
            <input
              type="checkbox"
              checked={dateFilterEnabled}
              onChange={handleDateFilterToggle}
            />
            <span>Filtrar periodo</span>
          </label>
          <TreeSelect
            value={dateFilterSelection}
            tree={periodTree.tree}
            allValues={periodTree.allValues}
            onChange={handleDateFilterApply}
            onDraftChange={setDateFilterSelection}
            onCancel={() => {
              if (dateFilterEnabled) setDateFilterSelection(dateFilterApplied)
            }}
            placeholder={dateFilterEnabled ? 'Periodo' : 'Periodo (desativado)'}
            searchable={false}
          />
          {selectionDiffersFromApplied && dateFilterEnabled ? (
            <div className="filter-hint">Selecao pendente (clique Aplicar)</div>
          ) : null}
        </div>
        <DataTable rows={pagedRows} columns={columns} emptyMessage={`Sem dados ${label}.`} />
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

export default RevenueMarket
