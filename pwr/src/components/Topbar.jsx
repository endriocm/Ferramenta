import { memo, useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'
import MultiSelect from './MultiSelect'
import SelectMenu from './SelectMenu'
import Modal from './Modal'
import { quickActions } from '../data/navigation'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { useHubxp } from '../contexts/HubxpContext'
import { useOutlook } from '../contexts/OutlookContext'
import { useToast } from '../hooks/useToast'
import { auth, db } from '../firebase'
import { EmailAuthProvider, linkWithCredential, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { getCurrentUserKey, invalidateUserKeyCache } from '../services/currentUser'
import { clearTags } from '../services/tags'
import { clearLastImported } from '../services/vencimentoCache'
import { clearLink } from '../services/vencimentoLink'
import { BARRIER_HIT_EVENT, listBarrierHitNotifications } from '../services/barrierHitStore'
import {
  ALARM_NOTIFICATION_EVENT,
  listAlarmNotifications,
  openRightToolPanel,
  RIGHT_TOOL_ALARMS_ID,
} from '../services/alarmNotifications'
import { listXpMonths, loadXpOverrideState, loadXpRevenue, setXpOverrideEnabled } from '../services/revenueXpCommission'
import {
  GLOBAL_FOLDER_EVENT,
  clearGlobalFolderLink,
  emitGlobalFolderUpdated,
  getGlobalFolderLabel,
  loadGlobalFolderLink,
  saveGlobalFolderLink,
} from '../services/globalFolderLink'
import {
  applyThemePalette,
  listThemePalettes,
  loadThemePalette,
  resolveThemePalette,
  saveThemePalette,
} from '../services/themePalette'
import {
  IMPORT_CATALOG_EVENT,
  loadImportCatalog,
  saveImportCatalog,
} from '../services/importCatalog'

const readNotificationSeenSeq = (storageKey) => {
  if (!storageKey || typeof window === 'undefined') return 0
  try {
    const raw = window.localStorage.getItem(storageKey)
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  } catch {
    return 0
  }
}

const writeNotificationSeenSeq = (storageKey, seq) => {
  if (!storageKey || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, String(Math.max(0, Number(seq) || 0)))
  } catch {
    // noop
  }
}

const formatNotificationTime = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const Topbar = ({ title, breadcrumbs, onToggleSidebar, currentPath, user }) => {
  const { notify } = useToast()
  const actions = quickActions[currentPath] || []
  const hubxp = useHubxp()
  const outlook = useOutlook()
  const {
    selectedBroker,
    setSelectedBroker,
    brokerOptions,
    selectedAssessor,
    setSelectedAssessor,
    assessorOptions,
    apuracaoMonths,
    setApuracaoMonths,
    apuracaoOptions,
    setClientCodeFilter,
  } = useGlobalFilters()

  const [menuOpen, setMenuOpen] = useState(false)
  const [logoutStatus, setLogoutStatus] = useState('idle')
  const [logoutError, setLogoutError] = useState('')
  const [senhaModalOpen, setSenhaModalOpen] = useState(false)
  const [novaSenha, setNovaSenha] = useState('')
  const [confirmarSenha, setConfirmarSenha] = useState('')
  const [senhaErro, setSenhaErro] = useState('')
  const [senhaStatus, setSenhaStatus] = useState('')
  const [salvandoSenha, setSalvandoSenha] = useState(false)
  const [hubxpModalOpen, setHubxpModalOpen] = useState(false)
  const [outlookModalOpen, setOutlookModalOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [notificationSeenSeq, setNotificationSeenSeq] = useState(0)
  const [barrierNotifications, setBarrierNotifications] = useState([])
  const [alarmNotifications, setAlarmNotifications] = useState([])
  const [activeBarrierAlarm, setActiveBarrierAlarm] = useState(null)
  const [activeAlarmOverlay, setActiveAlarmOverlay] = useState(null)
  const alarmOverlayTimerRef = useRef(null)
  const alarmOverlayTimer2Ref = useRef(null)
  const seenBarrierIdsRef = useRef(new Set())
  const seenAlarmIdsRef = useRef(new Set())
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const notificationTriggerRef = useRef(null)
  const notificationMenuRef = useRef(null)
  const lastMenuState = useRef(false)

  const currentUser = auth.currentUser || user
  const userEmail = currentUser?.email || ''
  const displayName = currentUser?.displayName || (userEmail ? userEmail.split('@')[0] : 'Usuario')
  const displaySub = userEmail || 'Conta ativa'
  const hasPasswordProvider = !!currentUser?.providerData?.some((provider) => provider?.providerId === 'password')
  const canCreatePassword = !!currentUser && !hasPasswordProvider

  const initials = useMemo(() => {
    const source = (displayName || userEmail || 'U').trim()
    if (!source) return 'U'
    const clean = source.includes('@') ? source.split('@')[0] : source
    const parts = clean.split(/\s+/).filter(Boolean)
    if (!parts.length) return 'U'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  }, [displayName, userEmail])

  const isLogoutLoading = logoutStatus === 'loading'
  const isSavingPassword = salvandoSenha

  const APURACAO_ALL = '__ALL__'
  const apuracaoValue = apuracaoMonths.all ? [APURACAO_ALL] : apuracaoMonths.months
  const apuracaoItems = [{ value: APURACAO_ALL, label: 'Todos' }, ...apuracaoOptions]
  const showApuracaoFilter = currentPath === '/' || currentPath === '/times' || currentPath === '/tags'
  const showXpOverrideControl = currentPath.startsWith('/receita')
  const [xpOverrideEnabled, setXpOverrideState] = useState(() => loadXpOverrideState().enabled)
  const [xpMonthCount, setXpMonthCount] = useState(() => listXpMonths(loadXpRevenue()).length)
  const [globalFolderLink, setGlobalFolderLink] = useState(null)
  const [globalFolderBusy, setGlobalFolderBusy] = useState(false)
  const [importRescanBusy, setImportRescanBusy] = useState(false)
  const [importCatalogRootPath, setImportCatalogRootPath] = useState(null)
  const currentUserKey = getCurrentUserKey()
  const themePaletteOptions = useMemo(
    () => listThemePalettes().map((item) => ({
      value: item.id,
      label: item.label,
      dotColor: item?.colors?.cyan || item?.colors?.amber || item?.colors?.blue || '#7ad1ff',
    })),
    [],
  )
  const [themePaletteId, setThemePaletteId] = useState(() => loadThemePalette(currentUserKey))
  const _globalFolderLabel = useMemo(() => getGlobalFolderLabel(globalFolderLink), [globalFolderLink])

  const hubxpStatus = hubxp.job?.status || 'DISCONNECTED'
  const hubxpStatusLabel = (() => {
    if (hubxpStatus === 'DISCONNECTED') return 'Desconectado'
    if (hubxpStatus === 'CREATED') return 'Pronto'
    if (hubxpStatus === 'STARTING') return 'Autenticando'
    if (hubxpStatus === 'OTP_REQUIRED') return 'OTP necessario'
    if (hubxpStatus === 'AUTHENTICATED') return 'Logado'
    if (hubxpStatus === 'COLLECTING') return 'Em execucao'
    if (hubxpStatus === 'SUCCESS') return 'Logado'
    if (hubxpStatus === 'FAILED') return 'Falha'
    if (hubxpStatus === 'CLEANED') return 'Encerrado'
    return hubxpStatus
  })()

  const hubxpTone = hubxp.isAuthenticated ? 'text-positive' : (hubxpStatus === 'FAILED' ? 'text-negative' : '')
  const hubxpLastLogs = useMemo(() => {
    if (!Array.isArray(hubxp.job?.logs)) return []
    return [...hubxp.job.logs].slice(-6).reverse()
  }, [hubxp.job?.logs])

  const outlookStatus = outlook.job?.status || 'DISCONNECTED'
  const outlookStatusLabel = (() => {
    if (outlookStatus === 'DISCONNECTED') return 'Desconectado'
    if (outlookStatus === 'CREATED') return 'Pronto'
    if (outlookStatus === 'STARTING') return 'Autenticando'
    if (outlookStatus === 'AUTHENTICATED') return 'Logado'
    if (outlookStatus === 'MONITORING') return 'Monitorando'
    if (outlookStatus === 'SENDING') return 'Enviando'
    if (outlookStatus === 'FAILED') return 'Falha'
    if (outlookStatus === 'CLEANED') return 'Encerrado'
    return outlookStatus
  })()
  const outlookTone = outlook.isAuthenticated ? 'text-positive' : (outlookStatus === 'FAILED' ? 'text-negative' : '')
  const outlookLastLogs = useMemo(() => {
    if (!Array.isArray(outlook.job?.logs)) return []
    return [...outlook.job.logs].slice(-6).reverse()
  }, [outlook.job?.logs])

  const notificationStorageKey = useMemo(
    () => `pwr.topbar.notification_seen_seq.${currentUserKey || outlook.userKey || 'guest'}`,
    [currentUserKey, outlook.userKey],
  )

  const emailNotifications = useMemo(() => {
    if (!Array.isArray(outlook.events)) return []
    return [...outlook.events]
      .filter((item) => item?.type === 'message_match')
      .slice(-30)
      .reverse()
  }, [outlook.events])

  const emailNotificationItems = useMemo(() => (
    emailNotifications.map((item) => ({
      id: String(item?.messageId || item?.at || item?.seq || Math.random()),
      type: 'email',
      sender: item?.sender || 'Sem remetente',
      subject: item?.subject || 'Sem assunto',
      at: item?.at,
      seq: Number(item?.seq || 0),
    }))
  ), [emailNotifications])

  const allNotifications = useMemo(() => {
    const merged = [...barrierNotifications, ...alarmNotifications, ...emailNotificationItems]
      .filter((item) => Number(item?.seq || 0) > 0)
      .sort((left, right) => Number(right?.seq || 0) - Number(left?.seq || 0))
    return merged.slice(0, 60)
  }, [alarmNotifications, barrierNotifications, emailNotificationItems])

  const latestNotificationSeq = useMemo(() => (
    allNotifications.reduce((max, item) => Math.max(max, Number(item?.seq || 0)), 0)
  ), [allNotifications])

  const unreadNotificationCount = useMemo(() => (
    allNotifications.reduce((count, item) => (
      Number(item?.seq || 0) > notificationSeenSeq ? count + 1 : count
    ), 0)
  ), [allNotifications, notificationSeenSeq])

  const markNotificationsRead = () => {
    if (!latestNotificationSeq) return
    setNotificationSeenSeq((prev) => Math.max(prev, latestNotificationSeq))
  }

  const handleApuracaoChange = (values) => {
    const selected = Array.isArray(values) ? values : []
    if (!selected.length) {
      setApuracaoMonths({ all: true, months: [] })
      return
    }
    if (selected.includes(APURACAO_ALL)) {
      const monthsOnly = selected.filter((item) => item !== APURACAO_ALL)
      if (monthsOnly.length) {
        setApuracaoMonths({ all: false, months: monthsOnly })
        return
      }
      setApuracaoMonths({ all: true, months: [] })
      return
    }
    setApuracaoMonths({ all: false, months: selected })
  }

  const logAuthEvent = (payload) => {
    if (!import.meta.env.DEV) return
    console.log('[auth]', payload)
  }

  useEffect(() => {
    if (!currentUser?.uid) {
      setIsAdmin(false)
      return undefined
    }

    const userRef = doc(db, 'users', currentUser.uid)
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        setIsAdmin(snap.exists() && snap.data()?.isAdmin === true)
      },
      () => {
        setIsAdmin(false)
      },
    )

    return () => unsub()
  }, [currentUser?.uid])

  const closeMenu = () => setMenuOpen(false)

  useEffect(() => {
    if (!menuOpen && !notificationsOpen) return

    const handleOutside = (event) => {
      const target = event.target
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      if (notificationMenuRef.current?.contains(target) || notificationTriggerRef.current?.contains(target)) return
      closeMenu()
      setNotificationsOpen(false)
    }

    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        setNotificationsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('touchstart', handleOutside)
    document.addEventListener('keydown', handleKey)

    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('touchstart', handleOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen, notificationsOpen])

  useEffect(() => {
    if (menuOpen) {
      setLogoutError('')
      setTimeout(() => {
        const firstItem = menuRef.current?.querySelector('[data-menu-item]')
        if (firstItem && typeof firstItem.focus === 'function') firstItem.focus()
      }, 0)
    }
  }, [menuOpen])

  useEffect(() => {
    if (lastMenuState.current && !menuOpen) {
      triggerRef.current?.focus()
    }
    lastMenuState.current = menuOpen
  }, [menuOpen])

  useEffect(() => {
    setMenuOpen(false)
    setNotificationsOpen(false)
  }, [currentPath])

  useEffect(() => {
    const refreshXpOverride = () => {
      setXpOverrideState(loadXpOverrideState().enabled)
      setXpMonthCount(listXpMonths(loadXpRevenue()).length)
    }
    refreshXpOverride()
    window.addEventListener('pwr:receita-updated', refreshXpOverride)
    return () => window.removeEventListener('pwr:receita-updated', refreshXpOverride)
  }, [])

  useEffect(() => {
    const stored = loadThemePalette(currentUserKey)
    setThemePaletteId(stored)
    applyThemePalette(stored)
  }, [currentUserKey])

  useEffect(() => {
    let active = true
    if (!currentUserKey) {
      setGlobalFolderLink(null)
      return () => {
        active = false
      }
    }
    void loadGlobalFolderLink(currentUserKey).then((link) => {
      if (!active) return
      setGlobalFolderLink(link || null)
    })
    return () => {
      active = false
    }
  }, [currentUserKey])

  useEffect(() => {
    const handleGlobalFolderUpdated = (event) => {
      const detailUserKey = event?.detail?.userKey
      if (detailUserKey && detailUserKey !== currentUserKey) return
      void loadGlobalFolderLink(currentUserKey).then((link) => {
        setGlobalFolderLink(link || null)
      })
    }
    window.addEventListener(GLOBAL_FOLDER_EVENT, handleGlobalFolderUpdated)
    return () => window.removeEventListener(GLOBAL_FOLDER_EVENT, handleGlobalFolderUpdated)
  }, [currentUserKey])

  useEffect(() => {
    const refreshRootPath = () => {
      const catalog = loadImportCatalog(currentUserKey)
      setImportCatalogRootPath(String(catalog?.rootPath || '').trim() || null)
    }
    refreshRootPath()
    window.addEventListener(IMPORT_CATALOG_EVENT, refreshRootPath)
    return () => window.removeEventListener(IMPORT_CATALOG_EVENT, refreshRootPath)
  }, [currentUserKey])

  const handleGlobalRescan = async () => {
    if (importRescanBusy) return
    const scanFn = window?.electronAPI?.scanImportFolder
    if (!currentUserKey || !importCatalogRootPath || typeof scanFn !== 'function') {
      notify('Nenhuma pasta de importacao disponivel para reimportar.', 'warning')
      return
    }
    setImportRescanBusy(true)
    try {
      const catalog = loadImportCatalog(currentUserKey)
      const files = await scanFn(importCatalogRootPath)
      const saved = saveImportCatalog(currentUserKey, {
        rootPath: importCatalogRootPath,
        rootName: catalog?.rootName,
        scannedAt: Date.now(),
        files,
      })
      notify(`Reimportacao concluida. ${saved?.fileCount || 0} planilha(s) catalogada(s).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao reimportar: ${error.message}` : 'Falha ao reimportar pasta.', 'warning')
    } finally {
      setImportRescanBusy(false)
    }
  }

  useEffect(() => {
    const refreshBarrierNotifications = () => {
      setBarrierNotifications(listBarrierHitNotifications(currentUserKey))
    }
    refreshBarrierNotifications()

    const handleBarrierEvent = (event) => {
      const detailUserKey = String(event?.detail?.userKey || '').trim()
      if (detailUserKey && detailUserKey !== currentUserKey) return
      refreshBarrierNotifications()
    }

    const handleStorage = (event) => {
      if (!event?.key || !event.key.startsWith('pwr.barrier-hit.state.')) return
      refreshBarrierNotifications()
    }

    window.addEventListener(BARRIER_HIT_EVENT, handleBarrierEvent)
    window.addEventListener('storage', handleStorage)
    window.addEventListener('focus', refreshBarrierNotifications)
    return () => {
      window.removeEventListener(BARRIER_HIT_EVENT, handleBarrierEvent)
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('focus', refreshBarrierNotifications)
    }
  }, [currentUserKey])

  useEffect(() => {
    if (!barrierNotifications.length) return
    const newHit = barrierNotifications.find((n) => !seenBarrierIdsRef.current.has(n.id))
    barrierNotifications.forEach((n) => seenBarrierIdsRef.current.add(n.id))
    if (!newHit) return
    setActiveBarrierAlarm(newHit)
    if (alarmOverlayTimerRef.current) clearTimeout(alarmOverlayTimerRef.current)
    alarmOverlayTimerRef.current = setTimeout(() => {
      setActiveBarrierAlarm(null)
      alarmOverlayTimerRef.current = null
    }, 10000)
  }, [barrierNotifications])

  useEffect(() => {
    if (!alarmNotifications.length) return
    const newAlarm = alarmNotifications.find((n) => !seenAlarmIdsRef.current.has(n.id))
    alarmNotifications.forEach((n) => seenAlarmIdsRef.current.add(n.id))
    if (!newAlarm) return
    setActiveAlarmOverlay(newAlarm)
    if (alarmOverlayTimer2Ref.current) clearTimeout(alarmOverlayTimer2Ref.current)
    alarmOverlayTimer2Ref.current = setTimeout(() => {
      setActiveAlarmOverlay(null)
      alarmOverlayTimer2Ref.current = null
    }, 10000)
  }, [alarmNotifications])

  useEffect(() => () => {
    if (alarmOverlayTimerRef.current) clearTimeout(alarmOverlayTimerRef.current)
    if (alarmOverlayTimer2Ref.current) clearTimeout(alarmOverlayTimer2Ref.current)
  }, [])

  useEffect(() => {
    const refreshAlarmNotifications = () => {
      setAlarmNotifications(listAlarmNotifications(currentUserKey))
    }
    refreshAlarmNotifications()

    const handleAlarmEvent = (event) => {
      const detailUserKey = String(event?.detail?.userKey || '').trim()
      if (detailUserKey && detailUserKey !== currentUserKey) return
      refreshAlarmNotifications()
    }

    const handleStorage = (event) => {
      if (!event?.key || !event.key.startsWith('pwr.alarm.notifications.')) return
      refreshAlarmNotifications()
    }

    window.addEventListener(ALARM_NOTIFICATION_EVENT, handleAlarmEvent)
    window.addEventListener('storage', handleStorage)
    window.addEventListener('focus', refreshAlarmNotifications)
    return () => {
      window.removeEventListener(ALARM_NOTIFICATION_EVENT, handleAlarmEvent)
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('focus', refreshAlarmNotifications)
    }
  }, [currentUserKey])

  useEffect(() => {
    setNotificationsOpen(false)
    setNotificationSeenSeq(readNotificationSeenSeq(notificationStorageKey))
  }, [notificationStorageKey])

  useEffect(() => {
    writeNotificationSeenSeq(notificationStorageKey, notificationSeenSeq)
  }, [notificationSeenSeq, notificationStorageKey])

  useEffect(() => {
    if (!notificationsOpen || !latestNotificationSeq) return
    setNotificationSeenSeq((prev) => Math.max(prev, latestNotificationSeq))
  }, [latestNotificationSeq, notificationsOpen])

  const resetLocalState = () => {
    setSelectedBroker([])
    setSelectedAssessor([])
    setClientCodeFilter([])
    setApuracaoMonths({ all: true, months: [] })
  }

  const _handleBindGlobalFolder = async () => {
    if (!currentUserKey || globalFolderBusy) return
    setGlobalFolderBusy(true)
    try {
      if (window?.electronAPI?.config?.selectWorkDir) {
        const selected = await window.electronAPI.config.selectWorkDir()
        const folderPath = selected?.workDir
        if (!folderPath) {
          notify('Selecao de pasta global cancelada.', 'warning')
          return
        }
        const saved = await saveGlobalFolderLink(currentUserKey, {
          source: 'electron',
          folderPath,
        })
        setGlobalFolderLink(saved)
        emitGlobalFolderUpdated(currentUserKey, { link: saved })
        notify('Pasta global vinculada.', 'success')
        return
      }

      if (window?.electronAPI?.selectFolder) {
        const meta = await window.electronAPI.selectFolder()
        if (!meta?.folderPath) {
          notify('Selecao de pasta global cancelada.', 'warning')
          return
        }
        const saved = await saveGlobalFolderLink(currentUserKey, {
          source: 'electron',
          folderPath: meta.folderPath,
        })
        setGlobalFolderLink(saved)
        emitGlobalFolderUpdated(currentUserKey, { link: saved })
        notify('Pasta global vinculada.', 'success')
        return
      }

      if ('showDirectoryPicker' in window) {
        const handle = await window.showDirectoryPicker()
        const saved = await saveGlobalFolderLink(currentUserKey, {
          source: 'browser',
          handle,
          folderName: handle?.name || null,
        })
        setGlobalFolderLink(saved)
        emitGlobalFolderUpdated(currentUserKey, { link: saved })
        notify('Pasta global vinculada.', 'success')
        return
      }

      notify('Vinculo global indisponivel neste ambiente.', 'warning')
    } catch {
      notify('Falha ao vincular a pasta global.', 'warning')
    } finally {
      setGlobalFolderBusy(false)
    }
  }

  const _handleClearGlobalFolder = async () => {
    if (!currentUserKey || globalFolderBusy) return
    setGlobalFolderBusy(true)
    try {
      await clearGlobalFolderLink(currentUserKey)
      setGlobalFolderLink(null)
      emitGlobalFolderUpdated(currentUserKey, { link: null })
      notify('Pasta global desvinculada.', 'success')
    } catch {
      notify('Falha ao desvincular a pasta global.', 'warning')
    } finally {
      setGlobalFolderBusy(false)
    }
  }

  const handleThemePaletteChange = (nextPaletteId) => {
    const stored = saveThemePalette(currentUserKey, nextPaletteId)
    setThemePaletteId(stored)
    applyThemePalette(stored)
    const palette = resolveThemePalette(stored)
    notify(`Paleta aplicada: ${palette.label}.`, 'success')
  }

  const clearUserCaches = async (userKey) => {
    if (!userKey || typeof window === 'undefined') return

    const prefixes = [
      'pwr.filters.',
      'pwr.vencimento.overrides.',
      'pwr.vencimento.cache.',
      'pwr.vencimento.link.',
      'pwr.vencimento.reportDate.',
      'pwr.global.folder.',
      'pwr.import.catalog.',
      'pwr.import.bindings.',
      'pwr.dashboard.goals.',
      'pwr.theme.palette.',
    ]

    try {
      const keys = Object.keys(localStorage)
      keys.forEach((key) => {
        const shouldRemove = prefixes.some((prefix) => key.startsWith(prefix) && key.includes(userKey))
        if (shouldRemove) {
          localStorage.removeItem(key)
        }
      })
      localStorage.removeItem('pwr.filters.broadcast')
      localStorage.removeItem('pwr.vencimento.broadcast')
      localStorage.removeItem('pwr.userKey')
      localStorage.removeItem('pwr.user')
      localStorage.removeItem('pwr.currentUser')
    } catch {
      // noop
    }

    await clearTags(userKey)
    clearLastImported(userKey)
    await clearLink(userKey)
    await clearGlobalFolderLink(userKey)
  }

  const handleLogout = async () => {
    if (isLogoutLoading) return

    logAuthEvent({ event: 'logout_click' })
    setLogoutError('')
    setLogoutStatus('loading')

    const userKey = getCurrentUserKey()

    try {
      await signOut(auth)
      invalidateUserKeyCache()
      resetLocalState()
      await clearUserCaches(userKey)
      logAuthEvent({ event: 'logout_success' })
      setLogoutStatus('idle')
      closeMenu()

      if (typeof window !== 'undefined') {
        const nextUrl = `${window.location.pathname}${window.location.search}#/`
        if (window.location.hash !== '#/') {
          window.location.replace(nextUrl)
        } else if (window.history?.replaceState) {
          window.history.replaceState(null, '', nextUrl)
        }
      }
    } catch (err) {
      logAuthEvent({ event: 'logout_error', code: err?.code || null })
      setLogoutStatus('error')
      setLogoutError('N�o foi poss�vel sair. Tenta de novo.')
    }
  }

  const handleOpenCriarSenha = () => {
    setSenhaModalOpen(true)
    setSenhaErro('')
    setSenhaStatus('')
    closeMenu()
  }

  const handleGoToAdmin = () => {
    closeMenu()
    if (typeof window !== 'undefined') {
      window.location.hash = '#/admin/access'
    }
  }

  const handleGoToAccess = () => {
    closeMenu()
    if (typeof window !== 'undefined') {
      window.location.hash = '#/account/access'
    }
  }

  const handleCloseCriarSenha = () => {
    if (isSavingPassword) return
    setSenhaModalOpen(false)
    setNovaSenha('')
    setConfirmarSenha('')
    setSenhaErro('')
    setSenhaStatus('')
  }

  const handleSalvarSenha = async () => {
    if (isSavingPassword) return
    setSenhaErro('')
    setSenhaStatus('')

    if (!novaSenha || novaSenha.length < 6) {
      setSenhaErro('A senha precisa ter pelo menos 6 caracteres.')
      return
    }

    if (novaSenha !== confirmarSenha) {
      setSenhaErro('As senhas não conferem.')
      return
    }

    const email = auth.currentUser?.email
    if (!auth.currentUser || !email) {
      setSenhaErro('Usuário não autenticado.')
      return
    }

    setSalvandoSenha(true)
    try {
      const cred = EmailAuthProvider.credential(email, novaSenha)
      await linkWithCredential(auth.currentUser, cred)
      await auth.currentUser.reload()
      setSenhaStatus('Senha criada. Agora você pode entrar com e-mail e senha.')
      setNovaSenha('')
      setConfirmarSenha('')
    } catch (err) {
      if (err?.code === 'auth/requires-recent-login') {
        setSenhaErro('Faça login de novo com Google e tente novamente.')
      } else if (
        err?.code === 'auth/email-already-in-use' ||
        err?.code === 'auth/credential-already-in-use'
      ) {
        setSenhaErro('Este e-mail já tem senha em outra conta.')
      } else {
        setSenhaErro(err?.message ? String(err.message) : 'Não foi possível criar a senha.')
      }
    } finally {
      setSalvandoSenha(false)
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn ghost mobile-only" onClick={onToggleSidebar} aria-label="Abrir menu">
          <Icon name="menu" size={18} />
        </button>
        <div>
          <div className="breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`}>
                {crumb}
                {index < breadcrumbs.length - 1 ? <span className="crumb-sep">/</span> : null}
              </span>
            ))}
          </div>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="topbar-actions">
        {showApuracaoFilter ? (
          <MultiSelect
            value={apuracaoValue}
            options={apuracaoItems}
            onChange={handleApuracaoChange}
            placeholder="Mes de apuracao"
            className="topbar-filter"
            menuClassName="topbar-filter-menu"
            searchable={false}
          />
        ) : null}
        <MultiSelect
          value={selectedBroker}
          options={brokerOptions}
          onChange={setSelectedBroker}
          placeholder="Broker global"
          className="topbar-filter"
          menuClassName="topbar-filter-menu"
        />
        <MultiSelect
          value={selectedAssessor}
          options={assessorOptions}
          onChange={setSelectedAssessor}
          placeholder="Assessor global"
          className="topbar-filter"
          menuClassName="topbar-filter-menu"
        />
        <SelectMenu
          value={themePaletteId}
          options={themePaletteOptions}
          onChange={handleThemePaletteChange}
          placeholder="Paleta neon"
          className="topbar-filter"
          menuClassName="topbar-filter-menu"
          searchPlaceholder="Buscar paleta"
        />
        {showXpOverrideControl ? (
          <button
            className={`btn ${xpOverrideEnabled ? 'btn-primary' : 'btn-secondary'}`}
            type="button"
            onClick={async () => {
              await setXpOverrideEnabled(!xpOverrideEnabled)
              setXpOverrideState(!xpOverrideEnabled)
            }}
            title={xpMonthCount
              ? `Sobrepoe meses do arquivo XP (${xpMonthCount} mes(es)).`
              : 'Importe comissao XP para habilitar a sobreposicao.'}
            disabled={!xpMonthCount}
          >
            XP sobreposicao: {xpOverrideEnabled ? 'ON' : 'OFF'}
          </button>
        ) : null}
        {actions.length ? (
          <div className="action-group">
            {actions.map((action) => (
              <button key={action.label} className="btn btn-secondary" type="button">
                <Icon name={action.icon} size={16} />
                {action.label}
              </button>
            ))}
          </div>
        ) : null}

        {importCatalogRootPath ? (
          <button
            className="btn btn-secondary"
            type="button"
            onClick={handleGlobalRescan}
            disabled={importRescanBusy}
            title={`Reimportar: ${importCatalogRootPath}`}
          >
            <Icon name="sync" size={15} />
            {importRescanBusy ? 'Reimportando...' : 'Reimportar'}
          </button>
        ) : null}

        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => setHubxpModalOpen(true)}
          disabled={hubxp.busy}
          title={`HubXP: ${hubxpStatusLabel}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <svg width="18" height="18" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="6" fill="#1a1a2e" />
            <path d="M10 8h4v7h4V8h4v16h-4v-7h-4v7h-4V8z" fill="#fff" />
          </svg>
          HubXP
          <span className={`pill ${hubxpTone}`.trim()} style={{ marginLeft: 4 }}>{hubxpStatusLabel}</span>
        </button>

        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => setOutlookModalOpen(true)}
          disabled={outlook.busy}
          title={`Outlook: ${outlookStatusLabel}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <svg width="18" height="18" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="6" fill="#015a9c" />
            <path d="M8 9h7v14H8V9z" fill="#fff" />
            <path d="M16 10h8v12h-8V10z" fill="#fff" opacity="0.85" />
          </svg>
          Outlook
          <span className={`pill ${outlookTone}`.trim()} style={{ marginLeft: 4 }}>{outlookStatusLabel}</span>
        </button>

        <div className="notification-menu">
          <button
            ref={notificationTriggerRef}
            type="button"
            className="icon-btn notification-trigger"
            id="outlook-notifications-trigger"
            aria-haspopup="menu"
            aria-expanded={notificationsOpen}
            aria-controls="outlook-notifications-menu"
            onClick={() => {
              setNotificationsOpen((open) => {
                const next = !open
                if (next) {
                  setNotificationSeenSeq((prev) => Math.max(prev, latestNotificationSeq))
                  setMenuOpen(false)
                }
                return next
              })
            }}
            title={unreadNotificationCount ? `${unreadNotificationCount} notificacao(oes) nova(s)` : 'Notificacoes'}
          >
            <Icon name="bell" size={21} />
            {unreadNotificationCount ? (
              <span className="notification-badge" aria-label={`${unreadNotificationCount} notificacoes nao lidas`}>
                {unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}
              </span>
            ) : null}
          </button>

          {notificationsOpen ? (
            <div
              ref={notificationMenuRef}
              id="outlook-notifications-menu"
              className="notification-dropdown"
              role="menu"
              aria-labelledby="outlook-notifications-trigger"
            >
              <div className="notification-header">
                <strong>Notificacoes</strong>
                {allNotifications.length ? (
                  <button className="notification-clear-btn" type="button" onClick={markNotificationsRead}>
                    Marcar lidos
                  </button>
                ) : null}
              </div>

              {allNotifications.length ? (
                <div className="notification-list">
                  {allNotifications.map((item) => {
                    const seq = Number(item?.seq || 0)
                    const isUnread = seq > notificationSeenSeq
                    return (
                      <article
                        key={`${item.id || item.at || seq}-${seq}`}
                        className={`notification-item ${isUnread ? 'is-unread' : ''}`.trim()}
                      >
                        <div className="notification-item-head">
                          <span className="notification-sender">{item.sender || 'Sem remetente'}</span>
                          <time className="notification-time">{formatNotificationTime(item.at)}</time>
                        </div>
                        <p className="notification-subject">{item.subject || 'Sem assunto'}</p>
                      </article>
                    )
                  })}
                </div>
              ) : (
                <p className="notification-empty">Nenhuma notificacao recente.</p>
              )}

              <div className="account-menu-divider" />
              {alarmNotifications.length ? (
                <button
                  className="account-menu-item"
                  type="button"
                  onClick={() => {
                    setNotificationsOpen(false)
                    openRightToolPanel(RIGHT_TOOL_ALARMS_ID)
                  }}
                >
                  Abrir alarmes
                </button>
              ) : null}
              {barrierNotifications.length ? (
                <button
                  className="account-menu-item"
                  type="button"
                  onClick={() => {
                    setNotificationsOpen(false)
                    if (typeof window !== 'undefined') {
                      window.location.hash = '#/batimento-barreira'
                    }
                  }}
                >
                  Abrir batimento de barreira
                </button>
              ) : null}
              <button
                className="account-menu-item"
                type="button"
                onClick={() => {
                  setNotificationsOpen(false)
                  if (typeof window !== 'undefined') {
                    window.location.hash = '#/outlook'
                  }
                }}
              >
                Abrir Outlook
              </button>
            </div>
          ) : null}
        </div>

        <div className="account-menu">
          <button
            ref={triggerRef}
            type="button"
            className="user-chip account-trigger"
            id="account-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls="account-menu"
            onClick={() => {
              setNotificationsOpen(false)
              setMenuOpen((open) => !open)
            }}
          >
            <span className="avatar">{initials}</span>
            <div>
              <div className="user-name">{displayName}</div>
              <div className="user-role">{displaySub}</div>
            </div>
            <span className="account-chevron" aria-hidden="true">
              <Icon name={menuOpen ? 'arrow-up' : 'arrow-down'} size={16} />
            </span>
          </button>
          {menuOpen ? (
            <div
              ref={menuRef}
              id="account-menu"
              className="account-dropdown"
              role="menu"
              aria-labelledby="account-trigger"
            >
              <div className="account-menu-header">
                <span className="avatar avatar-sm">{initials}</span>
                <div>
                  <div className="account-menu-name">{displayName}</div>
                  {userEmail ? <div className="account-menu-email">{userEmail}</div> : null}
                </div>
              </div>
              <div className="account-menu-divider" />
              {isAdmin ? (
                <button
                  className="account-menu-item"
                  type="button"
                  data-menu-item
                  onClick={handleGoToAdmin}
                >
                  Admin
                </button>
              ) : null}
              <button
                className="account-menu-item"
                type="button"
                data-menu-item
                onClick={handleGoToAccess}
              >
                Meu Acesso
              </button>
              {canCreatePassword ? (
                <button
                  className="account-menu-item"
                  type="button"
                  data-menu-item
                  onClick={handleOpenCriarSenha}
                >
                  Criar senha
                </button>
              ) : null}
              <button
                className="account-menu-item"
                type="button"
                data-menu-item
                disabled={isLogoutLoading}
                onClick={handleLogout}
              >
                {isLogoutLoading ? 'Saindo...' : 'Sair'}
              </button>
              {logoutError ? (
                <div className="account-menu-error" role="alert" aria-live="polite">
                  {logoutError}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <Modal
        open={hubxpModalOpen}
        title="HubXP"
        subtitle="Abra o navegador do HubXP, faça login (e OTP se necessario). A sessao fica compartilhada entre Central de Ordens e Apuracao Bovespa."
        onClose={() => {
          if (hubxp.busy) return
          setHubxpModalOpen(false)
        }}
      >
        <section className="panel" style={{ margin: 0 }}>
          <div className="panel-head">
            <div>
              <h3>Sessao</h3>
              <p className="muted">Status: <span className={`pill ${hubxpTone}`.trim()}>{hubxpStatusLabel}</span></p>
              {hubxp.jobId ? <p className="muted">Job ID: <strong>{hubxp.jobId}</strong></p> : null}
            </div>
            <div className="panel-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={async () => {
                  try {
                    await hubxp.startSession({ headless: false, keepVisible: true })
                  } catch {
                    // erro aparece abaixo
                  }
                }}
                disabled={hubxp.busy}
              >
                <Icon name="sync" size={16} />
                {hubxp.busy ? 'Abrindo...' : 'Login Hub XP'}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={async () => {
                  try {
                    await hubxp.cleanupSession()
                    setHubxpModalOpen(false)
                  } catch {
                    // erro aparece abaixo
                  }
                }}
                disabled={!hubxp.jobId || hubxp.busy}
              >
                <Icon name="close" size={16} />
                Encerrar sessao
              </button>
            </div>
          </div>

          <div className="form-grid hubxp-form-grid" style={{ marginTop: 8 }}>
            <label>
              Usuario (e-mail)
              <input
                className="input"
                type="text"
                autoComplete="username"
                value={hubxp.credentials.username}
                onChange={(event) => hubxp.updateCredential('username', event.target.value)}
                placeholder="seu@email.com"
                disabled={hubxp.busy}
              />
            </label>
            <label>
              Senha
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={hubxp.credentials.password}
                onChange={(event) => hubxp.updateCredential('password', event.target.value)}
                placeholder="••••••••"
                disabled={hubxp.busy}
              />
            </label>
          </div>

          {hubxp.lastError ? (
            <div className="sync-warnings" style={{ marginTop: 12 }}>
              <strong>ERRO</strong>
              {hubxp.lastError?.message || 'Falha ao conectar no HubXP.'}
            </div>
          ) : null}

          {hubxpLastLogs.length ? (
            <div className="hubxp-log-list" style={{ marginTop: 12 }}>
              {hubxpLastLogs.map((entry, index) => (
                <div key={`${entry.at}-${index}`} className="hubxp-log-item">
                  <small>{entry.at}</small>
                  <strong>{entry.stage}</strong>
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </Modal>

      <Modal
        open={outlookModalOpen}
        title="Outlook"
        subtitle="Login web do Outlook para monitorar inbox e disparar envios."
        onClose={() => {
          if (outlook.busy) return
          setOutlookModalOpen(false)
        }}
      >
        <section className="panel" style={{ margin: 0 }}>
          <div className="panel-head">
            <div>
              <h3>Sessao</h3>
              <p className="muted">Status: <span className={`pill ${outlookTone}`.trim()}>{outlookStatusLabel}</span></p>
              {outlook.jobId ? <p className="muted">Job ID: <strong>{outlook.jobId}</strong></p> : null}
            </div>
            <div className="panel-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={async () => {
                  try {
                    await outlook.startSession({ headless: false })
                  } catch {
                    // erro aparece abaixo
                  }
                }}
                disabled={outlook.busy}
              >
                <Icon name="sync" size={16} />
                {outlook.busy ? 'Abrindo...' : 'Login Outlook'}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={async () => {
                  try {
                    await outlook.cleanupSession()
                    setOutlookModalOpen(false)
                  } catch {
                    // erro aparece abaixo
                  }
                }}
                disabled={!outlook.jobId || outlook.busy}
              >
                <Icon name="close" size={16} />
                Encerrar sessao
              </button>
            </div>
          </div>

          <div className="form-grid hubxp-form-grid" style={{ marginTop: 8 }}>
            <label>
              Usuario (e-mail)
              <input
                className="input"
                type="text"
                autoComplete="username"
                value={outlook.credentials.username}
                onChange={(event) => outlook.updateCredential('username', event.target.value)}
                placeholder="seu@email.com"
                disabled={outlook.busy}
              />
            </label>
            <label>
              Senha
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={outlook.credentials.password}
                onChange={(event) => outlook.updateCredential('password', event.target.value)}
                placeholder="********"
                disabled={outlook.busy}
              />
            </label>
          </div>

          <div className="panel-actions" style={{ marginTop: 8 }}>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={async () => {
                try {
                  if (outlook.monitorEnabled) {
                    await outlook.stopMonitor()
                  } else {
                    await outlook.startMonitor({ intervalMs: outlook.monitorConfig.intervalMs })
                  }
                } catch {
                  // erro aparece abaixo
                }
              }}
              disabled={outlook.busy || !outlook.jobId}
            >
              <Icon name="sync" size={16} />
              {outlook.monitorEnabled ? 'Parar monitor' : 'Iniciar monitor'}
            </button>
          </div>

          {outlook.lastError ? (
            <div className="sync-warnings" style={{ marginTop: 12 }}>
              <strong>ERRO</strong>
              {outlook.lastError?.message || 'Falha ao conectar no Outlook.'}
            </div>
          ) : null}

          {outlookLastLogs.length ? (
            <div className="hubxp-log-list" style={{ marginTop: 12 }}>
              {outlookLastLogs.map((entry, index) => (
                <div key={`${entry.at}-${index}`} className="hubxp-log-item">
                  <small>{entry.at}</small>
                  <strong>{entry.stage}</strong>
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </Modal>

      {(activeAlarmOverlay || activeBarrierAlarm) ? (() => {
        const isAlarm = Boolean(activeAlarmOverlay)
        const overlay = activeAlarmOverlay || activeBarrierAlarm
        const borderColor = isAlarm ? 'var(--cyan, #7ad1ff)' : 'var(--color-negative, #e8394a)'
        const titleColor = isAlarm ? 'var(--cyan, #7ad1ff)' : 'var(--color-negative, #e8394a)'
        return (
          <div
            role="alert"
            aria-live="assertive"
            style={{
              position: 'fixed',
              top: 40,
              left: 40,
              zIndex: 2000,
              background: 'var(--color-card, #141820)',
              border: `2px solid ${borderColor}`,
              borderRadius: 14,
              padding: '28px 32px',
              maxWidth: 560,
              minWidth: 360,
              boxShadow: '0 12px 56px rgba(0,0,0,0.72)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 24, color: titleColor, display: 'block', marginBottom: 14, lineHeight: 1.3 }}>
                  {overlay.sender}
                </strong>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {String(overlay.subject || '').split(' | ').map((part, i) => (
                    <span key={i} style={{ fontSize: 19, lineHeight: 1.5, display: 'block' }}>{part}</span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (isAlarm) {
                    setActiveAlarmOverlay(null)
                    if (alarmOverlayTimer2Ref.current) {
                      clearTimeout(alarmOverlayTimer2Ref.current)
                      alarmOverlayTimer2Ref.current = null
                    }
                  } else {
                    setActiveBarrierAlarm(null)
                    if (alarmOverlayTimerRef.current) {
                      clearTimeout(alarmOverlayTimerRef.current)
                      alarmOverlayTimerRef.current = null
                    }
                  }
                }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, flexShrink: 0, opacity: 0.7, lineHeight: 1 }}
                aria-label="Fechar alarme"
              >
                <Icon name="close" size={22} />
              </button>
            </div>
          </div>
        )
      })() : null}

      {senhaModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="criar-senha-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 7, 10, 0.64)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1200,
          }}
        >
          <div className="panel" style={{ width: 'min(420px, 92vw)' }}>
            <div className="panel-head">
              <div>
                <h3 id="criar-senha-title">Criar senha</h3>
                <p className="muted">Defina uma senha para entrar com e-mail.</p>
              </div>
            </div>
            <div className="login-fields">
              <div className="login-field">
                <label className="login-label" htmlFor="nova-senha-modal">
                  Nova senha
                </label>
                <input
                  id="nova-senha-modal"
                  className="login-input"
                  type="password"
                  autoComplete="new-password"
                  value={novaSenha}
                  onChange={(event) => setNovaSenha(event.target.value)}
                  disabled={isSavingPassword}
                />
              </div>
              <div className="login-field">
                <label className="login-label" htmlFor="confirmar-senha-modal">
                  Confirmar senha
                </label>
                <input
                  id="confirmar-senha-modal"
                  className="login-input"
                  type="password"
                  autoComplete="new-password"
                  value={confirmarSenha}
                  onChange={(event) => setConfirmarSenha(event.target.value)}
                  disabled={isSavingPassword}
                />
              </div>
            </div>
            {senhaStatus ? (
              <div className="login-helper" role="status" aria-live="polite">
                {senhaStatus}
              </div>
            ) : null}
            {senhaErro ? (
              <div className="login-alert" role="alert" aria-live="polite">
                {senhaErro}
              </div>
            ) : null}
            <div className="panel-actions">
              <button className="btn btn-primary" type="button" onClick={handleSalvarSenha} disabled={isSavingPassword}>
                {isSavingPassword ? 'Salvando...' : 'Salvar senha'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={handleCloseCriarSenha} disabled={isSavingPassword}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  )
}

export default memo(Topbar)
