import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Modal from '../components/Modal'
import { useToast } from '../hooks/useToast'
import useGlobalFolderMenu from '../hooks/useGlobalFolderMenu'
import { formatCurrency } from '../utils/format'
import { getTagIndex } from '../lib/tagsStore'
import { exportXlsx } from '../services/exportXlsx'
import { parseXpCommissionFile } from '../services/revenueImport'
import {
  XP_TEMPLATE_HEADERS,
  listXpMonths,
  loadXpOverrideState,
  loadXpRevenue,
  saveXpRevenue,
  setXpOverrideEnabled,
} from '../services/revenueXpCommission'
import { filterSpreadsheetCandidates, normalizeFileName } from '../utils/spreadsheet'

const LAST_SYNC_KEY = 'pwr.receita.xp.lastSyncAt'
const PAGE_SIZE = 30

const resolveLineLabel = (line) => {
  if (line === 'Bovespa') return 'Bovespa'
  if (line === 'BMF') return 'BMF'
  if (line === 'Estruturadas') return 'Estruturadas'
  return line || '-'
}

const RevenueXpCommission = () => {
  const { notify } = useToast()
  const globalFolderMenu = useGlobalFolderMenu('comissao-xp')
  const [entries, setEntries] = useState([])
  const [overrideEnabled, setOverrideEnabledState] = useState(() => loadXpOverrideState().enabled)
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileCandidates, setFileCandidates] = useState([])
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [syncProgress, setSyncProgress] = useState({ processed: 0, total: 0, progress: 0 })
  const [page, setPage] = useState(1)
  const [lastSyncAt, setLastSyncAt] = useState(() => {
    try {
      return localStorage.getItem(LAST_SYNC_KEY) || ''
    } catch {
      return ''
    }
  })

  const abortRef = useRef(null)

  useEffect(() => {
    setEntries(loadXpRevenue())
  }, [])

  useEffect(() => {
    const handleRevenueUpdate = () => {
      setEntries(loadXpRevenue())
      setOverrideEnabledState(loadXpOverrideState().enabled)
    }
    window.addEventListener('pwr:receita-updated', handleRevenueUpdate)
    return () => window.removeEventListener('pwr:receita-updated', handleRevenueUpdate)
  }, [])

  const months = useMemo(() => listXpMonths(entries), [entries])
  const totalCommission = useMemo(
    () => entries.reduce((sum, entry) => sum + (Number(entry.comissao) || 0), 0),
    [entries],
  )

  const countsByLine = useMemo(() => {
    return entries.reduce((acc, entry) => {
      const line = resolveLineLabel(entry.line)
      acc[line] = (acc[line] || 0) + 1
      return acc
    }, { Bovespa: 0, BMF: 0, Estruturadas: 0 })
  }, [entries])

  const totalRows = entries.length
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageStart = totalRows ? (safePage - 1) * PAGE_SIZE + 1 : 0
  const pageEnd = totalRows ? Math.min(safePage * PAGE_SIZE, totalRows) : 0
  const pagedEntries = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE
    return entries.slice(start, start + PAGE_SIZE)
  }, [entries, safePage])

  useEffect(() => {
    setPage(1)
  }, [entries.length])

  const headerMeta = useMemo(() => ([
    { label: 'Linhas', value: entries.length },
    { label: 'Meses', value: months.length },
    { label: 'Total liquido', value: formatCurrency(totalCommission) },
    { label: 'Sobreposicao XP', value: overrideEnabled ? 'ON' : 'OFF' },
    { label: 'Ultima sync', value: lastSyncAt || '?' },
  ]), [entries.length, lastSyncAt, months.length, overrideEnabled, totalCommission])

  const directoryFilterOptions = useMemo(
    () => globalFolderMenu.directoryOptions.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.directory?.folderPath || '',
    })),
    [globalFolderMenu.directoryOptions],
  )

  const directoryOptionsEmptyMessage = useMemo(() => {
    if (globalFolderMenu.loading) return ''
    return globalFolderMenu.emptyMessage
  }, [globalFolderMenu.emptyMessage, globalFolderMenu.loading])

  const columns = useMemo(() => ([
    { key: 'data', label: 'Data' },
    { key: 'line', label: 'Linha', render: (row) => resolveLineLabel(row.line) },
    { key: 'codigoCliente', label: 'Conta', render: (row) => row.codigoCliente || row.conta || '-' },
    { key: 'assessor', label: 'Assessor', render: (row) => row.assessor || '-' },
    { key: 'broker', label: 'Broker', render: (row) => row.broker || '-' },
    { key: 'time', label: 'Time', render: (row) => row.time || '-' },
    { key: 'unit', label: 'Unidade', render: (row) => row.unit || '-' },
    { key: 'seniority', label: 'Senioridade', render: (row) => row.seniority || '-' },
    { key: 'comissao', label: 'Comissao', render: (row) => formatCurrency(row.comissao) },
  ]), [])

  const handleFolderSelection = useCallback((files) => {
    const candidates = filterSpreadsheetCandidates(files)
    if (!candidates.length) {
      setSelectedFile(null)
      setFileCandidates([])
      setIsPickerOpen(false)
      notify('Nenhuma planilha .xlsx/.xls valida foi encontrada.', 'warning')
      return null
    }

    const hintMatches = candidates.filter((file) => {
      const normalized = normalizeFileName(file.name)
      return normalized.includes('xp') || normalized.includes('comissao')
    })

    if (hintMatches.length === 1) {
      setSelectedFile(hintMatches[0])
      setFileCandidates([])
      setIsPickerOpen(false)
      return hintMatches[0]
    }
    if (candidates.length === 1) {
      setSelectedFile(candidates[0])
      setFileCandidates([])
      setIsPickerOpen(false)
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

  const handleToggleOverride = useCallback(async () => {
    const next = !overrideEnabled
    await setXpOverrideEnabled(next)
    setOverrideEnabledState(next)
    notify(`Sobreposicao XP ${next ? 'ativada' : 'desativada'}.`, 'success')
  }, [notify, overrideEnabled])

  const handleDownloadTemplate = useCallback(async () => {
    const sampleRow = [
      '01/01/2025',
      '17/01/2025',
      '123456',
      'PF',
      'R$ 1.234,56',
      'Mesa RV',
      'Sim',
      'Assessor Exemplo',
      'A12345',
      'A12345',
      'INVESTIMENTOS',
      'BOVESPA',
      'Mesa',
      '',
      '',
      '',
      'R$ 1.500,00',
      'R$ 1.425,00',
      '83',
      'Broker Exemplo',
      'Senior',
      'Time Exemplo',
    ]

    await exportXlsx({
      fileName: 'modelo_comissao_xp.xlsx',
      sheetName: 'Planilha1',
      columns: XP_TEMPLATE_HEADERS,
      rows: [sampleRow],
    })
    notify('Modelo XP exportado.', 'success')
  }, [notify])

  const handleSync = useCallback(async (file) => {
    if (syncing) return
    let targetFile = file || selectedFile || globalFolderMenu.resolvedFile
    if (!targetFile) targetFile = await globalFolderMenu.refreshFile()
    if (!targetFile) {
      notify('Selecione o arquivo da comissao XP.', 'warning')
      return
    }

    setSyncing(true)
    setSyncResult(null)
    setSyncProgress({ processed: 0, total: 0, progress: 0 })
    const controller = new AbortController()
    abortRef.current = controller

    try {
      let parseInput = targetFile
      if (targetFile?.source === 'electron' && targetFile?.filePath) {
        if (!window?.electronAPI?.readFile) {
          throw new Error('Leitura de arquivo indisponivel no modo atual.')
        }
        parseInput = await window.electronAPI.readFile(targetFile.filePath)
      }
      const tagIndex = await getTagIndex()
      const response = await parseXpCommissionFile(parseInput, {
        signal: controller.signal,
        tagIndex,
        onProgress: ({ processed, rawRows, progress }) => {
          setSyncProgress({ processed, total: rawRows || 0, progress: progress || 0 })
        },
      })

      const stats = response?.summary?.stats || {}
      const warnings = stats.warnings || []
      const details = stats.details || {}

      if (!response?.ok) {
        if (response?.error?.code === 'CANCELLED') {
          const integrity = stats.integrity || {}
          setSyncResult({
            moduleLabel: 'Comissao XP',
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
          notify('Importacao cancelada.', 'warning')
          return
        }

        const missingColumns = response?.error?.details?.missing?.length
          ? ` Colunas faltando: ${response.error.details.missing.join(', ')}`
          : ''
        notify(
          response?.error?.message
            ? `${response.error.message}${missingColumns}`
            : 'Falha ao importar a planilha XP.',
          'warning',
        )
        return
      }

      const nextEntries = Array.isArray(response.entries) ? response.entries : []
      const savedEntries = await saveXpRevenue(nextEntries)
      setEntries(savedEntries)

      const integrity = stats.integrity || {}
      setSyncResult({
        moduleLabel: 'Comissao XP',
        importados: stats.savedRows ?? savedEntries.length,
        duplicados: stats.duplicatedRows ?? 0,
        rejeitados: stats.rejectedRows ?? response.summary?.rowsRejected ?? 0,
        avisos: warnings.length,
        warnings,
        details,
        extra: [
          { label: 'Linhas no Excel', value: integrity.estimatedDataRows ?? 0 },
          { label: 'Linhas lidas (raw)', value: integrity.rawRows ?? stats.rawRows ?? response.summary?.rowsRead ?? 0 },
          { label: 'Processadas', value: integrity.processedRows ?? stats.processedRows ?? 0 },
          { label: 'Salvas', value: integrity.savedRows ?? stats.savedRows ?? savedEntries.length },
          { label: 'Divergencia', value: integrity.mismatch ?? 0 },
          { label: 'Enriquecidas (Tags)', value: stats.enrichedRows ?? 0 },
          { label: 'Auto-corrigidas', value: stats.autoFixedRows ?? 0 },
          { label: 'Bovespa (linhas)', value: response.summary?.lineCounts?.bovespa ?? 0 },
          { label: 'BMF (linhas)', value: response.summary?.lineCounts?.bmf ?? 0 },
          { label: 'Estruturadas (linhas)', value: response.summary?.lineCounts?.estruturadas ?? 0 },
          { label: 'Comissao Bovespa', value: formatCurrency(response.summary?.totalsByLine?.bovespa || 0) },
          { label: 'Comissao BMF', value: formatCurrency(response.summary?.totalsByLine?.bmf || 0) },
          { label: 'Comissao Estruturadas', value: formatCurrency(response.summary?.totalsByLine?.estruturadas || 0) },
        ],
      })

      const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
      setLastSyncAt(now)
      try {
        localStorage.setItem(LAST_SYNC_KEY, now)
      } catch {
        // noop
      }
      notify(`Importacao XP concluida. ${savedEntries.length} linhas validas.`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar planilha XP.', 'warning')
    } finally {
      setSyncing(false)
      abortRef.current = null
    }
  }, [globalFolderMenu, notify, selectedFile, syncing])

  return (
    <div className="page">
      <PageHeader
        title="Receita Comissao XP"
        subtitle="Importe o relatorio de comissao liquida da XP e ative sobreposicao mensal global."
        meta={headerMeta}
        actions={[
          {
            label: overrideEnabled ? 'Sobreposicao XP: ON' : 'Sobreposicao XP: OFF',
            icon: 'sync',
            variant: overrideEnabled ? 'btn-primary' : 'btn-secondary',
            onClick: handleToggleOverride,
          },
          {
            label: 'Baixar modelo XP',
            icon: 'download',
            variant: 'btn-secondary',
            onClick: handleDownloadTemplate,
          },
        ]}
      />

      <SyncPanel
        label="Importacao Comissao XP"
        helper="Use um arquivo ja importado no catalogo central."
        onSync={handleSync}
        onCancel={handleCancelSync}
        running={syncing}
        result={syncResult}
        progress={syncProgress.progress}
        progressInfo={syncProgress.total ? { processed: syncProgress.processed, total: syncProgress.total } : null}
        selectedFile={selectedFile || globalFolderMenu.resolvedFile}
        onSelectedFileChange={setSelectedFile}
        linkedFileOptions={directoryFilterOptions}
        linkedFileValue={globalFolderMenu.directoryValue}
        onLinkedFileChange={(value) => {
          setSelectedFile(null)
          globalFolderMenu.onDirectoryChange(value)
        }}
        linkedFileLabel="Arquivo importado"
        linkedFileEmptyMessage={directoryOptionsEmptyMessage}
        hideLocalPicker
      />

      <Modal
        open={isPickerOpen}
        onClose={handleClosePicker}
        title="Escolher arquivo"
        subtitle="Encontramos mais de um arquivo valido na selecao."
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
            <h3>Meses cobertos</h3>
            <p className="muted">A sobreposicao global usa estes meses quando estiver ON.</p>
          </div>
        </div>
        <div className="mini-grid">
          <div className="card mini-card">
            <div className="mini-label">Bovespa (linhas)</div>
            <div className="mini-value">{countsByLine.Bovespa || 0}</div>
          </div>
          <div className="card mini-card">
            <div className="mini-label">BMF (linhas)</div>
            <div className="mini-value">{countsByLine.BMF || 0}</div>
          </div>
          <div className="card mini-card">
            <div className="mini-label">Estruturadas (linhas)</div>
            <div className="mini-value">{countsByLine.Estruturadas || 0}</div>
          </div>
          <div className="card mini-card">
            <div className="mini-label">Meses</div>
            <div className="mini-value" style={{ fontSize: '0.98rem' }}>{months.length ? months.join(', ') : '-'}</div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Preview da importacao XP</h3>
            <p className="muted">{entries.length} linha(s) carregada(s).</p>
          </div>
          <div className="panel-actions">
            <span className="muted">
              Mostrando {pageStart}-{pageEnd} de {totalRows}
            </span>
          </div>
        </div>
        <DataTable rows={pagedEntries} columns={columns} emptyMessage="Nenhuma comissao XP importada." />
        {totalPages > 1 ? (
          <div className="panel-actions">
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

export default RevenueXpCommission
