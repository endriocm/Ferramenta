import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import MultiSelect from '../components/MultiSelect'
import { formatCurrency, formatDate } from '../utils/format'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { appendManualRevenue, loadManualRevenue, removeManualRevenue } from '../services/revenueStore'
import { loadStructuredRevenue } from '../services/revenueStructured'

const buildMultiOptions = (values) => {
  const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return unique.map((value) => ({ value, label: value }))
}

const RevenueManual = () => {
  const { notify } = useToast()
  const { selectedBroker, tagsIndex } = useGlobalFilters()
  const [entries, setEntries] = useState(() => loadManualRevenue())
  const [form, setForm] = useState({
    data: '2026-01-26',
    origem: 'Bovespa',
    cliente: '',
    assessores: [],
    ativo: '',
    valor: '',
    tipoEstrutura: '',
  })

  const handleChange = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    const valorNumber = Number(form.valor)
    const valor = Number.isFinite(valorNumber) ? valorNumber : 0
    const assessor = Array.isArray(form.assessores) && form.assessores.length ? form.assessores[0] : ''
    const next = {
      id: `mn-${Date.now()}`,
      data: form.data,
      origem: form.origem || '',
      cliente: form.cliente || '',
      assessor,
      ativo: form.ativo || '',
      estrutura: form.origem === 'Estruturadas' ? (form.tipoEstrutura || '') : undefined,
      valor,
      status: 'ok',
    }
    const nextEntries = appendManualRevenue(next)
    setEntries(nextEntries)
    notify('Lancamento manual registrado.', 'success')
    setForm((prev) => ({ ...prev, cliente: '', assessores: [], ativo: '', valor: '', tipoEstrutura: '' }))
  }

  const handleDelete = (row) => {
    const nextEntries = removeManualRevenue(row.id)
    setEntries(nextEntries)
    notify('Lancamento removido.', 'success')
  }

  const structuredEntries = useMemo(() => loadStructuredRevenue(), [])
  const estruturaOptions = useMemo(
    () => buildMultiOptions(structuredEntries.map((entry) => entry.estrutura)),
    [structuredEntries],
  )
  const assessorOptions = useMemo(
    () => buildMultiOptions(tagsIndex?.assessors || []),
    [tagsIndex],
  )

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
    return entries
      .map((entry) => enrichRow(entry, tagsIndex))
      .filter((entry) => {
        if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
        return true
      })
  }, [entries, selectedBroker, tagsIndex])

  return (
    <div className="page">
      <PageHeader
        title="Receita Manual"
        subtitle="Lancamentos precisos com confirmacao inteligente."
        meta={[{ label: 'Periodo selecionado', value: 'Jan 2026' }, { label: 'Entradas', value: entries.length }]}
        actions={[{ label: 'Exportar', icon: 'download', variant: 'btn-secondary' }]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Novo lancamento</h3>
            <p className="muted">Revise os dados antes de confirmar.</p>
          </div>
        </div>
        <form className="form-grid" onSubmit={handleSubmit}>
          <label>
            Tipo
            <select className="input" value={form.origem} onChange={handleChange('origem')}>
              <option value="Bovespa">Bovespa</option>
              <option value="BMF">BMF</option>
              <option value="Estruturadas">Estruturadas</option>
            </select>
          </label>
          <label>
            Data
            <input className="input" type="date" value={form.data} onChange={handleChange('data')} />
          </label>
          <label>
            Cliente
            <input className="input" placeholder="Cliente" value={form.cliente} onChange={handleChange('cliente')} />
          </label>
          <label>
            Assessor
            <MultiSelect
              value={form.assessores}
              options={assessorOptions}
              onChange={(value) => setForm((prev) => ({ ...prev, assessores: value }))}
              placeholder="Assessor"
            />
          </label>
          <label>
            Ativo
            <input className="input" placeholder="Ativo" value={form.ativo} onChange={handleChange('ativo')} />
          </label>
          {form.origem === 'Estruturadas' ? (
            <label>
              Tipo de estrutura
              <input
                className="input"
                placeholder="Tipo de estrutura"
                list="estrutura-suggestions"
                value={form.tipoEstrutura}
                onChange={handleChange('tipoEstrutura')}
              />
              <datalist id="estrutura-suggestions">
                {estruturaOptions.map((option) => (
                  <option key={option.value} value={option.label} />
                ))}
              </datalist>
            </label>
          ) : null}
          <label>
            Valor
            <input className="input" type="number" placeholder="Valor" value={form.valor} onChange={handleChange('valor')} />
          </label>
          <div className="form-confirm">
            <div>
              <strong>Confirmacao</strong>
              <p className="muted">Voce esta lancando {form.valor || '0'} para {form.cliente || 'cliente'} em {form.data}.</p>
            </div>
            <button className="btn btn-primary" type="submit">Confirmar lancamento</button>
          </div>
        </form>
      </section>

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
