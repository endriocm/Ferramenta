import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { auth } from './firebase'
import { onAuthStateChanged } from 'firebase/auth'
import ToastProvider from './components/ToastProvider'
import { useHashRoute } from './hooks/useHashRoute'
import { routeTitles } from './data/navigation'
import { getRouteComponent, preloadRoute, preloadableRoutePaths, resolveRoutePath } from './routeRegistry'
import { GlobalFilterProvider } from './contexts/GlobalFilterContext'
import { HubxpProvider } from './contexts/HubxpContext'
import { OutlookProvider } from './contexts/OutlookContext'
import { invalidateUserKeyCache } from './services/currentUser'
import KeepAlive from './components/KeepAlive'

const Login = lazy(() => import('./Login'))
const AccessGate = lazy(() => import('./AccessGate'))
const Sidebar = lazy(() => import('./components/Sidebar'))
const RightToolRail = lazy(() => import('./components/RightToolRail'))
const Topbar = lazy(() => import('./components/Topbar'))

const crumbLookup = {
  receita: 'Receita',
  estruturadas: 'Estruturadas',
  bovespa: 'Bovespa',
  bmf: 'BMF',
  'comissao-xp': 'Comissao XP',
  manual: 'Manual',
  consolidado: 'Consolidado',
  vencimento: 'Vencimento',
  'batimento-barreira': 'Batimento de barreira',
  'projecao-vencimento': 'Projecao de vencimento',
  'historico-operacoes': 'Historico de operacoes',
  'clientes-operando': 'Clientes operando',
  gap: 'Gap',
  antecipacao: 'Antecipacao',
  'central-ordens': 'Central de Ordens',
  'apuracao-bovespa': 'Apuracao Bovespa',
  'calendario-resultados': 'Calendario de resultados',
  'calendario-proventos': 'Calendario de proventos',
  outlook: 'Outlook',
  tags: 'Tags e Vinculos',
  times: 'Times',
  cards: 'Cards',
  importacao: 'Importacao',
  account: 'Conta',
  access: 'Meu Acesso',
  admin: 'Admin',
}

const LoadingFallback = () => (
  <div className="page" style={{ minHeight: '60vh' }}>
    <div className="panel loading-fallback-panel">
      <h3>Carregando</h3>
      <p className="muted">Preparando painel...</p>
    </div>
  </div>
)

const resolveWelcomeName = (user) => {
  if (!user) return 'de volta'
  const display = String(user.displayName || '').trim()
  if (display) {
    return display.split(/\s+/).filter(Boolean)[0] || display
  }
  const email = String(user.email || '').trim()
  if (email.includes('@')) {
    return email.split('@')[0]
  }
  return 'de volta'
}

function App() {
  const [usuario, setUsuario] = useState(null)
  const [carregandoAuth, setCarregandoAuth] = useState(true)
  const [temAcesso, setTemAcesso] = useState(false)
  const [welcomeState, setWelcomeState] = useState({ visible: false, name: '', runId: 0 })
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem('pwr.sidebar.collapsed') === '1'
    } catch {
      return false
    }
  })
  const [isDesktopViewport, setIsDesktopViewport] = useState(() => (
    typeof window === 'undefined' ? true : window.innerWidth > 900
  ))
  const seenLoggedOutRef = useRef(false)
  const welcomeTimerRef = useRef(null)
  const routeWarmupHandleRef = useRef(null)
  const routeWarmupStartedRef = useRef(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      invalidateUserKeyCache()
      setUsuario(u || null)
      if (typeof window !== 'undefined') {
        try {
          if (u) {
            const normalizedEmail = String(u.email || '').trim().toLowerCase()
            const userKey = normalizedEmail ? `email:${normalizedEmail}` : `id:${String(u.uid || '').trim()}`
            if (userKey) {
              window.__PWR_USER_KEY__ = userKey
              window.__PWR_USER__ = {
                uid: String(u.uid || ''),
                email: String(u.email || ''),
                displayName: String(u.displayName || ''),
              }
              window.localStorage.setItem('pwr.userKey', userKey)
              window.localStorage.setItem('pwr.user', JSON.stringify(window.__PWR_USER__))
              window.localStorage.setItem('pwr.currentUser', JSON.stringify(window.__PWR_USER__))
            }
          } else {
            delete window.__PWR_USER_KEY__
            delete window.__PWR_USER__
            window.localStorage.removeItem('pwr.userKey')
            window.localStorage.removeItem('pwr.user')
            window.localStorage.removeItem('pwr.currentUser')
          }
        } catch {
          // noop
        }
      }
      if (!u) {
        setTemAcesso(false)
        setWelcomeState((prev) => ({ ...prev, visible: false }))
        seenLoggedOutRef.current = true
      }
      setCarregandoAuth(false)
    })
    return () => unsub()
  }, [])

  const handleAccessGranted = () => {
    setTemAcesso(true)
    if (!seenLoggedOutRef.current) return
    const nextName = resolveWelcomeName(usuario || auth.currentUser)
    setWelcomeState((prev) => ({
      visible: true,
      name: nextName,
      runId: prev.runId + 1,
    }))
    seenLoggedOutRef.current = false
  }

  useEffect(() => {
    if (!welcomeState.visible) return undefined
    if (welcomeTimerRef.current) clearTimeout(welcomeTimerRef.current)
    welcomeTimerRef.current = setTimeout(() => {
      setWelcomeState((prev) => ({ ...prev, visible: false }))
      welcomeTimerRef.current = null
    }, 1800)
    return () => {
      if (welcomeTimerRef.current) {
        clearTimeout(welcomeTimerRef.current)
        welcomeTimerRef.current = null
      }
    }
  }, [welcomeState.runId, welcomeState.visible])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleResize = () => {
      setIsDesktopViewport(window.innerWidth > 900)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem('pwr.sidebar.collapsed', desktopSidebarCollapsed ? '1' : '0')
    } catch {
      // noop
    }
  }, [desktopSidebarCollapsed])

  const { path, navigate } = useHashRoute('/')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const resolvedPath = resolveRoutePath(path)
  const CurrentPage = getRouteComponent(resolvedPath)
  const sidebarCollapsed = isDesktopViewport && desktopSidebarCollapsed
  const stableGetComponent = useCallback((p) => getRouteComponent(p), [])
  const providerScopeKey = useMemo(() => {
    const email = String(usuario?.email || '').trim().toLowerCase()
    if (email) return `email:${email}`
    const uid = String(usuario?.uid || '').trim()
    if (uid) return `id:${uid}`
    return 'guest'
  }, [usuario?.email, usuario?.uid])

  useEffect(() => {
    if (path !== resolvedPath) {
      navigate(resolvedPath)
    }
  }, [path, resolvedPath, navigate])

  useEffect(() => {
    if (!temAcesso || typeof window === 'undefined') {
      routeWarmupStartedRef.current = false
      if (routeWarmupHandleRef.current != null) {
        if (routeWarmupHandleRef.current.kind === 'timeout') window.clearTimeout(routeWarmupHandleRef.current.id)
        else if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(routeWarmupHandleRef.current.id)
        routeWarmupHandleRef.current = null
      }
      return undefined
    }
    if (routeWarmupStartedRef.current) return undefined

    routeWarmupStartedRef.current = true
    const queue = preloadableRoutePaths.filter((routePath) => routePath !== resolvedPath)
    let cancelled = false
    let index = 0

    const clearScheduled = () => {
      if (routeWarmupHandleRef.current == null) return
      if (routeWarmupHandleRef.current.kind === 'timeout') window.clearTimeout(routeWarmupHandleRef.current.id)
      else if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(routeWarmupHandleRef.current.id)
      routeWarmupHandleRef.current = null
    }

    const scheduleNext = () => {
      if (cancelled || index >= queue.length) {
        routeWarmupHandleRef.current = null
        return
      }

      const run = (deadline) => {
        if (cancelled) return
        const remaining = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : 24
        if (remaining < 8) {
          scheduleNext()
          return
        }
        preloadRoute(queue[index])
        index += 1
        scheduleNext()
      }

      if (typeof window.requestIdleCallback === 'function') {
        routeWarmupHandleRef.current = {
          kind: 'idle',
          id: window.requestIdleCallback(run, { timeout: 1200 }),
        }
        return
      }

      routeWarmupHandleRef.current = {
        kind: 'timeout',
        id: window.setTimeout(() => run({ timeRemaining: () => 24 }), 180),
      }
    }

    scheduleNext()

    return () => {
      cancelled = true
      clearScheduled()
    }
  }, [resolvedPath, temAcesso])

  const title = routeTitles[resolvedPath]
    || (resolvedPath === '/account/access' ? 'Meu Acesso' : null)
    || (resolvedPath === '/admin/access' ? 'Admin' : 'Painel')

  const breadcrumbs = useMemo(() => {
    if (resolvedPath === '/') return ['Dashboard']
    return resolvedPath
      .split('/')
      .filter(Boolean)
      .map((segment) => crumbLookup[segment] || segment)
  }, [resolvedPath])

  if (carregandoAuth) {
    return <div style={{ padding: 24 }}>Carregando...</div>
  }

  if (!usuario) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <Login />
      </Suspense>
    )
  }

  if (!temAcesso) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <AccessGate onAccessGranted={handleAccessGranted}>
          <Suspense fallback={<LoadingFallback />}>
            <div>
              <CurrentPage />
            </div>
          </Suspense>
        </AccessGate>
      </Suspense>
    )
  }

  return (
    <ToastProvider>
      <HubxpProvider key={providerScopeKey}>
        <OutlookProvider>
          <GlobalFilterProvider>
            <Suspense fallback={<LoadingFallback />}>
              <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`.trim()}>
                <Sidebar
                  currentPath={resolvedPath}
                  onNavigate={(targetPath) => {
                    if (targetPath) preloadRoute(targetPath)
                    setSidebarOpen(false)
                  }}
                  isOpen={sidebarOpen}
                  onClose={() => setSidebarOpen(false)}
                  isDesktopCollapsed={sidebarCollapsed}
                  onToggleDesktopCollapse={() => setDesktopSidebarCollapsed((previous) => !previous)}
                />
                <div className="app-main">
                  <Topbar
                    title={title}
                    breadcrumbs={breadcrumbs}
                    onToggleSidebar={() => setSidebarOpen(true)}
                    currentPath={resolvedPath}
                    user={usuario}
                  />
                  <main className="page-content">
                    <KeepAlive
                      currentPath={resolvedPath}
                      getComponent={stableGetComponent}
                      maxCached={6}
                      fallback={<LoadingFallback />}
                    />
                  </main>
                </div>
                <RightToolRail />
                {welcomeState.visible ? (
                  <div key={welcomeState.runId} className="welcome-overlay" aria-hidden="true">
                    <div className="welcome-card">
                      <small>PWR</small>
                      <strong>Bem-vindo, {welcomeState.name}</strong>
                    </div>
                  </div>
                ) : null}
              </div>
            </Suspense>
          </GlobalFilterProvider>
        </OutlookProvider>
      </HubxpProvider>
    </ToastProvider>
  )
}

export default App
