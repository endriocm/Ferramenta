import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import { vinculos, vinculoResumo } from '../data/tags'

const Tags = () => {
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    return vinculos.filter((item) => {
      const input = query.toLowerCase()
      if (!input) return true
      return `${item.cliente} ${item.assessor} ${item.broker}`.toLowerCase().includes(input)
    })
  }, [query])

  const columns = useMemo(
    () => [
      { key: 'cliente', label: 'Cliente' },
      { key: 'assessor', label: 'Assessor' },
      { key: 'broker', label: 'Broker' },
      {
        key: 'status',
        label: 'Status',
        render: (row) => {
          const tone = row.status === 'ativo' ? 'green' : row.status === 'pendente' ? 'amber' : 'violet'
          return <Badge tone={tone}>{row.status}</Badge>
        },
      },
    ],
    [],
  )

  return (
    <div className="page">
      <PageHeader
        title="Tags e Vinculos"
        subtitle="Hierarquia Cliente -> Assessor -> Broker com visibilidade total."
        meta={[
          { label: 'Total vinculos', value: vinculoResumo.total },
          { label: 'Atualizados', value: vinculoResumo.atualizados },
          { label: 'Pendentes', value: vinculoResumo.pendentes },
        ]}
        actions={[{ label: 'Atualizar vinculos', icon: 'sync' }]}
      />

      <SyncPanel label="Sincronizacao de Vinculos" helper="Importe o arquivo mestre para atualizar tags." />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Mapa de hierarquia</h3>
            <p className="muted">Visualizacao clara do relacionamento.</p>
          </div>
        </div>
        <div className="hierarchy-grid">
          {rows.map((item) => (
            <div key={`${item.cliente}-${item.assessor}`} className="hierarchy-card">
              <div className="hierarchy-tier">
                <span>Cliente</span>
                <strong>{item.cliente}</strong>
              </div>
              <div className="hierarchy-tier">
                <span>Assessor</span>
                <strong>{item.assessor}</strong>
              </div>
              <div className="hierarchy-tier">
                <span>Broker</span>
                <strong>{item.broker}</strong>
              </div>
              <Badge tone={item.status === 'ativo' ? 'green' : 'amber'}>{item.status}</Badge>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Vinculos detalhados</h3>
            <p className="muted">Impacto direto nos filtros e atribuicao de receita.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input type="search" placeholder="Buscar" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
          </div>
        </div>
        <DataTable rows={rows} columns={columns} emptyMessage="Sem vinculos para exibir." />
      </section>
    </div>
  )
}

export default Tags
