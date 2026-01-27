import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import { receitaEntries, receitaResumo } from '../data/revenue'
import { formatCurrency, formatDate } from '../utils/format'

const RevenueBovespa = () => {
  const [filters, setFilters] = useState({ search: '', ativo: '', cliente: '' })

  const rows = useMemo(() => {
    return receitaEntries
      .filter((entry) => entry.origem === 'Bovespa')
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.cliente} ${entry.ativo}`.toLowerCase().includes(query)) return false
        if (filters.ativo && entry.ativo !== filters.ativo) return false
        if (filters.cliente && entry.cliente !== filters.cliente) return false
        return true
      })
  }, [filters])

  const columns = useMemo(
    () => [
      { key: 'data', label: 'Data', render: (row) => formatDate(row.data) },
      { key: 'cliente', label: 'Cliente' },
      { key: 'ativo', label: 'Ativo' },
      { key: 'estrutura', label: 'Estrutura' },
      {
        key: 'status',
        label: 'Status',
        render: (row) => (
          <Badge tone={row.status === 'duplicado' ? 'amber' : 'green'}>
            {row.status === 'duplicado' ? 'Duplicado' : 'OK'}
          </Badge>
        ),
      },
      { key: 'valor', label: 'Valor', render: (row) => formatCurrency(row.valor) },
    ],
    [],
  )

  return (
    <div className="page">
      <PageHeader
        title="Receita Bovespa"
        subtitle="Importacao rapida e consolidacao para operacoes Bovespa."
        meta={[
          { label: 'Periodo selecionado', value: 'Jan 2026' },
          { label: 'Ultima sync', value: receitaResumo.ultimaSync },
          { label: 'Total do mes', value: formatCurrency(6420000) },
        ]}
        actions={[{ label: 'Nova importacao', icon: 'upload' }, { label: 'Exportar', icon: 'download', variant: 'btn-secondary' }]}
      />

      <SyncPanel label="Importacao Bovespa" helper="Valide arquivos estruturados e consolide o resultado." />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Entradas Bovespa</h3>
            <p className="muted">{rows.length} registros neste periodo.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar cliente ou ativo"
                value={filters.search}
                onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
              />
            </div>
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
            placeholder="Ativo"
            value={filters.ativo}
            onChange={(event) => setFilters((prev) => ({ ...prev, ativo: event.target.value }))}
          />
        </div>
        <DataTable rows={rows} columns={columns} emptyMessage="Sem dados Bovespa." />
      </section>
    </div>
  )
}

export default RevenueBovespa
