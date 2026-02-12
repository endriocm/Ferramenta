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
      { path: '/receita/estruturadas', label: 'Estruturadas', icon: 'layers', tone: 'amber' },
      { path: '/receita/bovespa', label: 'Bovespa', icon: 'trend', tone: 'green' },
      { path: '/receita/bmf', label: 'BMF', icon: 'pulse', tone: 'blue' },
      { path: '/receita/manual', label: 'Manual', icon: 'pen' },
      { path: '/receita/consolidado', label: 'Consolidado', icon: 'upload' },
    ],
  },
  {
    section: 'Operacao',
    items: [
      { path: '/vencimento', label: 'Vencimento', icon: 'clock' },
      { path: '/tags', label: 'Tags e Vinculos', icon: 'link' },
      { path: '/cards', label: 'Cards', icon: 'spark' },
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
  '/vencimento': [
    { label: 'Gerar relatorio', icon: 'doc' },
  ],
  '/tags': [
    { label: 'Atualizar vinculos', icon: 'sync' },
  ],
}
