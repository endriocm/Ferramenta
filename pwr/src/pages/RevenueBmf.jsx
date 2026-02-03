import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Icon from '../components/Icons'
import Modal from '../components/Modal'
import MultiSelect from '../components/MultiSelect'
import { formatCurrency, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { loadRevenueList, saveRevenueList } from '../services/revenueStore'
import { buildMonthLabel, getMonthKey } from '../services/revenueStructured'
import { useToast } from '../hooks/useToast'
import { filterByApuracaoMonths } from '../services/apuracao'
import { exportXlsx } from '../services/exportXlsx'

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
  const [filters, setFilters] = useState({ search: '', conta: [], assessor: [], broker: [] })
  const [tipoMode, setTipoMode] = useState('variavel')
  const [granularity, setGranularity] = useState('monthly')
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
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

  const filteredRows = useMemo(() => {
    return enrichedEntries
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.codigoCliente || entry.conta || ''} ${entry.nomeCliente || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase().includes(query)) return false
        if (filters.conta.length && !filters.conta.includes(String(entry.codigoCliente || entry.conta || '').trim())) return false
        if (filters.assessor.length && !filters.assessor.includes(String(entry.assessor || '').trim())) return false
        if (filters.broker.length && !filters.broker.includes(String(entry.broker || '').trim())) return false
        if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
        return true
      })
      .sort((a, b) => (Number(b.corretagem) || 0) - (Number(a.corretagem) || 0))
  }, [enrichedEntries, filters, selectedBroker])

  const pageSize = 100
  const [page, setPage] = useState(1)
  const totalPages = useMemo(() => Math.max(1, Math.ceil(filteredRows.length / pageSize)), [filteredRows.length, pageSize])
  const pageStart = (page - 1) * pageSize
  const pagedRows = useMemo(() => filteredRows.slice(pageStart, pageStart + pageSize), [filteredRows, pageStart, pageSize])

  useEffect(() => {
    setPage(1)
  }, [filters.search, filters.conta, filters.assessor, filters.broker, tipoMode, granularity, selectedBroker, entries.length, apuracaoMonths])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    if (granularity === 'daily' && (apuracaoMonths.all || apuracaoMonths.months.length !== 1)) {
      setGranularity('monthly')
    }
  }, [apuracaoMonths, granularity])

  const totalReceita = useMemo(() => filteredRows.reduce((sum, entry) => sum + (Number(entry.receita) || 0), 0), [filteredRows])
  const totalVolume = useMemo(() => filteredRows.reduce((sum, entry) => sum + Math.abs(Number(entry.volumeNegociado) || 0), 0), [filteredRows])
  const uniqueContas = useMemo(() => new Set(filteredRows.map((entry) => String(entry.codigoCliente || entry.conta || '').trim()).filter(Boolean)), [filteredRows])

  const resolvedPeriodKey = useMemo(() => {
    const keys = Array.from(new Set(filteredRows.map((entry) => getMonthKey(normalizeDateKey(entry.data || entry.dataEntrada)))))
      .filter(Boolean)
      .sort()
    return keys[keys.length - 1] || ''
  }, [filteredRows])

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
    const periodLabel = resolvedPeriodKey ? resolvedPeriodKey : 'periodo'
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const safePeriod = String(periodLabel).replace(/[^0-9a-zA-Z_-]/g, '')
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
    try {
      const formData = new FormData()
      formData.append('file', targetFile)
      const response = await fetch('/api/receitas/bmf/import', {
        method: 'POST',
        body: formData,
      })
      const contentType = response.headers.get('content-type') || ''
      const isJson = contentType.includes('application/json')
      const payload = isJson ? await response.json().catch(() => ({})) : null
      if (!response.ok || payload?.ok === false) {
        const missing = payload?.error?.details?.missing?.length
          ? ` Colunas faltando: ${payload.error.details.missing.join(', ')}`
          : ''
        const message = response.status === 404
          ? 'Endpoint de importacao nao existe no ambiente atual.'
          : payload?.error?.message
            ? `${payload.error.message}${missing}`
            : isJson
              ? `Falha ao importar (status ${response.status}).`
              : `Resposta nao JSON (status ${response.status}).`
        notifyOnce(message, 'warning')
        return
      }
      const nextEntries = Array.isArray(payload.entries) ? payload.entries : []
      setEntries(nextEntries)
      saveRevenueList('bmf', nextEntries)
      const stats = payload.summary || payload.stats || {}
      setSyncResult({
        importados: stats.rowsValid ?? nextEntries.length,
        duplicados: 0,
        rejeitados: stats.rowsFiltered ?? 0,
        avisos: 0,
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
    }
  }, [notify, selectedFile, syncing])

  return (
    <div className="page">
      <PageHeader
        title="Receita BMF"
        subtitle="Monitoramento de contratos futuros e consolidacao automatica."
        meta={[
          { label: 'Periodo selecionado', value: resolvedPeriodKey ? buildMonthLabel(resolvedPeriodKey) : '?' },
          { label: 'Ultima sync', value: lastSyncAt || '?' },
          { label: 'Total do mes', value: formatCurrency(totalReceita) },
        ]}
        actions={[{ label: 'Exportar', icon: 'download', variant: 'btn-secondary', onClick: handleExportTable }]}
      />

      <SyncPanel
        label="Importacao BMF"
        helper="Selecione a pasta com o arquivo Export para consolidar."
        onSync={handleSync}
        running={syncing}
        result={syncResult}
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
