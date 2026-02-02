import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { getCurrentUserKey } from '../services/currentUser'
import { buildTagIndex, loadTags } from '../services/tags'
import { debugLog } from '../services/debug'
import { loadRevenueList, loadManualRevenue } from '../services/revenueStore'
import { loadStructuredRevenue } from '../services/revenueStructured'
import { collectMonthsFromEntries, formatMonthLabel } from '../services/apuracao'

const STORAGE_PREFIX = 'pwr.filters.'
const BROADCAST_KEY = 'pwr.filters.broadcast'
const BROADCAST_CHANNEL = 'pwr:filters'
const STORAGE_VERSION = 1

const buildKey = (userKey) => `${STORAGE_PREFIX}${userKey}`

const normalizeValue = (value) => {
  if (value == null) return ''
  return String(value).trim()
}

const normalizeList = (value) => {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map(normalizeValue).filter(Boolean)
  }
  const normalized = normalizeValue(value)
  return normalized ? [normalized] : []
}

const normalizeApuracao = (value) => {
  if (!value) return { all: true, months: [] }
  const all = value.all === true
  const months = normalizeList(value.months)
  if (all || !months.length) return { all: true, months: [] }
  return { all: false, months }
}

const parseStored = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const GlobalFilterContext = createContext(null)

export const GlobalFilterProvider = ({ children }) => {
  const [userKey] = useState(() => getCurrentUserKey())
  const [selectedBroker, setSelectedBroker] = useState([])
  const [selectedAssessor, setSelectedAssessor] = useState([])
  const [clientCodeFilter, setClientCodeFilter] = useState([])
  const [apuracaoMonths, setApuracaoMonths] = useState({ all: true, months: [] })
  const [apuracaoOptions, setApuracaoOptions] = useState([])
  const [tagsPayload, setTagsPayload] = useState(null)
  const channelRef = useRef(null)
  const senderRef = useRef(Math.random().toString(36).slice(2))
  const loadedRef = useRef(false)
  const applyingRemoteRef = useRef(false)

  const tagsIndex = useMemo(() => buildTagIndex(tagsPayload), [tagsPayload])
  const brokerOptions = useMemo(() => {
    const base = tagsIndex?.brokers || []
    return base.map((item) => ({ value: item, label: item }))
  }, [tagsIndex])
  const assessorOptions = useMemo(() => {
    const base = tagsIndex?.assessors || []
    return base.map((item) => ({ value: item, label: item }))
  }, [tagsIndex])

  const refreshApuracaoOptions = useCallback(() => {
    const structured = loadStructuredRevenue()
    const bovespa = loadRevenueList('bovespa')
    const bmf = loadRevenueList('bmf')
    const manual = loadManualRevenue()
    const months = new Set()
    collectMonthsFromEntries(structured, (entry) => entry.dataEntrada).forEach((key) => months.add(key))
    collectMonthsFromEntries(bovespa, (entry) => entry.data || entry.dataEntrada).forEach((key) => months.add(key))
    collectMonthsFromEntries(bmf, (entry) => entry.data || entry.dataEntrada).forEach((key) => months.add(key))
    collectMonthsFromEntries(manual, (entry) => entry.data || entry.dataEntrada).forEach((key) => months.add(key))
    const sorted = Array.from(months).sort()
    setApuracaoOptions(sorted.map((key) => ({ value: key, label: formatMonthLabel(key) })))
  }, [])

  const refreshTags = useCallback(async () => {
    if (!userKey) return
    const loaded = await loadTags(userKey)
    setTagsPayload(loaded)
  }, [userKey])

  useEffect(() => {
    refreshTags()
    refreshApuracaoOptions()
  }, [refreshTags, refreshApuracaoOptions])

  const applyRemote = useCallback((payload) => {
    if (!payload) return
    applyingRemoteRef.current = true
    setSelectedBroker(normalizeList(payload.broker))
    setSelectedAssessor(normalizeList(payload.assessor))
    setClientCodeFilter(normalizeList(payload.clientCode))
    setApuracaoMonths(normalizeApuracao(payload.apuracao))
    setTimeout(() => {
      applyingRemoteRef.current = false
    }, 0)
  }, [])

  useEffect(() => {
    if (!userKey) return
    const stored = parseStored(localStorage.getItem(buildKey(userKey)))
    if (stored) {
      setSelectedBroker(normalizeList(stored.broker))
      setSelectedAssessor(normalizeList(stored.assessor))
      setClientCodeFilter(normalizeList(stored.clientCode))
      setApuracaoMonths(normalizeApuracao(stored.apuracao))
    }
    loadedRef.current = true
  }, [userKey])

  useEffect(() => {
    if (!userKey || !loadedRef.current || applyingRemoteRef.current) return
    const payload = {
      version: STORAGE_VERSION,
      broker: normalizeList(selectedBroker),
      assessor: normalizeList(selectedAssessor),
      clientCode: normalizeList(clientCodeFilter),
      apuracao: normalizeApuracao(apuracaoMonths),
      updatedAt: Date.now(),
    }
    try {
      localStorage.setItem(buildKey(userKey), JSON.stringify(payload))
    } catch {
      // noop
    }
    const broadcastPayload = {
      ...payload,
      userKey,
      sender: senderRef.current,
    }
    if (channelRef.current) {
      channelRef.current.postMessage(broadcastPayload)
    } else {
      try {
        localStorage.setItem(BROADCAST_KEY, JSON.stringify(broadcastPayload))
      } catch {
        // noop
      }
    }
    debugLog('filters.change', { broker: payload.broker, clientCode: payload.clientCode })
  }, [selectedAssessor, selectedBroker, clientCodeFilter, apuracaoMonths, userKey])

  useEffect(() => {
    if (!userKey) return
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(BROADCAST_CHANNEL)
      channelRef.current = channel
      channel.onmessage = (event) => {
        const payload = event?.data
        if (!payload || payload.sender === senderRef.current) return
        if (payload.userKey !== userKey) return
        applyRemote(payload)
      }
    }

    const handleStorage = (event) => {
      if (!event?.key) return
      if (event.key === BROADCAST_KEY) {
        const payload = parseStored(event.newValue)
        if (!payload || payload.sender === senderRef.current) return
        if (payload.userKey !== userKey) return
        applyRemote(payload)
        return
      }
      if (event.key === buildKey(userKey)) {
        const payload = parseStored(event.newValue)
        if (!payload) return
        applyRemote(payload)
        return
      }
    }

    const handleTagsUpdate = (event) => {
      if (event?.detail?.userKey && event.detail.userKey !== userKey) return
      refreshTags()
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener('pwr:tags-updated', handleTagsUpdate)

    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('pwr:tags-updated', handleTagsUpdate)
      if (channelRef.current) {
        channelRef.current.close()
        channelRef.current = null
      }
    }
  }, [applyRemote, refreshTags, userKey])

  useEffect(() => {
    const handleReceitaUpdate = () => refreshApuracaoOptions()
    window.addEventListener('pwr:receita-updated', handleReceitaUpdate)
    return () => window.removeEventListener('pwr:receita-updated', handleReceitaUpdate)
  }, [refreshApuracaoOptions])

  const value = useMemo(
    () => ({
      userKey,
      selectedBroker,
      setSelectedBroker,
      selectedAssessor,
      setSelectedAssessor,
      clientCodeFilter,
      setClientCodeFilter,
      apuracaoMonths,
      setApuracaoMonths,
      apuracaoOptions,
      brokerOptions,
      assessorOptions,
      tagsIndex,
      refreshTags,
    }),
    [userKey, selectedBroker, selectedAssessor, clientCodeFilter, apuracaoMonths, apuracaoOptions, brokerOptions, assessorOptions, tagsIndex, refreshTags],
  )

  return (
    <GlobalFilterContext.Provider value={value}>
      {children}
    </GlobalFilterContext.Provider>
  )
}

export const useGlobalFilters = () => {
  const ctx = useContext(GlobalFilterContext)
  if (!ctx) throw new Error('useGlobalFilters must be used within GlobalFilterProvider')
  return ctx
}
