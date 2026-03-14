import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import SyncPanel from '../components/SyncPanel'
import DataTable from '../components/DataTable'
import MultiSelect from '../components/MultiSelect'
import Icon from '../components/Icons'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import {
  parseTagsXlsx,
  loadAssessorOverrides,
  loadTags,
  saveAssessorOverrides,
  saveTags,
  enrichRow,
  normalizeAssessorOverrideKey,
  normalizeSeniorityLabel,
  normalizeUnitLabel,
} from '../services/tags'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { useToast } from '../hooks/useToast'
import { useHashRoute } from '../hooks/useHashRoute'
import useGlobalFolderMenu from '../hooks/useGlobalFolderMenu'
import { loadRevenueList, loadManualRevenue } from '../services/revenueStore'
import { loadStructuredRevenue } from '../services/revenueStructured'
import { filterByApuracaoMonths } from '../services/apuracao'
import { exportTimesReportPdf } from '../services/pdf'
import { exportXlsx } from '../services/exportXlsx'
import { normalizeAssessorName } from '../utils/assessor'
import { filterSpreadsheetCandidates, normalizeFileName } from '../utils/spreadsheet'
import {
  buildEffectiveBmfEntries,
  buildEffectiveBovespaEntries,
  buildEffectiveStructuredEntries,
  loadXpRevenue,
  stripEntriesByXpMonths,
} from '../services/revenueXpCommission'

const TAB_TAGS = 'tags'
const TAB_TIMES = 'times'
const TEAM_FALLBACK = '(Sem time)'
const CLIENT_FALLBACK = '(Sem cliente)'
const ASSESSOR_FALLBACK = 'Sem assessor'
const TIMES_PROFILE_PREFIX = 'pwr.times.profiles.'
const TIMES_SHEET_EXCLUDED_TEAMS_PREFIX = 'pwr.times.sheet-excluded-teams.'

const SENIORITY_OPTIONS = ['', 'Acad', 'Junior', 'Junior Acad', 'Pleno', 'Senior']
const SENIORITY_ORDER = ['Senior', 'Pleno', 'Junior', 'Junior Acad', 'Acad', 'Sem nivel']
const SENIORITY_GOALS = {
  Acad: 5000,
  Junior: 5000,
  'Junior Acad': 5000,
  Pleno: 8000,
  Senior: 13000,
}
const UNIT_PORTO = 'Porto'
const UNIT_BALNEARIO = 'Balneario'
const UNIT_OPTIONS = [
  { value: UNIT_PORTO, label: 'Unidade Porto' },
  { value: UNIT_BALNEARIO, label: 'Unidade Balneario' },
]
const EXCLUDED_TEAM_KEYS = new Set(['gregori'])
const TIMES_XP_OVERLAY_OPTIONS = { forceOverlay: true }

const normalizeKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const normalizeTeam = (value) => {
  const raw = String(value || '').trim().replace(/\s+/g, ' ')
  return raw || TEAM_FALLBACK
}

const normalizeClientCode = (value) => String(value || '').trim()
const resolveTabFromPath = (path) => (path === '/times' ? TAB_TIMES : TAB_TAGS)
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const MISSING_ASSESSOR_KEY = normalizeKey(ASSESSOR_FALLBACK)
const MISSING_TEAM_KEY = normalizeKey(TEAM_FALLBACK)
const hasValidAssessor = (assessor) => {
  const assessorKey = normalizeKey(assessor)
  return Boolean(assessorKey) && assessorKey !== MISSING_ASSESSOR_KEY
}
const hasValidTeam = (team) => {
  const teamKey = normalizeKey(team)
  return Boolean(teamKey) && teamKey !== MISSING_TEAM_KEY && !EXCLUDED_TEAM_KEYS.has(teamKey)
}
const isB2bTeam = (team) => normalizeKey(team).includes('b2b')
const resolveGoalContribution = (row) => {
  const goal = Number(row?.goal)
  if (!(goal > 0)) return 0
  if (isB2bTeam(row?.team)) return 0
  return goal
}
const DEFAULT_INTERACTIVE_FILTERS = {
  line: 'all',
  team: '',
  assessor: '',
  seniority: '',
  gap: 'all',
}
const isGapFilterValue = (value) => value === 'above' || value === 'below'
const resolveGapBucket = (row) => {
  const goal = resolveGoalContribution(row)
  if (!(goal > 0)) return 'noGoal'
  return row.total >= goal ? 'above' : 'below'
}

const compareSeniorityLabel = (left, right) => {
  const leftLabel = String(left || 'Sem nivel')
  const rightLabel = String(right || 'Sem nivel')
  const leftIndex = SENIORITY_ORDER.indexOf(leftLabel)
  const rightIndex = SENIORITY_ORDER.indexOf(rightLabel)
  if (leftIndex >= 0 || rightIndex >= 0) {
    if (leftIndex < 0) return 1
    if (rightIndex < 0) return -1
    return leftIndex - rightIndex
  }
  return leftLabel.localeCompare(rightLabel, 'pt-BR')
}

const resolveGoalBySeniority = (seniority) => {
  const normalized = normalizeSeniorityLabel(seniority)
  if (!normalized) return 0
  return SENIORITY_GOALS[normalized] || 0
}

const resolveEntryValue = (entry) => {
  const value = entry?.receita ?? entry?.comissao ?? entry?.valor ?? entry?.value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const resolveEntryDate = (entry) => {
  const value = entry?.dataEntrada || entry?.data || entry?.vencimento || ''
  if (!value) return ''
  return String(value).slice(0, 10)
}

const resolveEntryMonth = (entry) => {
  const date = resolveEntryDate(entry)
  return date ? date.slice(0, 7) : ''
}

const resolveClientCodeFromRow = (row) => {
  return normalizeClientCode(
    row?.codigoCliente
    ?? row?.conta
    ?? row?.clienteCodigo
    ?? row?.codCliente
    ?? row?.codigo
    ?? row?.cliente
    ?? '',
  )
}

const parseBrNumber = (value) => {
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

const formatPercent = (value) => {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1).replace('.', ',')}%`
}

const formatSignedCurrency = (value) => {
  if (!Number.isFinite(value)) return '—'
  if (value > 0) return `+ ${formatCurrency(value)}`
  if (value < 0) return `- ${formatCurrency(Math.abs(value))}`
  return formatCurrency(0)
}

const formatMonthKeyLabel = (monthKey) => {
  const [yearRaw, monthRaw] = String(monthKey || '').split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return String(monthKey || '')
  return new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })
}

const joinFilterList = (values, limit = 5) => {
  const list = (Array.isArray(values) ? values : []).filter(Boolean)
  if (!list.length) return ''
  if (list.length <= limit) return list.join(', ')
  return `${list.slice(0, limit).join(', ')} (+${list.length - limit})`
}

const buildTimesProfileKey = (userKey) => `${TIMES_PROFILE_PREFIX}${userKey || 'anon'}`
const buildTimesSheetExcludedTeamsKey = (userKey) => `${TIMES_SHEET_EXCLUDED_TEAMS_PREFIX}${userKey || 'anon'}`

const normalizeTimesSheetExcludedTeams = (value) => {
  if (!Array.isArray(value)) return []
  const next = []
  const seen = new Set()
  value.forEach((item) => {
    const team = normalizeTeam(item)
    const teamKey = normalizeKey(team)
    if (!teamKey || teamKey === MISSING_TEAM_KEY || seen.has(teamKey)) return
    seen.add(teamKey)
    next.push(team)
  })
  return next
}

const loadTimesSheetExcludedTeams = (userKey) => {
  if (typeof window === 'undefined') return []
  const parsed = safeJsonParse(localStorage.getItem(buildTimesSheetExcludedTeamsKey(userKey)))
  return normalizeTimesSheetExcludedTeams(parsed)
}

const safeJsonParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const getAssessorProfileKey = (team, assessor) => `${normalizeKey(team)}::${normalizeKey(assessor)}`

const buildTimeAnalyticsRow = (entry, line, index) => {
  const value = resolveEntryValue(entry)
  const clientCode = resolveClientCodeFromRow(entry)
  const assessor = String(entry?.assessor || ASSESSOR_FALLBACK).trim() || ASSESSOR_FALLBACK
  const unit = normalizeUnitLabel(entry?.unit || entry?.unidade)
  return {
    id: `${line}-${entry?.id || entry?.uid || index}-${clientCode || 'no-client'}`,
    line,
    value,
    team: normalizeTeam(entry?.time),
    unit,
    assessor,
    clientCode: clientCode || CLIENT_FALLBACK,
    monthKey: resolveEntryMonth(entry),
  }
}

const resolveManualLine = (entry) => {
  const token = normalizeKey(entry?.origem || entry?.line || '')
  if (token.includes('estrutur')) return 'Estruturadas'
  if (token.includes('bmf') || token.includes('futuro')) return 'BMF'
  if (token.includes('bovespa') || token === 'bov') return 'Bovespa'
  return 'Manual'
}

const sortByRevenueDesc = (a, b) => b.total - a.total

const resolveMostFrequentValue = (map) => {
  if (!(map instanceof Map) || !map.size) return ''
  const ranked = Array.from(map.entries())
  ranked.sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1]
    return String(left[0]).localeCompare(String(right[0]), 'pt-BR')
  })
  return String(ranked[0]?.[0] || '').trim()
}

const Tags = () => {
  const { notify } = useToast()
  const globalFolderMenu = useGlobalFolderMenu('tags')
  const { path, navigate } = useHashRoute('/tags')
  const {
    userKey,
    refreshTags,
    selectedBroker,
    selectedAssessor,
    clientCodeFilter,
    tagsIndex,
    apuracaoMonths,
    apuracaoOptions,
  } = useGlobalFilters()

  const [activeTab, setActiveTab] = useState(() => resolveTabFromPath(path))
  const [query, setQuery] = useState('')
  const [tagsAccountQuery, setTagsAccountQuery] = useState('')
  const [tagsAssessorQuery, setTagsAssessorQuery] = useState('')
  const [tagsSelectedAccounts, setTagsSelectedAccounts] = useState([])
  const [tagsSelectedAssessors, setTagsSelectedAssessors] = useState([])
  const [savingAssessorRows, setSavingAssessorRows] = useState(() => new Set())
  const [pinnedEditedRowId, setPinnedEditedRowId] = useState('')
  const [running, setRunning] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  const [payload, setPayload] = useState(null)
  const [result, setResult] = useState(null)
  const [page, setPage] = useState(1)
  const [selectedTeams, setSelectedTeams] = useState([])
  const [selectedUnits, setSelectedUnits] = useState([])
  const [timesSheetQuery, setTimesSheetQuery] = useState('')
  const [timesSheetSeniorities, setTimesSheetSeniorities] = useState([])
  const [timesSheetExcludedTeams, setTimesSheetExcludedTeams] = useState([])
  const [assessorProfiles, setAssessorProfiles] = useState({})
  const [assessorManualOverrides, setAssessorManualOverrides] = useState({})
  const [profilesReady, setProfilesReady] = useState(false)
  const [interactiveFilters, setInteractiveFilters] = useState(DEFAULT_INTERACTIVE_FILTERS)
  const [revenueSnapshot, setRevenueSnapshot] = useState(() => {
    const manualEntries = loadManualRevenue()
    return {
      bovespa: buildEffectiveBovespaEntries(loadRevenueList('bovespa'), TIMES_XP_OVERLAY_OPTIONS),
      bmf: buildEffectiveBmfEntries(loadRevenueList('bmf'), TIMES_XP_OVERLAY_OPTIONS),
      estruturadas: buildEffectiveStructuredEntries(loadStructuredRevenue(), TIMES_XP_OVERLAY_OPTIONS),
      manual: stripEntriesByXpMonths(manualEntries, (entry) => entry.data || entry.dataEntrada, TIMES_XP_OVERLAY_OPTIONS),
      xp: loadXpRevenue(),
    }
  })
  const editedRowPinTimerRef = useRef(null)
  const pageSize = 30
  const isTagsTab = activeTab === TAB_TAGS
  const isTimesTab = activeTab === TAB_TIMES
  const hasPendingAssessorSave = savingAssessorRows.size > 0
  const directoryFilterOptions = useMemo(
    () => globalFolderMenu.directoryOptions.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.directory?.folderPath || '',
    })),
    [globalFolderMenu.directoryOptions],
  )
  const directoryOptionsEmptyMessage = useMemo(() => {
    if (globalFolderMenu.loading) return ''
    return globalFolderMenu.emptyMessage
  }, [globalFolderMenu.emptyMessage, globalFolderMenu.loading])

  const refreshRevenueSnapshot = useCallback(() => {
    const manualEntries = loadManualRevenue()
    setRevenueSnapshot({
      bovespa: buildEffectiveBovespaEntries(loadRevenueList('bovespa'), TIMES_XP_OVERLAY_OPTIONS),
      bmf: buildEffectiveBmfEntries(loadRevenueList('bmf'), TIMES_XP_OVERLAY_OPTIONS),
      estruturadas: buildEffectiveStructuredEntries(loadStructuredRevenue(), TIMES_XP_OVERLAY_OPTIONS),
      manual: stripEntriesByXpMonths(manualEntries, (entry) => entry.data || entry.dataEntrada, TIMES_XP_OVERLAY_OPTIONS),
      xp: loadXpRevenue(),
    })
  }, [])

  const toggleInteractiveFilter = useCallback((key, value, resetValue = '') => {
    setInteractiveFilters((prev) => ({
      ...prev,
      [key]: prev[key] === value ? resetValue : value,
    }))
  }, [])

  const clearInteractiveFilters = useCallback(() => {
    setInteractiveFilters({ ...DEFAULT_INTERACTIVE_FILTERS })
  }, [])

  const handleFilterKeyDown = useCallback((event, action) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      action()
    }
  }, [])

  const hasInteractiveFilters = useMemo(() => (
    interactiveFilters.line !== 'all'
    || Boolean(interactiveFilters.team)
    || Boolean(interactiveFilters.assessor)
    || Boolean(interactiveFilters.seniority)
    || isGapFilterValue(interactiveFilters.gap)
  ), [interactiveFilters])

  useEffect(() => {
    const tab = resolveTabFromPath(path)
    setActiveTab(tab)
  }, [path])

  useEffect(() => {
    if (!isTimesTab) return undefined
    refreshRevenueSnapshot()
    const handleRevenueUpdate = () => refreshRevenueSnapshot()
    window.addEventListener('pwr:receita-updated', handleRevenueUpdate)
    return () => window.removeEventListener('pwr:receita-updated', handleRevenueUpdate)
  }, [isTimesTab, refreshRevenueSnapshot])

  useEffect(() => {
    let active = true
    const load = async () => {
      const loaded = await loadTags(userKey)
      if (!active) return
      setPayload(loaded)
      setResult(loaded?.stats || null)
      setPage(1)
    }
    load()
    return () => {
      active = false
    }
  }, [userKey])

  useEffect(() => {
    setProfilesReady(false)
    const key = buildTimesProfileKey(userKey)
    const parsed = safeJsonParse(localStorage.getItem(key))
    setAssessorProfiles(parsed && typeof parsed === 'object' ? parsed : {})
    setProfilesReady(true)
  }, [userKey])

  useEffect(() => {
    setAssessorManualOverrides(loadAssessorOverrides(userKey))
  }, [userKey])

  useEffect(() => {
    setTimesSheetExcludedTeams(loadTimesSheetExcludedTeams(userKey))
  }, [userKey])

  useEffect(() => {
    const key = buildTimesSheetExcludedTeamsKey(userKey)
    localStorage.setItem(key, JSON.stringify(normalizeTimesSheetExcludedTeams(timesSheetExcludedTeams)))
  }, [timesSheetExcludedTeams, userKey])

  useEffect(() => () => {
    if (editedRowPinTimerRef.current) {
      clearTimeout(editedRowPinTimerRef.current)
      editedRowPinTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!profilesReady) return
    const key = buildTimesProfileKey(userKey)
    const timer = setTimeout(() => {
      localStorage.setItem(key, JSON.stringify(assessorProfiles || {}))
    }, 120)
    return () => clearTimeout(timer)
  }, [assessorProfiles, profilesReady, userKey])

  const handleSwitchTab = useCallback((tab) => {
    const target = tab === TAB_TIMES ? '/times' : '/tags'
    setActiveTab(tab)
    navigate(target)
  }, [navigate])

  const updateAssessorProfile = useCallback((profileKey, patch) => {
    if (!profileKey) return
    setAssessorProfiles((prev) => ({
      ...prev,
      [profileKey]: {
        ...(prev?.[profileKey] || {}),
        ...patch,
      },
    }))
  }, [])

  const updateAssessorGoal = useCallback((profileKey, goalRaw) => {
    if (!profileKey) return
    setAssessorProfiles((prev) => {
      const current = { ...(prev?.[profileKey] || {}) }
      if (String(goalRaw || '').trim()) {
        current.goalRaw = goalRaw
      } else {
        delete current.goalRaw
      }

      if (!Object.keys(current).length) {
        const next = { ...(prev || {}) }
        delete next[profileKey]
        return next
      }

      return {
        ...(prev || {}),
        [profileKey]: current,
      }
    })
  }, [])

  const resetAssessorProfiles = useCallback(() => {
    setAssessorProfiles({})
    notify('Times, senioridade e metas resetadas.', 'success')
  }, [notify])

  const persistAssessorManualOverrides = useCallback((nextOverrides) => {
    const saved = saveAssessorOverrides(userKey, nextOverrides)
    if (!saved) {
      notify('Falha ao salvar override manual por assessor.', 'warning')
      return false
    }
    setAssessorManualOverrides(saved)
    window.dispatchEvent(new CustomEvent('pwr:tags-updated', { detail: { userKey } }))
    window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
    return true
  }, [notify, userKey])

  const updateAssessorManualOverride = useCallback((assessorName, field, rawValue) => {
    const assessor = normalizeAssessorName(assessorName, '')
    const assessorKey = normalizeAssessorOverrideKey(assessor)
    if (!assessorKey) return
    const next = { ...(assessorManualOverrides || {}) }
    const current = { ...(next[assessorKey] || {}) }
    const normalizedValue = field === 'unit'
      ? normalizeUnitLabel(rawValue)
      : String(rawValue || '').trim()

    current.assessor = assessor
    if (normalizedValue) current[field] = normalizedValue
    else delete current[field]

    if (!current.broker && !current.unit && !current.time) {
      delete next[assessorKey]
    } else {
      next[assessorKey] = current
    }

    persistAssessorManualOverrides(next)
  }, [assessorManualOverrides, persistAssessorManualOverrides])

  const clearAssessorManualOverride = useCallback((assessorName) => {
    const assessor = normalizeAssessorName(assessorName, '')
    const assessorKey = normalizeAssessorOverrideKey(assessor)
    if (!assessorKey || !assessorManualOverrides?.[assessorKey]) return
    const next = { ...(assessorManualOverrides || {}) }
    delete next[assessorKey]
    persistAssessorManualOverrides(next)
  }, [assessorManualOverrides, persistAssessorManualOverrides])

  const markAssessorRowSaving = useCallback((rowId, saving) => {
    if (!rowId) return
    setSavingAssessorRows((prev) => {
      const next = new Set(prev)
      if (saving) next.add(rowId)
      else next.delete(rowId)
      return next
    })
  }, [])

  const pinEditedRow = useCallback((rowId) => {
    if (!rowId) return
    setPinnedEditedRowId(rowId)
    setPage(1)
    if (editedRowPinTimerRef.current) {
      clearTimeout(editedRowPinTimerRef.current)
    }
    editedRowPinTimerRef.current = setTimeout(() => {
      setPinnedEditedRowId((current) => (current === rowId ? '' : current))
      editedRowPinTimerRef.current = null
    }, 12000)
  }, [])

  const tagsSelectedAccountSet = useMemo(() => new Set(tagsSelectedAccounts), [tagsSelectedAccounts])
  const tagsSelectedAssessorSet = useMemo(() => new Set(tagsSelectedAssessors), [tagsSelectedAssessors])

  const tagsAccountOptions = useMemo(() => {
    if (!isTagsTab) return []
    const accountSet = new Set()
    ;(payload?.rows || []).forEach((item) => {
      const account = String(item?.cliente || '').trim()
      if (!account) return
      accountSet.add(account)
    })
    return Array.from(accountSet)
      .sort((left, right) => left.localeCompare(right, 'pt-BR'))
      .map((account) => ({ value: account, label: account }))
  }, [isTagsTab, payload?.rows])

  const tagsAssessorOptions = useMemo(() => {
    if (!isTagsTab) return []
    const assessors = new Set()
    ;(payload?.rows || []).forEach((item) => {
      const assessor = String(item?.assessor || '').trim()
      if (!assessor) return
      assessors.add(assessor)
    })
    return Array.from(assessors)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .map((assessor) => ({ value: assessor, label: assessor }))
  }, [isTagsTab, payload?.rows])

  const tagsAssessorOptionSet = useMemo(() => (
    new Set(tagsAssessorOptions
      .map((item) => normalizeAssessorName(item?.value, ''))
      .filter(Boolean))
  ), [tagsAssessorOptions])

  const handleChangeAssessor = useCallback(async (rowId, nextAssessorRaw) => {
    if (!rowId || !payload?.rows?.length) return
    if (hasPendingAssessorSave) return

    const normalizedAssessor = normalizeAssessorName(nextAssessorRaw, '')
    if (!normalizedAssessor) {
      notify('Selecione um assessor valido.', 'warning')
      return
    }

    if (!tagsAssessorOptionSet.has(normalizedAssessor)) {
      notify('Escolha um assessor ja existente na lista.', 'warning')
      return
    }

    const rowIndex = payload.rows.findIndex((row, index) => {
      const rowKey = row?.id || row?.cliente || `row-${index}`
      return String(rowKey) === String(rowId)
    })
    if (rowIndex < 0) return

    const currentRow = payload.rows[rowIndex]
    const currentAssessor = normalizeAssessorName(currentRow?.assessor, ASSESSOR_FALLBACK)
    if (currentAssessor === normalizedAssessor) return

    const previousPayload = payload
    const nextRows = previousPayload.rows.map((row, index) => (
      index === rowIndex
        ? { ...row, assessor: normalizedAssessor }
        : row
    ))
    const optimisticPayload = { ...previousPayload, rows: nextRows }

    markAssessorRowSaving(rowId, true)
    pinEditedRow(rowId)
    setPayload(optimisticPayload)

    try {
      const saved = await saveTags(userKey, optimisticPayload)
      if (!saved) throw new Error('tags-save-failed')
      setPayload(saved)
      await refreshTags()
      window.dispatchEvent(new CustomEvent('pwr:tags-updated', { detail: { userKey } }))
      notify('Assessor atualizado com sucesso.', 'success')
    } catch {
      setPayload(previousPayload)
      notify('Falha ao atualizar assessor da conta.', 'warning')
    } finally {
      markAssessorRowSaving(rowId, false)
    }
  }, [hasPendingAssessorSave, markAssessorRowSaving, notify, payload, pinEditedRow, refreshTags, tagsAssessorOptionSet, userKey])

  const rows = useMemo(() => {
    if (!isTagsTab) return []
    const items = (payload?.rows || []).map((item, index) => (
      item.id ? item : { ...item, id: item.cliente || `row-${index}` }
    ))
    const genericQuery = query.toLowerCase().trim()
    const accountQuery = tagsAccountQuery.toLowerCase().trim()
    const assessorQuery = tagsAssessorQuery.toLowerCase().trim()

    const filtered = items.filter((item) => {
      const rowId = String(item?.id || '')
      if (pinnedEditedRowId && rowId === pinnedEditedRowId) return true

      const account = String(item.cliente || '').trim()
      const assessor = String(item.assessor || '').trim()

      if (selectedBroker.length && !selectedBroker.includes(String(item.broker || '').trim())) return false
      if (tagsSelectedAccountSet.size && !tagsSelectedAccountSet.has(account)) return false
      if (tagsSelectedAssessorSet.size && !tagsSelectedAssessorSet.has(assessor)) return false
      if (accountQuery && !account.toLowerCase().includes(accountQuery)) return false
      if (assessorQuery && !assessor.toLowerCase().includes(assessorQuery)) return false
      if (genericQuery && !`${account} ${assessor} ${item.broker || ''}`.toLowerCase().includes(genericQuery)) return false
      return true
    })

    if (pinnedEditedRowId) {
      const pinnedIndex = filtered.findIndex((item) => String(item?.id || '') === pinnedEditedRowId)
      if (pinnedIndex > 0) {
        const [pinnedRow] = filtered.splice(pinnedIndex, 1)
        filtered.unshift(pinnedRow)
      }
    }

    return filtered
  }, [
    payload?.rows,
    query,
    selectedBroker,
    tagsAccountQuery,
    tagsAssessorQuery,
    tagsSelectedAccountSet,
    tagsSelectedAssessorSet,
    isTagsTab,
    pinnedEditedRowId,
  ])

  const totalRows = rows.length
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * pageSize
  const pageEnd = Math.min(pageStart + pageSize, totalRows)
  const pagedRows = rows.slice(pageStart, pageEnd)

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    if (!isTagsTab) return
    setPage(1)
  }, [isTagsTab, query, tagsAccountQuery, tagsAssessorQuery, tagsSelectedAccounts, tagsSelectedAssessors])

  const assessorRows = useMemo(() => {
    if (!isTagsTab) return []
    const map = new Map()
    rows.forEach((item) => {
      const assessor = item.assessor || 'Sem assessor'
      const broker = item.broker || 'Sem broker'
      const key = `${assessor}|||${broker}`
      const existing = map.get(key) || { id: key, assessor, broker, total: 0 }
      existing.total += 1
      map.set(key, existing)
    })
    return Array.from(map.values()).sort((a, b) => {
      if (a.broker === b.broker) return a.assessor.localeCompare(b.assessor, 'pt-BR')
      return a.broker.localeCompare(b.broker, 'pt-BR')
    })
  }, [isTagsTab, rows])

  const assessorManualRows = useMemo(() => {
    if (!isTagsTab) return []
    const byAssessor = new Map()
    ;(payload?.rows || []).forEach((entry) => {
      const assessor = normalizeAssessorName(entry?.assessor, '')
      const assessorKey = normalizeAssessorOverrideKey(assessor)
      if (!assessorKey) return
      const current = byAssessor.get(assessorKey) || {
        assessor,
        brokerFreq: new Map(),
        unitFreq: new Map(),
        teamFreq: new Map(),
      }
      const broker = String(entry?.broker || '').trim()
      const unit = normalizeUnitLabel(entry?.unit || entry?.unidade)
      const team = String(entry?.time || '').trim()
      if (broker) current.brokerFreq.set(broker, (current.brokerFreq.get(broker) || 0) + 1)
      if (unit) current.unitFreq.set(unit, (current.unitFreq.get(unit) || 0) + 1)
      if (team) current.teamFreq.set(team, (current.teamFreq.get(team) || 0) + 1)
      byAssessor.set(assessorKey, current)
    })

    const rowsList = Array.from(byAssessor.entries()).map(([assessorKey, info]) => {
      const override = assessorManualOverrides?.[assessorKey] || {}
      return {
        id: assessorKey,
        assessorKey,
        assessor: override.assessor || info.assessor,
        baseBroker: resolveMostFrequentValue(info.brokerFreq),
        baseUnit: resolveMostFrequentValue(info.unitFreq),
        baseTime: resolveMostFrequentValue(info.teamFreq),
        broker: String(override.broker || '').trim(),
        unit: normalizeUnitLabel(override.unit),
        time: String(override.time || '').trim(),
      }
    })

    Object.entries(assessorManualOverrides || {}).forEach(([assessorKey, override]) => {
      if (byAssessor.has(assessorKey)) return
      rowsList.push({
        id: assessorKey,
        assessorKey,
        assessor: override.assessor || assessorKey,
        baseBroker: '',
        baseUnit: '',
        baseTime: '',
        broker: String(override.broker || '').trim(),
        unit: normalizeUnitLabel(override.unit),
        time: String(override.time || '').trim(),
      })
    })

    return rowsList
      .map((row) => ({
        ...row,
        hasOverride: Boolean(row.broker || row.unit || row.time),
      }))
      .sort((a, b) => String(a.assessor || '').localeCompare(String(b.assessor || ''), 'pt-BR'))
  }, [isTagsTab, payload?.rows, assessorManualOverrides])

  const assessorManualBrokerOptions = useMemo(() => {
    const values = new Set()
    ;(payload?.rows || []).forEach((entry) => {
      const broker = String(entry?.broker || '').trim()
      if (broker) values.add(broker)
    })
    assessorManualRows.forEach((row) => {
      if (row.baseBroker) values.add(row.baseBroker)
      if (row.broker) values.add(row.broker)
    })
    return Array.from(values).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  }, [payload?.rows, assessorManualRows])

  const assessorManualTeamOptions = useMemo(() => {
    const values = new Set()
    ;(payload?.rows || []).forEach((entry) => {
      const team = String(entry?.time || '').trim()
      if (team) values.add(team)
    })
    assessorManualRows.forEach((row) => {
      if (row.baseTime) values.add(row.baseTime)
      if (row.time) values.add(row.time)
    })
    return Array.from(values).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  }, [payload?.rows, assessorManualRows])

  const assessorManualUnitOptions = useMemo(() => {
    const values = new Set(UNIT_OPTIONS.map((item) => item.value))
    ;(payload?.rows || []).forEach((entry) => {
      const unit = normalizeUnitLabel(entry?.unit || entry?.unidade)
      if (unit) values.add(unit)
    })
    assessorManualRows.forEach((row) => {
      if (row.baseUnit) values.add(row.baseUnit)
      if (row.unit) values.add(row.unit)
    })
    return Array.from(values).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  }, [payload?.rows, assessorManualRows])

  const assessorManualColumns = useMemo(() => ([
    { key: 'assessor', label: 'Assessor' },
    {
      key: 'broker',
      label: 'Broker',
      render: (row) => (
        <select
          className="tags-assessor-select"
          value={row.broker}
          onChange={(event) => updateAssessorManualOverride(row.assessor, 'broker', event.target.value)}
          aria-label={`Broker manual de ${row.assessor}`}
        >
          <option value="">
            {row.baseBroker ? `Padrao (${row.baseBroker})` : 'Padrao (sem broker)'}
          </option>
          {assessorManualBrokerOptions.map((value) => (
            <option key={`${row.id}-broker-${value}`} value={value}>{value}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'unit',
      label: 'Unidade',
      render: (row) => (
        <select
          className="tags-assessor-select"
          value={row.unit}
          onChange={(event) => updateAssessorManualOverride(row.assessor, 'unit', event.target.value)}
          aria-label={`Unidade manual de ${row.assessor}`}
        >
          <option value="">
            {row.baseUnit ? `Padrao (${row.baseUnit})` : 'Padrao (sem unidade)'}
          </option>
          {assessorManualUnitOptions.map((value) => (
            <option key={`${row.id}-unit-${value}`} value={value}>{value}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'time',
      label: 'Time',
      render: (row) => (
        <select
          className="tags-assessor-select"
          value={row.time}
          onChange={(event) => updateAssessorManualOverride(row.assessor, 'time', event.target.value)}
          aria-label={`Time manual de ${row.assessor}`}
        >
          <option value="">
            {row.baseTime ? `Padrao (${row.baseTime})` : 'Padrao (sem time)'}
          </option>
          {assessorManualTeamOptions.map((value) => (
            <option key={`${row.id}-time-${value}`} value={value}>{value}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'action',
      label: 'Acoes',
      render: (row) => (
        <button
          className="btn btn-secondary"
          type="button"
          style={{ padding: '6px 10px' }}
          disabled={!row.hasOverride}
          onClick={() => clearAssessorManualOverride(row.assessor)}
        >
          Limpar
        </button>
      ),
    },
  ]), [
    assessorManualBrokerOptions,
    assessorManualTeamOptions,
    assessorManualUnitOptions,
    clearAssessorManualOverride,
    updateAssessorManualOverride,
  ])

  const columns = useMemo(
    () => [
      { key: 'cliente', label: 'Conta', render: (row) => row.cliente || '—' },
      {
        key: 'assessor',
        label: 'Assessor',
        render: (row) => {
          const rowId = String(row?.id || '')
          const rawCurrent = String(row?.assessor || '').trim()
          const currentAssessor = normalizeAssessorName(rawCurrent, '')
          const isSaving = savingAssessorRows.has(rowId)
          const showCurrentOption = currentAssessor && !tagsAssessorOptionSet.has(currentAssessor)
          return (
            <div className="tags-assessor-editor">
              <select
                className="tags-assessor-select"
                value={rawCurrent}
                disabled={hasPendingAssessorSave || !tagsAssessorOptions.length}
                onChange={(event) => {
                  const nextValue = event.target.value
                  if (nextValue === rawCurrent) return
                  void handleChangeAssessor(rowId, nextValue)
                }}
                aria-label={`Assessor da conta ${row?.cliente || rowId}`}
              >
                <option value="" disabled>Selecione</option>
                {showCurrentOption ? <option value={rawCurrent}>{rawCurrent}</option> : null}
                {tagsAssessorOptions.map((option) => (
                  <option key={`${rowId}-${option.value}`} value={option.value}>{option.label}</option>
                ))}
              </select>
              {isSaving ? <small className="muted">Salvando...</small> : null}
            </div>
          )
        },
      },
      { key: 'broker', label: 'Broker', render: (row) => row.broker || '—' },
    ],
    [handleChangeAssessor, hasPendingAssessorSave, savingAssessorRows, tagsAssessorOptionSet, tagsAssessorOptions],
  )

  const assessorColumns = useMemo(
    () => [
      { key: 'assessor', label: 'Assessor' },
      { key: 'broker', label: 'Broker' },
      { key: 'total', label: 'Qtd clientes' },
    ],
    [],
  )

  const lastImportedAt = payload?.importedAt ? formatDate(new Date(payload.importedAt)) : '—'

  const normalizedAssessorFilter = useMemo(() => {
    if (!isTimesTab) return null
    const values = selectedAssessor.map(normalizeKey).filter(Boolean)
    return values.length ? new Set(values) : null
  }, [isTimesTab, selectedAssessor])

  const applyGlobalFilters = useCallback((entries) => {
    if (!isTimesTab) return []
    const source = Array.isArray(entries) ? entries : []
    if (!source.length) return []

    const availableBrokers = new Set(
      source.map((entry) => String(entry?.broker || '').trim()).filter(Boolean),
    )
    const effectiveBrokerFilter = selectedBroker
      .map((item) => String(item || '').trim())
      .filter((item) => availableBrokers.has(item))

    const availableAssessorKeys = new Set(
      source.map((entry) => normalizeKey(entry?.assessor)).filter(Boolean),
    )
    const effectiveAssessorFilter = normalizedAssessorFilter?.size
      ? new Set(Array.from(normalizedAssessorFilter).filter((item) => availableAssessorKeys.has(item)))
      : null

    return source.filter((entry) => {
      if (effectiveBrokerFilter.length && !effectiveBrokerFilter.includes(String(entry?.broker || '').trim())) return false
      if (effectiveAssessorFilter?.size) {
        const assessorKey = normalizeKey(entry?.assessor)
        if (!effectiveAssessorFilter.has(assessorKey)) return false
      }
      return true
    })
  }, [isTimesTab, selectedBroker, normalizedAssessorFilter])
  const bovespaScoped = useMemo(
    () => (isTimesTab
      ? filterByApuracaoMonths(revenueSnapshot.bovespa, apuracaoMonths, (entry) => entry.data || entry.dataEntrada)
      : []),
    [isTimesTab, revenueSnapshot.bovespa, apuracaoMonths],
  )

  const bmfScoped = useMemo(
    () => (isTimesTab
      ? filterByApuracaoMonths(revenueSnapshot.bmf, apuracaoMonths, (entry) => entry.data || entry.dataEntrada)
      : []),
    [isTimesTab, revenueSnapshot.bmf, apuracaoMonths],
  )

  const structuredScoped = useMemo(
    () => (isTimesTab
      ? filterByApuracaoMonths(revenueSnapshot.estruturadas, apuracaoMonths, (entry) => entry.dataEntrada || entry.data)
      : []),
    [isTimesTab, revenueSnapshot.estruturadas, apuracaoMonths],
  )

  const manualScoped = useMemo(
    () => (isTimesTab
      ? filterByApuracaoMonths(revenueSnapshot.manual, apuracaoMonths, (entry) => entry.data || entry.dataEntrada)
      : []),
    [isTimesTab, revenueSnapshot.manual, apuracaoMonths],
  )

  const bovespaRows = useMemo(() => {
    if (!isTimesTab) return []
    return applyGlobalFilters(
      bovespaScoped
        .filter((entry) => normalizeKey(entry?.tipoCorretagem) === 'variavel')
        .map((entry) => enrichRow(entry, tagsIndex)),
    )
  }, [isTimesTab, applyGlobalFilters, bovespaScoped, tagsIndex])

  const bmfRows = useMemo(() => {
    if (!isTimesTab) return []
    return applyGlobalFilters(
      bmfScoped
        .filter((entry) => normalizeKey(entry?.tipoCorretagem) === 'variavel')
        .map((entry) => enrichRow(entry, tagsIndex)),
    )
  }, [isTimesTab, applyGlobalFilters, bmfScoped, tagsIndex])

  const structuredRows = useMemo(() => {
    if (!isTimesTab) return []
    return applyGlobalFilters(structuredScoped.map((entry) => enrichRow(entry, tagsIndex)))
  }, [isTimesTab, applyGlobalFilters, structuredScoped, tagsIndex])

  const manualRows = useMemo(() => {
    if (!isTimesTab) return []
    return applyGlobalFilters(manualScoped.map((entry) => enrichRow(entry, tagsIndex)))
  }, [isTimesTab, applyGlobalFilters, manualScoped, tagsIndex])

  const xpScoped = useMemo(
    () => (isTimesTab
      ? filterByApuracaoMonths(revenueSnapshot.xp || [], apuracaoMonths, (entry) => entry.data || entry.dataEntrada)
      : []),
    [isTimesTab, revenueSnapshot.xp, apuracaoMonths],
  )

  const xpRows = useMemo(() => {
    if (!isTimesTab) return []
    return applyGlobalFilters(xpScoped.map((entry) => enrichRow(entry, tagsIndex)))
  }, [isTimesTab, applyGlobalFilters, xpScoped, tagsIndex])

  const analyticsRows = useMemo(() => {
    if (!isTimesTab) return []
    const rowsList = []
    bovespaRows.forEach((entry, index) => rowsList.push(buildTimeAnalyticsRow(entry, 'Bovespa', index)))
    bmfRows.forEach((entry, index) => rowsList.push(buildTimeAnalyticsRow(entry, 'BMF', index)))
    structuredRows.forEach((entry, index) => rowsList.push(buildTimeAnalyticsRow(entry, 'Estruturadas', index)))
    manualRows.forEach((entry, index) => rowsList.push(buildTimeAnalyticsRow(entry, resolveManualLine(entry), index)))

    const hasXpInInjectedFlows = [bovespaRows, bmfRows, structuredRows, manualRows]
      .some((list) => list.some((entry) => String(entry?.source || '').trim().toLowerCase() === 'xp-commission'))

    // Fallback: se o pipeline efetivo nao injetar XP, usa base XP direta para manter Times visivel.
    if (!hasXpInInjectedFlows) {
      xpRows.forEach((entry, index) => {
        const line = String(entry?.line || '').trim() || 'Bovespa'
        rowsList.push(buildTimeAnalyticsRow(entry, line, index))
      })
    }

    return rowsList
  }, [isTimesTab, bovespaRows, bmfRows, structuredRows, manualRows, xpRows])

  const teamOptions = useMemo(() => {
    if (!isTimesTab) return []
    const teams = Array.from(new Set(
      analyticsRows
        .map((row) => row.team)
        .filter((team) => hasValidTeam(team)),
    )).sort((a, b) => a.localeCompare(b, 'pt-BR'))
    return teams.map((team) => ({ value: team, label: team }))
  }, [isTimesTab, analyticsRows])

  const unitOptions = useMemo(() => {
    if (!isTimesTab) return []
    const available = new Set(analyticsRows.map((row) => row.unit).filter(Boolean))
    return UNIT_OPTIONS.filter((option) => available.has(option.value))
  }, [isTimesTab, analyticsRows])

  const selectedTeamSet = useMemo(() => new Set(selectedTeams), [selectedTeams])
  const selectedUnitSet = useMemo(() => new Set(selectedUnits), [selectedUnits])

  const analyticsFiltered = useMemo(() => {
    if (!isTimesTab) return []
    return analyticsRows.filter((row) => {
      if (!hasValidTeam(row.team)) return false
      if (selectedTeamSet.size && !selectedTeamSet.has(row.team)) return false
      if (selectedUnitSet.size && !selectedUnitSet.has(row.unit)) return false
      return true
    })
  }, [isTimesTab, analyticsRows, selectedTeamSet, selectedUnitSet])

  const analyticsInteractiveRows = useMemo(() => {
    if (!isTimesTab) return []
    const lineFilter = interactiveFilters.line
    const teamFilter = interactiveFilters.team
    const assessorFilterKey = normalizeKey(interactiveFilters.assessor)
    return analyticsFiltered.filter((row) => {
      if (lineFilter !== 'all' && row.line !== lineFilter) return false
      if (teamFilter && row.team !== teamFilter) return false
      if (assessorFilterKey && normalizeKey(row.assessor) !== assessorFilterKey) return false
      return true
    })
  }, [
    isTimesTab,
    analyticsFiltered,
    interactiveFilters.line,
    interactiveFilters.team,
    interactiveFilters.assessor,
  ])

  const tagSeniorityByProfile = useMemo(() => {
    if (!isTimesTab) return new Map()
    const frequencyByProfile = new Map()
    ;(payload?.rows || []).forEach((entry) => {
      const seniority = normalizeSeniorityLabel(entry?.seniority)
      if (!seniority) return
      const team = normalizeTeam(entry?.time)
      const assessor = String(entry?.assessor || ASSESSOR_FALLBACK).trim() || ASSESSOR_FALLBACK
      const profileKey = getAssessorProfileKey(team, assessor)
      const current = frequencyByProfile.get(profileKey) || new Map()
      current.set(seniority, (current.get(seniority) || 0) + 1)
      frequencyByProfile.set(profileKey, current)
    })

    const resolved = new Map()
    frequencyByProfile.forEach((levels, profileKey) => {
      const ranked = Array.from(levels.entries())
      ranked.sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1]
        return compareSeniorityLabel(left[0], right[0])
      })
      if (ranked[0]?.[0]) resolved.set(profileKey, ranked[0][0])
    })
    return resolved
  }, [isTimesTab, payload?.rows])

  const apuracaoMonthCount = useMemo(() => {
    if (!isTimesTab) return 1
    if (apuracaoMonths?.all === false) {
      const selectedMonths = Array.isArray(apuracaoMonths?.months) ? apuracaoMonths.months : []
      const uniqueMonths = new Set(selectedMonths.filter(Boolean))
      return Math.max(1, uniqueMonths.size)
    }
    const availableMonths = Array.isArray(apuracaoOptions) ? apuracaoOptions.length : 0
    return Math.max(1, availableMonths)
  }, [isTimesTab, apuracaoMonths, apuracaoOptions])

  const matrixRows = useMemo(() => {
    const map = new Map()
    analyticsInteractiveRows.forEach((row) => {
      const rowKey = getAssessorProfileKey(row.team, row.assessor)
      const current = map.get(rowKey) || {
        id: rowKey,
        profileKey: rowKey,
        team: row.team,
        assessor: row.assessor,
        bovespa: 0,
        bmf: 0,
        estruturadas: 0,
        manual: 0,
        total: 0,
      }
      current.total += row.value
      if (row.line === 'Bovespa') current.bovespa += row.value
      if (row.line === 'BMF') current.bmf += row.value
      if (row.line === 'Estruturadas') current.estruturadas += row.value
      if (row.line === 'Manual') current.manual += row.value
      map.set(rowKey, current)
    })

    const normalizedSeniorityFilter = interactiveFilters.seniority
      ? (normalizeSeniorityLabel(interactiveFilters.seniority) || interactiveFilters.seniority)
      : ''
    const gapFilter = isGapFilterValue(interactiveFilters.gap) ? interactiveFilters.gap : 'all'

    return Array.from(map.values())
      .map((item) => {
        const profile = assessorProfiles?.[item.profileKey] || {}
        const hasProfileSeniority = hasOwn(profile, 'seniority')
        const hasProfileGoal = hasOwn(profile, 'goalRaw')
        const hasProfileTeam = hasOwn(profile, 'team')
        const teamOverride = hasProfileTeam ? String(profile.team || '').trim() : ''
        const team = teamOverride || item.team
        const seniorityFromTag = tagSeniorityByProfile.get(item.profileKey) || ''
        const seniority = normalizeSeniorityLabel(hasProfileSeniority ? profile.seniority : seniorityFromTag)
        const goalBySeniority = resolveGoalBySeniority(seniority) * apuracaoMonthCount
        const goalRawInput = hasProfileGoal ? String(profile.goalRaw ?? '') : ''
        const parsedProfileGoal = hasProfileGoal ? parseBrNumber(goalRawInput) : null
        const goal = parsedProfileGoal != null ? parsedProfileGoal : goalBySeniority
        const goalRaw = hasProfileGoal ? goalRawInput : (goalBySeniority > 0 ? String(goalBySeniority) : '')
        const attainment = goal > 0 ? item.total / goal : null
        const gap = goal > 0 ? item.total - goal : item.total
        return {
          ...item,
          team,
          originalTeam: item.team,
          goalRaw,
          goal,
          goalBySeniority,
          seniority,
          attainment,
          gap,
        }
      })
      .filter((row) => {
        if (normalizedSeniorityFilter && (row.seniority || 'Sem nivel') !== normalizedSeniorityFilter) return false
        if (gapFilter !== 'all' && resolveGapBucket(row) !== gapFilter) return false
        return true
      })
      .sort(sortByRevenueDesc)
  }, [
    analyticsInteractiveRows,
    assessorProfiles,
    tagSeniorityByProfile,
    apuracaoMonthCount,
    interactiveFilters.seniority,
    interactiveFilters.gap,
  ])

  const lineTotals = useMemo(() => {
    const base = { Bovespa: 0, BMF: 0, Estruturadas: 0, Manual: 0 }
    matrixRows.forEach((row) => {
      base.Bovespa += row.bovespa
      base.BMF += row.bmf
      base.Estruturadas += row.estruturadas
      base.Manual += row.manual
    })
    return base
  }, [matrixRows])

  const matrixProfileSet = useMemo(
    () => new Set(matrixRows.map((row) => row.profileKey)),
    [matrixRows],
  )

  const uniqueBovespaClients = useMemo(() => {
    if (!matrixProfileSet.size) return 0
    const set = new Set()
    analyticsInteractiveRows.forEach((row) => {
      if (row.line !== 'Bovespa') return
      const profileKey = getAssessorProfileKey(row.team, row.assessor)
      if (!matrixProfileSet.has(profileKey)) return
      if (!row.clientCode || row.clientCode === CLIENT_FALLBACK) return
      set.add(row.clientCode)
    })
    return set.size
  }, [analyticsInteractiveRows, matrixProfileSet])

  const matrixRowsForTable = useMemo(
    () => matrixRows.filter((row) => hasValidAssessor(row.assessor)),
    [matrixRows],
  )

  const timesSheetExcludedTeamSet = useMemo(
    () => new Set(normalizeTimesSheetExcludedTeams(timesSheetExcludedTeams).map((team) => normalizeKey(team))),
    [timesSheetExcludedTeams],
  )

  const timesSheetSeniorityOptions = useMemo(() => {
    const values = new Set()
    matrixRowsForTable.forEach((row) => values.add(row.seniority || 'Sem nivel'))
    return Array.from(values)
      .sort(compareSeniorityLabel)
      .map((value) => ({ value, label: value }))
  }, [matrixRowsForTable])

  const timesSheetSenioritySet = useMemo(() => new Set(timesSheetSeniorities), [timesSheetSeniorities])

  const matrixFilteredRows = useMemo(() => {
    const queryKey = normalizeKey(timesSheetQuery)
    return matrixRowsForTable.filter((row) => {
      const seniority = row.seniority || 'Sem nivel'
      if (timesSheetExcludedTeamSet.has(normalizeKey(row.team))) return false
      if (timesSheetSenioritySet.size && !timesSheetSenioritySet.has(seniority)) return false
      if (!queryKey) return true
      return normalizeKey(`${row.team} ${row.assessor} ${seniority}`).includes(queryKey)
    })
  }, [matrixRowsForTable, timesSheetExcludedTeamSet, timesSheetQuery, timesSheetSenioritySet])

  const timesSheetExcludedTeamLabels = useMemo(() => {
    const labelsByKey = new Map()
    matrixRowsForTable.forEach((row) => {
      const team = normalizeTeam(row.team)
      const teamKey = normalizeKey(team)
      if (!teamKey || teamKey === MISSING_TEAM_KEY || labelsByKey.has(teamKey)) return
      labelsByKey.set(teamKey, team)
    })
    return normalizeTimesSheetExcludedTeams(timesSheetExcludedTeams)
      .map((team) => labelsByKey.get(normalizeKey(team)) || team)
  }, [matrixRowsForTable, timesSheetExcludedTeams])

  const matrixGroupedRowsByTeam = useMemo(() => {
    const grouped = new Map()
    matrixFilteredRows.forEach((row) => {
      const teamKey = normalizeTeam(row.team)
      const current = grouped.get(teamKey) || {
        team: teamKey,
        rows: [],
        totals: {
          bovespa: 0,
          estruturadas: 0,
          total: 0,
          goal: 0,
          gap: 0,
        },
      }
      current.rows.push(row)
      current.totals.bovespa += row.bovespa
      current.totals.estruturadas += row.estruturadas
      current.totals.total += row.total
      current.totals.goal += row.goal
      current.totals.gap += row.gap
      grouped.set(teamKey, current)
    })
    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        totals: {
          ...group.totals,
          attainment: group.totals.goal > 0 ? group.totals.total / group.totals.goal : null,
        },
      }))
      .sort((a, b) => a.team.localeCompare(b.team, 'pt-BR'))
  }, [matrixFilteredRows])

  const totalRevenue = useMemo(() => matrixRows.reduce((sum, row) => sum + row.total, 0), [matrixRows])
  const totalGoal = useMemo(() => matrixRows.reduce((sum, row) => sum + resolveGoalContribution(row), 0), [matrixRows])
  const attainmentAverage = totalGoal > 0 ? totalRevenue / totalGoal : null

  const collectiveGoalTotal = useMemo(
    () => matrixRowsForTable.reduce((sum, row) => sum + resolveGoalContribution(row), 0),
    [matrixRowsForTable],
  )

  const teamPerformance = useMemo(() => {
    const map = new Map()
    matrixRows.forEach((row) => {
      const current = map.get(row.team) || { team: row.team, receita: 0, goal: 0 }
      current.receita += row.total
      current.goal += resolveGoalContribution(row)
      map.set(row.team, current)
    })
    return Array.from(map.values())
      .map((item) => ({
        ...item,
        attainment: item.goal > 0 ? item.receita / item.goal : null,
      }))
      .sort((a, b) => b.receita - a.receita)
      .slice(0, 10)
  }, [matrixRows])

  const teamMaxValue = useMemo(
    () => Math.max(...teamPerformance.map((item) => Math.max(item.receita, item.goal)), 1),
    [teamPerformance],
  )

  const topAssessors = useMemo(() => matrixRowsForTable.slice(0, 8), [matrixRowsForTable])

  const seniorityPerformance = useMemo(() => {
    const map = new Map()
    matrixRows.forEach((row) => {
      const level = row.seniority || 'Sem nivel'
      const current = map.get(level) || {
        level,
        receita: 0,
        goal: 0,
        count: 0,
        eligibleCount: 0,
        reachedCount: 0,
        notReachedCount: 0,
      }
      const goal = resolveGoalContribution(row)
      current.receita += row.total
      current.goal += goal
      current.count += 1
      if (goal > 0) {
        current.eligibleCount += 1
        if (row.total >= goal) {
          current.reachedCount += 1
        } else {
          current.notReachedCount += 1
        }
      }
      map.set(level, current)
    })
    return Array.from(map.values())
      .map((item) => ({
        ...item,
        attainment: item.eligibleCount > 0 ? item.reachedCount / item.eligibleCount : null,
      }))
      .sort((a, b) => compareSeniorityLabel(a.level, b.level))
  }, [matrixRows])

  const gapDistribution = useMemo(() => {
    const result = { above: 0, below: 0 }
    matrixRows.forEach((row) => {
      const goal = resolveGoalContribution(row)
      if (!(goal > 0)) {
        return
      }
      if (row.total >= goal) {
        result.above += row.total - goal
      } else {
        result.below += goal - row.total
      }
    })
    return result
  }, [matrixRows])

  const gapTotal = gapDistribution.above + gapDistribution.below

  const gapDonutStyle = useMemo(() => {
    if (!gapTotal) return { background: 'rgba(255,255,255,0.06)' }
    const abovePct = (gapDistribution.above / gapTotal) * 100
    const belowPct = 100 - abovePct
    return {
      background: `conic-gradient(#34f5a4 0% ${abovePct}%, #ff4d6d ${abovePct}% ${abovePct + belowPct}%)`,
    }
  }, [gapDistribution.above, gapTotal])

  const gapShare = useMemo(() => {
    if (!gapTotal) return { above: 0, below: 0 }
    return {
      above: (gapDistribution.above / gapTotal) * 100,
      below: (gapDistribution.below / gapTotal) * 100,
    }
  }, [gapDistribution.above, gapDistribution.below, gapTotal])

  const interactiveGapLabel = useMemo(() => {
    if (interactiveFilters.gap === 'above') return 'Acima da meta'
    if (interactiveFilters.gap === 'below') return 'Abaixo da meta'
    return 'Todos'
  }, [interactiveFilters.gap])

  const interactiveFilterSummary = useMemo(() => {
    const labels = []
    if (interactiveFilters.line !== 'all') labels.push(`Receita: ${interactiveFilters.line}`)
    if (interactiveFilters.team) labels.push(`Equipe: ${interactiveFilters.team}`)
    if (interactiveFilters.assessor) labels.push(`Assessor: ${interactiveFilters.assessor}`)
    if (interactiveFilters.seniority) labels.push(`Senioridade: ${interactiveFilters.seniority}`)
    if (isGapFilterValue(interactiveFilters.gap)) labels.push(`GAP: ${interactiveGapLabel}`)
    return labels
  }, [
    interactiveFilters.line,
    interactiveFilters.team,
    interactiveFilters.assessor,
    interactiveFilters.seniority,
    interactiveFilters.gap,
    interactiveGapLabel,
  ])

  const clearMainFilters = useCallback(() => {
    setSelectedTeams([])
    setSelectedUnits([])
  }, [])
  const clearTimesSheetFilters = useCallback(() => {
    setTimesSheetQuery('')
    setTimesSheetSeniorities([])
  }, [])

  const hideTimesSheetTeam = useCallback((teamName) => {
    const team = normalizeTeam(teamName)
    const teamKey = normalizeKey(team)
    if (!teamKey || teamKey === MISSING_TEAM_KEY) return
    setTimesSheetExcludedTeams((prev) => {
      const next = normalizeTimesSheetExcludedTeams(prev)
      if (next.some((item) => normalizeKey(item) === teamKey)) return next
      return [...next, team]
    })
    notify(`${team} removido dos blocos da tabela.`, 'success')
  }, [notify])

  const restoreTimesSheetTeam = useCallback((teamName) => {
    const teamKey = normalizeKey(teamName)
    if (!teamKey) return
    setTimesSheetExcludedTeams((prev) => normalizeTimesSheetExcludedTeams(prev)
      .filter((item) => normalizeKey(item) !== teamKey))
  }, [])

  const restoreAllTimesSheetTeams = useCallback(() => {
    setTimesSheetExcludedTeams([])
    notify('Todos os times removidos foram restaurados na tabela.', 'success')
  }, [notify])

  const _handleFolderSelection = useCallback((files) => {
    const candidates = filterSpreadsheetCandidates(files)
    if (!candidates.length) {
      setSelectedFile(null)
      notify('Nenhuma planilha .xlsx/.xls valida foi encontrada.', 'warning')
      return null
    }

    const preferred = candidates.find((candidate) => {
      const normalized = normalizeFileName(candidate?.name || '')
      return normalized.includes('tag') || normalized.includes('vincul')
    })

    const picked = preferred || candidates[0]
    setSelectedFile(picked)
    return picked
  }, [notify])

  const resolveImportInput = useCallback(async (input) => {
    if (!input) return null
    if (input?.source === 'electron' && input?.filePath) {
      if (!window?.electronAPI?.readFile) return null
      return window.electronAPI.readFile(input.filePath)
    }
    return input
  }, [])

  const handleSync = async (file) => {
    let targetFile = file || selectedFile || globalFolderMenu.resolvedFile
    if (!targetFile) targetFile = await globalFolderMenu.refreshFile()
    if (!targetFile) {
      notify('Selecione o Tags.xlsx.', 'warning')
      return
    }
    setResult(null)
    setRunning(true)
    try {
      const importInput = await resolveImportInput(targetFile)
      if (!importInput) {
        notify('Nao foi possivel ler o arquivo selecionado.', 'warning')
        return
      }
      const parsed = await parseTagsXlsx(importInput)
      const saved = await saveTags(userKey, parsed)
      const nextPayload = saved || parsed
      setPayload(nextPayload)
      setResult(nextPayload?.stats || parsed.stats || null)
      setSelectedFile(targetFile)
      refreshRevenueSnapshot()
      await refreshTags()
      window.dispatchEvent(new CustomEvent('pwr:tags-updated', { detail: { userKey } }))
      notify('Tags importadas com sucesso.', 'success')
    } catch {
      notify('Falha ao importar Tags.xlsx.', 'warning')
    } finally {
      setRunning(false)
    }
  }

  const handleExportTimesPdf = useCallback(() => {
    try {
      if (!matrixFilteredRows.length) {
        notify('Nenhum assessor para exportar no PDF.', 'warning')
        return
      }

      const apuracaoAll = apuracaoMonths?.all !== false
      const apuracaoSelectedMonths = apuracaoAll
        ? []
        : (Array.isArray(apuracaoMonths?.months) ? apuracaoMonths.months : [])

      const unitLabelByValue = new Map(UNIT_OPTIONS.map((item) => [item.value, item.label]))
      const selectedUnitLabels = selectedUnits.map((value) => unitLabelByValue.get(value) || value).filter(Boolean)
      const selectedMonthLabels = apuracaoSelectedMonths.map(formatMonthKeyLabel).filter(Boolean)
      const filterItems = [
        { label: 'Apuracao', value: apuracaoAll ? 'Todos os meses' : (selectedMonthLabels.length ? joinFilterList(selectedMonthLabels, 6) : 'Todos os meses') },
        { label: 'Equipes', value: selectedTeams.length ? joinFilterList(selectedTeams, 6) : 'Todas' },
        { label: 'Unidades', value: selectedUnitLabels.length ? joinFilterList(selectedUnitLabels, 6) : 'Todas' },
        { label: 'Broker global', value: selectedBroker.length ? joinFilterList(selectedBroker, 6) : 'Todos' },
        { label: 'Assessor global', value: selectedAssessor.length ? joinFilterList(selectedAssessor, 6) : 'Todos' },
        { label: 'Clientes globais', value: clientCodeFilter.length ? joinFilterList(clientCodeFilter, 8) : 'Todos' },
        { label: 'Filtros graficos', value: interactiveFilterSummary.length ? joinFilterList(interactiveFilterSummary, 6) : 'Nenhum' },
        { label: 'Busca tabela', value: timesSheetQuery || 'Sem busca' },
        { label: 'Filtro senioridade', value: timesSheetSeniorities.length ? joinFilterList(timesSheetSeniorities, 6) : 'Todas' },
        { label: 'Linhas exportadas', value: String(matrixFilteredRows.length) },
      ]

      const kpiCards = [
        { label: 'Receita Liquida Total', value: formatCurrency(totalRevenue), tone: 'cyan' },
        { label: 'Receita Bovespa', value: formatCurrency(lineTotals.Bovespa), tone: 'blue' },
        { label: 'Receita Estruturadas', value: formatCurrency(lineTotals.Estruturadas), tone: 'amber' },
        { label: '% Atingimento Medio', value: formatPercent(attainmentAverage), tone: 'violet' },
        {
          label: 'Meta Coletiva',
          value: formatCurrency(collectiveGoalTotal),
          tone: 'emerald',
        },
      ]

      const reportTopAssessors = topAssessors.slice(0, 8).map((row) => ({
        assessor: row.assessor,
        meta: `${row.team} • ${row.seniority || 'Sem nivel'}`,
        value: formatCurrency(row.total),
      }))

      const reportTeamPerformance = teamPerformance.slice(0, 10).map((row) => ({
        team: row.team,
        attainmentPct: row.attainment != null ? row.attainment * 100 : 0,
        attainmentLabel: formatPercent(row.attainment),
        revenue: formatCurrency(row.receita),
        goal: formatCurrency(row.goal || 0),
      }))

      const reportSeniorityPerformance = seniorityPerformance.map((row) => ({
        level: row.level,
        attainmentPct: row.attainment != null ? row.attainment * 100 : 0,
        attainmentLabel: formatPercent(row.attainment),
        value: row.eligibleCount > 0
          ? `${row.reachedCount}/${row.eligibleCount} assessores atingiram a meta`
          : 'Sem meta configurada',
      }))

      const reportGapRows = [
        { label: 'Acima da meta', value: formatCurrency(gapDistribution.above), share: gapShare.above, tone: 'green' },
        { label: 'Abaixo da meta', value: formatCurrency(gapDistribution.below), share: gapShare.below, tone: 'red' },
      ]

      const reportTableRows = matrixFilteredRows.map((row) => ({
        team: row.team,
        seniority: row.seniority || 'Sem nivel',
        assessor: row.assessor,
        bovespa: formatCurrency(row.bovespa),
        bovespaValue: row.bovespa,
        estruturadas: formatCurrency(row.estruturadas),
        estruturadasValue: row.estruturadas,
        total: formatCurrency(row.total),
        totalValue: row.total,
        goal: row.goal > 0 ? formatCurrency(row.goal) : '—',
        goalValue: resolveGoalContribution(row),
        attainment: formatPercent(row.attainment),
        attainmentValue: row.attainment,
        gap: formatSignedCurrency(row.gap),
        gapValue: row.gap,
        attainmentPositive: row.attainment != null && row.attainment >= 1,
        gapPositive: row.gap >= 0,
      }))

      const today = new Date()
      const generatedAt = today.toLocaleString('pt-BR')
      const fileDate = today.toISOString().slice(0, 10)
      const exported = exportTimesReportPdf(
        {
          title: 'Relatorio de Times',
          generatedAt,
          filters: filterItems,
          kpis: kpiCards,
          topAssessors: reportTopAssessors,
          teamPerformance: reportTeamPerformance,
          seniorityPerformance: reportSeniorityPerformance,
          gapRows: reportGapRows,
          tableRows: reportTableRows,
        },
        `times_${fileDate}`,
      )

      if (!exported) {
        notify('Nao foi possivel abrir o popup para exportar PDF.', 'warning')
        return
      }
      notify('Relatorio aberto para impressao/PDF.', 'success')
    } catch {
      notify('Falha ao gerar PDF de Times.', 'warning')
    }
  }, [
    apuracaoMonths,
    attainmentAverage,
    clientCodeFilter,
    collectiveGoalTotal,
    gapDistribution.above,
    gapDistribution.below,
    gapShare.above,
    gapShare.below,
    interactiveFilterSummary,
    lineTotals.Bovespa,
    lineTotals.Estruturadas,
    matrixFilteredRows,
    notify,
    selectedAssessor,
    selectedBroker,
    selectedTeams,
    selectedUnits,
    seniorityPerformance,
    teamPerformance,
    timesSheetQuery,
    timesSheetSeniorities,
    topAssessors,
    totalRevenue,
  ])

  const handleExportExemplo = useCallback(async () => {
    try {
      await exportXlsx({
        fileName: 'Tags_exemplo.xlsx',
        sheetName: 'Tags',
        columns: ['Conta', 'Assessor', 'Broker', 'Time', 'Unidade', 'Senioridade'],
        rows: [
          ['12345678', 'Fulano', 'XP', 'Mesa A', 'Porto Alegre', 'Senior'],
        ],
      })
      notify('Planilha de exemplo exportada.', 'success')
    } catch {
      notify('Falha ao exportar planilha de exemplo.', 'warning')
    }
  }, [notify])

  const headerActions = useMemo(() => {
    const actions = [
      {
        label: 'Tags',
        icon: 'link',
        variant: activeTab === TAB_TAGS ? 'btn-primary' : 'btn-secondary',
        onClick: () => handleSwitchTab(TAB_TAGS),
      },
      {
        label: 'Times',
        icon: 'user',
        variant: activeTab === TAB_TIMES ? 'btn-primary' : 'btn-secondary',
        onClick: () => handleSwitchTab(TAB_TIMES),
      },
    ]
    if (activeTab === TAB_TAGS) {
      actions.push({
        label: 'Baixar exemplo',
        icon: 'download',
        variant: 'btn-secondary',
        onClick: handleExportExemplo,
      })
    }
    if (activeTab === TAB_TIMES) {
      actions.push({
        label: 'Exportar PDF',
        icon: 'doc',
        variant: 'btn-secondary',
        onClick: handleExportTimesPdf,
        disabled: !matrixFilteredRows.length,
      })
    }
    return actions
  }, [activeTab, handleExportExemplo, handleExportTimesPdf, handleSwitchTab, matrixFilteredRows.length])

  const tagsMeta = useMemo(() => ([
    { label: 'Total vinculos', value: payload?.rows?.length || 0 },
    { label: 'Ultima sync', value: lastImportedAt },
    { label: 'Avisos', value: result?.avisos ?? 0 },
  ]), [payload?.rows?.length, lastImportedAt, result?.avisos])

  const timesMeta = useMemo(() => ([
    { label: 'Receita liquida total', value: formatCurrency(totalRevenue) },
    { label: 'Objetivo total', value: formatCurrency(totalGoal) },
    { label: '% Atingimento medio', value: formatPercent(attainmentAverage) },
    { label: 'Clientes unicos Bovespa', value: formatNumber(uniqueBovespaClients) },
  ]), [totalRevenue, totalGoal, attainmentAverage, uniqueBovespaClients])

  const clearTagsFilters = useCallback(() => {
    setQuery('')
    setTagsAccountQuery('')
    setTagsAssessorQuery('')
    setTagsSelectedAccounts([])
    setTagsSelectedAssessors([])
  }, [])

  const renderTagsView = () => (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Filtros de Tags</h3>
            <p className="muted">Pesquise por conta e assessor com filtros pre-definidos.</p>
          </div>
          <div className="panel-actions">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={clearTagsFilters}
              disabled={!query && !tagsAccountQuery && !tagsAssessorQuery && !tagsSelectedAccounts.length && !tagsSelectedAssessors.length}
            >
              Limpar filtros
            </button>
          </div>
        </div>
        <div className="tags-filter-grid">
          <div className="search-pill">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="Pesquisar conta"
              value={tagsAccountQuery}
              onChange={(event) => setTagsAccountQuery(event.target.value)}
            />
          </div>
          <div className="search-pill">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="Pesquisar assessor"
              value={tagsAssessorQuery}
              onChange={(event) => setTagsAssessorQuery(event.target.value)}
            />
          </div>
          <MultiSelect
            value={tagsSelectedAccounts}
            options={tagsAccountOptions}
            onChange={setTagsSelectedAccounts}
            placeholder="Filtro conta (pre-definido)"
          />
          <MultiSelect
            value={tagsSelectedAssessors}
            options={tagsAssessorOptions}
            onChange={setTagsSelectedAssessors}
            placeholder="Filtro assessor (pre-definido)"
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Mapa de hierarquia</h3>
            <p className="muted">Visualizacao clara do relacionamento.</p>
          </div>
          <div className="panel-actions">
            <div className="muted">
              Mostrando {totalRows ? pageStart + 1 : 0}-{pageEnd} de {totalRows}
            </div>
          </div>
        </div>
        <div className="hierarchy-grid">
          {pagedRows.map((item) => (
            <div
              key={item.id || item.cliente || 'sem-conta'}
              className={`hierarchy-card ${pinnedEditedRowId && String(item.id || '') === pinnedEditedRowId ? 'hierarchy-card-highlight' : ''}`.trim()}
            >
              <div className="hierarchy-tier">
                <span>Conta</span>
                <strong>{item.cliente || '—'}</strong>
              </div>
              <div className="hierarchy-tier">
                <span>Assessor</span>
                <strong>{item.assessor || '—'}</strong>
              </div>
              <div className="hierarchy-tier">
                <span>Broker</span>
                <strong>{item.broker || '—'}</strong>
              </div>
            </div>
          ))}
        </div>
        {totalPages > 1 ? (
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={safePage <= 1}>
              Anterior
            </button>
            <span className="muted">Pagina {safePage} de {totalPages}</span>
            <button className="btn btn-secondary" type="button" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={safePage >= totalPages}>
              Proxima
            </button>
          </div>
        ) : null}
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
              <input type="search" placeholder="Busca geral" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
          </div>
        </div>
        <DataTable rows={pagedRows} columns={columns} emptyMessage="Sem vinculos para exibir." />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Tabela de assessores</h3>
            <p className="muted">Agregado por assessor e broker.</p>
          </div>
        </div>
        <DataTable rows={assessorRows} columns={assessorColumns} emptyMessage="Sem assessores para exibir." />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Override manual por assessor</h3>
            <p className="muted">Ajuste Broker, Unidade e Time manualmente para refletir nas receitas e no painel de Times.</p>
          </div>
          <div className="panel-actions">
            <span className="muted">{assessorManualRows.length} assessor(es)</span>
          </div>
        </div>
        <DataTable
          rows={assessorManualRows}
          columns={assessorManualColumns}
          emptyMessage="Sem assessores disponiveis para override."
        />
      </section>
    </>
  )

  const renderTimesView = () => {
    if (!payload?.rows?.length) {
      return (
        <section className="panel">
          <div className="empty-state">
            <h4>Importe o Tags.xlsx para habilitar Times</h4>
            <p className="muted">A visao usa a coluna Time para vincular receita por cliente.</p>
          </div>
        </section>
      )
    }

    if (!analyticsRows.length) {
      return (
        <section className="panel">
          <div className="empty-state">
            <h4>Sem receita para consolidar</h4>
            <p className="muted">Importe as receitas para ver analytics por time.</p>
          </div>
        </section>
      )
    }

    return (
      <div className="times-visual-shell">
        <section className="panel times-control-panel">
          <div className="panel-head">
            <div>
              <h3>Filtro Geral</h3>
              <p className="muted">Filtra toda a tela por equipe e unidade.</p>
            </div>
            <div className="panel-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={clearMainFilters}
                disabled={!selectedTeams.length && !selectedUnits.length}
              >
                Limpar filtros
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={clearInteractiveFilters}
                disabled={!hasInteractiveFilters}
              >
                Limpar filtros graficos
              </button>
              <button className="btn btn-secondary" type="button" onClick={resetAssessorProfiles}>
                Resetar metas/senioridade
              </button>
            </div>
          </div>
          <div className="times-filter-grid">
            <MultiSelect
              value={selectedTeams}
              options={teamOptions}
              onChange={setSelectedTeams}
              placeholder="Filtrar por equipe"
            />
            <MultiSelect
              value={selectedUnits}
              options={unitOptions}
              onChange={setSelectedUnits}
              placeholder="Filtrar por unidade"
              searchable={false}
            />
            <div className="times-filter-hint muted">
              {(selectedTeams.length || selectedUnits.length)
                ? `${selectedTeams.length || 0} equipe(s) e ${selectedUnits.length || 0} unidade(s) selecionada(s)`
                : 'Mostrando todas as equipes e unidades'}
              <small className="times-filter-hint-aux">
                {interactiveFilterSummary.length
                  ? `Graficos: ${joinFilterList(interactiveFilterSummary, 4)}`
                  : 'Graficos sem filtro interativo'}
              </small>
            </div>
          </div>
        </section>

        <section className="times-kpi-grid">
          <article
            className="card times-kpi-card cyan filter-action"
            role="button"
            tabIndex={0}
            onClick={() => setInteractiveFilters((prev) => ({ ...prev, line: 'all' }))}
            onKeyDown={(event) => handleFilterKeyDown(event, () => setInteractiveFilters((prev) => ({ ...prev, line: 'all' })))}
            aria-label="Mostrar todas as receitas"
          >
            <span>Receita Liquida Total</span>
            <strong>{formatCurrency(totalRevenue)}</strong>
          </article>
          <article
            className={`card times-kpi-card blue filter-action ${interactiveFilters.line === 'Bovespa' ? 'is-active-filter' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => toggleInteractiveFilter('line', 'Bovespa', 'all')}
            onKeyDown={(event) => handleFilterKeyDown(event, () => toggleInteractiveFilter('line', 'Bovespa', 'all'))}
            aria-label="Filtrar por receita Bovespa"
          >
            <span>Receita Bovespa</span>
            <strong>{formatCurrency(lineTotals.Bovespa)}</strong>
          </article>
          <article
            className={`card times-kpi-card amber filter-action ${interactiveFilters.line === 'Estruturadas' ? 'is-active-filter' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => toggleInteractiveFilter('line', 'Estruturadas', 'all')}
            onKeyDown={(event) => handleFilterKeyDown(event, () => toggleInteractiveFilter('line', 'Estruturadas', 'all'))}
            aria-label="Filtrar por receita Estruturadas"
          >
            <span>Receita Estruturadas</span>
            <strong>{formatCurrency(lineTotals.Estruturadas)}</strong>
          </article>
          <article className="card times-kpi-card violet">
            <span>% Atingimento Medio</span>
            <strong>{formatPercent(attainmentAverage)}</strong>
          </article>
          <article className="card times-kpi-card emerald">
            <span>Meta Coletiva</span>
            <strong>{formatCurrency(collectiveGoalTotal)}</strong>
          </article>
        </section>

        <section className="times-analytics-grid">
          <article className="card times-analytic-card">
            <div className="card-head">
              <h3>Top Assessores</h3>
              <span className="muted">Receita liquida</span>
            </div>
            <div className="times-assessor-list">
              {topAssessors.length ? topAssessors.map((row) => (
                <div
                  key={row.id}
                  className={`times-assessor-item filter-action ${normalizeKey(interactiveFilters.assessor) === normalizeKey(row.assessor) ? 'is-active-filter' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleInteractiveFilter('assessor', row.assessor, '')}
                  onKeyDown={(event) => handleFilterKeyDown(event, () => toggleInteractiveFilter('assessor', row.assessor, ''))}
                  aria-label={`Filtrar por assessor ${row.assessor}`}
                >
                  <div className="times-assessor-avatar">{String(row.assessor || '?').trim().slice(0, 1).toUpperCase()}</div>
                  <div className="times-assessor-main">
                    <strong>{row.assessor}</strong>
                    <small>{row.team} • {row.seniority || 'Sem nivel'}</small>
                  </div>
                  <div className="times-assessor-value">{formatCurrency(row.total)}</div>
                </div>
              )) : <p className="muted">Sem dados.</p>}
            </div>
          </article>

          <article className="card times-analytic-card">
            <div className="card-head">
              <h3>Receita por Equipe</h3>
              <span className="muted">Receita x Objetivo</span>
            </div>
            <div className="times-team-bars">
              {teamPerformance.length ? teamPerformance.map((row) => (
                <div
                  key={row.team}
                  className={`times-team-row filter-action ${interactiveFilters.team === row.team ? 'is-active-filter' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleInteractiveFilter('team', row.team, '')}
                  onKeyDown={(event) => handleFilterKeyDown(event, () => toggleInteractiveFilter('team', row.team, ''))}
                  aria-label={`Filtrar por equipe ${row.team}`}
                >
                  <div className="times-team-head">
                    <strong>{row.team}</strong>
                    <span>{formatPercent(row.attainment)}</span>
                  </div>
                  <div className="times-team-track receita">
                    <span className="times-fill-receita" style={{ width: `${(row.receita / teamMaxValue) * 100}%` }} />
                  </div>
                  <div className="times-team-track objetivo">
                    <span className="times-fill-objetivo" style={{ width: `${((row.goal || 0) / teamMaxValue) * 100}%` }} />
                  </div>
                  <small>R {formatCurrency(row.receita)} | Obj {formatCurrency(row.goal || 0)}</small>
                </div>
              )) : <p className="muted">Sem dados por equipe.</p>}
            </div>
          </article>

          <article className="card times-analytic-card">
            <div className="card-head">
              <h3>% Atingimento por Senioridade</h3>
              <span className="muted">Assessores que bateram meta vs nao bateram</span>
            </div>
            <div className="times-seniority-list">
              {seniorityPerformance.length ? seniorityPerformance.map((row) => {
                const width = Math.min((row.attainment || 0) * 100, 100)
                return (
                  <div
                    key={row.level}
                    className={`times-seniority-row filter-action ${interactiveFilters.seniority === row.level ? 'is-active-filter' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleInteractiveFilter('seniority', row.level, '')}
                    onKeyDown={(event) => handleFilterKeyDown(event, () => toggleInteractiveFilter('seniority', row.level, ''))}
                    aria-label={`Filtrar por senioridade ${row.level}`}
                  >
                    <span>{row.level}</span>
                    <div className="times-seniority-track">
                      <span className="times-fill-seniority" style={{ width: `${width}%` }} />
                    </div>
                    <strong title={row.eligibleCount > 0
                      ? `${row.reachedCount}/${row.eligibleCount} assessores bateram a meta`
                      : 'Sem meta configurada para esta senioridade'}>
                      {formatPercent(row.attainment)}
                    </strong>
                  </div>
                )
              }) : <p className="muted">Sem dados de senioridade.</p>}
            </div>
          </article>

          <article className="card times-analytic-card">
            <div className="card-head">
              <h3>GAP Objetivo</h3>
              <span className="muted">Acima e abaixo da meta</span>
            </div>
            <div className="times-gap-layout">
              <div
                className={`times-gap-donut times-gap-pie filter-action ${isGapFilterValue(interactiveFilters.gap) ? 'is-active-filter' : ''}`}
                style={gapDonutStyle}
                role="button"
                tabIndex={0}
                onClick={() => setInteractiveFilters((prev) => ({ ...prev, gap: 'all' }))}
                onKeyDown={(event) => handleFilterKeyDown(event, () => setInteractiveFilters((prev) => ({ ...prev, gap: 'all' })))}
                aria-label="Limpar filtro de GAP objetivo"
              />
              <div className="times-gap-list">
                <div
                  className={`times-gap-item above filter-action ${interactiveFilters.gap === 'above' ? 'is-active-filter' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleInteractiveFilter('gap', 'above', 'all')}
                  onKeyDown={(event) => handleFilterKeyDown(event, () => toggleInteractiveFilter('gap', 'above', 'all'))}
                  aria-label="Filtrar por acima da meta"
                >
                  <div className="times-gap-item-main">
                    <span className="dot green" />
                    <strong>Acima da meta</strong>
                    <em>{formatPercent(gapShare.above / 100)}</em>
                    <small>{formatCurrency(gapDistribution.above)}</small>
                  </div>
                  <div className="times-gap-item-bar"><span style={{ width: `${gapShare.above}%` }} /></div>
                </div>
                <div
                  className={`times-gap-item below filter-action ${interactiveFilters.gap === 'below' ? 'is-active-filter' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleInteractiveFilter('gap', 'below', 'all')}
                  onKeyDown={(event) => handleFilterKeyDown(event, () => toggleInteractiveFilter('gap', 'below', 'all'))}
                  aria-label="Filtrar por abaixo da meta"
                >
                  <div className="times-gap-item-main">
                    <span className="dot" style={{ background: 'var(--red)' }} />
                    <strong>Abaixo da meta</strong>
                    <em>{formatPercent(gapShare.below / 100)}</em>
                    <small>{formatCurrency(gapDistribution.below)}</small>
                  </div>
                  <div className="times-gap-item-bar"><span style={{ width: `${gapShare.below}%` }} /></div>
                </div>
              </div>
            </div>
          </article>
        </section>

        <section className="panel times-sheet-panel">
          <div className="panel-head">
            <div>
              <h3>Matriz de Assessores</h3>
              <p className="muted">Senioridade vem do Tags.xlsx e a meta padrao e aplicada automaticamente por nivel.</p>
            </div>
            <div className="panel-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={clearTimesSheetFilters}
                disabled={!timesSheetQuery && !timesSheetSeniorities.length}
              >
                Limpar filtros tabela
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={restoreAllTimesSheetTeams}
                disabled={!timesSheetExcludedTeamLabels.length}
              >
                Restaurar blocos
              </button>
            </div>
          </div>
          <div className="times-sheet-filter-grid">
            <div className="search-pill times-sheet-search">
              <Icon name="search" size={16} />
              <input
                type="search"
                placeholder="Buscar assessor ou equipe"
                value={timesSheetQuery}
                onChange={(event) => setTimesSheetQuery(event.target.value)}
              />
            </div>
            <MultiSelect
              value={timesSheetSeniorities}
              options={timesSheetSeniorityOptions}
              onChange={setTimesSheetSeniorities}
              placeholder="Filtrar senioridade"
              className="times-sheet-seniority-filter"
            />
            <div className="times-sheet-count muted">
              {matrixFilteredRows.length} de {matrixRowsForTable.length} assessores
              {timesSheetExcludedTeamLabels.length ? ` • ${timesSheetExcludedTeamLabels.length} time(s) removido(s)` : ''}
            </div>
          </div>
          {timesSheetExcludedTeamLabels.length ? (
            <div className="times-sheet-hidden-bar">
              <span className="muted">Times removidos dos blocos:</span>
              <div className="times-sheet-hidden-list">
                {timesSheetExcludedTeamLabels.map((team) => (
                  <button
                    key={`restore-team-${team}`}
                    className="times-sheet-hidden-chip"
                    type="button"
                    onClick={() => restoreTimesSheetTeam(team)}
                  >
                    {team} ×
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="times-sheet-wrap">
            <table className="times-sheet">
              <thead>
                <tr>
                  <th>Equipe</th>
                  <th>Senioridade</th>
                  <th>Assessor</th>
                  <th>Receita Bovespa</th>
                  <th>Receita Estruturadas</th>
                  <th>Receita Liquida Total</th>
                  <th>Objetivo</th>
                  <th>% Ating.</th>
                  <th>GAP Objetivo</th>
                </tr>
              </thead>
              <tbody>
                {matrixGroupedRowsByTeam.length ? matrixGroupedRowsByTeam.map((group, groupIndex) => {
                  const isLastGroup = groupIndex === (matrixGroupedRowsByTeam.length - 1)
                  return (
                    <Fragment key={group.team}>
                    <tr key={`${group.team}-header`} className="times-sheet-team-header">
                      <td colSpan={9}>
                        <div className="times-sheet-team-head">
                          <div className="times-sheet-team-head-copy">
                            <strong>{group.team}</strong>
                            <span>{group.rows.length} assessor(es)</span>
                          </div>
                          <button
                            className="btn btn-secondary times-sheet-team-remove-btn"
                            type="button"
                            onClick={() => hideTimesSheetTeam(group.team)}
                          >
                            Remover bloco
                          </button>
                        </div>
                      </td>
                    </tr>
                    {group.rows.map((row) => {
                      const positiveGap = row.gap >= 0
                      return (
                        <tr key={row.id}>
                          <td>
                            <select
                              className="times-cell-select"
                              value={row.team}
                              onChange={(event) => updateAssessorProfile(row.profileKey, { team: event.target.value })}
                              aria-label={`Time de ${row.assessor}`}
                            >
                              {teamOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                              {!teamOptions.some((o) => o.value === row.team) && row.team ? (
                                <option value={row.team}>{row.team}</option>
                              ) : null}
                            </select>
                          </td>
                          <td>
                            <select
                              className="times-cell-select"
                              value={row.seniority}
                              onChange={(event) => updateAssessorProfile(row.profileKey, { seniority: event.target.value })}
                              aria-label={`Senioridade de ${row.assessor}`}
                            >
                              {SENIORITY_OPTIONS.map((option) => (
                                <option key={option || 'none'} value={option}>{option || 'Selecionar'}</option>
                              ))}
                            </select>
                          </td>
                          <td>{row.assessor}</td>
                          <td>{formatCurrency(row.bovespa)}</td>
                          <td>{formatCurrency(row.estruturadas)}</td>
                          <td className="times-cell-strong">{formatCurrency(row.total)}</td>
                          <td>
                            <input
                              className="times-cell-input"
                              type="text"
                              inputMode="decimal"
                              placeholder="Ex: 12500"
                              value={row.goalRaw}
                              onChange={(event) => updateAssessorGoal(row.profileKey, event.target.value)}
                              aria-label={`Objetivo de ${row.assessor}`}
                            />
                          </td>
                          <td className={row.attainment != null && row.attainment >= 1 ? 'times-cell-positive' : 'times-cell-negative'}>{formatPercent(row.attainment)}</td>
                          <td className={positiveGap ? 'times-cell-positive' : 'times-cell-negative'}>{formatSignedCurrency(row.gap)}</td>
                        </tr>
                      )
                    })}
                    <tr key={`${group.team}-total`} className="times-sheet-team-total">
                      <td colSpan={3}>Total do time</td>
                      <td>{formatCurrency(group.totals.bovespa)}</td>
                      <td>{formatCurrency(group.totals.estruturadas)}</td>
                      <td className="times-cell-strong">{formatCurrency(group.totals.total)}</td>
                      <td>{formatCurrency(group.totals.goal)}</td>
                      <td className={group.totals.attainment != null && group.totals.attainment >= 1 ? 'times-cell-positive' : 'times-cell-negative'}>{formatPercent(group.totals.attainment)}</td>
                      <td className={group.totals.gap >= 0 ? 'times-cell-positive' : 'times-cell-negative'}>{formatSignedCurrency(group.totals.gap)}</td>
                    </tr>
                    {!isLastGroup ? (
                      <tr className="times-sheet-team-gap" aria-hidden="true">
                        <td colSpan={9} />
                      </tr>
                    ) : null}
                  </Fragment>
                  )
                }) : (
                  <tr>
                    <td className="times-sheet-empty" colSpan={9}>Nenhum assessor encontrado com os filtros aplicados.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader
        title={activeTab === TAB_TIMES ? 'Times' : 'Tags e Vinculos'}
        subtitle={activeTab === TAB_TIMES
          ? 'Painel por equipe com metas e senioridade por assessor.'
          : 'Hierarquia Conta -> Assessor -> Broker com visibilidade total.'}
        meta={activeTab === TAB_TIMES ? timesMeta : tagsMeta}
        actions={headerActions}
      />

      <SyncPanel
        label="Sincronizacao de Vinculos"
        helper="Importe o Tags.xlsx para atualizar as tags reais (incluindo colunas Time, Unidade e Senioridade)."
        onSync={handleSync}
        running={running}
        result={result}
        accept=".xlsx,.xls"
        selectedFile={selectedFile || globalFolderMenu.resolvedFile}
        onSelectedFileChange={setSelectedFile}
        linkedFileOptions={directoryFilterOptions}
        linkedFileValue={globalFolderMenu.directoryValue}
        onLinkedFileChange={(value) => {
          setSelectedFile(null)
          globalFolderMenu.onDirectoryChange(value)
        }}
        linkedFileLabel="Arquivo importado"
        linkedFileEmptyMessage={directoryOptionsEmptyMessage}
        hideLocalPicker
      />

      {activeTab === TAB_TIMES ? renderTimesView() : renderTagsView()}
    </div>
  )
}

export default Tags
