import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import { formatCurrency, formatDate } from '../utils/format'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { loadManualRevenue, removeManualRevenue } from '../services/revenueStore'
import { filterByApuracaoMonths } from '../services/apuracao'

const RevenueManual = () => {
  const { notify } = useToast()
  const { selectedBroker, tagsIndex, apuracaoMonths } = useGlobalFilters()
  const [entries, setEntries] = useState(() => loadManualRevenue())
  const handleDelete = (row) => {
    const nextEntries = removeManualRevenue(row.id)
    setEntries(nextEntries)
    notify('Lancamento removido.', 'success')
  }

  const columns = useMemo(
    () => [
      { key: 'data', label: 'Data', render: (row) => formatDate(row.data) },
      { key: 'cliente', label: 'Cliente', render: (row) => row.nomeCliente || row.cliente },
      { key: 'assessor', label: 'Assessor' },
      { key: 'broker', label: 'Broker', render: (row) => row.broker || '—' },
      { key: 'ativo', label: 'Ativo' },
      { key: 'valor', label: 'Valor', render: (row) => formatCurrency(row.valor) },
      { key: 'status', label: 'Status', render: () => <Badge tone="green">OK</Badge> },
      {
        key: 'acoes',
        label: 'Acoes',
        render: (row) => (
          <button className="icon-btn" type="button" onClick={() => handleDelete(row)} aria-label="Remover lancamento">
            <Icon name="x" size={14} />
          </button>
        ),
      },
    ],
    [handleDelete],
  )

  const rows = useMemo(() => {
    const scoped = filterByApuracaoMonths(entries, apuracaoMonths, (entry) => entry.data || entry.dataEntrada)
    return scoped
      .map((entry) => enrichRow(entry, tagsIndex))
      .filter((entry) => {
        if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
        return true
      })
  }, [entries, selectedBroker, tagsIndex, apuracaoMonths])

  return (
    <div className="page">
      <PageHeader
        title="Receita Manual"
        subtitle="Lancamentos precisos com confirmacao inteligente."
        meta={[{ label: 'Periodo selecionado', value: 'Jan 2026' }, { label: 'Entradas', value: entries.length }]}
        actions={[]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Historico recente</h3>
            <p className="muted">Ultimos lancamentos manuais.</p>
          </div>
        </div>
        <DataTable rows={rows} columns={columns} emptyMessage="Sem lancamentos manuais." />
      </section>
    </div>
  )
}

export default RevenueManual
