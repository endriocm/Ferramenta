/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { getCurrentUserKey } from '../services/currentUser'
import { buildTagIndex, loadAssessorOverrides, loadTags } from '../services/tags'
import { debugLog } from '../services/debug'
import { loadRevenueList, loadManualRevenue } from '../services/revenueStore'
import { loadStructuredRevenue } from '../services/revenueStructured'
import { collectMonthsFromEntries, formatMonthLabel } from '../services/apuracao'
import { normalizeAssessorName } from '../utils/assessor'
import {
  buildEffectiveBmfEntries,
  buildEffectiveBovespaEntries,
  buildEffectiveStructuredEntries,
  loadXpRevenue,
} from '../services/revenueXpCommission'

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

const normalizeBrokerToken = (value) => {
  const raw = normalizeValue(value)
  if (!raw) return ''
  const compact = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
  if (!compact || compact === '-' || compact === '--') return '--'
  if (compact === 'sembroker' || compact === 'semcorretora' || compact === 'cotizador') return '--'
  return raw
}

const normalizeBrokerList = (value) => {
  const seen = new Set()
  const normalized = []
  normalizeList(value).forEach((item) => {
    const broker = normalizeBrokerToken(item)
    if (!broker || seen.has(broker)) return
    seen.add(broker)
    normalized.push(broker)
  })
  return normalized
}

const normalizeAssessorList = (value) => normalizeList(value)
  .map((item) => normalizeAssessorName(item))
  .filter(Boolean)

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

const readStoredFilters = (userKey) => {
  if (!userKey || typeof window === 'undefined') return null
  return parseStored(localStorage.getItem(buildKey(userKey)))
}

const collectApuracaoOptions = () => {
  const structured = buildEffectiveStructuredEntries(loadStructuredRevenue())
  const bovespa = buildEffectiveBovespaEntries(loadRevenueList('bovespa'))
  const bmf = buildEffectiveBmfEntries(loadRevenueList('bmf'))
  const manual = loadManualRevenue()
  const xp = loadXpRevenue()
  const months = new Set()
  collectMonthsFromEntries(structured, (entry) => entry.dataEntrada).forEach((key) => months.add(key))
  collectMonthsFromEntries(bovespa, (entry) => entry.data || entry.dataEntrada).forEach((key) => months.add(key))
  collectMonthsFromEntries(bmf, (entry) => entry.data || entry.dataEntrada).forEach((key) => months.add(key))
  collectMonthsFromEntries(manual, (entry) => entry.data || entry.dataEntrada).forEach((key) => months.add(key))
  collectMonthsFromEntries(xp, (entry) => entry.data).forEach((key) => months.add(key))
  const sorted = Array.from(months).sort()
  return sorted.map((key) => ({ value: key, label: formatMonthLabel(key) }))
}

const GlobalFilterContext = createContext(null)

export const GlobalFilterProvider = ({ children }) => {
  const [userKey] = useState(() => getCurrentUserKey())
  const initialStored = readStoredFilters(userKey)
  const [selectedBroker, setSelectedBrokerState] = useState(() => normalizeBrokerList(initialStored?.broker))
  const [selectedAssessor, setSelectedAssessor] = useState(() => normalizeAssessorList(initialStored?.assessor))
  const [clientCodeFilter, setClientCodeFilter] = useState(() => normalizeList(initialStored?.clientCode))
  const [apuracaoMonths, setApuracaoMonths] = useState(() => normalizeApuracao(initialStored?.apuracao))
  const [apuracaoOptions, setApuracaoOptions] = useState([])
  const [tagsPayload, setTagsPayload] = useState(null)
  const [assessorOverrides, setAssessorOverrides] = useState({})
  const senderId = useId()
  const channelRef = useRef(null)
  const loadedRef = useRef(true)
  const applyingRemoteRef = useRef(false)
  const filterPersistTimerRef = useRef(null)

  // Defer expensive apuracao computation to idle time after first paint
  useEffect(() => {
    let cancelled = false
    const compute = () => {
      if (cancelled) return
      const result = collectApuracaoOptions()
      if (!cancelled) {
        startTransition(() => {
          setApuracaoOptions(result)
        })
      }
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(compute, { timeout: 2000 })
      return () => { cancelled = true; window.cancelIdleCallback(id) }
    }
    const id = setTimeout(compute, 60)
    return () => { cancelled = true; clearTimeout(id) }
  }, [])

  const tagsIndex = useMemo(
    () => buildTagIndex(tagsPayload, { assessorOverrides }),
    [tagsPayload, assessorOverrides],
  )
  const brokerOptions = useMemo(() => {
    const base = tagsIndex?.brokers || []
    return base.map((item) => ({ value: item, label: item }))
  }, [tagsIndex])
  const assessorOptions = useMemo(() => {
    const base = tagsIndex?.assessors || []
    return base.map((item) => ({ value: item, label: item }))
  }, [tagsIndex])

  const setSelectedBroker = useCallback((valueOrUpdater) => {
    setSelectedBrokerState((current) => {
      const raw = typeof valueOrUpdater === 'function' ? valueOrUpdater(current) : valueOrUpdater
      const normalized = normalizeBrokerList(raw)
      if (
        normalized.length === current.length
        && normalized.every((item, index) => item === current[index])
      ) {
        return current
      }
      return normalized
    })
  }, [])

  const refreshApuracaoOptions = useCallback(() => {
    startTransition(() => {
      setApuracaoOptions(collectApuracaoOptions())
    })
  }, [])

  const refreshTags = useCallback(async () => {
    if (!userKey) return
    const loaded = await loadTags(userKey)
    const overrides = loadAssessorOverrides(userKey)
    setTagsPayload(loaded)
    setAssessorOverrides(overrides)
  }, [userKey])

  useEffect(() => {
    if (!userKey) return undefined
    let cancelled = false
    loadTags(userKey)
      .then((loaded) => {
        if (!cancelled) {
          setTagsPayload(loaded)
          setAssessorOverrides(loadAssessorOverrides(userKey))
        }
      })
      .catch(() => {
        // noop
      })
    return () => {
      cancelled = true
    }
  }, [userKey])

  const applyRemote = useCallback((payload) => {
    if (!payload) return
    applyingRemoteRef.current = true
    setSelectedBroker(normalizeBrokerList(payload.broker))
    setSelectedAssessor(normalizeAssessorList(payload.assessor))
    setClientCodeFilter(normalizeList(payload.clientCode))
    setApuracaoMonths(normalizeApuracao(payload.apuracao))
    setTimeout(() => {
      applyingRemoteRef.current = false
    }, 0)
  }, [setSelectedBroker])

  useEffect(() => {
    if (!userKey || !loadedRef.current || applyingRemoteRef.current) return
    const payload = {
      version: STORAGE_VERSION,
      broker: normalizeBrokerList(selectedBroker),
      assessor: normalizeAssessorList(selectedAssessor),
      clientCode: normalizeList(clientCodeFilter),
      apuracao: normalizeApuracao(apuracaoMonths),
      updatedAt: Date.now(),
    }
    if (filterPersistTimerRef.current) clearTimeout(filterPersistTimerRef.current)
    filterPersistTimerRef.current = setTimeout(() => {
      filterPersistTimerRef.current = null
      try {
        localStorage.setItem(buildKey(userKey), JSON.stringify(payload))
      } catch {
        // noop
      }
      const broadcastPayload = { ...payload, userKey, sender: senderId }
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
    }, 300)
  }, [selectedAssessor, selectedBroker, clientCodeFilter, apuracaoMonths, senderId, userKey])

  useEffect(() => {
    if (!userKey) return
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(BROADCAST_CHANNEL)
      channelRef.current = channel
      channel.onmessage = (event) => {
        const payload = event?.data
        if (!payload || payload.sender === senderId) return
        if (payload.userKey !== userKey) return
        applyRemote(payload)
      }
    }

    const handleStorage = (event) => {
      if (!event?.key) return
      if (event.key === BROADCAST_KEY) {
        const payload = parseStored(event.newValue)
        if (!payload || payload.sender === senderId) return
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
  }, [applyRemote, refreshTags, senderId, userKey])

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
    [userKey, selectedBroker, setSelectedBroker, selectedAssessor, clientCodeFilter, apuracaoMonths, apuracaoOptions, brokerOptions, assessorOptions, tagsIndex, refreshTags],
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
