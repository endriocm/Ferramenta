import { lazy } from 'react'

const createLazyRoute = (loader) => {
  let pending = null

  const load = () => {
    if (!pending) {
      pending = loader().catch((error) => {
        pending = null
        throw error
      })
    }
    return pending
  }

  const Component = lazy(load)
  Component.preload = load
  return Component
}

const Dashboard = createLazyRoute(() => import('./pages/Dashboard'))
const RevenueStructured = createLazyRoute(() => import('./pages/RevenueStructured'))
const RevenueBovespa = createLazyRoute(() => import('./pages/RevenueBovespa'))
const RevenueBmf = createLazyRoute(() => import('./pages/RevenueBmf'))
const RevenueXpCommission = createLazyRoute(() => import('./pages/RevenueXpCommission'))
const RevenueManual = createLazyRoute(() => import('./pages/RevenueManual'))
const RevenueConsolidated = createLazyRoute(() => import('./pages/RevenueConsolidated'))
const CardGenerator = createLazyRoute(() => import('./pages/CardGenerator'))
const Importacao = createLazyRoute(() => import('./pages/Importacao'))
const Vinculos = createLazyRoute(() => import('./pages/Vinculos'))
const Vencimento = createLazyRoute(() => import('./pages/Vencimento'))
const BatimentoBarreira = createLazyRoute(() => import('./pages/BatimentoBarreira'))
const ProjecaoVencimento = createLazyRoute(() => import('./pages/ProjecaoVencimento'))
const HistoricoOperacoes = createLazyRoute(() => import('./pages/HistoricoOperacoes'))
const ClientesOperando = createLazyRoute(() => import('./pages/ClientesOperando'))
const Gap = createLazyRoute(() => import('./pages/Gap'))
const Antecipacao = createLazyRoute(() => import('./pages/Antecipacao'))
const CentralOrdens = createLazyRoute(() => import('./pages/CentralOrdens'))
const ApuracaoBovespa = createLazyRoute(() => import('./pages/ApuracaoBovespa'))
const Outlook = createLazyRoute(() => import('./pages/Outlook'))
const CalendarioResultados = createLazyRoute(() => import('./pages/CalendarioResultados'))
const CalendarioProventos = createLazyRoute(() => import('./pages/CalendarioProventos'))
const Tags = createLazyRoute(() => import('./pages/Tags'))
const AccessStatus = createLazyRoute(() => import('./pages/account/AccessStatus'))
const AdminAccess = createLazyRoute(() => import('./pages/admin/AdminAccess'))
const BillingSuccess = createLazyRoute(() => import('./pages/billing/BillingSuccess'))
const BillingPending = createLazyRoute(() => import('./pages/billing/BillingPending'))
const BillingFailure = createLazyRoute(() => import('./pages/billing/BillingFailure'))
const NotFound = createLazyRoute(() => import('./pages/NotFound'))

export const resolveRoutePath = (path) => {
  if (path === '/receita') return '/receita/estruturadas'
  return path
}

export const routeMap = {
  '/': Dashboard,
  '/times': Tags,
  '/cards': CardGenerator,
  '/importacao': Importacao,
  '/vinculos': Vinculos,
  '/receita/estruturadas': RevenueStructured,
  '/receita/bovespa': RevenueBovespa,
  '/receita/bmf': RevenueBmf,
  '/receita/comissao-xp': RevenueXpCommission,
  '/receita/manual': RevenueManual,
  '/receita/consolidado': RevenueConsolidated,
  '/vencimento': Vencimento,
  '/batimento-barreira': BatimentoBarreira,
  '/projecao-vencimento': ProjecaoVencimento,
  '/historico-operacoes': HistoricoOperacoes,
  '/clientes-operando': ClientesOperando,
  '/gap': Gap,
  '/antecipacao': Antecipacao,
  '/central-ordens': CentralOrdens,
  '/apuracao-bovespa': ApuracaoBovespa,
  '/calendario-resultados': CalendarioResultados,
  '/calendario-proventos': CalendarioProventos,
  '/outlook': Outlook,
  '/tags': Tags,
  '/account/access': AccessStatus,
  '/admin/access': AdminAccess,
  '/billing/success': BillingSuccess,
  '/billing/pending': BillingPending,
  '/billing/failure': BillingFailure,
}

export const preloadableRoutePaths = Object.keys(routeMap).filter((path) => (
  !path.startsWith('/billing/')
  && path !== '/account/access'
  && path !== '/admin/access'
))

export const getRouteComponent = (path) => routeMap[resolveRoutePath(path)] || NotFound

export const preloadRoute = (path) => {
  const Component = getRouteComponent(path)
  if (typeof Component?.preload === 'function') return Component.preload()
  return Promise.resolve(null)
}
