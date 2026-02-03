import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Icon from '../components/Icons'
import Modal from '../components/Modal'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { buildMonthLabel, getMonthKey, loadStructuredRevenue, saveStructuredRevenue } from '../services/revenueStructured'
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
  const [selectedDays, setSelectedDays] = useState([])
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
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

  const buildDateTree = (items) => {
    const years = new Map()
    const allValues = new Set()
    items.forEach((item) => {
      const key = normalizeDateKey(item?.dataEntrada)
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
              label: key.split('-')[2],
              value: key,
              values: [key],
            }))
            return {
              key: `${year}-${month}`,
              label: buildMonthLabel(`${year}-${month}`),
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

  const apuracaoEntries = useMemo(
    () => filterByApuracaoMonths(entries, apuracaoMonths, (entry) => entry.dataEntrada),
    [entries, apuracaoMonths],
  )

  const allDays = useMemo(
    () => Array.from(new Set(apuracaoEntries.map((entry) => normalizeDateKey(entry.dataEntrada)))).filter(Boolean).sort(),
    [apuracaoEntries],
  )

  const monthOptions = useMemo(() => {
    const keys = Array.from(new Set(allDays.map((key) => getMonthKey(key))))
      .filter(Boolean)
      .sort()
    return keys.map((key) => ({ value: key, label: buildMonthLabel(key) }))
  }, [allDays])

  const resolvedPeriodKey = useMemo(() => {
    if (selectedDays.length) {
      const months = Array.from(new Set(selectedDays.map((key) => getMonthKey(key))))
      return months.length === 1 ? months[0] : 'multi'
    }
    const sorted = monthOptions.map((item) => item.value).sort()
    return sorted[sorted.length - 1] || ''
  }, [monthOptions, selectedDays])

  const defaultMonthDays = useMemo(() => {
    if (!resolvedPeriodKey || resolvedPeriodKey === 'multi') return []
    return allDays.filter((key) => getMonthKey(key) === resolvedPeriodKey)
  }, [allDays, resolvedPeriodKey])

  const effectiveDays = selectedDays.length ? selectedDays : defaultMonthDays

  const totalMes = useMemo(() => {
    if (!effectiveDays.length) return 0
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

  const periodTree = useMemo(() => buildDateTree(enrichedEntries), [enrichedEntries])

  const vencimentoCache = useMemo(() => loadLastImported(userKey), [userKey])
  const vencimentoIndex = useMemo(
    () => buildVencimentoIndex(vencimentoCache?.rows || []),
    [vencimentoCache],
  )

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
  }, [filters.search, filters.cliente, filters.assessor, filters.ativo, filters.estrutura, filters.broker, selectedDays, selectedBroker, apuracaoMonths, entries.length])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    setSelectedDays([])
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
    try {
      if (debugEnabled) {
        console.info('[receita-estruturadas] sync:start', { name: targetFile.name, size: targetFile.size })
      }
      const result = await parseStructuredReceitasFile(targetFile)
      if (!result.ok) {
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
      const monthFromStats = stats.months?.[stats.months.length - 1] || ''
      if (monthFromStats) {
        const nextDays = nextEntries
          .map((entry) => normalizeDateKey(entry.dataEntrada))
          .filter((key) => key && getMonthKey(key) === monthFromStats)
        setSelectedDays(Array.from(new Set(nextDays)))
      }
      const periodKeyResolved = monthFromStats || resolvedPeriodKey
      const periodEntries = periodKeyResolved
        ? nextEntries.filter((entry) => getMonthKey(entry.dataEntrada) === periodKeyResolved)
        : nextEntries
      setSyncResult({
        importados: periodEntries.length,
        duplicados: 0,
        rejeitados: stats.rowsSkipped ?? 0,
        avisos: 0,
      })
      const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
      setLastSyncAt(now)
      try {
        localStorage.setItem('pwr.receita.estruturadas.lastSyncAt', now)
      } catch {
        // noop
      }
      notifyOnce(`Importacao concluida. ${periodEntries.length} linhas validas.`, 'success')
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
    }
  }, [debugEnabled, notify, resolvedPeriodKey, selectedFile, syncing])

  return (
    <div className="page">
      <PageHeader
        title="Receita Estruturadas"
        subtitle="Controle completo da importacao por pasta e consolidacao mensal."
        meta={[
          { label: 'Periodo selecionado', value: resolvedPeriodKey === 'multi' ? 'Varios periodos' : (resolvedPeriodKey ? buildMonthLabel(resolvedPeriodKey) : '?') },
          { label: 'Entradas', value: rows.length },
          { label: 'Total do mes', value: formatCurrency(totalMes) },
          { label: 'Ultima sync', value: lastSyncAt || '?' },
        ]}
        actions={[{ label: 'Exportar resumo', icon: 'download', variant: 'btn-secondary', onClick: handleExportTable }]}
      />

      <SyncPanel
        label="Sincronizacao Estruturadas"
        helper="Selecione a pasta com a planilha Operacoes para validar e consolidar."
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
                setSelectedDays([])
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
          <TreeSelect
            value={selectedDays}
            tree={periodTree.tree}
            allValues={periodTree.allValues}
            onChange={setSelectedDays}
            placeholder="Periodo"
            searchable={false}
          />
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
