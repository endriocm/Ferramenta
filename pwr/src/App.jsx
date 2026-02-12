import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { auth } from './firebase'
import { onAuthStateChanged } from 'firebase/auth'
import ToastProvider from './components/ToastProvider'
import { useHashRoute } from './hooks/useHashRoute'
import { routeTitles } from './data/navigation'
import { GlobalFilterProvider } from './contexts/GlobalFilterContext'

const Login = lazy(() => import('./Login'))
const AccessGate = lazy(() => import('./AccessGate'))
const Sidebar = lazy(() => import('./components/Sidebar'))
const Topbar = lazy(() => import('./components/Topbar'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const RevenueStructured = lazy(() => import('./pages/RevenueStructured'))
const RevenueBovespa = lazy(() => import('./pages/RevenueBovespa'))
const RevenueBmf = lazy(() => import('./pages/RevenueBmf'))
const RevenueManual = lazy(() => import('./pages/RevenueManual'))
const RevenueConsolidated = lazy(() => import('./pages/RevenueConsolidated'))
const CardGenerator = lazy(() => import('./pages/CardGenerator'))
const Vencimento = lazy(() => import('./pages/Vencimento'))
const Tags = lazy(() => import('./pages/Tags'))
const AccessStatus = lazy(() => import('./pages/account/AccessStatus'))
const AdminAccess = lazy(() => import('./pages/admin/AdminAccess'))
const BillingSuccess = lazy(() => import('./pages/billing/BillingSuccess'))
const BillingPending = lazy(() => import('./pages/billing/BillingPending'))
const BillingFailure = lazy(() => import('./pages/billing/BillingFailure'))
const NotFound = lazy(() => import('./pages/NotFound'))

const routeMap = {
  '/': Dashboard,
  '/times': Tags,
  '/cards': CardGenerator,
  '/receita/estruturadas': RevenueStructured,
  '/receita/bovespa': RevenueBovespa,
  '/receita/bmf': RevenueBmf,
  '/receita/manual': RevenueManual,
  '/receita/consolidado': RevenueConsolidated,
  '/vencimento': Vencimento,
  '/tags': Tags,
  '/account/access': AccessStatus,
  '/admin/access': AdminAccess,
  '/billing/success': BillingSuccess,
  '/billing/pending': BillingPending,
  '/billing/failure': BillingFailure,
}

const crumbLookup = {
  receita: 'Receita',
  estruturadas: 'Estruturadas',
  bovespa: 'Bovespa',
  bmf: 'BMF',
  manual: 'Manual',
  consolidado: 'Consolidado',
  vencimento: 'Vencimento',
  tags: 'Tags e Vinculos',
  times: 'Times',
  cards: 'Cards',
  account: 'Conta',
  access: 'Meu Acesso',
  admin: 'Admin',
}

const resolvePath = (path) => {
  if (path === '/receita') return '/receita/estruturadas'
  return path
}

const LoadingFallback = () => (
  <div className="page">
    <div className="panel">
      <h3>Carregando</h3>
      <p className="muted">Preparando painel...</p>
    </div>
  </div>
)

function App() {
  const [usuario, setUsuario] = useState(null)
  const [carregandoAuth, setCarregandoAuth] = useState(true)
  const [temAcesso, setTemAcesso] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUsuario(u || null)
      if (!u) setTemAcesso(false)
      setCarregandoAuth(false)
    })
    return () => unsub()
  }, [])

  const { path, navigate } = useHashRoute('/')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const resolvedPath = resolvePath(path)
  const CurrentPage = routeMap[resolvedPath] || NotFound

  useEffect(() => {
    if (path !== resolvedPath) {
      navigate(resolvedPath)
    }
  }, [path, resolvedPath, navigate])

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
        <AccessGate onAccessGranted={() => setTemAcesso(true)}>
          <Suspense fallback={<LoadingFallback />}>
            <div key={resolvedPath}>
              <CurrentPage />
            </div>
          </Suspense>
        </AccessGate>
      </Suspense>
    )
  }

  return (
    <ToastProvider>
      <GlobalFilterProvider>
        <Suspense fallback={<LoadingFallback />}>
          <div className="app-shell">
            <Sidebar
              currentPath={resolvedPath}
              onNavigate={() => setSidebarOpen(false)}
              isOpen={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
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
                <Suspense fallback={<LoadingFallback />}>
                  <div key={resolvedPath}>
                    <CurrentPage />
                  </div>
                </Suspense>
              </main>
            </div>
          </div>
        </Suspense>
      </GlobalFilterProvider>
    </ToastProvider>
  )
}

export default App
