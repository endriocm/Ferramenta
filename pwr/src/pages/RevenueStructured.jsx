import { useCallback, useMemo, useState } from 'react'
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
  const [showWarnings, setShowWarnings] = useState(true)

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
        if (query && !`${entry.codigoCliente || ''} ${entry.assessor || ''} ${entry.ativo || ''} ${entry.estrutura || ''}`.toLowerCase().includes(query)) return false
        if (selectedBroker && entry.broker !== selectedBroker) return false
        if (filters.cliente && entry.codigoCliente !== filters.cliente) return false
        if (filters.assessor && entry.assessor !== filters.assessor) return false
        if (filters.ativo && entry.ativo !== filters.ativo) return false
        if (filters.estrutura && entry.estrutura !== filters.estrutura) return false
        if (resolvedPeriodKey && getMonthKey(entry.dataEntrada) !== resolvedPeriodKey) return false
        return true
      })
  }, [entries, filters, resolvedPeriodKey, selectedBroker, tagsIndex])

  const columns = useMemo(
    () => [
      { key: 'codigoCliente', label: 'Codigo cliente', render: (row) => row.codigoCliente || '?' },
      { key: 'dataEntrada', label: 'Data de entrada', render: (row) => formatDate(row.dataEntrada) },
      { key: 'estrutura', label: 'Estrutura' },
      { key: 'ativo', label: 'Ativo' },
      { key: 'vencimento', label: 'Vencimento', render: (row) => formatDate(row.vencimento) },
      { key: 'comissao', label: 'Comissao', render: (row) => formatCurrency(row.comissao) },
    ],
    [],
  )

  const handleSync = useCallback(async (file) => {
    if (!file) {
      notify('Selecione o arquivo Operacoes.', 'warning')
      return
    }
    const name = file.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      notify('Formato invalido. Use .xlsx.', 'warning')
      return
    }
    setSyncing(true)
    setSyncResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch('/api/receitas/estruturadas/import', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        const missing = payload?.missingColumns?.length
          ? ` Colunas faltando: ${payload.missingColumns.join(', ')}`
          : ''
        notify(payload?.error ? `${payload.error}${missing}` : 'Falha ao importar.', 'warning')
        return
      }
      const payload = await response.json()
      const nextEntries = Array.isArray(payload.entries) ? payload.entries : []
      setEntries(nextEntries)
      saveStructuredRevenue(nextEntries)
      const stats = payload.stats || {}
      setSyncResult({
        importados: stats.rowsValid ?? nextEntries.length,
        duplicados: 0,
        rejeitados: stats.rowsSkipped ?? 0,
        avisos: 0,
      })
      notify(`Importacao concluida. ${stats.rowsValid ?? nextEntries.length} linhas validas.`, 'success')
      if (stats.months?.length) {
        setPeriodKey(stats.months[stats.months.length - 1])
      }
    } catch {
      notify('Falha ao importar a planilha.', 'warning')
    } finally {
      setSyncing(false)
    }
  }, [notify])

  return (
    <div className="page">
      <PageHeader
        title="Receita Estruturadas"
        subtitle="Controle completo da importacao por pasta e consolidacao mensal."
        meta={[
          { label: 'Periodo selecionado', value: resolvedPeriodKey ? buildMonthLabel(resolvedPeriodKey) : '?' },
          { label: 'Entradas', value: rows.length },
          { label: 'Total do mes', value: formatCurrency(totalMes) },
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
        <DataTable rows={rows} columns={columns} emptyMessage="Sem entradas estruturadas." />
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
