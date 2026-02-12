import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Icon from '../components/Icons'
import Modal from '../components/Modal'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { buildDateTree, buildMonthLabel, getMonthKey, normalizeDateKey } from '../lib/periodTree'
import { reprocessRejected } from '../lib/reprocessRejected'
import { getTagIndex } from '../lib/tagsStore'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { loadStructuredRevenue, saveStructuredRevenue } from '../services/revenueStructured'
import { exportXlsx } from '../services/exportXlsx'
import { parseStructuredReceitasFile } from '../services/revenueImport'
import MultiSelect from '../components/MultiSelect'
import TreeSelect from '../components/TreeSelect'
import { getCurrentUserKey } from '../services/currentUser'
import { loadLastImported } from '../services/vencimentoCache'
import { buildEstruturadasDashboard, buildVencimentoIndex } from '../services/estruturadasDashboard'
import { filterByApuracaoMonths } from '../services/apuracao'

const normalizeFileName = (name) => String(name || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const filterSpreadsheetCandidates = (files) => {
  return (Array.isArray(files) ? files : [])
    .filter((file) => file && file.name)
    .filter((file) => {
      const lower = file.name.toLowerCase()
      return (lower.endsWith('.xlsx') || lower.endsWith('.xls')) && !file.name.startsWith('~$')
    })
}

const RevenueStructured = () => {
  const { notify } = useToast()
  const { selectedBroker, tagsIndex, apuracaoMonths } = useGlobalFilters()
  const [userKey] = useState(() => getCurrentUserKey())
  const [filters, setFilters] = useState({ search: '', cliente: [], assessor: [], ativo: [], estrutura: [], broker: [] })
  const [entries, setEntries] = useState(() => loadStructuredRevenue())
  const [dateFilterEnabled, setDateFilterEnabled] = useState(false)
  const [dateFilterSelection, setDateFilterSelection] = useState([])
  const [dateFilterApplied, setDateFilterApplied] = useState([])
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [syncProgress, setSyncProgress] = useState({ processed: 0, total: 0, progress: 0 })
  const [reprocessRunning, setReprocessRunning] = useState(false)
  const [reprocessProgress, setReprocessProgress] = useState({ processed: 0, total: 0, progress: 0 })
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileCandidates, setFileCandidates] = useState([])
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [lastSyncAt, setLastSyncAt] = useState(() => {
    try {
      return localStorage.getItem('pwr.receita.estruturadas.lastSyncAt') || ''
    } catch {
      return ''
    }
  })
  const [showWarnings, setShowWarnings] = useState(true)
  const toastLockRef = useRef(null)
  const abortRef = useRef(null)
  const reprocessAbortRef = useRef(null)
  const debugEnabled = useMemo(() => {
    try {
      return localStorage.getItem('pwr.debug.receita') === '1'
    } catch {
      return false
    }
  }, [])

  const buildMultiOptions = (values) => {
    const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
      .map((value) => String(value).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))
    return unique.map((value) => ({ value, label: value }))
  }


  const baseEntries = entries
  const apuracaoEntries = useMemo(
    () => filterByApuracaoMonths(baseEntries, apuracaoMonths, (entry) => entry.dataEntrada),
    [baseEntries, apuracaoMonths],
  )

  const resolvedPeriodKey = useMemo(() => {
    if (!dateFilterEnabled || !dateFilterApplied.length) return ''
    const months = Array.from(new Set(dateFilterApplied.map((key) => getMonthKey(key))))
    return months.length === 1 ? months[0] : 'multi'
  }, [dateFilterApplied, dateFilterEnabled])

  const selectionDiffersFromApplied = useMemo(() => {
    if (!dateFilterEnabled) return false
    const a = dateFilterSelection || []
    const b = dateFilterApplied || []
    if (a.length !== b.length) return true
    const setB = new Set(b)
    return a.some((val) => !setB.has(val))
  }, [dateFilterApplied, dateFilterEnabled, dateFilterSelection])

  const periodLabel = useMemo(() => {
    if (!dateFilterEnabled || !resolvedPeriodKey) return 'Todos'
    if (resolvedPeriodKey === 'multi') return 'Varios periodos'
    return buildMonthLabel(resolvedPeriodKey)
  }, [dateFilterEnabled, resolvedPeriodKey])

  const effectiveDays = dateFilterEnabled ? dateFilterApplied : []

  const totalMes = useMemo(() => {
    if (!effectiveDays.length) {
      return apuracaoEntries.reduce((sum, entry) => sum + (Number(entry.comissao) || 0), 0)
    }
    const set = new Set(effectiveDays)
    return apuracaoEntries
      .filter((entry) => set.has(normalizeDateKey(entry.dataEntrada)))
      .reduce((sum, entry) => sum + (Number(entry.comissao) || 0), 0)
  }, [effectiveDays, apuracaoEntries])

  const enrichedEntries = useMemo(
    () => apuracaoEntries.map((entry) => enrichRow(entry, tagsIndex)),
    [apuracaoEntries, tagsIndex],
  )

  const brokerOptions = useMemo(
    () => buildMultiOptions(enrichedEntries.map((entry) => entry.broker)),
    [enrichedEntries],
  )
  const clienteOptions = useMemo(
    () => buildMultiOptions(enrichedEntries.map((entry) => entry.codigoCliente)),
    [enrichedEntries],
  )
  const assessorOptions = useMemo(
    () => buildMultiOptions(enrichedEntries.map((entry) => entry.assessor)),
    [enrichedEntries],
  )
  const ativoOptions = useMemo(
    () => buildMultiOptions(enrichedEntries.map((entry) => entry.ativo)),
    [enrichedEntries],
  )
  const estruturaOptions = useMemo(
    () => buildMultiOptions(enrichedEntries.map((entry) => entry.estrutura)),
    [enrichedEntries],
  )

  const periodTree = useMemo(
    () => buildDateTree(enrichedEntries, (entry) => entry?.dataEntrada),
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

  const vencimentoCache = useMemo(() => loadLastImported(userKey), [userKey])
  const vencimentoIndex = useMemo(
    () => buildVencimentoIndex(vencimentoCache?.rows || []),
    [vencimentoCache],
  )

  const periodEntries = useMemo(() => {
    if (!effectiveDays.length) return apuracaoEntries
    const daySet = new Set(effectiveDays)
    return apuracaoEntries.filter((entry) => daySet.has(normalizeDateKey(entry.dataEntrada)))
  }, [apuracaoEntries, effectiveDays])

  const baseTotal = apuracaoEntries.length
  const periodTotal = periodEntries.length
  const hasApplied = dateFilterEnabled && dateFilterApplied.length > 0
  const filterLabel = useMemo(() => {
    if (!dateFilterEnabled) return 'OFF'
    if (hasApplied) return `ON — ${periodLabel}`
    return 'ON (sem selecao aplicada)'
  }, [dateFilterEnabled, hasApplied, periodLabel])

  const rows = useMemo(() => {
    const daySet = new Set(effectiveDays)
    return enrichedEntries
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.codigoCliente || ''} ${entry.nomeCliente || ''} ${entry.assessor || ''} ${entry.broker || ''} ${entry.ativo || ''} ${entry.estrutura || ''}`.toLowerCase().includes(query)) return false
        if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
        if (filters.broker.length && !filters.broker.includes(String(entry.broker || '').trim())) return false
        if (filters.cliente.length && !filters.cliente.includes(String(entry.codigoCliente || '').trim())) return false
        if (filters.assessor.length && !filters.assessor.includes(String(entry.assessor || '').trim())) return false
        if (filters.ativo.length && !filters.ativo.includes(String(entry.ativo || '').trim())) return false
        if (filters.estrutura.length && !filters.estrutura.includes(String(entry.estrutura || '').trim())) return false
        if (effectiveDays.length && !daySet.has(normalizeDateKey(entry.dataEntrada))) return false
        return true
      })
  }, [effectiveDays, enrichedEntries, filters, selectedBroker])

  const dashboard = useMemo(
    () => buildEstruturadasDashboard({ entries: rows, vencimentoIndex }),
    [rows, vencimentoIndex],
  )

  const top5Max = useMemo(
    () => Math.max(...dashboard.top5.map((item) => item.receita), 1),
    [dashboard.top5],
  )

  const pageSize = 100
  const [page, setPage] = useState(1)
  const totalPages = useMemo(() => Math.max(1, Math.ceil(rows.length / pageSize)), [rows.length, pageSize])
  const pageStart = (page - 1) * pageSize
  const pagedRows = useMemo(() => rows.slice(pageStart, pageStart + pageSize), [rows, pageStart, pageSize])

  useEffect(() => {
    setPage(1)
  }, [filters.search, filters.cliente, filters.assessor, filters.ativo, filters.estrutura, filters.broker, dateFilterApplied, dateFilterEnabled, selectedBroker, apuracaoMonths, entries.length])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    setDateFilterSelection([])
    setDateFilterApplied([])
  }, [apuracaoMonths])

  const columns = useMemo(
    () => [
      { key: 'codigoCliente', label: 'Codigo cliente', render: (row) => row.codigoCliente || '—' },
      { key: 'nomeCliente', label: 'Nome do cliente', render: (row) => row.nomeCliente || row.cliente || '—' },
      { key: 'assessor', label: 'Assessor', render: (row) => row.assessor || '—' },
      { key: 'broker', label: 'Broker', render: (row) => row.broker || '—' },
      { key: 'dataEntrada', label: 'Data de entrada', render: (row) => formatDate(row.dataEntrada) },
      { key: 'estrutura', label: 'Estrutura' },
      { key: 'ativo', label: 'Ativo' },
      { key: 'vencimento', label: 'Vencimento', render: (row) => formatDate(row.vencimento) },
      { key: 'comissao', label: 'Comissao', render: (row) => formatCurrency(row.comissao) },
    ],
    [],
  )

  
  const resolveCellValue = (row, column) => {
    if (typeof column?.exportValue === 'function') return column.exportValue(row)
    if (typeof column?.render === 'function') {
      const rendered = column.render(row)
      if (typeof rendered === 'string' || typeof rendered === 'number') return rendered
    }
    const raw = row?.[column?.key]
    return raw == null ? '' : raw
  }

  const handleExportTable = useCallback(async () => {
    if (!pagedRows.length) {
      notify('Nenhuma linha para exportar.', 'warning')
      return
    }
    const headers = columns.map((column) => column.label || column.key || '')
    const rowsToExport = pagedRows.map((row) => columns.map((column) => resolveCellValue(row, column)))
    const periodLabel = resolvedPeriodKey && resolvedPeriodKey !== 'multi' ? resolvedPeriodKey : 'periodo'
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const safePeriod = String(periodLabel).replace(/[^0-9a-zA-Z_-]/g, '')
    await exportXlsx({
      fileName: `receita_estruturadas_${safePeriod}_${timestamp}.xlsx`,
      sheetName: 'Estruturadas',
      columns: headers,
      rows: rowsToExport,
    })
  }, [columns, notify, pagedRows, resolvedPeriodKey])

const handleFolderSelection = useCallback((files) => {
    const candidates = filterSpreadsheetCandidates(files)
    if (!candidates.length) {
      setSelectedFile(null)
      notify('Nenhuma planilha .xlsx encontrada na pasta.', 'warning')
      return null
    }
    const hintMatches = candidates.filter((file) => normalizeFileName(file.name).includes('estrutur'))
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
  }, [notify])

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
        moduleLabel: 'Estruturadas',
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
        setEntries(nextEntries)
        saveStructuredRevenue(nextEntries)
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
        data: entry.dataEntrada || entry.data || '',
        codigoCliente: entry.codigoCliente || '',
        estrutura: entry.estrutura || '',
        ativo: entry.ativo || '',
        comissao: entry.comissao ?? '',
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
  }, [entries, notify, reprocessRunning, syncResult, syncing])

  const handleSync = useCallback(async (file) => {
    if (syncing) return
    const targetFile = file || selectedFile
    const attemptId = `${Date.now()}-${Math.random()}`
    toastLockRef.current = attemptId
    const notifyOnce = (message, tone) => {
      if (toastLockRef.current !== attemptId) return
      toastLockRef.current = null
      notify(message, tone)
    }
    if (!targetFile) {
      notifyOnce('Selecione a pasta com a planilha Operacoes.', 'warning')
      return
    }
    const name = targetFile.name.toLowerCase()
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
      if (debugEnabled) {
        console.info('[receita-estruturadas] sync:start', { name: targetFile.name, size: targetFile.size })
      }
      const tagIndex = await getTagIndex()
      const result = await parseStructuredReceitasFile(targetFile, {
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
            moduleLabel: 'Estruturadas',
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
          if (debugEnabled) console.error('[receita-estruturadas] sync:cancelled')
          return
        }
        const missing = result.error?.details?.missing?.length
          ? ` Colunas faltando: ${result.error.details.missing.join(', ')}`
          : ''
        const message = result.error?.message
          ? `${result.error.message}${missing}`
          : 'Falha ao importar a planilha.'
        notifyOnce(message, 'warning')
        if (debugEnabled) console.error('[receita-estruturadas] sync:error', { payload: result })
        return
      }
      const nextEntries = Array.isArray(result.entries) ? result.entries : []
      setEntries(nextEntries)
      saveStructuredRevenue(nextEntries)
      const stats = result.summary || {}
      const finalStats = stats.stats || {}
      const monthFromStats = stats.months?.[stats.months.length - 1] || ''
      if (monthFromStats) {
        const nextDays = nextEntries
          .map((entry) => normalizeDateKey(entry.dataEntrada))
          .filter((key) => key && getMonthKey(key) === monthFromStats)
        const uniqueDays = Array.from(new Set(nextDays))
        setDateFilterSelection(uniqueDays)
        if (dateFilterEnabled) {
          setDateFilterApplied(uniqueDays)
        }
      }
      const periodKeyResolved = monthFromStats || resolvedPeriodKey
      const periodEntries = periodKeyResolved
        ? nextEntries.filter((entry) => getMonthKey(entry.dataEntrada) === periodKeyResolved)
        : nextEntries
      const rawRows = finalStats.rawRows ?? stats.rowsRead ?? 0
      const validRows = finalStats.validRows ?? stats.rowsValid ?? nextEntries.length
      const savedRows = finalStats.savedRows ?? nextEntries.length
      const integrity = finalStats.integrity || {}
      const warnings = finalStats.warnings || []
      const details = finalStats.details || {}
      console.log('[IMPORT][Estruturadas] rawRows=', rawRows, 'validRows=', validRows, 'savedRows=', savedRows)
      setSyncResult({
        moduleLabel: 'Estruturadas',
        importados: savedRows,
        duplicados: finalStats.duplicatedRows ?? 0,
        rejeitados: finalStats.rejectedRows ?? stats.rowsSkipped ?? 0,
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
        localStorage.setItem('pwr.receita.estruturadas.lastSyncAt', now)
      } catch {
        // noop
      }
      notifyOnce(`Importacao concluida. ${savedRows} linhas validas.`, 'success')
      if (debugEnabled) {
        console.info('[receita-estruturadas] sync:success', {
          rowsRead: stats.rowsRead,
          rowsValid: stats.rowsValid,
          totalCommission: stats.totalCommission,
          months: stats.months,
          periodKey: periodKeyResolved,
          periodCount: periodEntries.length,
        })
      }
    } catch (error) {
      notifyOnce(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar a planilha.', 'warning')
      if (debugEnabled) console.error('[receita-estruturadas] sync:exception', error)
    } finally {
      setSyncing(false)
      abortRef.current = null
    }
  }, [dateFilterEnabled, debugEnabled, notify, resolvedPeriodKey, selectedFile, syncing])

  return (
    <div className="page">
      <PageHeader
        title="Receita Estruturadas"
        subtitle="Controle completo da importacao por pasta e consolidacao mensal."
        meta={[
          { label: 'Periodo selecionado', value: periodLabel },
          { label: 'Filtro', value: filterLabel },
          { label: 'Entradas do periodo', value: periodTotal },
          { label: 'Base total', value: baseTotal },
          { label: 'Total do mes', value: formatCurrency(totalMes) },
          { label: 'Ultima sync', value: lastSyncAt || '?' },
        ]}
        actions={[{ label: 'Exportar resumo', icon: 'download', variant: 'btn-secondary', onClick: handleExportTable }]}
      />

      <SyncPanel
        label="Sincronizacao Estruturadas"
        helper="Selecione a pasta com a planilha Operacoes para validar e consolidar."
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
        directory
        selectedFile={selectedFile}
        onSelectedFileChange={setSelectedFile}
        onFileSelected={handleFolderSelection}
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
        </div>
        <div className="kpi-grid">
          <div className="card kpi-card">
            <div className="kpi-label">CPFs unicos</div>
            <div className="kpi-value">{formatNumber(dashboard.kpis.uniqueClients)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">Receita total</div>
            <div className="kpi-value">{formatCurrency(dashboard.kpis.totalRevenue)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">Volume financeiro</div>
            <div className="kpi-value">{formatCurrency(dashboard.kpis.totalVolume)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">Entradas</div>
            <div className="kpi-value">{formatNumber(dashboard.kpis.totalEntries)}</div>
          </div>
        </div>
        <div className="card segment-card">
          <div className="card-head">
            <h3>Top 5 estruturas por receita</h3>
            <span className="muted">Volume exibido como referencia secundaria.</span>
          </div>
          <div className="segment-list">
            {dashboard.top5.length ? dashboard.top5.map((item) => {
              const percent = (item.receita / top5Max) * 100
              return (
                <div key={item.estrutura} className="segment-row">
                  <div className="segment-dot cyan" />
                  <div className="segment-info">
                    <strong>{item.estrutura}</strong>
                    <span>{formatCurrency(item.receita)} • {formatCurrency(item.volume)}</span>
                  </div>
                  <div className="segment-bar">
                    <span style={{ width: `${percent}%` }} className="cyan" />
                  </div>
                </div>
              )
            }) : (
              <div className="muted">Sem dados suficientes no periodo.</div>
            )}
          </div>
          {debugEnabled ? (
            <div className="muted">
              Excecoes: {dashboard.kpis.exceptionsCount} •
              Matched: {dashboard.kpis.exceptionsMatched} •
              Fallback: {dashboard.kpis.exceptionsFallback}
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Entradas consolidadas</h3>
            <p className="muted">{rows.length} registros ativos neste periodo.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar cliente, ativo ou assessor"
                value={filters.search}
                onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
              />
            </div>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setFilters({ search: '', cliente: [], assessor: [], ativo: [], estrutura: [], broker: [] })
                setDateFilterSelection([])
                setDateFilterApplied([])
                notify('Filtros limpos com sucesso.', 'success')
              }}
            >
              Limpar filtros
            </button>
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
            value={filters.cliente}
            options={clienteOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, cliente: value }))}
            placeholder="Codigo cliente"
          />
          <MultiSelect
            value={filters.assessor}
            options={assessorOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, assessor: value }))}
            placeholder="Assessor"
          />
          <MultiSelect
            value={filters.ativo}
            options={ativoOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, ativo: value }))}
            placeholder="Ativo"
          />
          <MultiSelect
            value={filters.estrutura}
            options={estruturaOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, estrutura: value }))}
            placeholder="Estrutura"
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
        <DataTable rows={pagedRows} columns={columns} emptyMessage="Sem entradas estruturadas." />
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

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Avisos e inconsistencias</h3>
            <p className="muted">Sem alertas no momento.</p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={() => setShowWarnings((prev) => !prev)}>
            {showWarnings ? 'Ocultar' : 'Mostrar'} painel
          </button>
        </div>
        {showWarnings ? (
          <div className="warning-panel">
            <div>
              <Icon name="warning" size={18} />
              <div>
                <strong>Sem inconsistencias detectadas</strong>
                <p className="muted">Nenhuma entrada pendente.</p>
              </div>
              <button className="btn btn-secondary" type="button">Ver detalhes</button>
            </div>
          </div>
        ) : (
          <p className="muted">Painel minimizado. Nenhuma acao pendente.</p>
        )}
      </section>
    </div>
  )
}

export default RevenueStructured
