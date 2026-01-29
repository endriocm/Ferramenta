export const navigation = [
  {
    section: 'Visao',
    items: [
      { path: '/', label: 'Dashboard', icon: 'grid', description: 'KPIs e tendencias' },
    ],
  },
  {
    section: 'Receita',
    items: [
      { path: '/receita/estruturadas', label: 'Estruturadas', icon: 'layers' },
      { path: '/receita/bovespa', label: 'Bovespa', icon: 'trend' },
      { path: '/receita/bmf', label: 'BMF', icon: 'pulse' },
      { path: '/receita/manual', label: 'Manual', icon: 'pen' },
    ],
  },
  {
    section: 'Operacao',
    items: [
      { path: '/vencimento', label: 'Vencimento', icon: 'clock' },
      { path: '/tags', label: 'Tags e Vinculos', icon: 'link' },
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
  '/': [
    { label: 'Atualizar painel', icon: 'spark' },
  ],
  '/receita/estruturadas': [
    { label: 'Sincronizar', icon: 'sync' },
    { label: 'Exportar', icon: 'download' },
  ],
  '/receita/bovespa': [
    { label: 'Importar arquivo', icon: 'upload' },
  ],
  '/receita/bmf': [
    { label: 'Importar arquivo', icon: 'upload' },
  ],
  '/receita/manual': [
    { label: 'Novo lancamento', icon: 'plus' },
  ],
  '/vencimento': [
    { label: 'Gerar relatorio', icon: 'doc' },
  ],
  '/tags': [
    { label: 'Atualizar vinculos', icon: 'sync' },
  ],
}
