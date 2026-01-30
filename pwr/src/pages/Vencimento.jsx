import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Badge from '../components/Badge'
import Icon from '../components/Icons'
import ReportModal from '../components/ReportModal'
import OverrideModal from '../components/OverrideModal'
import SelectMenu from '../components/SelectMenu'
import MultiSelect from '../components/MultiSelect'
import TreeSelect from '../components/TreeSelect'
import { vencimentos } from '../data/vencimento'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { fetchYahooMarketData, normalizeYahooSymbol } from '../services/marketData'
import { buildDividendKey, clearDividendsCache, fetchDividend, fetchDividendsBatch } from '../services/dividends'
import { computeBarrierStatus, computeResult, getEffectiveLegs } from '../services/settlement'
import { clearOverride, loadOverrides, saveOverrides, updateOverride } from '../services/overrides'
import { parseWorkbook, parseWorkbookBuffer } from '../services/excel'
import { exportReportPdf } from '../services/pdf'
import { getCurrentUserKey } from '../services/currentUser'
import { enrichRow } from '../services/tags'
import { clearLink, ensurePermission, isValidElectronPath, loadLink, saveLink } from '../services/vencimentoLink'
import { clearLastImported, loadLastImported, saveLastImported } from '../services/vencimentoCache'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { debugLog } from '../services/debug'

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
  const clienteLabel = row.nomeCliente || row.codigoCliente || row.cliente || '-'
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

const addDays = (dateKey, delta) => {
  const key = normalizeDateKey(dateKey)
  if (!key) return ''
  const date = new Date(`${key}T00:00:00`)
  if (Number.isNaN(date.getTime())) return ''
  date.setDate(date.getDate() + delta)
  return date.toISOString().slice(0, 10)
}

const buildFolderLabel = (link, cache) => {
  if (link) {
    if (link.source === 'electron') {
      if (link.folderPath && link.fileName) return `${link.folderPath} • ${link.fileName}`
      if (link.folderPath) return link.folderPath
    }
    if (link.source === 'browser') {
      const folder = link.folderName || 'Pasta'
      const file = link.fileName || cache?.fileName
      return file ? `${folder} • ${file}` : folder
    }
    if (link.fileName) return link.fileName
  }
  if (cache?.fileName) return `${cache.fileName} • cache`
  return 'Nenhuma pasta vinculada'
}

const pickFileFromDirectoryHandle = async (handle) => {
  if (!handle) return null
  const files = []
  for await (const entry of handle.values()) {
    const lowerName = entry.name.toLowerCase()
    if (entry.kind === 'file' && (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) && !entry.name.startsWith('~$')) {
      const file = await entry.getFile()
      files.push(file)
    }
  }
  const pickedFile = pickPreferredFile(files)
  if (!pickedFile) return null
  return { file: pickedFile, folderName: handle.name, fileName: pickedFile.name }
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

const buildMultiOptions = (values) => {
  const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return unique.map((value) => ({ value, label: value }))
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

const buildDividendRequest = (operation, reportDate) => {
  const ticker = normalizeYahooSymbol(operation?.ativo)
  const baseFrom = normalizeDateKey(reportDate || operation?.dataRegistro)
  const from = baseFrom ? addDays(baseFrom, 1) : ''
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
  const { selectedBroker, selectedAssessor, clientCodeFilter, setClientCodeFilter, tagsIndex } = useGlobalFilters()
  const [userKey] = useState(() => getCurrentUserKey())
  const [filters, setFilters] = useState({
    search: '',
    broker: '',
    status: '',
    vencimentos: [],
    estruturas: [],
    ativos: [],
    assessores: [],
  })
  const [operations, setOperations] = useState(vencimentos)
  const [marketMap, setMarketMap] = useState({})
  const [overrides, setOverrides] = useState(() => loadOverrides(userKey))
  const [selectedReport, setSelectedReport] = useState(null)
  const [selectedOverride, setSelectedOverride] = useState(null)
  const [overrideDraft, setOverrideDraft] = useState({ high: 'auto', low: 'auto', manualCouponBRL: '', qtyBonus: 0, bonusDate: '', bonusNote: '' })
  const [reportDate, setReportDate] = useState('')
  const [dividendAdjustments, setDividendAdjustments] = useState(new Map())
  const [dividendStatus, setDividendStatus] = useState({ loading: false, error: '' })
  const [dividendsRefreshToken, setDividendsRefreshToken] = useState(0)
  const [linkMeta, setLinkMeta] = useState(null)
  const [cacheMeta, setCacheMeta] = useState(null)
  const [restoreStatus, setRestoreStatus] = useState({ state: 'idle', message: '' })
  const [permissionState, setPermissionState] = useState(null)
  const [pendingFile, setPendingFile] = useState(null)
  const [isParsing, setIsParsing] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isRefreshingAll, setIsRefreshingAll] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const fileInputRef = useRef(null)
  const broadcastRef = useRef(null)
  const tabIdRef = useRef(Math.random().toString(36).slice(2))
  const restoreRef = useRef({ running: false })

  const folderLabel = useMemo(() => {
    if (pendingFile) {
      if (pendingFile.source === 'electron') {
        if (pendingFile.folderPath && pendingFile.fileName) return `${pendingFile.folderPath} • ${pendingFile.fileName}`
        if (pendingFile.folderPath) return pendingFile.folderPath
      }
      if (pendingFile.source === 'browser') {
        const folder = pendingFile.folderName || pendingFile.handle?.name || 'Pasta'
        const fileName = pendingFile.fileName || pendingFile.file?.name
        return fileName ? `${folder} • ${fileName}` : folder
      }
      if (pendingFile.file?.name) return pendingFile.file.name
    }
    return buildFolderLabel(linkMeta, cacheMeta)
  }, [pendingFile, linkMeta, cacheMeta])

  useEffect(() => {
    if (!userKey) return
    setOverrides(loadOverrides(userKey))
  }, [userKey])

  useEffect(() => {
    if (!userKey) return
    saveOverrides(userKey, overrides)
  }, [overrides, userKey])

  useEffect(() => {
    if (!userKey) return
    try {
      const stored = localStorage.getItem(`pwr.vencimento.reportDate.${userKey}`)
      if (stored) setReportDate(stored)
    } catch {
      // noop
    }
  }, [userKey])

  useEffect(() => {
    if (!userKey) return
    try {
      if (reportDate) {
        localStorage.setItem(`pwr.vencimento.reportDate.${userKey}`, reportDate)
      } else {
        localStorage.removeItem(`pwr.vencimento.reportDate.${userKey}`)
      }
    } catch {
      // noop
    }
  }, [reportDate, userKey])

  const broadcastUpdate = useCallback((type, payload = {}) => {
    if (!userKey) return
    const message = {
      type,
      userKey,
      sender: tabIdRef.current,
      ts: Date.now(),
      ...payload,
    }
    if (broadcastRef.current) {
      broadcastRef.current.postMessage(message)
    } else {
      try {
        localStorage.setItem('pwr.vencimento.broadcast', JSON.stringify(message))
      } catch {
        // noop
      }
    }
  }, [userKey])

  const hydrateCache = useCallback((cache) => {
    setCacheMeta(cache || null)
    if (cache?.rows?.length) {
      setOperations(cache.rows)
    } else if (!cache) {
      setOperations(vencimentos)
    }
  }, [])

  const applyPendingFile = useCallback(async (nextPending, { save = true, silent = false } = {}) => {
    if (!nextPending) return false
    setIsParsing(true)
    let parsedRows = null
    let parseSource = nextPending?.source || 'browser'
    const fileName = nextPending?.fileName || nextPending?.file?.name || null

    try {
      if (nextPending?.source === 'electron') {
        if (!window?.electronAPI?.readFile) throw new Error('electron-unavailable')
        const raw = await window.electronAPI.readFile(nextPending.filePath)
        const buffer = toArrayBuffer(raw)
        if (!buffer) throw new Error('buffer-invalid')
        parsedRows = await parseWorkbookBuffer(buffer)
        parseSource = 'electron'
      } else {
        const file = nextPending?.file || nextPending
        try {
          const formData = new FormData()
          formData.append('file', file)
          const response = await fetch('/api/vencimentos/parse', {
            method: 'POST',
            body: formData,
          })
          if (!response.ok) throw new Error('api-failed')
          const data = await response.json()
          if (!data?.rows) throw new Error('api-invalid')
          parsedRows = data.rows
          parseSource = 'api'
        } catch {
          parsedRows = await parseWorkbook(file)
          parseSource = 'local'
          if (!silent) {
            notify('API indisponivel. Calculo local aplicado.', 'warning')
          }
        }
      }

      if (!parsedRows) throw new Error('parse-empty')
      const withSpot = await attachSpotPrices(parsedRows)
      debugLog('vencimento.restore.parse', { rows: withSpot.length, source: parseSource })
      setOperations(withSpot)
      const storedCache = saveLastImported(userKey, {
        rows: withSpot,
        fileName,
        importedAt: Date.now(),
        source: parseSource,
      })
      setCacheMeta(storedCache)

      if (save) {
        if (nextPending?.source === 'electron' && isValidElectronPath(nextPending.folderPath)) {
          const saved = await saveLink(userKey, {
            source: 'electron',
            folderPath: nextPending.folderPath,
            fileName: nextPending.fileName || fileName,
          })
          if (saved) setLinkMeta(saved)
        } else if (nextPending?.source === 'browser' && nextPending.handle) {
          const saved = await saveLink(userKey, {
            source: 'browser',
            handle: nextPending.handle,
            folderName: nextPending.folderName || nextPending.handle?.name,
            fileName,
          })
          if (saved) setLinkMeta(saved)
        } else {
          const saved = await saveLink(userKey, {
            source: 'file',
            fileName,
          })
          if (saved) setLinkMeta(saved)
        }
        broadcastUpdate('vencimento-updated', { kind: 'link' })
      }

      broadcastUpdate('vencimento-updated', { kind: 'cache' })
      if (!silent) notify('Planilha vinculada e calculada.', 'success')
      setPendingFile(null)
      return true
    } catch {
      if (!silent) notify('Falha ao calcular os dados da planilha.', 'warning')
      return false
    } finally {
      setIsParsing(false)
    }
  }, [broadcastUpdate, notify, userKey])

  const restoreFromLink = useCallback(async (link, { silent = true } = {}) => {
    if (!link || restoreRef.current.running) return
    restoreRef.current.running = true
    setIsRestoring(true)
    setRestoreStatus({ state: 'restoring', message: 'Restaurando vinculo salvo...' })
    debugLog('vencimento.restore.link', { source: link.source })
    try {
      if (link.source === 'electron') {
        if (!window?.electronAPI?.resolveFolder || !isValidElectronPath(link.folderPath)) {
          setRestoreStatus({ state: 'error', message: 'Vinculo salvo invalido.' })
          return
        }
        const meta = await window.electronAPI.resolveFolder(link.folderPath)
        if (!meta?.filePath) {
          setRestoreStatus({ state: 'error', message: 'Pasta nao encontrada ou sem permissao.' })
          return
        }
        const nextPending = { source: 'electron', ...meta }
        setPendingFile(nextPending)
        await applyPendingFile(nextPending, { save: false, silent })
        setRestoreStatus({ state: 'idle', message: '' })
        return
      }

      if (link.source === 'browser') {
        const handle = link.handle
        if (!handle) {
          setRestoreStatus({ state: 'needs-permission', message: 'Permissao pendente para a pasta.' })
          return
        }
        const permission = await ensurePermission(handle)
        setPermissionState(permission)
        if (permission !== 'granted') {
          setRestoreStatus({ state: 'needs-permission', message: 'Reautorize o acesso a pasta para restaurar.' })
          return
        }
        const picked = await pickFileFromDirectoryHandle(handle)
        if (!picked?.file) {
          setRestoreStatus({ state: 'error', message: 'Planilha nao encontrada na pasta vinculada.' })
          return
        }
        const nextPending = { source: 'browser', handle, ...picked }
        setPendingFile(nextPending)
        await applyPendingFile(nextPending, { save: false, silent })
        setRestoreStatus({ state: 'idle', message: '' })
        return
      }

      if (link.source === 'file') {
        setRestoreStatus({ state: 'idle', message: cacheMeta?.rows?.length ? '' : 'Cache local pronto para uso.' })
      }
    } finally {
      restoreRef.current.running = false
      setIsRestoring(false)
    }
  }, [applyPendingFile, cacheMeta?.rows?.length])

  const restoreFromStorage = useCallback(async ({ reparse = false } = {}) => {
    if (!userKey) return
    const cached = loadLastImported(userKey)
    hydrateCache(cached)
    const link = await loadLink(userKey)
    debugLog('vencimento.restore.storage', { hasCache: Boolean(cached?.rows?.length), linkSource: link?.source || null })
    setLinkMeta(link || null)
    setPermissionState(null)
    if (!link) {
      if (cached?.rows?.length) {
        setRestoreStatus({ state: 'idle', message: 'Dados restaurados do cache local.' })
      } else {
        setRestoreStatus({ state: 'idle', message: '' })
      }
      return
    }
    if (reparse) {
      await restoreFromLink(link, { silent: true })
    }
  }, [hydrateCache, restoreFromLink, userKey])

  useEffect(() => {
    if (!userKey) return
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('pwr:vencimento')
      broadcastRef.current = channel
      channel.onmessage = (event) => {
        const message = event?.data
        if (!message || message.sender === tabIdRef.current) return
        if (message.userKey !== userKey) return
        restoreFromStorage({ reparse: false })
      }
    }

    const handleStorage = (event) => {
      if (!event?.key) return
      if (event.key === 'pwr.vencimento.broadcast') {
        const payload = (() => {
          try {
            return JSON.parse(event.newValue || '{}')
          } catch {
            return null
          }
        })()
        if (!payload || payload.sender === tabIdRef.current) return
        if (payload.userKey !== userKey) return
        restoreFromStorage({ reparse: false })
        return
      }
      if (event.key.startsWith('pwr.vencimento.link.') || event.key.startsWith('pwr.vencimento.cache.')) {
        if (!event.key.endsWith(userKey)) return
        restoreFromStorage({ reparse: false })
      }
    }

    window.addEventListener('storage', handleStorage)

    return () => {
      window.removeEventListener('storage', handleStorage)
      if (broadcastRef.current) {
        broadcastRef.current.close()
        broadcastRef.current = null
      }
    }
  }, [restoreFromStorage, userKey])

  useEffect(() => {
    if (!userKey) return
    restoreFromStorage({ reparse: true })
  }, [restoreFromStorage, userKey])

  useEffect(() => {
    let active = true
    const loadMarket = async () => {
      const next = {}
      const dividendRequests = operations.map((operation) => buildDividendRequest(operation, reportDate)).filter(Boolean)
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
        const dividendRequest = buildDividendRequest(operation, reportDate)
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

  useEffect(() => {
    let active = true
    const run = async () => {
      if (!reportDate) {
        setDividendAdjustments(new Map())
        setDividendStatus({ loading: false, error: '' })
        return
      }
      clearDividendsCache()
      const from = addDays(reportDate, 1)
      if (!from) {
        setDividendAdjustments(new Map())
        setDividendStatus({ loading: false, error: '' })
        return
      }
      const requests = operations
        .map((operation) => {
          const to = normalizeDateKey(operation?.vencimento || operation?.dataReferencia)
          const ticker = operation?.ativo
          if (!ticker || !to || from >= to) return null
          return {
            id: operation.id,
            key: buildDividendKey(ticker, from, to),
            ticker,
            from,
            to,
          }
        })
        .filter(Boolean)

      if (!requests.length) {
        setDividendAdjustments(new Map())
        setDividendStatus({ loading: false, error: '' })
        return
      }

      setDividendStatus({ loading: true, error: '' })
      try {
        const results = await fetchDividendsBatch(requests.map(({ ticker, from, to }) => ({ ticker, from, to })))
        const resultMap = new Map(results.filter(Boolean).map((item) => [item.key, item]))
        const next = new Map()
        requests.forEach((req) => {
          const item = resultMap.get(req.key)
          next.set(req.id, {
            total: Number(item?.total || 0),
            source: item?.source || null,
          })
        })
        if (active) {
          setDividendAdjustments(next)
          setDividendStatus({ loading: false, error: '' })
        }
      } catch (error) {
        if (active) {
          setDividendAdjustments(new Map())
          setDividendStatus({ loading: false, error: 'Falha ao recalcular proventos.' })
        }
      }
    }
    run()
    return () => {
      active = false
    }
  }, [dividendsRefreshToken, operations, reportDate])

  const enrichedOperations = useMemo(
    () => operations.map((operation) => enrichRow(operation, tagsIndex)),
    [operations, tagsIndex],
  )
  const brokerOptions = useMemo(() => buildOptions(enrichedOperations.map((item) => item.broker), 'Broker'), [enrichedOperations])
  const operationsByPeriod = useMemo(() => {
    if (!filters.vencimentos.length) return enrichedOperations
    const set = new Set(filters.vencimentos)
    return enrichedOperations.filter((item) => set.has(normalizeDateKey(item?.vencimento)))
  }, [enrichedOperations, filters.vencimentos])
  const estruturaOptions = useMemo(() => buildMultiOptions(operationsByPeriod.map((item) => item.estrutura)), [operationsByPeriod])
  const ativoOptions = useMemo(() => buildMultiOptions(enrichedOperations.map((item) => item.ativo)), [enrichedOperations])
  const assessorOptions = useMemo(() => buildMultiOptions(enrichedOperations.map((item) => item.assessor)), [enrichedOperations])
  const { tree: vencimentoTree, allValues: vencimentoValues } = useMemo(
    () => buildVencimentoTree(enrichedOperations),
    [enrichedOperations],
  )

  const handleRefreshData = useCallback(async (operation) => {
    try {
      const market = await fetchYahooMarketData({
        symbol: operation.ativo,
        startDate: operation.dataRegistro,
        endDate: operation.vencimento,
      })
      let dividend = null
      const dividendRequest = buildDividendRequest(operation, reportDate)
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

  const applyDividendAdjustments = useCallback((legs, adjustment) => {
    if (!Array.isArray(legs) || !legs.length) return legs
    const total = Number(adjustment || 0)
    if (!reportDate || !Number.isFinite(total) || total <= 0) return legs
    return legs.map((leg) => {
      const tipo = String(leg?.tipo || '').toUpperCase()
      if (tipo !== 'CALL' && tipo !== 'PUT') return leg
      const strike = Number(leg?.strike ?? leg?.precoStrike)
      if (!Number.isFinite(strike)) return leg
      const adjusted = Math.max(0, strike - total)
      return {
        ...leg,
        strikeOriginal: strike,
        strikeAjustado: adjusted,
        dividendAdjustment: total,
      }
    })
  }, [reportDate])

  const rows = useMemo(() => {
    const vencimentoSet = new Set(filters.vencimentos)
    return enrichedOperations
      .map((operation) => {
        const market = marketMap[operation.id]
        const dividendInfo = dividendAdjustments.get(operation.id)
        const override = overrides[operation.id] || { high: 'auto', low: 'auto', manualCouponBRL: null, manualCouponPct: null, qtyBonus: 0, bonusDate: '', bonusNote: '' }
        const qtyBase = parseQuantity(operation.qtyBase ?? operation.quantidade ?? 0)
        const qtyAtualRaw = operation.qtyAtual ?? operation.quantidadeAtual
        const qtyAtualSource = parseQuantity(qtyAtualRaw)
        const hasQtyAtualSource = qtyAtualRaw != null && qtyAtualSource > 0
        const overrideBonus = parseQuantity(override.qtyBonus ?? 0)
        const hasOverrideBonus = overrideBonus > 0
        const qtyBonus = hasOverrideBonus
          ? overrideBonus
          : hasQtyAtualSource
            ? Math.max(0, qtyAtualSource - qtyBase)
            : 0
        const qtyAtual = hasOverrideBonus
          ? Math.max(0, qtyBase + qtyBonus)
          : hasQtyAtualSource
            ? qtyAtualSource
            : Math.max(0, qtyBase + qtyBonus)
        const spotBase = resolveSpotBase(operation, market)
        const adjustedLegs = applyDividendAdjustments(operation.pernas, dividendInfo?.total)
        const operationWithSpot = spotBase != null
          ? { ...operation, spotInicial: spotBase, qtyBase, qtyBonus, qtyAtual, pernas: adjustedLegs }
          : { ...operation, qtyBase, qtyBonus, qtyAtual, pernas: adjustedLegs }
        const barrierStatus = computeBarrierStatus(operationWithSpot, market, override)
        const manualCouponBRL = override?.manualCouponBRL != null && Number.isFinite(Number(override.manualCouponBRL))
          ? Number(override.manualCouponBRL)
          : null
        const legacyCouponLabel = override?.manualCouponPct || null
        const cupomResolved = manualCouponBRL != null
          ? formatCurrency(manualCouponBRL)
          : (legacyCouponLabel || operation.cupom || 'N/A')
        const result = computeResult(operationWithSpot, market, barrierStatus, override)
        const effectiveLegs = result.effectiveLegs || getEffectiveLegs(operationWithSpot)
        return {
          ...operation,
          qtyBase,
          qtyBonus,
          qtyAtual,
          market,
          spotBase,
          override,
          manualCouponBRL,
          legacyCouponLabel,
          cupomResolved,
          barrierStatus,
          result,
          effectiveLegs,
          dividendAdjustment: dividendInfo?.total || 0,
          dividendSource: dividendInfo?.source || null,
          status: getStatus(operation.vencimento),
        }
      })
      .filter((entry) => {
        const query = filters.search.toLowerCase()
        const searchBase = `${entry.codigoCliente || ''} ${entry.cliente || ''} ${entry.nomeCliente || ''} ${entry.ativo || ''} ${entry.estrutura || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase()
        if (query && !searchBase.includes(query)) return false
        if (selectedBroker && entry.broker !== selectedBroker) return false
        if (selectedAssessor && entry.assessor !== selectedAssessor) return false
        if (filters.broker && entry.broker !== filters.broker) return false
        if (filters.assessores?.length && !filters.assessores.includes(entry.assessor)) return false
        if (clientCodeFilter) {
          const clienteMatch = String(entry.codigoCliente || entry.cliente || '').trim()
          if (clienteMatch !== String(clientCodeFilter).trim()) return false
        }
        if (filters.estruturas?.length && !filters.estruturas.includes(entry.estrutura)) return false
        if (filters.ativos?.length && !filters.ativos.includes(entry.ativo)) return false
        if (vencimentoSet.size && !vencimentoSet.has(normalizeDateKey(entry.vencimento))) return false
        if (filters.status && entry.status.key !== filters.status) return false
        return true
      })
  }, [applyDividendAdjustments, clientCodeFilter, dividendAdjustments, enrichedOperations, filters, marketMap, overrides, reportDate, selectedBroker, selectedAssessor])

  const pageCount = useMemo(() => Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), [rows.length])
  const paginationItems = useMemo(() => buildPagination(currentPage, pageCount), [currentPage, pageCount])
  useEffect(() => {
    setCurrentPage((prev) => Math.min(Math.max(prev, 1), pageCount))
  }, [pageCount])
  useEffect(() => {
    setCurrentPage(1)
  }, [filters, operations, selectedBroker, selectedAssessor, clientCodeFilter])

  const pageStart = (currentPage - 1) * PAGE_SIZE
  const visibleRows = useMemo(() => rows.slice(pageStart, pageStart + PAGE_SIZE), [rows, pageStart])

  useEffect(() => {
    if (!selectedReport) return
    const updated = rows.find((row) => row.id === selectedReport.id)
    if (updated && updated !== selectedReport) setSelectedReport(updated)
  }, [rows, selectedReport])

  const handleRefreshAll = useCallback(async () => {
    setIsRefreshingAll(true)
    try {
      const operationMap = new Map(visibleRows.map((operation) => [operation.id, operation]))
      const dividendRequests = visibleRows.map((operation) => buildDividendRequest(operation, reportDate)).filter(Boolean)
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
              const dividendRequest = operation ? buildDividendRequest(operation, reportDate) : null
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
    const current = overrides[row.id] || { high: 'auto', low: 'auto', manualCouponBRL: '', qtyBonus: 0, bonusDate: '', bonusNote: '' }
    setOverrideDraft({ ...current, manualCouponBRL: current.manualCouponBRL ?? '' })
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
        render: (row) => {
          const valorEntrada = row.result?.valorEntrada
          if (row.result?.valorEntradaIncomplete) return <span className="muted">Dados incompletos</span>
          if (valorEntrada == null || Number.isNaN(Number(valorEntrada))) return '—'
          return formatCurrency(valorEntrada)
        },
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
        render: (row) => (
          row.result.optionsSuppressed
            ? <span className="muted">N/A</span>
            : formatCurrency(row.result.ganhosOpcoes)
        ),
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
          const manual = row.manualCouponBRL != null
          const legacyNeedsInput = row.result.cupomLegacyNeedsInput
          const legacyConverted = row.result.cupomLegacyConverted
          const label = row.cupomResolved || row.cupom || 'N/A'
          return (
            <div className="cell-stack">
              <strong>{label}</strong>
              {legacyNeedsInput
                ? <small className="muted">Precisa reentrada</small>
                : manual
                  ? <small>Manual</small>
                  : legacyConverted
                    ? <small>Legado</small>
                    : <small>Automatico</small>}
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
      { key: 'broker', label: filters.broker, onClear: () => setFilters((prev) => ({ ...prev, broker: '' })) },
    { key: 'assessores', label: filters.assessores.length ? `Assessores (${filters.assessores.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, assessores: [] })) },
    { key: 'clientCode', label: clientCodeFilter, onClear: () => setClientCodeFilter('') },
    { key: 'estruturas', label: filters.estruturas.length ? `Estruturas (${filters.estruturas.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, estruturas: [] })) },
    { key: 'ativos', label: filters.ativos.length ? `Ativos (${filters.ativos.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, ativos: [] })) },
    { key: 'vencimentos', label: vencimentoChipLabel, onClear: () => setFilters((prev) => ({ ...prev, vencimentos: [] })) },
      { key: 'status', label: filters.status, onClear: () => setFilters((prev) => ({ ...prev, status: '' })) },
    ].filter((chip) => chip.label)

    const handleClearFilters = useCallback(() => {
      setFilters({
        search: '',
        broker: '',
        status: '',
        vencimentos: [],
        estruturas: [],
        ativos: [],
        assessores: [],
      })
      setClientCodeFilter('')
    }, [setClientCodeFilter])

  const handlePickFolder = useCallback(async () => {
    try {
      if (window?.electronAPI?.selectFolder) {
        const meta = await window.electronAPI.selectFolder()
        if (!meta?.filePath) {
          notify('Selecao de pasta cancelada.', 'warning')
          return
        }
        const nextPending = { source: 'electron', ...meta }
        setPendingFile(nextPending)
        if (isValidElectronPath(meta.folderPath)) {
          const saved = await saveLink(userKey, {
            source: 'electron',
            folderPath: meta.folderPath,
            fileName: meta.fileName,
          })
          if (saved) setLinkMeta(saved)
          broadcastUpdate('vencimento-updated', { kind: 'link' })
        }
        notify('Pasta vinculada. Clique em calcular.', 'success')
        return
      }
      if ('showDirectoryPicker' in window) {
        const handle = await window.showDirectoryPicker()
        const picked = await pickFileFromDirectoryHandle(handle)
        if (!picked?.file) {
          notify('Nenhuma planilha .xlsx encontrada.', 'warning')
          setPendingFile(null)
          return
        }
        const nextPending = { source: 'browser', handle, ...picked }
        setPendingFile(nextPending)
        setPermissionState('granted')
        const saved = await saveLink(userKey, {
          source: 'browser',
          handle,
          folderName: picked.folderName,
          fileName: picked.fileName,
        })
        if (saved) setLinkMeta(saved)
        broadcastUpdate('vencimento-updated', { kind: 'link' })
        notify('Pasta selecionada. Clique em vincular para calcular.', 'success')
      } else {
        fileInputRef.current?.click()
      }
    } catch {
      notify('Selecao de pasta cancelada.', 'warning')
    }
  }, [broadcastUpdate, notify, userKey])

  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files || [])
    const file = pickPreferredFile(files)
    if (!file) {
      notify('Selecione um arquivo .xlsx.', 'warning')
      return
    }
    const nextPending = { source: 'file', file, fileName: file.name }
    setPendingFile(nextPending)
    const saved = await saveLink(userKey, {
      source: 'file',
      fileName: file.name,
    })
    if (saved) setLinkMeta(saved)
    broadcastUpdate('vencimento-updated', { kind: 'link' })
    notify('Planilha pronta. Clique em vincular para calcular.', 'success')
  }

  const handleApplyFolder = useCallback(async () => {
    if (!pendingFile) {
      notify('Escolha a pasta/planilha antes de vincular.', 'warning')
      return
    }
    await applyPendingFile(pendingFile, { save: true, silent: false })
  }, [applyPendingFile, notify, pendingFile])

  const handleReauthorize = useCallback(async () => {
    if (!linkMeta?.handle) {
      notify('Nenhuma pasta para reautorizar.', 'warning')
      return
    }
    const state = await ensurePermission(linkMeta.handle, { interactive: true })
    setPermissionState(state)
    if (state === 'granted') {
      await restoreFromLink(linkMeta, { silent: false })
    } else {
      setRestoreStatus({ state: 'needs-permission', message: 'Permissao nao concedida.' })
    }
  }, [linkMeta, notify, restoreFromLink])

  const handleUnlink = useCallback(async () => {
    await clearLink(userKey)
    clearLastImported(userKey)
    setLinkMeta(null)
    setCacheMeta(null)
    setPendingFile(null)
    setPermissionState(null)
    setRestoreStatus({ state: 'idle', message: '' })
    setOperations(vencimentos)
    broadcastUpdate('vencimento-updated', { kind: 'clear' })
    notify('Vinculo removido.', 'success')
  }, [broadcastUpdate, notify, userKey])

  const handleRecalculateDividends = useCallback(() => {
    clearDividendsCache()
    setDividendsRefreshToken((prev) => prev + 1)
  }, [])

  const handleExportPdf = (row) => {
    const barrierBadge = getBarrierBadge(row.barrierStatus)
    const clienteLabel = row.nomeCliente || row.cliente || row.codigoCliente || 'Cliente'
    const payload = {
      title: `Relatorio - ${clienteLabel}`,
      header: `${row.ativo} | ${row.estrutura} | ${formatDate(row.vencimento)}`,
      summary: `<strong>${formatCurrency(row.result.financeiroFinal)}</strong> <span class="badge">${barrierBadge.label}</span>`,
      details: [
        { label: 'Spot', value: formatSpotValue(row.spotBase ?? row.spotInicial) },
        { label: 'Quantidade base', value: formatNumber(row.qtyBase) },
        { label: 'Bonificacao', value: formatNumber(row.qtyBonus) },
        { label: 'Quantidade atual', value: formatNumber(row.qtyAtual) },
        { label: 'Valor de entrada', value: row.result.valorEntradaIncomplete ? 'Dados incompletos' : formatCurrency(row.result.valorEntrada) },
        { label: 'Financeiro final', value: formatCurrency(row.result.financeiroFinal) },
        { label: 'Ganho/Prejuizo', value: formatCurrency(row.result.ganho) },
        { label: 'Ganho %', value: `${(row.result.percent * 100).toFixed(2)}%` },
        { label: 'Venda do ativo', value: formatCurrency(row.result.vendaAtivo) },
        { label: 'Ganho na Call', value: row.result.optionsSuppressed ? 'N/A' : formatCurrency(row.result.ganhoCall) },
        { label: 'Ganho na Put', value: row.result.optionsSuppressed ? 'N/A' : formatCurrency(row.result.ganhoPut) },
        { label: 'Ganhos nas opcoes', value: row.result.optionsSuppressed ? 'N/A' : formatCurrency(row.result.ganhosOpcoes) },
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
        row.manualCouponBRL != null ? 'Cupom manual aplicado.' : null,
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

  const hasLink = Boolean(linkMeta)
  const showReauthorize = Boolean(
    linkMeta?.source === 'browser'
    && (permissionState === 'prompt' || permissionState === 'denied' || restoreStatus.state === 'needs-permission'),
  )
  const isBusy = isParsing || isRestoring

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
            {showReauthorize ? (
              <button className="btn btn-secondary" type="button" onClick={handleReauthorize} disabled={isBusy}>
                <Icon name="sync" size={16} />
                Reautorizar
              </button>
            ) : null}
            <button className="btn btn-secondary" type="button" onClick={handlePickFolder} disabled={isBusy}>
              <Icon name="link" size={16} />
              {hasLink ? 'Trocar pasta' : 'Vincular pasta'}
            </button>
            {hasLink ? (
              <button className="btn btn-secondary" type="button" onClick={handleUnlink} disabled={isBusy}>
                <Icon name="close" size={16} />
                Desvincular
              </button>
            ) : null}
            <button
              className="btn btn-primary"
              type="button"
              onClick={handleApplyFolder}
              disabled={!pendingFile || isBusy}
            >
              <Icon name="sync" size={16} />
              {isBusy ? 'Calculando...' : 'Vincular e calcular'}
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
        {restoreStatus.message ? <div className="muted">{restoreStatus.message}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Data do relatorio</h3>
            <p className="muted">Usada como corte para ajustar strikes por proventos.</p>
          </div>
          <div className="panel-actions">
            <input
              className="input"
              type="date"
              value={reportDate}
              onChange={(event) => setReportDate(event.target.value)}
            />
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleRecalculateDividends}
              disabled={!reportDate || dividendStatus.loading}
            >
              <Icon name="sync" size={16} />
              {dividendStatus.loading ? 'Recalculando...' : 'Recalcular proventos'}
            </button>
          </div>
        </div>
        {dividendStatus.error ? <div className="muted">{dividendStatus.error}</div> : null}
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
          <MultiSelect
            value={filters.assessores}
            options={assessorOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, assessores: value }))}
            placeholder="Assessor"
          />
          <MultiSelect
            value={filters.estruturas}
            options={estruturaOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, estruturas: value }))}
            placeholder="Estrutura"
          />
          <MultiSelect
            value={filters.ativos}
            options={ativoOptions}
            onChange={(value) => setFilters((prev) => ({ ...prev, ativos: value }))}
            placeholder="Ativo"
          />
          <TreeSelect
            value={filters.vencimentos}
            tree={vencimentoTree}
            allValues={vencimentoValues}
            onChange={(value) => setFilters((prev) => ({ ...prev, vencimentos: value }))}
            placeholder="Vencimento da estrutura"
          />
          <input
            className="input"
            placeholder="Codigo do cliente"
            value={clientCodeFilter}
            onChange={(event) => setClientCodeFilter(event.target.value)}
          />
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
                onClick={() => chip.onClear?.()}
                type="button"
              >
                {chip.label}
                <Icon name="close" size={12} />
              </button>
            ))}
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleClearFilters}
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
