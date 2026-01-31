import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Icon from '../components/Icons'
import { formatCurrency, formatDate } from '../utils/format'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { buildMonthLabel, getMonthKey, loadStructuredRevenue, saveStructuredRevenue } from '../services/revenueStructured'

const RevenueStructured = () => {
  const { notify } = useToast()
  const { selectedBroker, tagsIndex } = useGlobalFilters()
  const [filters, setFilters] = useState({ search: '', cliente: '', assessor: '', ativo: '', estrutura: '' })
  const [entries, setEntries] = useState(() => loadStructuredRevenue())
  const [periodKey, setPeriodKey] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
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

  const monthOptions = useMemo(() => {
    const keys = Array.from(new Set(entries.map((entry) => getMonthKey(entry.dataEntrada))))
      .filter(Boolean)
      .sort()
    return keys.map((key) => ({ value: key, label: buildMonthLabel(key) }))
  }, [entries])

  const resolvedPeriodKey = useMemo(() => {
    if (periodKey) return periodKey
    const sorted = monthOptions.map((item) => item.value).sort()
    return sorted[sorted.length - 1] || ''
  }, [monthOptions, periodKey])

  const totalMes = useMemo(() => {
    if (!resolvedPeriodKey) return 0
    return entries
      .filter((entry) => getMonthKey(entry.dataEntrada) === resolvedPeriodKey)
      .reduce((sum, entry) => sum + (Number(entry.comissao) || 0), 0)
  }, [entries, resolvedPeriodKey])

  const rows = useMemo(() => {
    return entries
      .map((entry) => enrichRow(entry, tagsIndex))
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.codigoCliente || ''} ${entry.nomeCliente || ''} ${entry.assessor || ''} ${entry.broker || ''} ${entry.ativo || ''} ${entry.estrutura || ''}`.toLowerCase().includes(query)) return false
        if (selectedBroker && entry.broker !== selectedBroker) return false
        if (filters.cliente && entry.codigoCliente !== filters.cliente) return false
        if (filters.assessor && entry.assessor !== filters.assessor) return false
        if (filters.ativo && entry.ativo !== filters.ativo) return false
        if (filters.estrutura && entry.estrutura !== filters.estrutura) return false
        if (resolvedPeriodKey && getMonthKey(entry.dataEntrada) !== resolvedPeriodKey) return false
        return true
      })
  }, [entries, filters, resolvedPeriodKey, selectedBroker, tagsIndex])

  const pageSize = 100
  const [page, setPage] = useState(1)
  const totalPages = useMemo(() => Math.max(1, Math.ceil(rows.length / pageSize)), [rows.length, pageSize])
  const pageStart = (page - 1) * pageSize
  const pagedRows = useMemo(() => rows.slice(pageStart, pageStart + pageSize), [rows, pageStart, pageSize])

  useEffect(() => {
    setPage(1)
  }, [filters.search, filters.cliente, filters.assessor, filters.ativo, filters.estrutura, resolvedPeriodKey, selectedBroker, entries.length])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

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
      notifyOnce('Selecione o arquivo Operacoes.', 'warning')
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
      if (debugEnabled) {
        console.info('[receita-estruturadas] sync:start', { name: file.name, size: file.size })
      }
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch('/api/receitas/estruturadas/import', {
        method: 'POST',
        body: formData,
      })
      const contentType = response.headers.get('content-type') || ''
      const isJson = contentType.includes('application/json')
      const payload = isJson ? await response.json().catch(() => ({})) : null
      const responseText = !isJson ? await response.text().catch(() => '') : ''
      if (!response.ok || payload?.ok === false) {
        const missing = payload?.error?.details?.missing?.length
          ? ` Colunas faltando: ${payload.error.details.missing.join(', ')}`
          : payload?.missingColumns?.length
            ? ` Colunas faltando: ${payload.missingColumns.join(', ')}`
            : ''
        const message = response.status === 404
          ? 'Endpoint de importacao nao existe no ambiente atual.'
          : payload?.error?.message
            ? `${payload.error.message}${missing}`
            : payload?.error
              ? `${payload.error}${missing}`
              : isJson
                ? `Falha ao importar (status ${response.status}).`
                : `Resposta nao JSON (status ${response.status}).`
        notifyOnce(message, 'warning')
        if (debugEnabled) console.error('[receita-estruturadas] sync:error', { status: response.status, payload, responseText })
        return
      }
      const nextEntries = Array.isArray(payload.entries) ? payload.entries : []
      setEntries(nextEntries)
      saveStructuredRevenue(nextEntries)
      const stats = payload.summary || payload.stats || {}
      const monthFromStats = stats.months?.[stats.months.length - 1] || ''
      if (monthFromStats) setPeriodKey(monthFromStats)
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
  }, [debugEnabled, notify, resolvedPeriodKey, syncing])

  return (
    <div className="page">
      <PageHeader
        title="Receita Estruturadas"
        subtitle="Controle completo da importacao por pasta e consolidacao mensal."
        meta={[
          { label: 'Periodo selecionado', value: resolvedPeriodKey ? buildMonthLabel(resolvedPeriodKey) : '?' },
          { label: 'Entradas', value: rows.length },
          { label: 'Total do mes', value: formatCurrency(totalMes) },
          { label: 'Ultima sync', value: lastSyncAt || '?' },
        ]}
        actions={[{ label: 'Exportar resumo', icon: 'download', variant: 'btn-secondary' }]}
      />

      <SyncPanel
        label="Sincronizacao Estruturadas"
        helper="Selecione o arquivo Operacoes para validar e consolidar."
        onSync={handleSync}
        running={syncing}
        result={syncResult}
      />

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
                setFilters({ search: '', cliente: '', assessor: '', ativo: '', estrutura: '' })
                setPeriodKey('')
                notify('Filtros limpos com sucesso.', 'success')
              }}
            >
              Limpar filtros
            </button>
          </div>
        </div>
        <div className="filter-grid">
          <input
            className="input"
            placeholder="Codigo cliente"
            value={filters.cliente}
            onChange={(event) => setFilters((prev) => ({ ...prev, cliente: event.target.value }))}
          />
          <input
            className="input"
            placeholder="Assessor"
            value={filters.assessor}
            onChange={(event) => setFilters((prev) => ({ ...prev, assessor: event.target.value }))}
          />
          <input
            className="input"
            placeholder="Ativo"
            value={filters.ativo}
            onChange={(event) => setFilters((prev) => ({ ...prev, ativo: event.target.value }))}
          />
          <input
            className="input"
            placeholder="Estrutura"
            value={filters.estrutura}
            onChange={(event) => setFilters((prev) => ({ ...prev, estrutura: event.target.value }))}
          />
          <select
            className="input"
            value={periodKey}
            onChange={(event) => setPeriodKey(event.target.value)}
          >
            <option value="">Periodo</option>
            {monthOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
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
