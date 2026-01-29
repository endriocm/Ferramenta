import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import ReportModal from '../components/ReportModal'
import OverrideModal from '../components/OverrideModal'
import SelectMenu from '../components/SelectMenu'
import TreeSelect from '../components/TreeSelect'
import { vencimentos } from '../data/vencimento'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { fetchYahooMarketData, normalizeYahooSymbol } from '../services/marketData'
import { buildDividendKey, fetchDividend, fetchDividendsBatch } from '../services/dividends'
import { computeBarrierStatus, computeResult } from '../services/settlement'
import { clearOverride, loadOverrides, saveOverrides, updateOverride } from '../services/overrides'
import { parseWorkbook, parseWorkbookBuffer } from '../services/excel'
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
  const clienteLabel = row.codigoCliente || row.cliente || '-'
  return [
    `Cliente: ${clienteLabel}`,
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

const toArrayBuffer = (data) => {
  if (!data) return null
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  return null
}

const spotCache = new Map()
const SPOT_CONCURRENCY = 8
const PAGE_SIZE = 15

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index
      index += 1
      if (current >= items.length) break
      results[current] = await mapper(items[current], current)
    }
  })
  await Promise.all(workers)
  return results
}

const formatSpotValue = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—'
  return formatNumber(value)
}

const formatUpdateError = (error, prefix = 'Falha ao atualizar') => {
  const provider = error?.provider || error?.payload?.source || error?.source
  const status = error?.status || error?.payload?.status
  const detail = error?.detail || error?.message || 'erro desconhecido'
  const providerLabel = provider ? ` (${provider}${status ? ` ${status}` : ''})` : ''
  return `${prefix}${providerLabel}: ${detail}`
}

const parseQuantity = (value) => {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const cleaned = String(value).trim().replace(/\s+/g, '').replace(',', '.')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

const formatMonthName = (year, month) => {
  const date = new Date(Number(year), Number(month) - 1, 1)
  if (Number.isNaN(date.getTime())) return `${month}/${year}`
  const label = date.toLocaleDateString('pt-BR', { month: 'long' })
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
}

const formatDayLabel = (key) => {
  const [year, month, day] = String(key || '').split('-')
  if (!year || !month || !day) return String(key || '')
  return day
}

const buildVencimentoTree = (items) => {
  const years = new Map()
  const allValues = new Set()

  items.forEach((item) => {
    const key = normalizeDateKey(item?.vencimento)
    if (!key) return
    allValues.add(key)
    const [year, month] = key.split('-')
    if (!years.has(year)) years.set(year, new Map())
    const monthMap = years.get(year)
    if (!monthMap.has(month)) monthMap.set(month, new Set())
    monthMap.get(month).add(key)
  })

  const tree = Array.from(years.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, monthMap]) => {
      const months = Array.from(monthMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, daySet]) => {
          const days = Array.from(daySet).sort()
          const children = days.map((key) => ({
            key,
            label: formatDayLabel(key),
            value: key,
            values: [key],
          }))
          return {
            key: `${year}-${month}`,
            label: `${formatMonthName(year, month)} (${month})`,
            children,
            values: days,
            count: days.length,
          }
        })
      const values = months.flatMap((month) => month.values)
      return {
        key: year,
        label: year,
        children: months,
        values,
        count: values.length,
      }
    })

  return { tree, allValues: Array.from(allValues).sort() }
}

const buildOptions = (values, placeholder) => {
  const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return [{ value: '', label: placeholder }, ...unique.map((value) => ({ value, label: value }))]
}

const getResultTone = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number === 0) return ''
  return number > 0 ? 'text-positive' : 'text-negative'
}

const buildPagination = (current, total) => {
  if (total <= 1) return [1]
  const delta = 1
  const range = []
  for (let page = 1; page <= total; page += 1) {
    if (page === 1 || page === total || (page >= current - delta && page <= current + delta)) {
      range.push(page)
    }
  }
  const items = []
  let previous = 0
  range.forEach((page) => {
    if (page - previous > 1) items.push('ellipsis')
    items.push(page)
    previous = page
  })
  return items
}

const buildDividendRequest = (operation) => {
  const ticker = normalizeYahooSymbol(operation?.ativo)
  const from = normalizeDateKey(operation?.dataRegistro)
  const to = normalizeDateKey(operation?.vencimento)
  if (!ticker || !from || !to) return null
  return {
    key: buildDividendKey(ticker, from, to),
    ticker,
    from,
    to,
  }
}

const applyDividendsToMarket = (market, dividend) => {
  if (!dividend) return market
  const total = Number(dividend.total ?? 0)
  return {
    ...market,
    dividendsTotal: Number.isFinite(total) ? total : market?.dividendsTotal ?? 0,
    dividendsSource: dividend.source || market?.dividendsSource,
    dividendsCached: dividend.cached ?? market?.dividendsCached,
  }
}

const fetchSpotPrice = async (ticker, { force = false } = {}) => {
  const key = String(ticker || '').trim().toUpperCase()
  if (!key) return null
  if (!force && spotCache.has(key)) return spotCache.get(key)
  try {
    const r = await fetch(`/api/spot?symbol=${encodeURIComponent(key)}`)
    if (!r.ok) return null
    const data = await r.json()
    const price = Number(data?.price)
    if (!Number.isFinite(price)) return null
    spotCache.set(key, price)
    return price
  } catch {
    return null
  }
}

const attachSpotPrices = async (rows) => {
  if (!Array.isArray(rows) || !rows.length) return rows
  spotCache.clear()
  const pendingTickers = Array.from(new Set(
    rows
      .filter((row) => row?.ativo)
      .map((row) => String(row.ativo || '').trim().toUpperCase())
      .filter(Boolean),
  ))

  if (!pendingTickers.length) return rows

  const results = await mapWithConcurrency(
    pendingTickers,
    SPOT_CONCURRENCY,
    async (ticker) => [ticker, await fetchSpotPrice(ticker, { force: true })],
  )

  const priceMap = new Map(results.filter(([, price]) => price != null))
  if (!priceMap.size) return rows

  return rows.map((row) => {
    if (!row?.ativo) return row
    const price = priceMap.get(String(row.ativo || '').trim().toUpperCase())
    if (price == null) return row
    return { ...row, spotInicial: price }
  })
}

const resolveSpotBase = (operation, market) => {
  const close = market?.close
  if (close != null && Number.isFinite(Number(close))) return Number(close)
  const spot = operation?.spotInicial
  if (spot != null && Number.isFinite(Number(spot))) return Number(spot)
  return null
}

const Vencimento = () => {
  const { notify } = useToast()
  const [filters, setFilters] = useState({ search: '', broker: '', assessor: '', cliente: '', status: '', estrutura: '', vencimentos: [] })
  const [operations, setOperations] = useState(vencimentos)
  const [marketMap, setMarketMap] = useState({})
  const [overrides, setOverrides] = useState(() => loadOverrides())
  const [selectedReport, setSelectedReport] = useState(null)
  const [selectedOverride, setSelectedOverride] = useState(null)
  const [overrideDraft, setOverrideDraft] = useState({ high: 'auto', low: 'auto', cupomManual: '', qtyBonus: 0, bonusDate: '', bonusNote: '' })
  const [folderLabel, setFolderLabel] = useState('Nenhuma pasta vinculada')
  const [pendingFile, setPendingFile] = useState(null)
  const [isParsing, setIsParsing] = useState(false)
  const [isRefreshingAll, setIsRefreshingAll] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const fileInputRef = useRef(null)

  useEffect(() => {
    saveOverrides(overrides)
  }, [overrides])

  useEffect(() => {
    if (!window?.electronAPI?.resolveFolder) return
    const savedFolder = window.localStorage.getItem('pwr.vencimento.folder')
    if (!savedFolder) return
    window.electronAPI.resolveFolder(savedFolder).then((meta) => {
      if (!meta?.filePath) return
      setPendingFile({ source: 'electron', ...meta })
      setFolderLabel(`${meta.folderPath} • ${meta.fileName}`)
    })
  }, [])

  useEffect(() => {
    let active = true
    const loadMarket = async () => {
      const next = {}
      const dividendRequests = operations.map(buildDividendRequest).filter(Boolean)
      let dividendMap = new Map()
      if (dividendRequests.length) {
        try {
          const results = await fetchDividendsBatch(dividendRequests.map(({ ticker, from, to }) => ({ ticker, from, to })))
          dividendMap = new Map(results.filter(Boolean).map((item) => [item.key, item]))
        } catch {
          dividendMap = new Map()
        }
      }
      for (const operation of operations) {
        if (!operation.ativo || !operation.dataRegistro || !operation.vencimento) continue
        const dividendRequest = buildDividendRequest(operation)
        const dividend = dividendRequest ? dividendMap.get(dividendRequest.key) : null
        try {
          const market = await fetchYahooMarketData({
            symbol: operation.ativo,
            startDate: operation.dataRegistro,
            endDate: operation.vencimento,
          })
          next[operation.id] = applyDividendsToMarket(market, dividend)
        } catch {
          const fallback = {
            close: operation.spotInicial,
            high: null,
            low: null,
            dividendsTotal: 0,
            lastUpdate: Date.now(),
            source: 'fallback',
          }
          next[operation.id] = applyDividendsToMarket(fallback, dividend)
        }
      }
      if (active) setMarketMap(next)
    }
    loadMarket()
    return () => {
      active = false
    }
  }, [operations])

  const brokerOptions = useMemo(() => buildOptions(operations.map((item) => item.broker), 'Broker'), [operations])
  const assessorOptions = useMemo(() => buildOptions(operations.map((item) => item.assessor), 'Assessor'), [operations])
  const estruturaOptions = useMemo(() => buildOptions(operations.map((item) => item.estrutura), 'Estrutura'), [operations])
  const { tree: vencimentoTree, allValues: vencimentoValues } = useMemo(
    () => buildVencimentoTree(operations),
    [operations],
  )

  const handleRefreshData = useCallback(async (operation) => {
    try {
      const market = await fetchYahooMarketData({
        symbol: operation.ativo,
        startDate: operation.dataRegistro,
        endDate: operation.vencimento,
      })
      let dividend = null
      const dividendRequest = buildDividendRequest(operation)
      if (dividendRequest) {
        try {
          dividend = await fetchDividend(dividendRequest)
        } catch {
          dividend = null
        }
      }
      const marketWithDividends = applyDividendsToMarket(market, dividend)
      setMarketMap((prev) => ({ ...prev, [operation.id]: marketWithDividends }))
      notify('Dados atualizados.', 'success')
    } catch (error) {
      notify(formatUpdateError(error), 'warning')
    }
  }, [notify])

  const rows = useMemo(() => {
    const vencimentoSet = new Set(filters.vencimentos)
    return operations
      .map((operation) => {
        const market = marketMap[operation.id]
        const override = overrides[operation.id] || { high: 'auto', low: 'auto', cupomManual: '', qtyBonus: 0, bonusDate: '', bonusNote: '' }
        const qtyBase = parseQuantity(operation.qtyBase ?? operation.quantidade ?? 0)
        const qtyBonus = Math.max(0, parseQuantity(override.qtyBonus ?? operation.qtyBonus ?? 0))
        const qtyAtual = Math.max(0, qtyBase + qtyBonus)
        const spotBase = resolveSpotBase(operation, market)
        const operationWithSpot = spotBase != null
          ? { ...operation, spotInicial: spotBase, qtyBase, qtyBonus, qtyAtual }
          : { ...operation, qtyBase, qtyBonus, qtyAtual }
        const barrierStatus = computeBarrierStatus(operationWithSpot, market, override)
        const cupomManual = override?.cupomManual != null && String(override.cupomManual).trim() !== ''
          ? override.cupomManual
          : null
        const cupomResolved = cupomManual ?? operation.cupom
        const result = computeResult(operationWithSpot, market, barrierStatus, override)
        return {
          ...operation,
          qtyBase,
          qtyBonus,
          qtyAtual,
          market,
          spotBase,
          override,
          cupomManual,
          cupomResolved,
          barrierStatus,
          result,
          status: getStatus(operation.vencimento),
        }
      })
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        const searchBase = `${entry.codigoCliente || entry.cliente || ''} ${entry.ativo || ''} ${entry.estrutura || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase()
        if (query && !searchBase.includes(query)) return false
        if (filters.broker && entry.broker !== filters.broker) return false
        if (filters.assessor && entry.assessor !== filters.assessor) return false
        const clienteMatch = entry.codigoCliente || entry.cliente
        if (filters.cliente && clienteMatch !== filters.cliente) return false
        if (filters.estrutura && entry.estrutura !== filters.estrutura) return false
        if (vencimentoSet.size && !vencimentoSet.has(normalizeDateKey(entry.vencimento))) return false
        if (filters.status && entry.status.key !== filters.status) return false
        return true
      })
  }, [filters, operations, marketMap, overrides])

  const pageCount = useMemo(() => Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), [rows.length])
  const paginationItems = useMemo(() => buildPagination(currentPage, pageCount), [currentPage, pageCount])
  useEffect(() => {
    setCurrentPage((prev) => Math.min(Math.max(prev, 1), pageCount))
  }, [pageCount])
  useEffect(() => {
    setCurrentPage(1)
  }, [filters, operations])

  const pageStart = (currentPage - 1) * PAGE_SIZE
  const visibleRows = useMemo(() => rows.slice(pageStart, pageStart + PAGE_SIZE), [rows, pageStart])

  const handleRefreshAll = useCallback(async () => {
    setIsRefreshingAll(true)
    try {
      const operationMap = new Map(visibleRows.map((operation) => [operation.id, operation]))
      const dividendRequests = visibleRows.map(buildDividendRequest).filter(Boolean)
      let dividendMap = new Map()
      if (dividendRequests.length) {
        try {
          const results = await fetchDividendsBatch(dividendRequests.map(({ ticker, from, to }) => ({ ticker, from, to })))
          dividendMap = new Map(results.filter(Boolean).map((item) => [item.key, item]))
        } catch {
          dividendMap = new Map()
        }
      }
      const updates = await mapWithConcurrency(
        visibleRows,
        SPOT_CONCURRENCY,
        async (operation) => {
          if (!operation.ativo || !operation.dataRegistro || !operation.vencimento) return null
          try {
            const market = await fetchYahooMarketData({
              symbol: operation.ativo,
              startDate: operation.dataRegistro,
              endDate: operation.vencimento,
            })
            return { id: operation.id, market }
          } catch (error) {
            return { id: operation.id, error }
          }
        },
      )
      setMarketMap((prev) => {
        const next = { ...prev }
        updates.forEach((update) => {
          if (update?.id && update.market) {
            const operation = operationMap.get(update.id)
            const dividendRequest = operation ? buildDividendRequest(operation) : null
            const dividend = dividendRequest ? dividendMap.get(dividendRequest.key) : null
            next[update.id] = applyDividendsToMarket(update.market, dividend)
          }
        })
        return next
      })
      const failures = updates.filter((update) => update?.error)
      if (failures.length) {
        notify(formatUpdateError(failures[0].error, `Falha ao atualizar ${failures.length} ativo(s)`), 'warning')
      } else {
        notify('Precos atualizados.', 'success')
      }
    } catch (error) {
      notify(formatUpdateError(error, 'Falha ao atualizar precos'), 'warning')
    } finally {
      setIsRefreshingAll(false)
    }
  }, [visibleRows, notify])

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
    const current = overrides[row.id] || { high: 'auto', low: 'auto', cupomManual: '', qtyBonus: 0, bonusDate: '', bonusNote: '' }
    setOverrideDraft(current)
    setSelectedOverride(row)
  }, [overrides])

  const columns = useMemo(
    () => [
      {
        key: 'assessor',
        label: 'Assessor',
        render: (row) => row.assessor || '—',
      },
      {
        key: 'broker',
        label: 'Broker',
        render: (row) => row.broker || '—',
      },
      {
        key: 'codigoCliente',
        label: 'Codigo cliente',
        render: (row) => row.codigoCliente || row.cliente || '—',
      },
      {
        key: 'dataRegistro',
        label: 'Data registro',
        render: (row) => formatDate(row.dataRegistro),
      },
      { key: 'ativo', label: 'Ativo' },
      { key: 'estrutura', label: 'Estrutura' },
      {
        key: 'vencimento',
        label: 'Vencimento',
        render: (row) => formatDate(row.vencimento),
      },
      {
        key: 'spot',
        label: 'Spot',
        render: (row) => (
          <div className="spot-cell">
            <div className="cell-stack">
              <strong>{formatSpotValue(row.spotBase ?? row.spotInicial)}</strong>
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
        key: 'qtyBase',
        label: 'Qtd base',
        render: (row) => formatNumber(row.qtyBase),
      },
      {
        key: 'qtyBonus',
        label: 'Bonificacao',
        render: (row) => formatNumber(row.qtyBonus),
      },
      {
        key: 'qtyAtual',
        label: 'Qtd atual',
        render: (row) => formatNumber(row.qtyAtual),
      },
      {
        key: 'valorEntrada',
        label: 'Valor de entrada',
        render: (row) => formatCurrency(row.result.valorEntrada ?? row.result.pagou),
      },
      {
        key: 'resultado',
        label: 'Resultado $',
        render: (row) => (
          <span className={getResultTone(row.result.financeiroFinal)}>
            {formatCurrency(row.result.financeiroFinal)}
          </span>
        ),
      },
      {
        key: 'vendaAtivo',
        label: 'Venda do ativo',
        render: (row) => formatCurrency(row.result.vendaAtivo),
      },
      {
        key: 'resultadoPercent',
        label: 'Resultado %',
        render: (row) => (
          <span className={getResultTone(row.result.percent)}>
            {(row.result.percent * 100).toFixed(2)}%
          </span>
        ),
      },
      {
        key: 'debito',
        label: 'Debito',
        render: (row) => formatCurrency(row.result.debito ?? 0),
      },
      {
        key: 'ganhosOpcoes',
        label: 'Ganho nas opcoes',
        render: (row) => formatCurrency(row.result.ganhosOpcoes),
      },
      {
        key: 'dividendos',
        label: 'Dividendos',
        render: (row) => formatCurrency(row.result.dividends),
      },
      {
        key: 'cupom',
        label: 'Cupom',
        render: (row) => {
          const manual = row.cupomManual != null
          const label = row.cupomResolved || row.cupom || 'N/A'
          return (
            <div className="cell-stack">
              <strong>{label}</strong>
              {manual ? <small>Manual</small> : <small>Automatico</small>}
            </div>
          )
        },
      },
      {
        key: 'barreira',
        label: 'Status barreira',
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
    [handleRefreshData, handleReportClick, handleOverrideClick],
  )

  const vencimentoChipLabel = filters.vencimentos.length
    ? (filters.vencimentos.length === 1
      ? formatDate(filters.vencimentos[0])
      : `${filters.vencimentos.length} vencimentos`)
    : ''

  const chips = [
    { key: 'broker', label: filters.broker },
    { key: 'assessor', label: filters.assessor },
    { key: 'cliente', label: filters.cliente },
    { key: 'estrutura', label: filters.estrutura },
    { key: 'vencimentos', label: vencimentoChipLabel },
    { key: 'status', label: filters.status },
  ].filter((chip) => chip.label)

  const handlePickFolder = useCallback(async () => {
    try {
      if (window?.electronAPI?.selectFolder) {
        const meta = await window.electronAPI.selectFolder()
        if (!meta?.filePath) {
          notify('Selecao de pasta cancelada.', 'warning')
          return
        }
        setPendingFile({ source: 'electron', ...meta })
        setFolderLabel(`${meta.folderPath} • ${meta.fileName}`)
        window.localStorage.setItem('pwr.vencimento.folder', meta.folderPath)
        notify('Pasta vinculada. Clique em calcular.', 'success')
        return
      }
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
        setPendingFile({ source: 'browser', file: pickedFile })
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
    setPendingFile({ source: 'browser', file })
    notify('Planilha pronta. Clique em vincular para calcular.', 'success')
  }

  const handleApplyFolder = useCallback(async () => {
    if (!pendingFile) {
      notify('Escolha a pasta/planilha antes de vincular.', 'warning')
      return
    }
    setIsParsing(true)
    try {
      if (pendingFile?.source === 'electron') {
        const raw = await window.electronAPI.readFile(pendingFile.filePath)
        const buffer = toArrayBuffer(raw)
        if (!buffer) throw new Error('buffer-invalid')
        const parsed = await parseWorkbookBuffer(buffer)
        const withSpot = await attachSpotPrices(parsed)
        setOperations(withSpot)
        notify('Planilha vinculada e calculada.', 'success')
        return
      }
      const formData = new FormData()
      formData.append('file', pendingFile?.file || pendingFile)
      const response = await fetch('/api/vencimentos/parse', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) throw new Error('api-failed')
      const data = await response.json()
      if (!data?.rows) throw new Error('api-invalid')
      const withSpot = await attachSpotPrices(data.rows)
      setOperations(withSpot)
      notify('Planilha vinculada e calculada.', 'success')
    } catch {
      try {
        const file = pendingFile?.file || pendingFile
        const parsed = await parseWorkbook(file)
        const withSpot = await attachSpotPrices(parsed)
        setOperations(withSpot)
        notify('API indisponivel. Calculo local aplicado.', 'warning')
      } catch {
        notify('Falha ao calcular os dados da planilha.', 'warning')
      }
    } finally {
      setIsParsing(false)
    }
  }, [pendingFile, notify])

  const handleExportPdf = (row) => {
    const barrierBadge = getBarrierBadge(row.barrierStatus)
    const clienteLabel = row.cliente || row.codigoCliente || 'Cliente'
    const payload = {
      title: `Relatorio - ${clienteLabel}`,
      header: `${row.ativo} | ${row.estrutura} | ${formatDate(row.vencimento)}`,
      summary: `<strong>${formatCurrency(row.result.financeiroFinal)}</strong> <span class="badge">${barrierBadge.label}</span>`,
      details: [
        { label: 'Spot', value: formatSpotValue(row.spotBase ?? row.spotInicial) },
        { label: 'Quantidade base', value: formatNumber(row.qtyBase) },
        { label: 'Bonificacao', value: formatNumber(row.qtyBonus) },
        { label: 'Quantidade atual', value: formatNumber(row.qtyAtual) },
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
        row.cupomManual != null && String(row.cupomManual).trim() !== '' ? 'Cupom manual aplicado.' : null,
      ].filter(Boolean),
    }
    exportReportPdf(payload, `${clienteLabel}_${row.ativo}_${row.vencimento}`)
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
          <SelectMenu
            value={filters.broker}
            options={brokerOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, broker: value }))}
            placeholder="Broker"
          />
          <SelectMenu
            value={filters.assessor}
            options={assessorOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, assessor: value }))}
            placeholder="Assessor"
          />
          <SelectMenu
            value={filters.estrutura}
            options={estruturaOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, estrutura: value }))}
            placeholder="Estrutura"
          />
          <TreeSelect
            value={filters.vencimentos}
            tree={vencimentoTree}
            allValues={vencimentoValues}
            onChange={(value) => setFilters((prev) => ({ ...prev, vencimentos: value }))}
            placeholder="Vencimento da estrutura"
          />
          <input className="input" placeholder="Cliente" value={filters.cliente} onChange={(event) => setFilters((prev) => ({ ...prev, cliente: event.target.value }))} />
          <SelectMenu
            value={filters.status}
            options={[
              { value: '', label: 'Status' },
              { value: 'ok', label: 'Neutro' },
              { value: 'alerta', label: 'Alerta' },
              { value: 'critico', label: 'Critico' },
            ]}
            onChange={(value) => setFilters((prev) => ({ ...prev, status: value }))}
            placeholder="Status"
          />
        </div>
        {chips.length ? (
          <div className="chip-row">
            {chips.map((chip) => (
              <button
                key={chip.key}
                className="chip"
                onClick={() => setFilters((prev) => ({
                  ...prev,
                  [chip.key]: Array.isArray(prev[chip.key]) ? [] : '',
                }))}
                type="button"
              >
                {chip.label}
                <Icon name="close" size={12} />
              </button>
            ))}
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setFilters({ search: '', broker: '', assessor: '', cliente: '', status: '', estrutura: '', vencimentos: [] })}
            >
              Limpar tudo
            </button>
          </div>
        ) : null}
        <div className="table-actions">
          <div className="table-actions-left">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleRefreshAll}
              disabled={isRefreshingAll}
            >
              <Icon name="sync" size={16} />
              {isRefreshingAll ? 'Atualizando...' : 'Atualizar spots'}
            </button>
            <span className="muted">Mostrando {visibleRows.length} de {rows.length}</span>
          </div>
        </div>
        <DataTable
          rows={visibleRows}
          columns={columns}
          emptyMessage="Nenhuma estrutura encontrada."
          onRowClick={handleReportClick}
        />
        <div className="table-footer">
          <div className="table-pagination">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              disabled={currentPage <= 1}
            >
              Anterior
            </button>
            <div className="page-list" role="navigation" aria-label="Paginacao">
              <span className="page-label">Pagina</span>
              {paginationItems.map((item, index) => (
                item === 'ellipsis' ? (
                  <span key={`ellipsis-${index}`} className="page-ellipsis">…</span>
                ) : (
                  <button
                    key={`page-${item}`}
                    className={`page-number ${item === currentPage ? 'active' : ''}`}
                    type="button"
                    onClick={() => setCurrentPage(item)}
                    aria-current={item === currentPage ? 'page' : undefined}
                  >
                    {item}
                  </button>
                )
              ))}
            </div>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setCurrentPage((prev) => Math.min(prev + 1, pageCount))}
              disabled={currentPage >= pageCount}
            >
              Proxima
            </button>
          </div>
        </div>
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
        qtyBase={selectedOverride?.qtyBase}
        qtyAtual={selectedOverride?.qtyAtual}
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
