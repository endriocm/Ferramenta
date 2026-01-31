import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Icon from '../components/Icons'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { loadRevenueList, saveRevenueList } from '../services/revenueStore'
import { buildMonthLabel, getMonthKey } from '../services/revenueStructured'
import { useToast } from '../hooks/useToast'

const aggregateByKey = (entries, keyFn) => {
  const map = new Map()
  entries.forEach((entry) => {
    const key = keyFn(entry)
    if (!key) return
    map.set(key, (map.get(key) || 0) + (Number(entry.receita) || 0))
  })
  return map
}

const RevenueBmf = () => {
  const { notify } = useToast()
  const { selectedBroker, tagsIndex } = useGlobalFilters()
  const [entries, setEntries] = useState(() => loadRevenueList('bmf'))
  const [filters, setFilters] = useState({ search: '', conta: '', assessor: '', broker: '' })
  const [tipoMode, setTipoMode] = useState('variavel')
  const [granularity, setGranularity] = useState('monthly')
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
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

  const enrichedEntries = useMemo(
    () => baseEntries.map((entry) => enrichRow(entry, tagsIndex)),
    [baseEntries, tagsIndex],
  )

  const filteredRows = useMemo(() => {
    return enrichedEntries
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.codigoCliente || entry.conta || ''} ${entry.nomeCliente || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase().includes(query)) return false
        if (filters.conta && String(entry.codigoCliente || entry.conta || '').trim() !== String(filters.conta).trim()) return false
        if (filters.assessor && String(entry.assessor || '').trim() !== String(filters.assessor).trim()) return false
        if (filters.broker && String(entry.broker || '').trim() !== String(filters.broker).trim()) return false
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
  }, [filters.search, filters.conta, filters.assessor, filters.broker, tipoMode, granularity, selectedBroker, entries.length])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const totalReceita = useMemo(() => filteredRows.reduce((sum, entry) => sum + (Number(entry.receita) || 0), 0), [filteredRows])
  const totalVolume = useMemo(() => filteredRows.reduce((sum, entry) => sum + (Number(entry.volumeNegociado) || 0), 0), [filteredRows])
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

  const handleSync = useCallback(async (file) => {
    if (syncing) return
    const attemptId = `${Date.now()}-${Math.random()}`
    toastLockRef.current = attemptId
    const notifyOnce = (message, tone) => {
      if (toastLockRef.current !== attemptId) return
      toastLockRef.current = null
      notify(message, tone)
    }
    if (!file) {
      notifyOnce('Selecione o arquivo Export.', 'warning')
      return
    }
    const name = file.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      notifyOnce('Formato invalido. Use .xlsx.', 'warning')
      return
    }
    setSyncing(true)
    setSyncResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
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
  }, [notify, syncing])

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
        actions={[{ label: 'Importar', icon: 'upload' }, { label: 'Exportar', icon: 'download', variant: 'btn-secondary' }]}
      />

      <SyncPanel
        label="Importacao BMF"
        helper="Carregue arquivos e consolide contratos futuros."
        onSync={handleSync}
        running={syncing}
        result={syncResult}
      />

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
                const [year, month, day] = key.split('-')
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
          <input
            className="input"
            placeholder="Conta"
            value={filters.conta}
            onChange={(event) => setFilters((prev) => ({ ...prev, conta: event.target.value }))}
          />
          <input
            className="input"
            placeholder="Assessor"
            value={filters.assessor}
            onChange={(event) => setFilters((prev) => ({ ...prev, assessor: event.target.value }))}
          />
          <input
            className="input"
            placeholder="Broker"
            value={filters.broker}
            onChange={(event) => setFilters((prev) => ({ ...prev, broker: event.target.value }))}
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
