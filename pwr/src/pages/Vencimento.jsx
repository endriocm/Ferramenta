import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import ReportModal from '../components/ReportModal'
import OverrideModal from '../components/OverrideModal'
import { vencimentos, statusConfig } from '../data/vencimento'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { fetchYahooMarketData } from '../services/marketData'
import { computeBarrierStatus, computeResult } from '../services/settlement'
import { clearOverride, loadOverrides, saveOverrides, updateOverride } from '../services/overrides'
import { parseWorkbook } from '../services/excel'
import { exportReportPdf } from '../services/pdf'
import { useToast } from '../hooks/useToast'

const getStatus = (date) => {
  const target = new Date(date)
  const diff = Math.ceil((target.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (diff <= 0) return { key: 'critico', days: diff }
  if (diff <= 7) return { key: 'alerta', days: diff }
  return { key: 'ok', days: diff }
}

const getBarrierBadge = (status) => {
  if (!status) return { label: 'N/A', tone: 'cyan' }
  const high = status.high
  const low = status.low
  if (high && low) return { label: 'Alta + Baixa', tone: 'red' }
  if (high) return { label: 'Bateu alta', tone: 'amber' }
  if (low) return { label: 'Bateu baixa', tone: 'amber' }
  if (high === false || low === false) return { label: 'Nao bateu', tone: 'green' }
  return { label: 'N/A', tone: 'cyan' }
}

const buildCopySummary = (row) => {
  return [
    `Cliente: ${row.cliente}`,
    `Ativo: ${row.ativo}`,
    `Estrutura: ${row.estrutura}`,
    `Resultado: ${formatCurrency(row.result.financeiroFinal)}`,
    `Barreira: ${getBarrierBadge(row.barrierStatus).label}`,
  ].join('\n')
}

const normalizeFileName = (name) => String(name || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const pickPreferredFile = (files) => {
  const candidates = files.filter((file) => {
    if (!file || !file.name) return false
    const lower = file.name.toLowerCase()
    return (lower.endsWith('.xlsx') || lower.endsWith('.xls')) && !file.name.startsWith('~$')
  })
  if (!candidates.length) return null
  const preferred = candidates.find((file) => {
    const normalized = normalizeFileName(file.name)
    return normalized.includes('relatorio') && normalized.includes('posicao')
  })
  if (preferred) return preferred
  return candidates.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))[0]
}

const Vencimento = () => {
  const { notify } = useToast()
  const [filters, setFilters] = useState({ search: '', broker: '', assessor: '', cliente: '', status: '' })
  const [operations, setOperations] = useState(vencimentos)
  const [marketMap, setMarketMap] = useState({})
  const [overrides, setOverrides] = useState(() => loadOverrides())
  const [selectedReport, setSelectedReport] = useState(null)
  const [selectedOverride, setSelectedOverride] = useState(null)
  const [overrideDraft, setOverrideDraft] = useState({ high: 'auto', low: 'auto' })
  const [folderLabel, setFolderLabel] = useState('Nenhuma pasta vinculada')
  const [pendingFile, setPendingFile] = useState(null)
  const [isParsing, setIsParsing] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    saveOverrides(overrides)
  }, [overrides])

  useEffect(() => {
    let active = true
    const loadMarket = async () => {
      const next = {}
      for (const operation of operations) {
        if (!operation.ativo || !operation.dataRegistro || !operation.vencimento) continue
        try {
          const market = await fetchYahooMarketData({
            symbol: operation.ativo,
            startDate: operation.dataRegistro,
            endDate: operation.vencimento,
          })
          next[operation.id] = market
        } catch {
          next[operation.id] = {
            close: operation.spotInicial,
            high: null,
            low: null,
            dividendsTotal: 0,
            lastUpdate: Date.now(),
            source: 'fallback',
          }
        }
      }
      if (active) setMarketMap(next)
    }
    loadMarket()
    return () => {
      active = false
    }
  }, [operations])

  const handleRefreshData = useCallback(async (operation) => {
    try {
      const market = await fetchYahooMarketData({
        symbol: operation.ativo,
        startDate: operation.dataRegistro,
        endDate: operation.vencimento,
      })
      setMarketMap((prev) => ({ ...prev, [operation.id]: market }))
      notify('Dados atualizados.', 'success')
    } catch {
      notify('Falha ao atualizar dados.', 'warning')
    }
  }, [notify])

  const rows = useMemo(() => {
    return operations
      .map((operation) => {
        const market = marketMap[operation.id]
        const override = overrides[operation.id] || { high: 'auto', low: 'auto' }
        const barrierStatus = computeBarrierStatus(operation, market, override)
        const result = computeResult(operation, market, barrierStatus)
        return {
          ...operation,
          market,
          override,
          barrierStatus,
          result,
          status: getStatus(operation.vencimento),
        }
      })
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        if (query && !`${entry.cliente} ${entry.ativo} ${entry.estrutura}`.toLowerCase().includes(query)) return false
        if (filters.broker && entry.broker !== filters.broker) return false
        if (filters.assessor && entry.assessor !== filters.assessor) return false
        if (filters.cliente && entry.cliente !== filters.cliente) return false
        if (filters.status && entry.status.key !== filters.status) return false
        return true
      })
  }, [filters, operations, marketMap, overrides])

  const visibleRows = useMemo(() => rows.slice(0, 20), [rows])

  const totals = useMemo(() => {
    const total = rows.length
    const criticos = rows.filter((row) => row.status.key === 'critico').length
    const alertas = rows.filter((row) => row.status.key === 'alerta').length
    return { total, criticos, alertas }
  }, [rows])

  const handleReportClick = useCallback((row) => {
    setSelectedReport(row)
  }, [])

  const handleOverrideClick = useCallback((row) => {
    const current = overrides[row.id] || { high: 'auto', low: 'auto' }
    setOverrideDraft(current)
    setSelectedOverride(row)
  }, [overrides])

  const columns = useMemo(
    () => [
      {
        key: 'datas',
        label: 'Datas',
        render: (row) => (
          <div className="cell-stack">
            <strong>{formatDate(row.dataRegistro)}</strong>
            <small>{formatDate(row.vencimento)}</small>
          </div>
        ),
      },
      {
        key: 'cliente',
        label: 'Cliente',
        render: (row) => (
          <div className="cell-stack">
            <strong>{row.cliente}</strong>
            <small>{row.assessor}</small>
          </div>
        ),
      },
      { key: 'ativo', label: 'Ativo' },
      { key: 'estrutura', label: 'Estrutura' },
      {
        key: 'spot',
        label: 'Spot',
        render: (row) => (
          <div className="spot-cell">
            <div className="cell-stack">
              <strong>{formatNumber(row.spotInicial)}</strong>
              <small>{formatNumber(row.result.spotFinal)}</small>
            </div>
            <button
              className="icon-btn ghost"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                handleRefreshData(row)
              }}
              aria-label="Atualizar spot"
            >
              <Icon name="sync" size={14} />
            </button>
          </div>
        ),
      },
      {
        key: 'barreira',
        label: 'Barreira',
        render: (row) => {
          const badge = getBarrierBadge(row.barrierStatus)
          const manual = row.override?.high !== 'auto' || row.override?.low !== 'auto'
          return (
            <div className="cell-stack">
              <Badge tone={badge.tone}>{badge.label}</Badge>
              {manual ? <small>Manual ligado</small> : <small>Automatico</small>}
            </div>
          )
        },
      },
      {
        key: 'resultado',
        label: 'Resultado',
        render: (row) => (
          <div className="cell-stack">
            <strong>{formatCurrency(row.result.financeiroFinal)}</strong>
            <small>{(row.result.percent * 100).toFixed(2)}%</small>
          </div>
        ),
      },
      {
        key: 'pagou',
        label: 'Pagou',
        render: (row) => formatCurrency(row.result.pagou),
      },
      {
        key: 'dividendos',
        label: 'Dividendos',
        render: (row) => formatCurrency(row.result.dividends),
      },
      {
        key: 'cupom',
        label: 'Cupom/Rebate',
        render: (row) => (
          <div className="cell-stack">
            <small>Cupom {row.cupom || 'N/A'}</small>
            <small>Rebate {formatCurrency(row.result.rebateTotal)}</small>
          </div>
        ),
      },
      {
        key: 'acoes',
        label: 'Acoes',
        render: (row) => (
          <div className="row-actions">
            <button
              className="icon-btn"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                handleReportClick(row)
              }}
              aria-label="Ver relatorio"
            >
              <Icon name="eye" size={16} />
            </button>
            <button
              className="icon-btn"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                handleOverrideClick(row)
              }}
              aria-label="Override manual"
            >
              <Icon name="sliders" size={16} />
            </button>
          </div>
        ),
      },
    ],
    [handleReportClick, handleOverrideClick],
  )

  const chips = [
    { key: 'broker', label: filters.broker },
    { key: 'assessor', label: filters.assessor },
    { key: 'cliente', label: filters.cliente },
    { key: 'status', label: filters.status },
  ].filter((chip) => chip.label)

  const handlePickFolder = useCallback(async () => {
    try {
      if ('showDirectoryPicker' in window) {
        const handle = await window.showDirectoryPicker()
        let pickedFile = null
        const files = []
        for await (const entry of handle.values()) {
          const lowerName = entry.name.toLowerCase()
          if (entry.kind === 'file' && (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) && !entry.name.startsWith('~$')) {
            const file = await entry.getFile()
            files.push(file)
          }
        }
        pickedFile = pickPreferredFile(files)
        if (!pickedFile) {
          notify('Nenhuma planilha .xlsx encontrada.', 'warning')
          setPendingFile(null)
          return
        }
        setPendingFile(pickedFile)
        setFolderLabel(`${handle.name} • ${pickedFile.name}`)
        notify('Pasta selecionada. Clique em vincular para calcular.', 'success')
      } else {
        fileInputRef.current?.click()
      }
    } catch {
      notify('Selecao de pasta cancelada.', 'warning')
    }
  }, [notify])

  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files || [])
    const file = pickPreferredFile(files)
    if (!file) {
      notify('Selecione um arquivo .xlsx.', 'warning')
      return
    }
    setFolderLabel(file.name)
    setPendingFile(file)
    notify('Planilha pronta. Clique em vincular para calcular.', 'success')
  }

  const handleApplyFolder = useCallback(async () => {
    if (!pendingFile) {
      notify('Escolha a pasta/planilha antes de vincular.', 'warning')
      return
    }
    setIsParsing(true)
    const isLocalHost = typeof window !== 'undefined'
      && ['localhost', '127.0.0.1'].includes(window.location.hostname)
    try {
      if (isLocalHost) {
        const formData = new FormData()
        formData.append('file', pendingFile)
        const response = await fetch('/api/vencimentos/parse', {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) throw new Error('api-failed')
        const data = await response.json()
        if (!data?.rows) throw new Error('api-invalid')
        setOperations(data.rows)
        notify('Planilha vinculada e calculada.', 'success')
        return
      }
      const parsed = await parseWorkbook(pendingFile)
      setOperations(parsed)
      notify('Planilha calculada no navegador.', 'success')
    } catch {
      try {
        const parsed = await parseWorkbook(pendingFile)
        setOperations(parsed)
        notify('Calculo local aplicado.', 'warning')
      } catch {
        notify('Falha ao calcular os dados da planilha.', 'warning')
      }
    } finally {
      setIsParsing(false)
    }
  }, [pendingFile, notify])

  const handleExportPdf = (row) => {
    const barrierBadge = getBarrierBadge(row.barrierStatus)
    const payload = {
      title: `Relatorio - ${row.cliente}`,
      header: `${row.ativo} | ${row.estrutura} | ${formatDate(row.vencimento)}`,
      summary: `<strong>${formatCurrency(row.result.financeiroFinal)}</strong> <span class=\"badge\">${barrierBadge.label}</span>`,
      details: [
        { label: 'Spot inicial', value: formatNumber(row.spotInicial) },
        { label: 'Spot vencimento', value: formatNumber(row.result.spotFinal) },
        { label: 'Quantidade', value: formatNumber(row.quantidade) },
        { label: 'Pagou', value: formatCurrency(row.result.pagou) },
        { label: 'Financeiro final', value: formatCurrency(row.result.financeiroFinal) },
        { label: 'Ganho/Prejuizo', value: formatCurrency(row.result.ganho) },
        { label: 'Ganho %', value: `${(row.result.percent * 100).toFixed(2)}%` },
        { label: 'Venda do ativo', value: formatCurrency(row.result.vendaAtivo) },
        { label: 'Ganho na Call', value: formatCurrency(row.result.ganhoCall) },
        { label: 'Ganho na Put', value: formatCurrency(row.result.ganhoPut) },
        { label: 'Ganhos nas opcoes', value: formatCurrency(row.result.ganhosOpcoes) },
        { label: 'Dividendos', value: formatCurrency(row.result.dividends) },
        { label: 'Cupom', value: formatCurrency(row.result.cupomTotal) },
        { label: 'Rebates', value: formatCurrency(row.result.rebateTotal) },
      ],
      barriers: (row.barrierStatus?.list || []).map((item) => {
        const direction = item.direction === 'high' ? 'Alta' : 'Baixa'
        const hit = item.direction === 'high' ? row.barrierStatus?.high : row.barrierStatus?.low
        return {
          label: `${direction} (${item.barreiraTipo || 'N/A'})`,
          value: `${item.barreiraValor} - ${hit == null ? 'N/A' : hit ? 'Bateu' : 'Nao bateu'}`,
        }
      }),
      warnings: [
        row.market?.source !== 'yahoo' ? 'Cotacao em fallback.' : null,
        row.override?.high !== 'auto' || row.override?.low !== 'auto' ? 'Override manual aplicado.' : null,
      ].filter(Boolean),
    }
    exportReportPdf(payload, `${row.cliente}_${row.ativo}_${row.vencimento}`)
  }

  const handleCopy = async (row) => {
    try {
      await navigator.clipboard.writeText(buildCopySummary(row))
      notify('Resumo copiado.', 'success')
    } catch {
      notify('Nao foi possivel copiar.', 'warning')
    }
  }

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
            <h3>Fonte de dados</h3>
            <p className="muted">Vincule a pasta com a planilha de posicao para atualizar os calculos.</p>
          </div>
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={handlePickFolder}>
              <Icon name="link" size={16} />
              Vincular pasta
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={handleApplyFolder}
              disabled={!pendingFile || isParsing}
            >
              <Icon name="sync" size={16} />
              {isParsing ? 'Calculando...' : 'Vincular e calcular'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              multiple
              webkitdirectory="true"
              directory="true"
              hidden
            />
          </div>
        </div>
        <div className="muted">{folderLabel}</div>
      </section>

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
          rows={visibleRows}
          columns={columns}
          emptyMessage="Nenhuma estrutura encontrada."
          onRowClick={handleReportClick}
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

      <ReportModal
        open={Boolean(selectedReport)}
        row={selectedReport}
        onClose={() => setSelectedReport(null)}
        onRefresh={() => selectedReport && handleRefreshData(selectedReport)}
        onCopy={() => selectedReport && handleCopy(selectedReport)}
        onExport={() => selectedReport && handleExportPdf(selectedReport)}
      />

      <OverrideModal
        open={Boolean(selectedOverride)}
        value={overrideDraft}
        onClose={() => setSelectedOverride(null)}
        onChange={setOverrideDraft}
        onApply={() => {
          if (!selectedOverride) return
          setOverrides((prev) => updateOverride(prev, selectedOverride.id, overrideDraft))
          notify('Override aplicado.', 'success')
          setSelectedOverride(null)
        }}
        onReset={() => {
          if (!selectedOverride) return
          setOverrides((prev) => clearOverride(prev, selectedOverride.id))
          notify('Override resetado.', 'success')
          setSelectedOverride(null)
        }}
      />
    </div>
  )
}

export default Vencimento
