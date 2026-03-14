import { useCallback, useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { enrichRow } from '../services/tags'
import { appendManualRevenue, loadManualRevenue, removeManualRevenue, bulkDeleteManualRevenue } from '../services/revenueStore'
import { filterByApuracaoMonths } from '../services/apuracao'
import { normalizeAssessorName } from '../utils/assessor'

const ORIGIN_OPTIONS = ['Bovespa', 'BMF', 'Estruturadas']
const CORRETAGEM_OPTIONS = ['variavel', 'independente']
const DEFAULT_ORIGIN = ORIGIN_OPTIONS[0]
const DEFAULT_CORRETAGEM = CORRETAGEM_OPTIONS[0]
const PAGE_SIZE = 30

const getTodayIso = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const buildFormState = () => ({
  data: getTodayIso(),
  origem: DEFAULT_ORIGIN,
  tipoCorretagem: DEFAULT_CORRETAGEM,
  conta: '',
  assessor: '',
  broker: '',
  ativo: '',
  valor: '',
})

const parseDecimal = (value) => {
  if (value == null) return null
  let text = String(value).trim()
  if (!text) return null
  text = text.replace(/\s+/g, '')
  const hasComma = text.includes(',')
  const hasDot = text.includes('.')

  if (hasComma && hasDot) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.')
    } else {
      text = text.replace(/,/g, '')
    }
  } else if (hasComma) {
    text = text.replace(/\./g, '').replace(',', '.')
  } else {
    text = text.replace(/,/g, '')
  }

  text = text.replace(/[^0-9.-]/g, '')
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

const uniqSorted = (values) => {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
}

const RevenueManual = () => {
  const { notify } = useToast()
  const {
    selectedBroker,
    selectedAssessor,
    tagsIndex,
    apuracaoMonths,
  } = useGlobalFilters()

  const [entries, setEntries] = useState(() => loadManualRevenue())
  const [form, setForm] = useState(buildFormState)
  const [filters, setFilters] = useState({
    search: '',
    origem: '',
    assessor: '',
    broker: '',
  })
  const [page, setPage] = useState(1)
  const [bulkDelete, setBulkDelete] = useState({
    open: false,
    origem: '',
    dateFrom: '',
    dateTo: '',
  })

  const handleDelete = useCallback((row) => {
    const nextEntries = removeManualRevenue(row.id)
    setEntries(nextEntries)
    notify('Lancamento removido.', 'success')
  }, [notify])

  useEffect(() => {
    const handleReceitaUpdate = () => setEntries(loadManualRevenue())
    window.addEventListener('pwr:receita-updated', handleReceitaUpdate)
    return () => window.removeEventListener('pwr:receita-updated', handleReceitaUpdate)
  }, [])

  const handleFormChange = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleClearForm = useCallback(() => {
    setForm(buildFormState())
  }, [])

  const handleSubmit = useCallback((event) => {
    event.preventDefault()
    const normalizedDate = String(form.data || '').slice(0, 10)
    if (!normalizedDate) {
      notify('Informe a data do lancamento.', 'warning')
      return
    }

    const value = parseDecimal(form.valor)
    if (value == null || value === 0) {
      notify('Informe um valor valido diferente de zero.', 'warning')
      return
    }

    const timestamp = Date.now()
    const assessor = normalizeAssessorName(form.assessor, '')
    const conta = String(form.conta || '').trim()

    const nextEntry = {
      id: `mn-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      data: normalizedDate,
      dataEntrada: normalizedDate,
      origem: form.origem || DEFAULT_ORIGIN,
      tipoCorretagem: String(form.tipoCorretagem || DEFAULT_CORRETAGEM).toLowerCase(),
      codigoCliente: conta,
      conta,
      cliente: conta,
      assessor: assessor || 'Sem assessor',
      broker: String(form.broker || '').trim(),
      ativo: String(form.ativo || '').trim(),
      corretagem: Number(value.toFixed(6)),
      receita: Number(value.toFixed(6)),
      valor: Number(value.toFixed(6)),
      source: 'manual',
      createdAt: timestamp,
    }

    const nextEntries = appendManualRevenue(nextEntry)
    setEntries(nextEntries)
    setForm((prev) => ({
      ...prev,
      valor: '',
      ativo: '',
      conta: '',
    }))
    notify('Lancamento manual adicionado.', 'success')
  }, [form, notify])

  const columns = useMemo(
    () => [
      { key: 'data', label: 'Data', render: (row) => formatDate(row.data) },
      { key: 'origem', label: 'Origem', render: (row) => row.origem || '-' },
      { key: 'cliente', label: 'Conta', render: (row) => row.codigoCliente || row.conta || row.cliente || '-' },
      { key: 'assessor', label: 'Assessor' },
      { key: 'broker', label: 'Broker', render: (row) => row.broker || '-' },
      { key: 'ativo', label: 'Ativo', render: (row) => row.ativo || '-' },
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

  const brokerOptions = useMemo(() => {
    return uniqSorted(tagsIndex?.brokers || [])
  }, [tagsIndex])

  const assessorOptions = useMemo(() => {
    return uniqSorted([
      ...(tagsIndex?.assessors || []),
      ...entries.map((entry) => entry?.assessor),
    ])
  }, [entries, tagsIndex])

  const rows = useMemo(() => {
    const scoped = filterByApuracaoMonths(entries, apuracaoMonths, (entry) => entry.data || entry.dataEntrada)
    return scoped
      .map((entry) => enrichRow(entry, tagsIndex))
      .filter((entry) => {
        const search = filters.search.toLowerCase().trim()
        if (search) {
          const content = `${entry.codigoCliente || entry.conta || entry.cliente || ''} ${entry.assessor || ''} ${entry.broker || ''} ${entry.origem || ''}`
            .toLowerCase()
          if (!content.includes(search)) return false
        }

        if (filters.origem && String(entry.origem || '').trim() !== filters.origem) return false
        if (filters.assessor && String(entry.assessor || '').trim() !== filters.assessor) return false
        if (filters.broker && String(entry.broker || '').trim() !== filters.broker) return false
        if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
        if (selectedAssessor.length && !selectedAssessor.includes(String(entry.assessor || '').trim())) return false
        return true
      })
      .sort((a, b) => {
        const leftDate = String(a.data || a.dataEntrada || '')
        const rightDate = String(b.data || b.dataEntrada || '')
        if (leftDate !== rightDate) return rightDate.localeCompare(leftDate)
        return Number(b.createdAt || 0) - Number(a.createdAt || 0)
      })
  }, [apuracaoMonths, entries, filters, selectedAssessor, selectedBroker, tagsIndex])

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(rows.length / PAGE_SIZE)),
    [rows.length],
  )
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * PAGE_SIZE
  const pageEnd = Math.min(pageStart + PAGE_SIZE, rows.length)
  const pagedRows = useMemo(
    () => rows.slice(pageStart, pageStart + PAGE_SIZE),
    [rows, pageStart],
  )

  useEffect(() => {
    setPage(1)
  }, [filters, selectedBroker, selectedAssessor, apuracaoMonths])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const selectedPeriodLabel = useMemo(() => {
    if (apuracaoMonths.all || !apuracaoMonths.months.length) return 'Todos'
    if (apuracaoMonths.months.length === 1) return apuracaoMonths.months[0]
    return `${apuracaoMonths.months.length} meses`
  }, [apuracaoMonths])

  const handleClearTableFilters = useCallback(() => {
    setFilters({
      search: '',
      origem: '',
      assessor: '',
      broker: '',
    })
  }, [])

  const handleBulkDelete = useCallback(() => {
    if (!bulkDelete.origem && !bulkDelete.dateFrom && !bulkDelete.dateTo) {
      notify('Selecione pelo menos um filtro (origem ou data) para exclusao.', 'warning')
      return
    }
    const before = entries.length
    const nextEntries = bulkDeleteManualRevenue({
      origem: bulkDelete.origem || undefined,
      dateFrom: bulkDelete.dateFrom || undefined,
      dateTo: bulkDelete.dateTo || undefined,
    })
    setEntries(nextEntries)
    const removed = before - nextEntries.length
    if (removed > 0) {
      notify(`${removed} lancamento(s) removido(s) com sucesso.`, 'success')
    } else {
      notify('Nenhum lancamento encontrado com os filtros selecionados.', 'warning')
    }
    setBulkDelete((prev) => ({ ...prev, open: false }))
  }, [bulkDelete, entries.length, notify])

  return (
    <div className="page">
      <PageHeader
        title="Receita Manual"
        subtitle="Lancamentos precisos com confirmacao inteligente."
        meta={[
          { label: 'Periodo selecionado', value: selectedPeriodLabel },
          { label: 'Entradas', value: entries.length },
          { label: 'Exibindo', value: rows.length },
        ]}
        actions={[
          {
            label: bulkDelete.open ? 'Cancelar exclusao' : 'Exclusao em massa',
            icon: 'x',
            onClick: () => setBulkDelete((prev) => ({ ...prev, open: !prev.open })),
            variant: bulkDelete.open ? 'btn-secondary' : 'btn-danger',
          },
        ]}
      />

      {bulkDelete.open ? (
        <section className="panel" style={{ borderLeft: '3px solid var(--negative)' }}>
          <div className="panel-head">
            <div>
              <h3>Exclusao em massa</h3>
              <p className="muted">Selecione os filtros abaixo para remover lancamentos. Pelo menos um filtro e obrigatorio.</p>
            </div>
          </div>
          <div className="filter-grid">
            <label>
              Tipo de operacao
              <select
                className="input"
                value={bulkDelete.origem}
                onChange={(event) => setBulkDelete((prev) => ({ ...prev, origem: event.target.value }))}
              >
                <option value="">Todos os tipos</option>
                {ORIGIN_OPTIONS.map((origin) => (
                  <option key={origin} value={origin}>{origin}</option>
                ))}
              </select>
            </label>
            <label>
              Data inicial
              <input
                className="input"
                type="date"
                value={bulkDelete.dateFrom}
                onChange={(event) => setBulkDelete((prev) => ({ ...prev, dateFrom: event.target.value }))}
              />
            </label>
            <label>
              Data final
              <input
                className="input"
                type="date"
                value={bulkDelete.dateTo}
                onChange={(event) => setBulkDelete((prev) => ({ ...prev, dateTo: event.target.value }))}
              />
            </label>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button className="btn btn-danger" type="button" onClick={handleBulkDelete}>
                <Icon name="x" size={16} />
                Excluir lancamentos
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Novo lancamento</h3>
            <p className="muted">Preencha os campos e salve na base manual.</p>
          </div>
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={handleClearForm}>
              Limpar campos
            </button>
          </div>
        </div>
        <form className="filter-grid" onSubmit={handleSubmit}>
          <input
            className="input"
            type="date"
            value={form.data}
            onChange={(event) => handleFormChange('data', event.target.value)}
            required
          />
          <select
            className="input"
            value={form.origem}
            onChange={(event) => handleFormChange('origem', event.target.value)}
          >
            {ORIGIN_OPTIONS.map((origin) => (
              <option key={origin} value={origin}>{origin}</option>
            ))}
          </select>
          <select
            className="input"
            value={form.tipoCorretagem}
            onChange={(event) => handleFormChange('tipoCorretagem', event.target.value)}
          >
            {CORRETAGEM_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
          <input
            className="input"
            type="text"
            placeholder="Conta"
            value={form.conta}
            onChange={(event) => handleFormChange('conta', event.target.value)}
          />
          <input
            className="input"
            type="text"
            list="manual-assessor-options"
            placeholder="Assessor"
            value={form.assessor}
            onChange={(event) => handleFormChange('assessor', event.target.value)}
          />
          <input
            className="input"
            type="text"
            list="manual-broker-options"
            placeholder="Broker"
            value={form.broker}
            onChange={(event) => handleFormChange('broker', event.target.value)}
          />
          <input
            className="input"
            type="text"
            placeholder="Ativo"
            value={form.ativo}
            onChange={(event) => handleFormChange('ativo', event.target.value)}
          />
          <input
            className="input"
            type="text"
            inputMode="decimal"
            placeholder="Valor (R$)"
            value={form.valor}
            onChange={(event) => handleFormChange('valor', event.target.value)}
            required
          />
          <button className="btn btn-primary" type="submit">
            <Icon name="plus" size={16} />
            Adicionar
          </button>
        </form>

        <datalist id="manual-assessor-options">
          {assessorOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <datalist id="manual-broker-options">
          {brokerOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Historico recente</h3>
            <p className="muted">Ultimos lancamentos manuais com filtros aplicados.</p>
          </div>
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={handleClearTableFilters}>
              Limpar filtros
            </button>
          </div>
        </div>
        <div className="filter-grid">
          <div className="search-pill">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="Buscar conta, cliente, assessor ou broker"
              value={filters.search}
              onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
            />
          </div>
          <select
            className="input"
            value={filters.origem}
            onChange={(event) => setFilters((prev) => ({ ...prev, origem: event.target.value }))}
          >
            <option value="">Todas as origens</option>
            {ORIGIN_OPTIONS.map((origin) => (
              <option key={origin} value={origin}>{origin}</option>
            ))}
          </select>
          <select
            className="input"
            value={filters.assessor}
            onChange={(event) => setFilters((prev) => ({ ...prev, assessor: event.target.value }))}
          >
            <option value="">Todos os assessores</option>
            {assessorOptions.map((assessor) => (
              <option key={assessor} value={assessor}>{assessor}</option>
            ))}
          </select>
          <select
            className="input"
            value={filters.broker}
            onChange={(event) => setFilters((prev) => ({ ...prev, broker: event.target.value }))}
          >
            <option value="">Todos os brokers</option>
            {brokerOptions.map((broker) => (
              <option key={broker} value={broker}>{broker}</option>
            ))}
          </select>
          <div className="muted" style={{ display: 'flex', alignItems: 'center' }}>
            {formatNumber(rows.length)} registro(s)
          </div>
        </div>
        <DataTable rows={pagedRows} columns={columns} emptyMessage="Sem lancamentos manuais." />
        {totalPages > 1 ? (
          <div className="table-pagination">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={safePage <= 1}
            >
              Anterior
            </button>
            <span className="muted">
              Pagina {safePage} de {totalPages} | Mostrando {formatNumber(rows.length ? pageStart + 1 : 0)}-{formatNumber(pageEnd)} de {formatNumber(rows.length)}
            </span>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={safePage >= totalPages}
            >
              Proxima
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

export default RevenueManual
