import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import ToastProvider from './components/ToastProvider'
import { useHashRoute } from './hooks/useHashRoute'
import { routeTitles } from './data/navigation'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const RevenueStructured = lazy(() => import('./pages/RevenueStructured'))
const RevenueBovespa = lazy(() => import('./pages/RevenueBovespa'))
const RevenueBmf = lazy(() => import('./pages/RevenueBmf'))
const RevenueManual = lazy(() => import('./pages/RevenueManual'))
const Vencimento = lazy(() => import('./pages/Vencimento'))
const Tags = lazy(() => import('./pages/Tags'))
const NotFound = lazy(() => import('./pages/NotFound'))

const routeMap = {
  '/': Dashboard,
  '/receita/estruturadas': RevenueStructured,
  '/receita/bovespa': RevenueBovespa,
  '/receita/bmf': RevenueBmf,
  '/receita/manual': RevenueManual,
  '/vencimento': Vencimento,
  '/tags': Tags,
}

const crumbLookup = {
  receita: 'Receita',
  estruturadas: 'Estruturadas',
  bovespa: 'Bovespa',
  bmf: 'BMF',
  manual: 'Manual',
  vencimento: 'Vencimento',
  tags: 'Tags e Vinculos',
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
  const { path, navigate } = useHashRoute('/')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const resolvedPath = resolvePath(path)
  const CurrentPage = routeMap[resolvedPath] || NotFound

  useEffect(() => {
    if (path !== resolvedPath) {
      navigate(resolvedPath)
    }
  }, [path, resolvedPath, navigate])

  const title = routeTitles[resolvedPath] || 'Painel'
  const breadcrumbs = useMemo(() => {
    if (resolvedPath === '/') return ['Dashboard']
    return resolvedPath
      .split('/')
      .filter(Boolean)
      .map((segment) => crumbLookup[segment] || segment)
  }, [resolvedPath])

  return (
    <ToastProvider>
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
          />
          <main className="page-content">
            <Suspense fallback={<LoadingFallback />}>
              <CurrentPage />
            </Suspense>
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}

export default App
