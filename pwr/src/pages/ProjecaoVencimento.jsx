import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Icon from '../components/Icons'
import MultiSelect from '../components/MultiSelect'
import TreeSelect from '../components/TreeSelect'
import SelectMenu from '../components/SelectMenu'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { apiFetch } from '../services/apiBase'
import { parseWorkbook, parseWorkbookBuffer } from '../services/excel'
import { applyOverridesToOperation, computeResult, resolveOperationQuantities } from '../services/settlement'
import { loadOverrides } from '../services/overrides'
import { getCurrentUserKey } from '../services/currentUser'
import { enrichRow } from '../services/tags'
import { clearLink, ensurePermission, isValidElectronPath, loadLink, saveLink } from '../services/vencimentoLink'
import { clearLastImported, loadLastImported, saveLastImported } from '../services/vencimentoCache'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import useGlobalFolderMenu from '../hooks/useGlobalFolderMenu'

const TOP_GROUP_LIMIT = 10
const SPOT_CONCURRENCY = 8
const EMPTY_OVERRIDE = Object.freeze({})
const SCOPE_ALL = 'all'
const SCOPE_CURRENT_FORWARD = 'current-forward'
const EMPTY_STACK_TOOLTIP = { open: false, index: null, x: 0, y: 0, flip: false }
const EMPTY_RECEITA_TOOLTIP = { open: false, index: null, x: 0, y: 0, flip: false }
const STACK_COLORS = [
  '#28f2e6',
  '#4da3ff',
  '#a66bff',
  '#34f5a4',
  '#ffb454',
  '#ff4d6d',
  '#8ec5ff',
  '#90e0ef',
  '#9ef0b8',
  '#ffd27d',
  '#b39ddb',
]
const spotCache = new Map()
const spotInflight = new Map()
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

let compactCurrencyFormatter = null

try {
  compactCurrencyFormatter = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    notation: 'compact',
    maximumFractionDigits: 1,
  })
} catch {
  compactCurrencyFormatter = null
}

const formatCurrencyCompact = (value) => {
  const safeValue = Number.isFinite(value) ? value : 0
  if (compactCurrencyFormatter) return compactCurrencyFormatter.format(safeValue)

  const abs = Math.abs(safeValue)
  if (abs < 1000) return formatCurrency(safeValue)
  const sign = safeValue < 0 ? '-' : ''
  if (abs >= 1000000000) return `${sign}R$ ${(abs / 1000000000).toFixed(1)}B`
  if (abs >= 1000000) return `${sign}R$ ${(abs / 1000000).toFixed(1)}M`
  return `${sign}R$ ${(abs / 1000).toFixed(1)}k`
}

const buildChartScale = (values, tickCount = 5) => {
  const safeValues = values.filter((value) => Number.isFinite(value))
  const domainMin = safeValues.length ? Math.min(0, ...safeValues) : 0
  const domainMax = safeValues.length ? Math.max(0, ...safeValues) : 0
  const range = domainMax - domainMin || 1
  const normalizedTickCount = Math.max(tickCount, 4)
  const ticks = Array.from({ length: normalizedTickCount }, (_, index) => {
    const ratio = normalizedTickCount === 1 ? 0 : index / (normalizedTickCount - 1)
    return {
      value: domainMin + ratio * range,
      percent: ratio * 100,
    }
  })
  return { domainMin, range, ticks }
}

const normalizeSeries = (values, scale) => values.map((value) => {
  const safeValue = Number.isFinite(value) ? value : 0
  const percent = ((safeValue - scale.domainMin) / scale.range) * 100
  return clamp(percent, 0, 100)
})

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

const buildFolderLabel = (link, cache) => {
  if (link) {
    if (link.source === 'electron') {
      if (link.folderPath && link.fileName) return `${link.folderPath} - ${link.fileName}`
      if (link.folderPath) return link.folderPath
    }
    if (link.source === 'browser') {
      const folder = link.folderName || 'Pasta'
      const file = link.fileName || cache?.fileName
      return file ? `${folder} - ${file}` : folder
    }
    if (link.fileName) return link.fileName
  }
  if (cache?.fileName) return `${cache.fileName} - cache`
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

const buildMultiOptions = (values) => {
  const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return unique.map((value) => ({ value, label: value }))
}

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

const toOptionalNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const parseQuantity = (value) => {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const cleaned = String(value).trim().replace(/\s+/g, '').replace(',', '.')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

const resolveProjectionEntryValue = (operation, result, qtyBase) => {
  const valorEntrada = toOptionalNumber(result?.valorEntrada)
  if (valorEntrada != null && valorEntrada > 0) {
    return { value: valorEntrada, incomplete: false }
  }

  const calculo = toOptionalNumber(operation?.calculo)
  if (calculo != null && calculo > 0) {
    return { value: calculo, incomplete: false }
  }

  const stockUnitPrice = toOptionalNumber(operation?.spotInicial ?? operation?.custoUnitario)
  if (stockUnitPrice != null && stockUnitPrice > 0 && qtyBase > 0) {
    return { value: stockUnitPrice * qtyBase, incomplete: false }
  }

  return {
    value: valorEntrada ?? 0,
    incomplete: Boolean(result?.valorEntradaIncomplete),
  }
}

const toMonthKey = (value) => {
  const normalized = normalizeDateKey(value)
  return normalized ? normalized.slice(0, 7) : ''
}

const formatMonthLabel = (key) => {
  if (!key) return '-'
  const [year, month] = String(key).split('-')
  if (!year || !month) return key
  const date = new Date(Number(year), Number(month) - 1, 1)
  if (Number.isNaN(date.getTime())) return `${month}/${year}`
  const monthLabel = date.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')
  return `${monthLabel}/${year}`
}

const getCurrentMonthKey = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const getMaxMonthKey = (monthsAhead = 12) => {
  const now = new Date()
  now.setMonth(now.getMonth() + monthsAhead)
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const fetchSpotPrice = async (ticker, { force = false } = {}) => {
  const key = String(ticker || '').trim().toUpperCase()
  if (!key) return null
  if (!force && spotCache.has(key)) return spotCache.get(key)
  if (!force && spotInflight.has(key)) return spotInflight.get(key)

  const request = (async () => {
    try {
      const response = await apiFetch(`/api/spot?symbol=${encodeURIComponent(key)}&provider=yahoo`, {}, {
        retries: 2,
        backoffMs: 500,
        timeoutMs: 8000,
      })
      if (!response.ok) return null
      const data = await response.json()
      const price = Number(data?.price)
      if (!Number.isFinite(price)) return null
      spotCache.set(key, price)
      return price
    } catch {
      return null
    } finally {
      spotInflight.delete(key)
    }
  })()

  spotInflight.set(key, request)
  return request
}

const mergeSpotPrice = (rows, ticker, price) => {
  if (!Array.isArray(rows) || !rows.length) return rows
  const targetTicker = String(ticker || '').trim().toUpperCase()
  if (!targetTicker || price == null) return rows
  let changed = false
  const next = rows.map((row) => {
    const rowTicker = String(row?.ativo || '').trim().toUpperCase()
    if (!rowTicker || rowTicker !== targetTicker) return row
    const current = Number(row.spotInicial)
    if (Number.isFinite(current) && Math.abs(current - price) < 1e-9) return row
    changed = true
    return { ...row, spotInicial: price }
  })
  return changed ? next : rows
}

const attachSpotPrices = async (rows, { force = false, onSpot } = {}) => {
  if (!Array.isArray(rows) || !rows.length) return rows

  const tickers = Array.from(new Set(
    rows
      .filter((row) => row?.ativo)
      .map((row) => String(row.ativo || '').trim().toUpperCase())
      .filter(Boolean),
  ))

  if (!tickers.length) return rows

  const results = await mapWithConcurrency(
    tickers,
    SPOT_CONCURRENCY,
    async (ticker) => {
      const price = await fetchSpotPrice(ticker, { force })
      if (price != null) onSpot?.(ticker, price)
      return [ticker, price]
    },
  )

  const priceMap = new Map(results.filter(([, price]) => price != null))
  if (!priceMap.size) return rows

  return rows.map((row) => {
    const ticker = String(row?.ativo || '').trim().toUpperCase()
    if (!ticker) return row
    const price = priceMap.get(ticker)
    if (price == null) return row
    return { ...row, spotInicial: price }
  })
}

const normalizeForFilter = (value) => String(value || '').trim()

const normalizeSelectionValues = (values) => {
  const list = Array.isArray(values) ? values : [values]
  return Array.from(new Set(list.map((value) => String(value || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
}

const hasSameSelection = (currentValues, nextValues) => {
  const current = normalizeSelectionValues(currentValues)
  const next = normalizeSelectionValues(nextValues)
  if (current.length !== next.length) return false
  return current.every((value, index) => value === next[index])
}

const ProjecaoVencimento = () => {
  const { notify } = useToast()
  const {
    selectedBroker,
    selectedAssessor,
    clientCodeFilter,
    setClientCodeFilter,
    tagsIndex,
  } = useGlobalFilters()

  const [userKey] = useState(() => getCurrentUserKey())
  const globalFolderMenu = useGlobalFolderMenu('projecao-vencimento')
  const [filters, setFilters] = useState({
    search: '',
    broker: [],
    assessores: [],
    estruturas: [],
    ativos: [],
    vencimentos: [],
  })
  const [maturityScope, setMaturityScope] = useState(SCOPE_ALL)
  const [operations, setOperations] = useState([])
  const [overrides, setOverrides] = useState(() => loadOverrides(userKey))
  const [linkMeta, setLinkMeta] = useState(null)
  const [cacheMeta, setCacheMeta] = useState(null)
  const [restoreStatus, setRestoreStatus] = useState({ state: 'idle', message: '' })
  const [permissionState, setPermissionState] = useState(null)
  const [pendingFile, setPendingFile] = useState(null)
  const [isParsing, setIsParsing] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)

  const fileInputRef = useRef(null)
  const broadcastRef = useRef(null)
  const tabIdRef = useRef(Math.random().toString(36).slice(2))
  const restoreRef = useRef({ running: false })
  const spotEnrichmentSeqRef = useRef(0)
  const receitaChartRef = useRef(null)
  const stackChartRef = useRef(null)
  const [receitaTooltip, setReceitaTooltip] = useState(() => EMPTY_RECEITA_TOOLTIP)
  const [stackTooltip, setStackTooltip] = useState(() => EMPTY_STACK_TOOLTIP)
  const currentMonthKey = useMemo(() => getCurrentMonthKey(), [])

  const folderLabel = useMemo(() => {
    if (pendingFile) {
      if (pendingFile.source === 'electron') {
        if (pendingFile.folderPath && pendingFile.fileName) return `${pendingFile.folderPath} - ${pendingFile.fileName}`
        if (pendingFile.folderPath) return pendingFile.folderPath
      }
      if (pendingFile.source === 'browser') {
        const folder = pendingFile.folderName || pendingFile.handle?.name || 'Pasta'
        const fileName = pendingFile.fileName || pendingFile.file?.name
        return fileName ? `${folder} - ${fileName}` : folder
      }
      if (pendingFile.file?.name) return pendingFile.file.name
    }
    return buildFolderLabel(linkMeta, cacheMeta)
  }, [cacheMeta, linkMeta, pendingFile])
  const globalDirectoryOptions = useMemo(
    () => globalFolderMenu.directoryOptions.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.directory?.folderPath || '',
    })),
    [globalFolderMenu.directoryOptions],
  )
  const globalDirectoryEmptyMessage = useMemo(() => {
    if (globalFolderMenu.loading) return ''
    return globalFolderMenu.emptyMessage
  }, [globalFolderMenu.emptyMessage, globalFolderMenu.loading])

  useEffect(() => {
    if (!userKey) return
    setOverrides(loadOverrides(userKey))
  }, [userKey])

  useEffect(() => {
    if (!userKey) return undefined
    const handleStorage = (event) => {
      if (!event?.key) return
      if (event.key.startsWith('pwr.vencimento.overrides.') && event.key.endsWith(userKey)) {
        setOverrides(loadOverrides(userKey))
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [userKey])

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
      return
    }
    try {
      localStorage.setItem('pwr.vencimento.broadcast', JSON.stringify(message))
    } catch {
      // noop
    }
  }, [userKey])

  const hydrateCache = useCallback((cache) => {
    setCacheMeta(cache || null)
    if (cache?.rows?.length) {
      setOperations(cache.rows)
      return
    }
    setOperations([])
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
          const response = await apiFetch('/api/vencimentos/parse', {
            method: 'POST',
            body: formData,
          }, { retries: 0, timeoutMs: 45000 })
          if (!response.ok) throw new Error('api-failed')
          const data = await response.json()
          if (!Array.isArray(data?.rows)) throw new Error('api-invalid')
          parsedRows = data.rows
          parseSource = 'api'
        } catch {
          parsedRows = await parseWorkbook(file)
          parseSource = 'local'
          if (!silent) notify('API indisponivel. Parse local aplicado.', 'warning')
        }
      }

      if (!parsedRows) throw new Error('parse-empty')
      const enrichmentRunId = spotEnrichmentSeqRef.current + 1
      spotEnrichmentSeqRef.current = enrichmentRunId
      setOperations(parsedRows)

      const storedCache = saveLastImported(userKey, {
        rows: parsedRows,
        fileName,
        importedAt: Date.now(),
        source: parseSource,
      })
      setCacheMeta(storedCache)
      void attachSpotPrices(parsedRows, {
        onSpot: (ticker, price) => {
          if (spotEnrichmentSeqRef.current !== enrichmentRunId) return
          setOperations((prev) => mergeSpotPrice(prev, ticker, price))
        },
      }).then((rowsWithSpot) => {
        if (spotEnrichmentSeqRef.current !== enrichmentRunId) return
        const nextCache = saveLastImported(userKey, {
          rows: rowsWithSpot,
          fileName,
          importedAt: Date.now(),
          source: `${parseSource}-spot`,
        })
        setCacheMeta(nextCache)
      })

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
      setPendingFile(null)
      if (!silent) notify('Planilha vinculada e calculada.', 'success')
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
          setRestoreStatus({ state: 'needs-permission', message: 'Permissao pendente para a pasta vinculada.' })
          return
        }
        const permission = await ensurePermission(handle)
        setPermissionState(permission)
        if (permission !== 'granted') {
          setRestoreStatus({ state: 'needs-permission', message: 'Reautorize o acesso da pasta para restaurar.' })
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
    if (!userKey) return undefined

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

  const _handlePickFolder = useCallback(async () => {
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

        notify('Pasta vinculada. Clique em vincular e calcular.', 'success')
        return
      }

      if ('showDirectoryPicker' in window) {
        const handle = await window.showDirectoryPicker()
        const picked = await pickFileFromDirectoryHandle(handle)
        if (!picked?.file) {
          notify('Nenhuma planilha .xlsx encontrada na pasta.', 'warning')
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
        notify('Pasta selecionada. Clique em vincular e calcular.', 'success')
        return
      }

      fileInputRef.current?.click()
    } catch {
      notify('Selecao de pasta cancelada.', 'warning')
    }
  }, [broadcastUpdate, notify, userKey])

  const handleUseGlobalFolder = useCallback(async () => {
    try {
      const resolved = await globalFolderMenu.refreshFile()
      if (!resolved?.filePath) {
        notify('Nenhum arquivo importado vinculado para este modulo.', 'warning')
        return
      }

      const nextPending = { source: 'electron', ...resolved }
      setPendingFile(nextPending)
      const applied = await applyPendingFile(nextPending, { save: true, silent: false })
      if (!applied) setPendingFile(null)
    } catch {
      notify('Falha ao carregar arquivo importado.', 'warning')
    }
  }, [applyPendingFile, globalFolderMenu, notify])

  const _handleFileChange = useCallback(async (event) => {
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
    notify('Planilha pronta. Clique em vincular e calcular.', 'success')
  }, [broadcastUpdate, notify, userKey])

  const _handleApplyFolder = useCallback(async () => {
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
    setOperations([])
    broadcastUpdate('vencimento-updated', { kind: 'clear' })
    notify('Vinculo removido.', 'success')
  }, [broadcastUpdate, notify, userKey])

  const enrichedOperations = useMemo(
    () => operations.map((operation) => enrichRow(operation, tagsIndex) || operation),
    [operations, tagsIndex],
  )

  const operationsByScope = useMemo(() => {
    if (maturityScope !== SCOPE_CURRENT_FORWARD) return enrichedOperations
    return enrichedOperations.filter((operation) => {
      const monthKey = toMonthKey(operation?.vencimento)
      if (!monthKey) return false
      return monthKey >= currentMonthKey
    })
  }, [currentMonthKey, enrichedOperations, maturityScope])

  const operationsBySelectedVencimento = useMemo(() => {
    if (!filters.vencimentos.length) return operationsByScope
    const set = new Set(filters.vencimentos)
    return operationsByScope.filter((item) => set.has(normalizeDateKey(item?.vencimento)))
  }, [filters.vencimentos, operationsByScope])

  const brokerOptions = useMemo(
    () => buildMultiOptions(operationsByScope.map((item) => item.broker)),
    [operationsByScope],
  )
  const assessorOptions = useMemo(
    () => buildMultiOptions(operationsByScope.map((item) => item.assessor)),
    [operationsByScope],
  )
  const estruturaOptions = useMemo(
    () => buildMultiOptions(operationsBySelectedVencimento.map((item) => item.estrutura)),
    [operationsBySelectedVencimento],
  )
  const ativoOptions = useMemo(
    () => buildMultiOptions(operationsByScope.map((item) => item.ativo)),
    [operationsByScope],
  )
  const clienteOptions = useMemo(
    () => buildMultiOptions(operationsByScope.map((item) => item.codigoCliente || item.cliente)),
    [operationsByScope],
  )
  const effectiveSelectedBroker = useMemo(() => {
    if (!selectedBroker.length) return []
    const available = new Set(operationsByScope.map((item) => normalizeForFilter(item.broker)).filter(Boolean))
    return selectedBroker
      .map((value) => normalizeForFilter(value))
      .filter((value) => available.has(value))
  }, [operationsByScope, selectedBroker])
  const effectiveSelectedAssessor = useMemo(() => {
    if (!selectedAssessor.length) return []
    const available = new Set(operationsByScope.map((item) => normalizeForFilter(item.assessor)).filter(Boolean))
    return selectedAssessor
      .map((value) => normalizeForFilter(value))
      .filter((value) => available.has(value))
  }, [operationsByScope, selectedAssessor])
  const effectiveClientCodeFilter = useMemo(() => {
    if (!clientCodeFilter.length) return []
    const available = new Set(
      operationsByScope.map((item) => normalizeForFilter(item.codigoCliente || item.cliente)).filter(Boolean),
    )
    return clientCodeFilter
      .map((value) => normalizeForFilter(value))
      .filter((value) => available.has(value))
  }, [clientCodeFilter, operationsByScope])

  const { tree: vencimentoTree, allValues: vencimentoValues } = useMemo(
    () => buildVencimentoTree(operationsByScope),
    [operationsByScope],
  )

  const filteredOperations = useMemo(() => {
    const query = filters.search.toLowerCase()
    const vencimentoSet = new Set(filters.vencimentos)

    return operationsByScope.filter((entry) => {
      const broker = normalizeForFilter(entry.broker)
      const assessor = normalizeForFilter(entry.assessor)
      const estrutura = normalizeForFilter(entry.estrutura)
      const ativo = normalizeForFilter(entry.ativo)
      const clientCode = normalizeForFilter(entry.codigoCliente || entry.cliente)
      const vencimentoKey = normalizeDateKey(entry.vencimento)

      if (effectiveSelectedBroker.length && !effectiveSelectedBroker.includes(broker)) return false
      if (effectiveSelectedAssessor.length && !effectiveSelectedAssessor.includes(assessor)) return false
      if (filters.broker.length && !filters.broker.includes(broker)) return false
      if (filters.assessores.length && !filters.assessores.includes(assessor)) return false
      if (filters.estruturas.length && !filters.estruturas.includes(estrutura)) return false
      if (filters.ativos.length && !filters.ativos.includes(ativo)) return false
      if (effectiveClientCodeFilter.length && !effectiveClientCodeFilter.includes(clientCode)) return false
      if (vencimentoSet.size && !vencimentoSet.has(vencimentoKey)) return false

      if (query) {
        const searchBase = `${entry.codigoCliente || ''} ${entry.cliente || ''} ${entry.ativo || ''} ${entry.estrutura || ''} ${entry.assessor || ''} ${entry.broker || ''}`.toLowerCase()
        if (!searchBase.includes(query)) return false
      }

      return true
    })
  }, [
    effectiveClientCodeFilter,
    effectiveSelectedAssessor,
    effectiveSelectedBroker,
    filters,
    operationsByScope,
  ])

  const projectionRows = useMemo(() => {
    return filteredOperations
      .map((operation, index) => {
        const override = overrides?.[operation.id] || EMPTY_OVERRIDE
        const overrideBonus = parseQuantity(override.qtyBonus ?? 0)
        const {
          displayQtyBase: qtyBase,
          displayQtyAtual: qtyAtual,
          displayQtyBonus: qtyBonus,
          settlementQtyBase,
          settlementQtyAtual,
          settlementQtyBonus,
        } = resolveOperationQuantities(operation, overrideBonus)

        const operationEffective = applyOverridesToOperation(
          {
            ...operation,
            qtyBase: settlementQtyBase,
            qtyBonus: settlementQtyBonus,
            qtyAtual: settlementQtyAtual,
          },
          override,
        )

        let result = null
        try {
          result = computeResult(operationEffective, null, null, override)
        } catch {
          result = {
            valorEntrada: null,
            valorEntradaIncomplete: true,
          }
        }

        const projectionEntry = resolveProjectionEntryValue(operationEffective, result, qtyBase)
        const entryValue = projectionEntry.value
        const incomplete = projectionEntry.incomplete

        return {
          id: operation.id || `projection-${index}`,
          monthKey: toMonthKey(operation.vencimento),
          broker: normalizeForFilter(operation.broker) || 'Sem broker',
          estrutura: normalizeForFilter(operation.estrutura) || 'Sem estrutura',
          entryValue,
          incomplete,
        }
      })
      .filter((row) => row.monthKey)
  }, [filteredOperations, overrides])

  const projectionRowsInYear = useMemo(() => {
    const maxKey = getMaxMonthKey(12)
    return projectionRows.filter((row) => row.monthKey <= maxKey)
  }, [projectionRows])

  const kpis = useMemo(() => {
    const volumeTotal = projectionRowsInYear.reduce((sum, row) => sum + row.entryValue, 0)
    const incompletas = projectionRowsInYear.filter((row) => row.incomplete).length
    const brokerSet = new Set(projectionRowsInYear.map((row) => row.broker).filter(Boolean))
    const estruturaSet = new Set(projectionRowsInYear.map((row) => row.estrutura).filter(Boolean))

    return {
      volumeTotal,
      operacoes: projectionRowsInYear.length,
      incompletas,
      brokers: brokerSet.size,
      estruturas: estruturaSet.size,
    }
  }, [projectionRowsInYear])

  const monthlySummary = useMemo(() => {
    const map = new Map()
    projectionRowsInYear.forEach((row) => {
      if (!map.has(row.monthKey)) {
        map.set(row.monthKey, {
          monthKey: row.monthKey,
          total: 0,
          count: 0,
          incompletas: 0,
        })
      }
      const item = map.get(row.monthKey)
      item.total += row.entryValue
      item.count += 1
      if (row.incomplete) item.incompletas += 1
    })

    return Array.from(map.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey))
  }, [projectionRowsInYear])

  const monthlyMax = useMemo(() => {
    const max = monthlySummary.reduce((acc, row) => Math.max(acc, row.total), 0)
    return max > 0 ? max : 1
  }, [monthlySummary])

  const receitaSeries = useMemo(
    () => monthlySummary.map((row) => row.total),
    [monthlySummary],
  )
  const receitaScale = useMemo(
    () => buildChartScale(receitaSeries, 5),
    [receitaSeries],
  )
  const receitaScaled = useMemo(
    () => normalizeSeries(receitaSeries, receitaScale),
    [receitaScale, receitaSeries],
  )
  const receitaTicks = useMemo(
    () => (receitaSeries.length ? receitaScale.ticks.map((tick) => ({ ...tick, label: formatCurrency(tick.value) })) : []),
    [receitaScale.ticks, receitaSeries.length],
  )
  const receitaHasData = receitaSeries.length > 0
  const receitaGridStyle = useMemo(
    () => ({ '--chart-columns': Math.max(receitaSeries.length, 1) }),
    [receitaSeries.length],
  )
  const receitaShowCompactValues = receitaSeries.length >= 10
  const hideReceitaTooltip = useCallback(() => setReceitaTooltip(EMPTY_RECEITA_TOOLTIP), [])
  const handleReceitaBarEnter = useCallback((index, event) => {
    const target = event?.currentTarget
    const chartNode = receitaChartRef.current
    if (!target || !chartNode) return

    const chartRect = chartNode.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const rawX = targetRect.left + targetRect.width / 2 - chartRect.left
    const rawY = targetRect.top - chartRect.top
    const minX = 120
    const maxX = Math.max(chartRect.width - 120, minX)
    const x = clamp(rawX, minX, maxX)
    const flip = rawY < 90
    const y = flip ? rawY + 12 : rawY - 8

    setReceitaTooltip({ open: true, index, x, y, flip })
  }, [])
  useEffect(() => {
    hideReceitaTooltip()
  }, [monthlySummary, hideReceitaTooltip])
  const safeReceitaTooltipIndex = receitaTooltip.index !== null && receitaTooltip.index < monthlySummary.length
    ? receitaTooltip.index
    : null
  const receitaTooltipRow = safeReceitaTooltipIndex !== null ? monthlySummary[safeReceitaTooltipIndex] : null
  const receitaTooltipOpen = receitaTooltip.open && Boolean(receitaTooltipRow)
  const receitaTooltipMonthLabel = receitaTooltipRow ? formatMonthLabel(receitaTooltipRow.monthKey) : ''

  const brokerAggregation = useMemo(() => {
    const brokerTotals = new Map()
    projectionRowsInYear.forEach((row) => {
      brokerTotals.set(row.broker, (brokerTotals.get(row.broker) || 0) + row.entryValue)
    })

    const ordered = Array.from(brokerTotals.entries())
      .map(([broker, total]) => ({ broker, total }))
      .sort((a, b) => b.total - a.total)

    const topGroups = ordered.slice(0, TOP_GROUP_LIMIT).map((item) => item.broker)
    const hasOthers = ordered.length > TOP_GROUP_LIMIT
    const otherGroups = hasOthers ? ordered.slice(TOP_GROUP_LIMIT).map((item) => item.broker) : []
    const groups = hasOthers ? [...topGroups, 'Outros'] : topGroups
    const topSet = new Set(topGroups)

    const monthMap = new Map(
      monthlySummary.map((month) => [
        month.monthKey,
        {
          monthKey: month.monthKey,
          total: month.total,
          values: Object.fromEntries(groups.map((group) => [group, 0])),
        },
      ]),
    )

    projectionRowsInYear.forEach((row) => {
      const month = monthMap.get(row.monthKey)
      if (!month) return
      const group = topSet.has(row.broker) ? row.broker : 'Outros'
      if (!month.values[group]) month.values[group] = 0
      month.values[group] += row.entryValue
    })

    const series = monthlySummary.map((month) => monthMap.get(month.monthKey))
    const colors = {}
    groups.forEach((group, index) => {
      colors[group] = STACK_COLORS[index % STACK_COLORS.length]
    })

    const groupMembers = Object.fromEntries(
      groups.map((group) => [group, group === 'Outros' ? normalizeSelectionValues(otherGroups) : [group]]),
    )

    return { groups, series, colors, groupMembers }
  }, [monthlySummary, projectionRowsInYear])
  const stackHasData = brokerAggregation.series.length > 0 && brokerAggregation.groups.length > 0
  const stackGridStyle = useMemo(
    () => ({ '--stack-columns': Math.max(brokerAggregation.series.length, 1) }),
    [brokerAggregation.series.length],
  )
  const stackShowCompactValues = brokerAggregation.series.length >= 9
  const hideStackTooltip = useCallback(() => setStackTooltip(EMPTY_STACK_TOOLTIP), [])
  const handleStackEnter = useCallback((index, event) => {
    const target = event?.currentTarget
    const chartNode = stackChartRef.current
    if (!target || !chartNode) return

    const chartRect = chartNode.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const rawX = targetRect.left + targetRect.width / 2 - chartRect.left
    const rawY = targetRect.top - chartRect.top
    const minX = 120
    const maxX = Math.max(chartRect.width - 120, minX)
    const x = clamp(rawX, minX, maxX)
    const flip = rawY < 90
    const y = flip ? rawY + 12 : rawY - 8

    setStackTooltip({ open: true, index, x, y, flip })
  }, [])
  useEffect(() => {
    hideStackTooltip()
  }, [brokerAggregation.series, brokerAggregation.groups, hideStackTooltip])
  const safeStackTooltipIndex = stackTooltip.index !== null && stackTooltip.index < brokerAggregation.series.length
    ? stackTooltip.index
    : null
  const stackTooltipRow = safeStackTooltipIndex !== null ? brokerAggregation.series[safeStackTooltipIndex] : null
  const stackTooltipOpen = stackTooltip.open && Boolean(stackTooltipRow)
  const stackTooltipBreakdown = useMemo(() => {
    if (!stackTooltipRow) return []
    return brokerAggregation.groups
      .map((group) => ({
        group,
        color: brokerAggregation.colors[group],
        value: stackTooltipRow.values[group] || 0,
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [brokerAggregation.colors, brokerAggregation.groups, stackTooltipRow])
  const stackTooltipMonthLabel = stackTooltipRow ? formatMonthLabel(stackTooltipRow.monthKey) : ''

  const structureAggregation = useMemo(() => {
    const structureTotals = new Map()
    projectionRowsInYear.forEach((row) => {
      const current = structureTotals.get(row.estrutura) || { total: 0, count: 0, incompletas: 0 }
      current.total += row.entryValue
      current.count += 1
      if (row.incomplete) current.incompletas += 1
      structureTotals.set(row.estrutura, current)
    })

    const ordered = Array.from(structureTotals.entries())
      .map(([estrutura, data]) => ({ estrutura, ...data }))
      .sort((a, b) => b.total - a.total)

    const topGroups = ordered.slice(0, TOP_GROUP_LIMIT).map((item) => item.estrutura)
    const hasOthers = ordered.length > TOP_GROUP_LIMIT
    const topSet = new Set(topGroups)
    const grouped = new Map()

    projectionRowsInYear.forEach((row) => {
      const label = topSet.has(row.estrutura) ? row.estrutura : 'Outros'
      if (!hasOthers && label === 'Outros') return
      const current = grouped.get(label) || {
        estrutura: label,
        total: 0,
        count: 0,
        incompletas: 0,
        members: new Set(),
      }
      current.total += row.entryValue
      current.count += 1
      if (row.incomplete) current.incompletas += 1
      current.members.add(row.estrutura)
      grouped.set(label, current)
    })

    const rows = Array.from(grouped.values())
      .map((row) => ({
        ...row,
        members: normalizeSelectionValues(Array.from(row.members)),
      }))
      .sort((a, b) => b.total - a.total)
    const max = rows.reduce((acc, row) => Math.max(acc, row.total), 0) || 1

    return { rows, max }
  }, [projectionRowsInYear])

  const monthSelectionMap = useMemo(() => {
    const map = new Map()
    operationsByScope.forEach((entry) => {
      const monthKey = toMonthKey(entry?.vencimento)
      const vencimentoKey = normalizeDateKey(entry?.vencimento)
      if (!monthKey || !vencimentoKey) return
      if (!map.has(monthKey)) map.set(monthKey, new Set())
      map.get(monthKey).add(vencimentoKey)
    })

    return new Map(
      Array.from(map.entries()).map(([monthKey, values]) => [
        monthKey,
        normalizeSelectionValues(Array.from(values)),
      ]),
    )
  }, [operationsByScope])

  const toggleVisualFilter = useCallback((key, values) => {
    const nextValues = normalizeSelectionValues(values)
    if (!nextValues.length) return
    setFilters((prev) => {
      const currentValues = Array.isArray(prev?.[key]) ? prev[key] : []
      return {
        ...prev,
        [key]: hasSameSelection(currentValues, nextValues) ? [] : nextValues,
      }
    })
  }, [])

  const handleMonthVisualFilter = useCallback((monthKey) => {
    toggleVisualFilter('vencimentos', monthSelectionMap.get(monthKey) || [])
  }, [monthSelectionMap, toggleVisualFilter])

  const handleBrokerVisualFilter = useCallback((group) => {
    toggleVisualFilter('broker', brokerAggregation.groupMembers[group] || [])
  }, [brokerAggregation.groupMembers, toggleVisualFilter])

  const handleStructureVisualFilter = useCallback((values) => {
    toggleVisualFilter('estruturas', values)
  }, [toggleVisualFilter])

  const isMonthVisualFilterActive = useCallback(
    (monthKey) => hasSameSelection(filters.vencimentos, monthSelectionMap.get(monthKey) || []),
    [filters.vencimentos, monthSelectionMap],
  )

  const isBrokerVisualFilterActive = useCallback(
    (group) => hasSameSelection(filters.broker, brokerAggregation.groupMembers[group] || []),
    [brokerAggregation.groupMembers, filters.broker],
  )

  const isStructureVisualFilterActive = useCallback(
    (values) => hasSameSelection(filters.estruturas, values),
    [filters.estruturas],
  )

  const chips = [
    {
      key: 'scope',
      label: maturityScope === SCOPE_CURRENT_FORWARD ? 'Escopo: mes atual em diante' : 'Escopo: todos',
      onClear: () => setMaturityScope(SCOPE_ALL),
    },
    { key: 'broker', label: filters.broker.length ? `Broker (${filters.broker.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, broker: [] })) },
    { key: 'assessores', label: filters.assessores.length ? `Assessores (${filters.assessores.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, assessores: [] })) },
    { key: 'estruturas', label: filters.estruturas.length ? `Estruturas (${filters.estruturas.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, estruturas: [] })) },
    { key: 'ativos', label: filters.ativos.length ? `Ativos (${filters.ativos.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, ativos: [] })) },
    { key: 'vencimentos', label: filters.vencimentos.length ? `Vencimentos (${filters.vencimentos.length})` : '', onClear: () => setFilters((prev) => ({ ...prev, vencimentos: [] })) },
    { key: 'clientes', label: clientCodeFilter.length ? `Clientes (${clientCodeFilter.length})` : '', onClear: () => setClientCodeFilter([]) },
  ].filter((chip) => chip.label)

  const handleClearFilters = useCallback(() => {
    setFilters({
      search: '',
      broker: [],
      assessores: [],
      estruturas: [],
      ativos: [],
      vencimentos: [],
    })
    setMaturityScope(SCOPE_ALL)
    setClientCodeFilter([])
  }, [setClientCodeFilter])

  const hasLink = Boolean(linkMeta)
  const showReauthorize = Boolean(
    linkMeta?.source === 'browser'
    && (permissionState === 'prompt' || permissionState === 'denied' || restoreStatus.state === 'needs-permission'),
  )
  const isBusy = isParsing || isRestoring

  return (
    <div className="page projection-page">
      <PageHeader
        title="Projecao de vencimento"
        subtitle="Volume de entrada projetado por mes, broker e estrutura, usando a mesma logica da aba de vencimento."
        meta={[
          { label: 'Volume entrada', value: formatCurrency(kpis.volumeTotal) },
          { label: 'Operacoes', value: formatNumber(kpis.operacoes) },
          { label: 'Entrada incompleta', value: formatNumber(kpis.incompletas) },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Fonte de dados</h3>
            <p className="muted">Use o arquivo importado para vincular automaticamente o relatorio de posicao.</p>
          </div>
          <div className="panel-actions">
            {showReauthorize ? (
              <button className="btn btn-secondary" type="button" onClick={handleReauthorize} disabled={isBusy}>
                <Icon name="sync" size={16} />
                Reautorizar
              </button>
            ) : null}
            {hasLink ? (
              <button className="btn btn-secondary" type="button" onClick={handleUnlink} disabled={isBusy}>
                <Icon name="close" size={16} />
                Desvincular
              </button>
            ) : null}
          </div>
        </div>

        <div className="sync-folder-filter">
          <label className="sync-folder-filter-field">
            <span>Arquivo importado</span>
            <select
              className="input"
              value={globalFolderMenu.directoryValue || ''}
              onChange={(event) => globalFolderMenu.onDirectoryChange(event.target.value)}
              disabled={!globalDirectoryOptions.length || globalFolderMenu.loading || isBusy}
            >
              {!globalDirectoryOptions.length ? (
                <option value="">
                  {globalFolderMenu.loading ? 'Carregando arquivos...' : 'Sem arquivos disponiveis'}
                </option>
              ) : null}
              {globalDirectoryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={handleUseGlobalFolder}
            disabled={!globalDirectoryOptions.length || globalFolderMenu.loading || isBusy}
          >
            Usar arquivo importado
          </button>
          {globalDirectoryEmptyMessage ? <div className="muted">{globalDirectoryEmptyMessage}</div> : null}
        </div>

        <div className="projection-source-grid">
          <div>
            <strong>{folderLabel}</strong>
            <span className="muted">Pasta/arquivo ativo</span>
          </div>
          <div>
            <strong>{cacheMeta?.rows?.length ? formatNumber(cacheMeta.rows.length) : '-'}</strong>
            <span className="muted">Linhas no cache</span>
          </div>
          <div>
            <strong>{cacheMeta?.importedAt ? formatDate(cacheMeta.importedAt) : '-'}</strong>
            <span className="muted">Ultima leitura</span>
          </div>
        </div>

        {restoreStatus.message ? <div className="muted">{restoreStatus.message}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Filtros</h3>
            <p className="muted">Refine o recorte para os graficos e para o resumo executivo.</p>
          </div>
          <div className="panel-actions">
            <div className="search-pill">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar conta, ativo ou estrutura"
                value={filters.search}
                onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
              />
            </div>
            <button className="btn btn-secondary" type="button" onClick={handleClearFilters}>
              Limpar filtros
            </button>
          </div>
        </div>

        <div className="filter-grid">
          <SelectMenu
            value={maturityScope}
            options={[
              { value: SCOPE_CURRENT_FORWARD, label: 'Mes atual em diante' },
              { value: SCOPE_ALL, label: 'Todos os vencimentos' },
            ]}
            onChange={(value) => setMaturityScope(value || SCOPE_ALL)}
            placeholder="Escopo de vencimento"
          />
          <MultiSelect
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
          <MultiSelect
            value={clientCodeFilter}
            options={clienteOptions}
            onChange={setClientCodeFilter}
            placeholder="Conta"
            searchable
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
            <button className="btn btn-secondary" type="button" onClick={handleClearFilters}>
              Limpar tudo
            </button>
          </div>
        ) : null}

        <p className="muted projection-global-note">
          Broker global: {effectiveSelectedBroker.length ? effectiveSelectedBroker.join(', ') : 'Todos'} | Assessor global: {effectiveSelectedAssessor.length ? effectiveSelectedAssessor.join(', ') : 'Todos'}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Graficos de projecao</h3>
            <p className="muted">Volume de entrada agregado por mes, broker e estrutura (Top {TOP_GROUP_LIMIT} + Outros), conforme o recorte atual.</p>
          </div>
        </div>

        <div className="projection-chart-grid">
          <article className="card chart-card projection-chart-card">
            <div className="card-head">
              <h3>Total de receita por mes</h3>
              <span className="muted">Visual do dashboard principal</span>
            </div>
            <div className="chart projection-receita-chart" ref={receitaChartRef} role="img" aria-label="Grafico de total de receita mensal no recorte atual">
              {receitaTicks.length ? (
                <>
                  <div className="chart-lines">
                    {receitaTicks.map((tick, index) => (
                      <span key={`projection-line-${index}`} className="chart-line" style={{ bottom: `${tick.percent}%` }} />
                    ))}
                  </div>
                  <div className="chart-ticks">
                    {receitaTicks.map((tick, index) => (
                      <span key={`projection-tick-${index}`} className="chart-tick" style={{ bottom: `${tick.percent}%` }}>
                        {tick.label}
                      </span>
                    ))}
                  </div>
                </>
              ) : null}

              {receitaHasData ? (
                <>
                  <div className="chart-grid" style={receitaGridStyle}>
                    {monthlySummary.map((row, index) => {
                      const value = receitaSeries[index] || 0
                      const height = receitaScaled[index] || 0
                      const isSelected = isMonthVisualFilterActive(row.monthKey)
                      const isActive = isSelected || (receitaTooltip.open && receitaTooltip.index === index)
                      const monthLabel = formatMonthLabel(row.monthKey)
                      const valueLabel = receitaShowCompactValues ? formatCurrencyCompact(value) : formatCurrency(value)
                      return (
                        <div
                          key={row.monthKey}
                          className="chart-col filter-action"
                          style={{ '--bar-height': `${height}%` }}
                          onClick={() => handleMonthVisualFilter(row.monthKey)}
                          title={isSelected ? `Remover filtro de ${monthLabel}` : `Filtrar somente ${monthLabel}`}
                        >
                          <span className="chart-value-label" title={formatCurrency(value)}>{valueLabel}</span>
                          <button
                            type="button"
                            className={`chart-bar ${isActive ? 'is-active' : ''}`}
                            style={{ height: `${height}%` }}
                            onMouseEnter={(event) => handleReceitaBarEnter(index, event)}
                            onMouseLeave={hideReceitaTooltip}
                            onFocus={(event) => handleReceitaBarEnter(index, event)}
                            onBlur={hideReceitaTooltip}
                            aria-pressed={isSelected}
                            aria-label={`${monthLabel} - Total ${formatCurrency(value)}`}
                          />
                          <span className="chart-date-label">{monthLabel}</span>
                        </div>
                      )
                    })}
                  </div>
                  {receitaTooltipOpen ? (
                    <div className={`chart-tooltip ${receitaTooltip.flip ? 'is-flipped' : ''}`} style={{ left: receitaTooltip.x, top: receitaTooltip.y }}>
                      <div className="chart-tooltip-title">{receitaTooltipMonthLabel || 'Periodo indisponivel'}</div>
                      <div className="chart-tooltip-row chart-tooltip-row--total">
                        <span>Total</span>
                        <strong>{formatCurrency(receitaTooltipRow?.total ?? 0)}</strong>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="chart-empty">Sem dados para o recorte atual.</div>
              )}
            </div>

            <div className="chart-footer">
              <div>
                <span className="muted">Total no periodo</span>
                <strong>{formatCurrency(kpis.volumeTotal)}</strong>
              </div>
            </div>
          </article>

          <article className="card chart-card projection-chart-card">
            <div className="card-head">
              <h3>Broker por mes (empilhado)</h3>
              <span className="muted">Top {TOP_GROUP_LIMIT} + Outros</span>
            </div>
            {stackHasData ? (
              <>
                <div className="projection-stack-chart" ref={stackChartRef}>
                  <div className="projection-stack-scroll" onScroll={hideStackTooltip}>
                    <div className="projection-stack-grid" style={stackGridStyle} role="img" aria-label="Grafico empilhado de volume de entrada por broker e mes">
                      {brokerAggregation.series.map((row, index) => {
                        if (!row) return null
                        const totalPercent = row.total > 0 ? clamp((row.total / monthlyMax) * 100, 0, 100) : 0
                        const valueLabel = stackShowCompactValues ? formatCurrencyCompact(row.total) : formatCurrency(row.total)
                        const monthLabel = formatMonthLabel(row.monthKey)
                        const isSelected = isMonthVisualFilterActive(row.monthKey)
                        const isActive = isSelected || (stackTooltip.open && stackTooltip.index === index)
                        const ariaLabel = `${monthLabel} - Total ${formatCurrency(row.total)}`
                        return (
                          <div
                            key={row.monthKey}
                            className="projection-stack-col filter-action"
                            onClick={() => handleMonthVisualFilter(row.monthKey)}
                            title={isSelected ? `Remover filtro de ${monthLabel}` : `Filtrar somente ${monthLabel}`}
                          >
                            <span className="projection-bar-value" title={formatCurrency(row.total)}>{valueLabel}</span>
                            <div className={`projection-stack-track ${isActive ? 'is-active' : ''}`}>
                              <div className="projection-stack-bar" style={{ height: `${totalPercent}%` }}>
                                {brokerAggregation.groups.map((group) => {
                                  const value = row.values[group] || 0
                                  if (!value || !row.total) return null
                                  const segmentPercent = (value / row.total) * 100
                                  return (
                                    <span
                                      key={`${row.monthKey}-${group}`}
                                      className="projection-stack-segment"
                                      style={{
                                        height: `${segmentPercent}%`,
                                        backgroundColor: brokerAggregation.colors[group],
                                      }}
                                      title={`${group}: ${formatCurrency(value)}`}
                                    />
                                  )
                                })}
                              </div>
                              <button
                                type="button"
                                className="projection-stack-hitarea"
                                onMouseEnter={(event) => handleStackEnter(index, event)}
                                onMouseLeave={hideStackTooltip}
                                onFocus={(event) => handleStackEnter(index, event)}
                                onBlur={hideStackTooltip}
                                aria-pressed={isSelected}
                                aria-label={ariaLabel}
                              />
                            </div>
                            <span className="projection-bar-label">{monthLabel}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  {stackTooltipOpen ? (
                    <div className={`chart-tooltip projection-stack-tooltip ${stackTooltip.flip ? 'is-flipped' : ''}`} style={{ left: stackTooltip.x, top: stackTooltip.y }}>
                      <div className="chart-tooltip-title">{stackTooltipMonthLabel || 'Periodo indisponivel'}</div>
                      <div className="chart-tooltip-row chart-tooltip-row--total">
                        <span>Total</span>
                        <strong>{formatCurrency(stackTooltipRow?.total ?? 0)}</strong>
                      </div>
                      {stackTooltipBreakdown.map((item) => (
                        <div key={item.group} className="chart-tooltip-row projection-stack-tooltip-row" style={{ '--stack-color': item.color }}>
                          <span className="projection-stack-tooltip-label">
                            <span className="projection-legend-dot" style={{ backgroundColor: item.color }} />
                            {item.group}
                          </span>
                          <strong>{formatCurrency(item.value)}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="projection-legend">
                  {brokerAggregation.groups.map((group) => {
                    const isActive = isBrokerVisualFilterActive(group)
                    return (
                    <button
                      key={group}
                      type="button"
                      className={`projection-legend-item filter-action ${isActive ? 'is-active-filter' : ''}`}
                      onClick={() => handleBrokerVisualFilter(group)}
                      aria-pressed={isActive}
                      title={isActive ? `Remover filtro de ${group}` : `Filtrar broker ${group}`}
                    >
                      <span className="projection-legend-dot" style={{ backgroundColor: brokerAggregation.colors[group] }} />
                      {group}
                    </button>
                    )
                  })}
                </div>
              </>
            ) : <div className="empty-state muted">Sem dados para o recorte atual.</div>}
          </article>

          <article className="card chart-card projection-chart-card projection-chart-card--wide">
            <div className="card-head">
              <h3>Estruturas vencendo</h3>
              <span className="muted">Top {TOP_GROUP_LIMIT} + Outros</span>
            </div>

            {structureAggregation.rows.length ? (
              <div className="projection-structure-list" aria-label="Grafico de barras por estrutura vencendo">
                {structureAggregation.rows.map((row, index) => {
                  const width = row.total > 0 ? Math.max(2, (row.total / structureAggregation.max) * 100) : 0
                  const color = STACK_COLORS[index % STACK_COLORS.length]
                  const isActive = isStructureVisualFilterActive(row.members)
                  return (
                    <div
                      key={row.estrutura}
                      className={`projection-structure-row filter-action ${isActive ? 'is-active-filter' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleStructureVisualFilter(row.members)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        handleStructureVisualFilter(row.members)
                      }}
                      aria-pressed={isActive}
                      title={isActive ? `Remover filtro de ${row.estrutura}` : `Filtrar estrutura ${row.estrutura}`}
                    >
                      <div className="projection-structure-head">
                        <strong title={row.estrutura}>{row.estrutura}</strong>
                        <span>{formatCurrency(row.total)}</span>
                      </div>
                      <div className="projection-structure-track">
                        <span style={{ width: `${width}%`, backgroundColor: color }} />
                      </div>
                      <div className="projection-structure-meta muted">
                        {formatNumber(row.count)} operacoes | {formatNumber(row.incompletas)} incompletas
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : <div className="empty-state muted">Sem dados para o recorte atual.</div>}
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Resumo executivo</h3>
            <p className="muted">Cards KPI e tabela curta por mes no mesmo recorte filtrado.</p>
          </div>
        </div>

        <div className="kpi-grid projection-kpi-grid">
          <div className="card kpi-card">
            <div className="kpi-label">Volume total entrada</div>
            <div className="kpi-value">{formatCurrency(kpis.volumeTotal)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">Operacoes no recorte</div>
            <div className="kpi-value">{formatNumber(kpis.operacoes)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">Entrada incompleta</div>
            <div className="kpi-value">{formatNumber(kpis.incompletas)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">Brokers ativos</div>
            <div className="kpi-value">{formatNumber(kpis.brokers)}</div>
          </div>
          <div className="card kpi-card">
            <div className="kpi-label">Estruturas ativas</div>
            <div className="kpi-value">{formatNumber(kpis.estruturas)}</div>
          </div>
        </div>

        <div className="table-wrap projection-summary-table-wrap">
          {monthlySummary.length ? (
            <table className="data-table projection-summary-table">
              <thead>
                <tr>
                  <th>Mes</th>
                  <th>Volume entrada</th>
                  <th>Operacoes</th>
                  <th>Entrada incompleta</th>
                </tr>
              </thead>
              <tbody>
                {monthlySummary.map((row) => (
                  <tr key={row.monthKey}>
                    <td>{formatMonthLabel(row.monthKey)}</td>
                    <td>{formatCurrency(row.total)}</td>
                    <td>{formatNumber(row.count)}</td>
                    <td>{formatNumber(row.incompletas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state muted">Sem dados para exibir no resumo mensal.</div>
          )}
        </div>
      </section>
    </div>
  )
}

export default ProjecaoVencimento
