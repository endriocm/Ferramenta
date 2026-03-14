export const navigation = [
  {
    section: 'Visao',
    items: [
      { path: '/', label: 'Dashboard', icon: 'grid', description: 'KPIs e tendencias' },
      { path: '/times', label: 'Times', icon: 'user' },
    ],
  },
  {
    section: 'Receita',
    items: [
      { path: '/receita/bmf', label: 'BMF', icon: 'pulse', tone: 'blue' },
      { path: '/receita/bovespa', label: 'Bovespa', icon: 'trend', tone: 'green' },
      { path: '/receita/estruturadas', label: 'Estruturadas', icon: 'layers', tone: 'amber' },
      { path: '/receita/comissao-xp', label: 'Comissao XP', icon: 'doc', tone: 'violet' },
      { path: '/receita/consolidado', label: 'Consolidado', icon: 'upload' },
      { path: '/receita/manual', label: 'Manual', icon: 'pen' },
    ],
  },
  {
    section: 'Operacao',
    items: [
      { path: '/antecipacao', label: 'Antecipacao', icon: 'trend' },
      { path: '/batimento-barreira', label: 'Batimento de barreira', icon: 'warning' },
      { path: '/clientes-operando', label: 'Clientes operando', icon: 'grid' },
      { path: '/gap', label: 'Gap', icon: 'trend' },
      { path: '/historico-operacoes', label: 'Historico de operacoes', icon: 'doc' },
      { path: '/projecao-vencimento', label: 'Projecao de vencimento', icon: 'trend' },
      { path: '/tags', label: 'Tags e Vinculos', icon: 'link' },
      { path: '/vencimento', label: 'Vencimento', icon: 'clock' },
    ],
  },
  {
    section: 'Ferramentas',
    items: [
      { path: '/calendario-resultados', label: 'Calendario de resultados', icon: 'calendar' },
      { path: '/calendario-proventos', label: 'Calendario de proventos', icon: 'calendar' },
      { path: '/cards', label: 'Cards', icon: 'spark' },
      { path: '/central-ordens', label: 'Central de Ordens', icon: 'doc' },
      { path: '/apuracao-bovespa', label: 'Apuracao Bovespa', icon: 'trend' },
      { path: '/outlook', label: 'Envio de email', icon: 'doc' },
    ],
  },
  {
    section: 'Dados',
    items: [
      { path: '/importacao', label: 'Importacao', icon: 'upload' },
      { path: '/vinculos', label: 'Vinculos', icon: 'link', description: 'Vincule pastas aos modulos e sincronize tudo' },
    ],
  },
]

export const routeTitles = navigation
  .flatMap((section) => section.items)
  .reduce((acc, item) => {
    acc[item.path] = item.label
    return acc
  }, {})

export const quickActions = {
  '/': [],
  '/times': [],
  '/cards': [],
  '/importacao': [],
  '/vinculos': [],
  '/calendario-resultados': [],
  '/calendario-proventos': [],
  '/antecipacao': [],
  '/batimento-barreira': [],
  '/vencimento': [
    { label: 'Gerar relatorio', icon: 'doc' },
  ],
  '/projecao-vencimento': [],
  '/historico-operacoes': [],
  '/clientes-operando': [],
  '/gap': [],
  '/central-ordens': [],
  '/apuracao-bovespa': [],
  '/outlook': [],
  '/tags': [
    { label: 'Atualizar vinculos', icon: 'sync' },
  ],
}
