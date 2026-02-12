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
import { loadRevenueList, saveRevenueList } from '../services/revenueStore'
import { useToast } from '../hooks/useToast'
import { filterByApuracaoMonths } from '../services/apuracao'
import { exportXlsx } from '../services/exportXlsx'
import { parseBovespaReceitasFile } from '../services/revenueImport'

const aggregateByKey = (entries, keyFn) => {
  const map = new Map()
  entries.forEach((entry) => {
    const key = keyFn(entry)
    if (!key) return
    map.set(key, (map.get(key) || 0) + (Number(entry.receita) || 0))
  })
  return map
}

const buildMultiOptions = (values) => {
  const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return unique.map((value) => ({ value, label: value }))
}

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

const RevenueBmf = () => {
  const { notify } = useToast()
  const { selectedBroker, tagsIndex, apuracaoMonths } = useGlobalFilters()
  const [entries, setEntries] = useState(() => loadRevenueList('bmf'))
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
  const [fileCandidates, setFileCandidates] = useState([])
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [lastSyncAt, setLastSyncAt] = useState(() => {
    try {
      return localStorage.getItem('pwr.receita.bmf.lastSyncAt') || ''
    } catch {
      return ''
    }
  })
  const toastLockRef = useRef(null)
  const abortRef = useRef(null)
  const reprocessAbortRef = useRef(null)

  const baseEntries = useMemo(() => {
    return entries.filter((entry) => String(entry.tipoCorretagem || '').toLowerCase() === tipoMode)
  }, [entries, tipoMode])

  const scopedEntries = useMemo(
    () => filterByApuracaoMonths(baseEntries, apuracaoMonths, (entry) => entry.data || entry.dataEntrada),
    [baseEntries, apuracaoMonths],
  )

  const enrichedEntries = useMemo(
    () => scopedEntries.map((entry) => enrichRow(entry, tagsIndex)),
    [scopedEntries, tagsIndex],
  )

  const apuracaoEntries = scopedEntries

  const contaOptions = useMemo(
    () => buildMultiOptions(enrichedEntries.map((entry) => entry.codigoCliente || entry.conta)),
    [enrichedEntries],
  )
  const assessorOptions = useMemo(
    () => buildMultiOptions(enrichedEntries.map((entry) => entry.assessor)),
    [enrichedEntries],
  )
  const brokerOptions = useMemo(
    () => buildMultiOptions(enrichedEntries.map((entry) => entry.broker)),
    [enrichedEntries],
  )

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

  const effectiveDays = dateFilterEnabled ? dateFilterApplied : []

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
        if (query && !`${entry.codigoCliente || entry.conta || ''} ${entry.nomeCliente || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase().includes(query)) return false
        if (filters.conta.length && !filters.conta.includes(String(entry.codigoCliente || entry.conta || '').trim())) return false
        if (filters.assessor.length && !filters.assessor.includes(String(entry.assessor || '').trim())) return false
        if (filters.broker.length && !filters.broker.includes(String(entry.broker || '').trim())) return false
        if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
        if (effectiveDays.length && !daySet.has(normalizeDateKey(entry.data || entry.dataEntrada))) return false
        return true
      })
      .sort((a, b) => (Number(b.corretagem) || 0) - (Number(a.corretagem) || 0))
  }, [effectiveDays, enrichedEntries, filters, selectedBroker])

  const pageSize = 100
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

  const columns = useMemo(
    () => [
      { key: 'conta', label: 'Conta', render: (row) => row.codigoCliente || row.conta || '?' },
      { key: 'assessor', label: 'Assessor', render: (row) => row.assessor || '?' },
      { key: 'broker', label: 'Broker', render: (row) => row.broker || '?' },
      { key: 'nomeCliente', label: 'Nome do Cliente', render: (row) => row.nomeCliente || row.cliente || '?' },
      { key: 'corretagem', label: 'Corretagem', render: (row) => formatCurrency(row.corretagem) },
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
    const periodKey = resolvedPeriodKey || 'periodo'
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const safePeriod = String(periodKey).replace(/[^0-9a-zA-Z_-]/g, '')
    await exportXlsx({
      fileName: `receita_bmf_${safePeriod}_${timestamp}.xlsx`,
      sheetName: 'BMF',
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
    const hintMatches = candidates.filter((file) => normalizeFileName(file.name).includes('bmf'))
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
        moduleLabel: 'BMF',
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
        saveRevenueList('bmf', nextEntries)
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
      notifyOnce('Selecione a pasta com o arquivo Export.', 'warning')
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
      const tagIndex = await getTagIndex()
      const result = await parseBovespaReceitasFile(targetFile, {
        mercado: 'bmf',
        fatorReceita: 0.9435 * 0.8285,
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
            moduleLabel: 'BMF',
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
      setEntries(nextEntries)
      saveRevenueList('bmf', nextEntries)
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
      const validRows = finalStats.validRows ?? stats.rowsValid ?? nextEntries.length
      const savedRows = finalStats.savedRows ?? nextEntries.length
      const integrity = finalStats.integrity || {}
      const warnings = finalStats.warnings || []
      const details = finalStats.details || {}
      console.log('[IMPORT][BMF] rawRows=', rawRows, 'validRows=', validRows, 'savedRows=', savedRows)
      setSyncResult({
        moduleLabel: 'BMF',
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
        localStorage.setItem('pwr.receita.bmf.lastSyncAt', now)
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
  }, [dateFilterEnabled, notify, selectedFile, syncing])

  return (
    <div className="page">
      <PageHeader
        title="Receita BMF"
        subtitle="Monitoramento de contratos futuros e consolidacao automatica."
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
        label="Importacao BMF"
        helper="Selecione a pasta com o arquivo Export para consolidar."
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
          <div className="page-list">
            <button className={`page-number ${tipoMode === 'variavel' ? 'active' : ''}`} type="button" onClick={() => setTipoMode('variavel')}>
              Variavel
            </button>
            <button className={`page-number ${tipoMode === 'independente' ? 'active' : ''}`} type="button" onClick={() => setTipoMode('independente')}>
              Independente
            </button>
          </div>
        </div>
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
            <h3>Entradas BMF</h3>
            <p className="muted">{filteredRows.length} registros no recorte atual.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar conta, cliente ou broker"
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
        <DataTable rows={pagedRows} columns={columns} emptyMessage="Sem dados BMF." />
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

export default RevenueBmf
