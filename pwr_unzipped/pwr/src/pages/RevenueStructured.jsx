import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import { receitaEntries, receitaResumo } from '../data/revenue'
import { formatCurrency, formatDate } from '../utils/format'
import { useToast } from '../hooks/useToast'

const RevenueStructured = () => {
  const { notify } = useToast()
  const [filters, setFilters] = useState({ search: '', cliente: '', assessor: '', ativo: '', estrutura: '' })
  const [showWarnings, setShowWarnings] = useState(true)

  const rows = useMemo(() => {
    return receitaEntries
      .filter((entry) => entry.origem === 'Estruturadas')
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.cliente} ${entry.assessor} ${entry.ativo}`.toLowerCase().includes(query)) return false
        if (filters.cliente && entry.cliente !== filters.cliente) return false
        if (filters.assessor && entry.assessor !== filters.assessor) return false
        if (filters.ativo && entry.ativo !== filters.ativo) return false
        if (filters.estrutura && entry.estrutura !== filters.estrutura) return false
        return true
      })
  }, [filters])

  const columns = useMemo(
    () => [
      { key: 'data', label: 'Data', render: (row) => formatDate(row.data) },
      { key: 'cliente', label: 'Cliente' },
      { key: 'assessor', label: 'Assessor' },
      { key: 'ativo', label: 'Ativo' },
      { key: 'estrutura', label: 'Estrutura' },
      {
        key: 'status',
        label: 'Status',
        render: (row) => {
          const tone = row.status === 'ok' ? 'green' : row.status === 'duplicado' ? 'amber' : 'violet'
          const label = row.status === 'ok' ? 'OK' : row.status === 'duplicado' ? 'Duplicado' : 'Aviso'
          return <Badge tone={tone}>{label}</Badge>
        },
      },
      { key: 'valor', label: 'Valor', render: (row) => formatCurrency(row.valor) },
    ],
    [],
  )

  return (
    <div className="page">
      <PageHeader
        title="Receita Estruturadas"
        subtitle="Controle completo da importacao por pasta e consolidacao mensal."
        meta={[
          { label: 'Periodo selecionado', value: 'Jan 2026' },
          { label: 'Ultima sync', value: receitaResumo.ultimaSync },
          { label: 'Total do mes', value: formatCurrency(receitaResumo.totalMes) },
        ]}
        actions={[{ label: 'Exportar resumo', icon: 'download', variant: 'btn-secondary' }]}
      />

      <SyncPanel label="Sincronizacao Estruturadas" helper="Selecione a pasta da mesa para validar e consolidar." />

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
            placeholder="Cliente"
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
        </div>
        <DataTable rows={rows} columns={columns} emptyMessage="Sem entradas estruturadas." />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Avisos e inconsistencias</h3>
            <p className="muted">{receitaResumo.avisos} alertas precisam de revisao.</p>
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
                <strong>Duplicidades detectadas</strong>
                <p className="muted">Revise 6 entradas com possivel repeticao.</p>
              </div>
              <button className="btn btn-secondary" type="button">Ver detalhes</button>
            </div>
            <div>
              <Icon name="info" size={18} />
              <div>
                <strong>Campos incompletos</strong>
                <p className="muted">2 registros aguardam definicao de assessor.</p>
              </div>
              <button className="btn btn-secondary" type="button">Corrigir agora</button>
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
