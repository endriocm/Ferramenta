import { useCallback, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import Modal from '../components/Modal'
import Tabs from '../components/Tabs'
import { vencimentos, statusConfig } from '../data/vencimento'
import { formatCurrency, formatDate } from '../utils/format'

const getStatus = (date) => {
  const target = new Date(date)
  const diff = Math.ceil((target.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (diff <= 0) return { key: 'critico', days: diff }
  if (diff <= 7) return { key: 'alerta', days: diff }
  return { key: 'ok', days: diff }
}

const Vencimento = () => {
  const [filters, setFilters] = useState({ search: '', broker: '', assessor: '', cliente: '', status: '' })
  const [selected, setSelected] = useState(null)
  const [tab, setTab] = useState('resumo')

  const rows = useMemo(() => {
    return vencimentos
      .map((entry) => ({ ...entry, status: getStatus(entry.vencimento) }))
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.cliente} ${entry.ativo} ${entry.estrutura}`.toLowerCase().includes(query)) return false
        if (filters.broker && entry.broker !== filters.broker) return false
        if (filters.assessor && entry.assessor !== filters.assessor) return false
        if (filters.cliente && entry.cliente !== filters.cliente) return false
        if (filters.status && entry.status.key !== filters.status) return false
        return true
      })
  }, [filters])

  const totals = useMemo(() => {
    const total = rows.length
    const criticos = rows.filter((row) => row.status.key === 'critico').length
    const alertas = rows.filter((row) => row.status.key === 'alerta').length
    return { total, criticos, alertas }
  }, [rows])

  const columns = useMemo(
    () => [
      { key: 'vencimento', label: 'Data', render: (row) => formatDate(row.vencimento) },
      { key: 'ativo', label: 'Ativo' },
      { key: 'estrutura', label: 'Estrutura' },
      { key: 'cliente', label: 'Cliente' },
      {
        key: 'status',
        label: 'Status',
        render: (row) => {
          const config = statusConfig[row.status.key]
          return <Badge tone={config.tone}>{config.label}</Badge>
        },
      },
      { key: 'barreira', label: 'Barreira' },
      { key: 'cupom', label: 'Cupom' },
    ],
    [],
  )

  const chips = [
    { key: 'broker', label: filters.broker },
    { key: 'assessor', label: filters.assessor },
    { key: 'cliente', label: filters.cliente },
    { key: 'status', label: filters.status },
  ].filter((chip) => chip.label)

  const handleRowClick = useCallback(
    (row) => {
      setSelected(row)
      setTab('resumo')
    },
    [setSelected, setTab],
  )

  return (
    <div className="page">
      <PageHeader
        title="Vencimento de Estruturas"
        subtitle="Visao de mesa para riscos, barreiras e prazos criticos."
        meta={[
          { label: 'Total operacoes', value: totals.total },
          { label: 'Alertas', value: totals.alertas },
          { label: 'Criticos', value: totals.criticos },
        ]}
        actions={[{ label: 'Gerar relatorio', icon: 'doc' }, { label: 'Exportar', icon: 'download', variant: 'btn-secondary' }]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Filtros rapidos</h3>
            <p className="muted">Use chips para limpar e ajustar rapidamente.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar cliente, ativo ou estrutura"
                value={filters.search}
                onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
              />
            </div>
          </div>
        </div>
        <div className="filter-grid">
          <input className="input" placeholder="Broker" value={filters.broker} onChange={(event) => setFilters((prev) => ({ ...prev, broker: event.target.value }))} />
          <input className="input" placeholder="Assessor" value={filters.assessor} onChange={(event) => setFilters((prev) => ({ ...prev, assessor: event.target.value }))} />
          <input className="input" placeholder="Cliente" value={filters.cliente} onChange={(event) => setFilters((prev) => ({ ...prev, cliente: event.target.value }))} />
          <select className="input" value={filters.status} onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))}>
            <option value="">Status</option>
            <option value="ok">Neutro</option>
            <option value="alerta">Alerta</option>
            <option value="critico">Critico</option>
          </select>
        </div>
        {chips.length ? (
          <div className="chip-row">
            {chips.map((chip) => (
              <button
                key={chip.key}
                className="chip"
                onClick={() => setFilters((prev) => ({ ...prev, [chip.key]: '' }))}
                type="button"
              >
                {chip.label}
                <Icon name="close" size={12} />
              </button>
            ))}
            <button className="btn btn-secondary" type="button" onClick={() => setFilters({ search: '', broker: '', assessor: '', cliente: '', status: '' })}>
              Limpar tudo
            </button>
          </div>
        ) : null}
        <DataTable
          rows={rows}
          columns={columns}
          emptyMessage="Nenhuma estrutura encontrada."
          onRowClick={handleRowClick}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Historico e relatorios</h3>
            <p className="muted">Exportacao e auditoria em um clique.</p>
          </div>
          <button className="btn btn-secondary" type="button">Gerar CSV</button>
        </div>
        <div className="history-grid">
          <div className="history-card">
            <strong>Relatorio semanal</strong>
            <span className="muted">Gerado em 24/01/2026</span>
            <button className="btn btn-secondary" type="button">Baixar</button>
          </div>
          <div className="history-card">
            <strong>Operacoes vencidas</strong>
            <span className="muted">Atualizado em 23/01/2026</span>
            <button className="btn btn-secondary" type="button">Baixar</button>
          </div>
        </div>
      </section>

      <Modal
        open={Boolean(selected)}
        title={selected ? `${selected.ativo} - ${selected.estrutura}` : ''}
        subtitle={selected ? `${selected.cliente} | ${formatDate(selected.vencimento)}` : ''}
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <div>
            <Tabs
              tabs={[
                { value: 'resumo', label: 'Resumo' },
                { value: 'detalhes', label: 'Detalhes' },
                { value: 'barreira', label: 'Barreira' },
                { value: 'cupom', label: 'Cupom' },
                { value: 'historico', label: 'Historico' },
              ]}
              active={tab}
              onChange={setTab}
            />
            <div className="modal-grid">
              <div className="modal-column">
                <div className="modal-block">
                  <h4>Status atual</h4>
                  <Badge tone={statusConfig[selected.status.key].tone}>{statusConfig[selected.status.key].label}</Badge>
                  <p className="muted">{Math.abs(selected.status.days)} dias para vencimento.</p>
                </div>
                <div className="modal-block">
                  <h4>Dados principais</h4>
                  <div className="definition-list">
                    <div>
                      <span>Cliente</span>
                      <strong>{selected.cliente}</strong>
                    </div>
                    <div>
                      <span>Assessor</span>
                      <strong>{selected.assessor}</strong>
                    </div>
                    <div>
                      <span>Broker</span>
                      <strong>{selected.broker}</strong>
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-column">
                <div className="modal-block">
                  <h4>Parametros</h4>
                  <div className="definition-list">
                    <div>
                      <span>Barreira</span>
                      <strong>{selected.barreira}</strong>
                    </div>
                    <div>
                      <span>Cupom</span>
                      <strong>{selected.cupom}</strong>
                    </div>
                    <div>
                      <span>P/L</span>
                      <strong>{formatCurrency(selected.pl)}</strong>
                    </div>
                  </div>
                </div>
                <div className="modal-actions">
                  <button className="btn btn-primary" type="button">Aplicar ajuste</button>
                  <button className="btn btn-danger" type="button">Marcar vencido</button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

export default Vencimento
