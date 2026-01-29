export const receitaEntries = [
  {
    id: 'rx-1021',
    data: '2026-01-21',
    cliente: 'Atlas Capital',
    assessor: 'M. Torres',
    ativo: 'PETR4',
    estrutura: 'Kite 12M',
    origem: 'Estruturadas',
    status: 'ok',
    valor: 420000,
  },
  {
    id: 'rx-1022',
    data: '2026-01-20',
    cliente: 'Nova Alpha',
    assessor: 'A. Lima',
    ativo: 'VALE3',
    estrutura: 'Shield 6M',
    origem: 'Bovespa',
    status: 'duplicado',
    valor: 185000,
  },
  {
    id: 'rx-1023',
    data: '2026-01-18',
    cliente: 'Aurora Assets',
    assessor: 'C. Prado',
    ativo: 'WINJ26',
    estrutura: 'Bear 3M',
    origem: 'BMF',
    status: 'ok',
    valor: 98000,
  },
  {
    id: 'rx-1024',
    data: '2026-01-17',
    cliente: 'Fenix Partners',
    assessor: 'R. Costa',
    ativo: 'BBDC4',
    estrutura: 'Snowball 9M',
    origem: 'Estruturadas',
    status: 'aviso',
    valor: 210000,
  },
  {
    id: 'rx-1025',
    data: '2026-01-15',
    cliente: 'Helios Invest',
    assessor: 'G. Souza',
    ativo: 'WDOF26',
    estrutura: 'Cap 4M',
    origem: 'Manual',
    status: 'ok',
    valor: 145000,
  },
]

export const receitaResumo = {
  totalMes: 12845000,
  ultimaSync: '2026-01-24 19:15',
  entradas: 182,
  duplicados: 6,
  avisos: 4,
}

export const syncSteps = [
  'Selecionar fonte',
  'Validar arquivos',
  'Processar linhas',
  'Consolidar base',
  'Concluir',
]

export const syncResultsMock = {
  importados: 142,
  duplicados: 6,
  rejeitados: 2,
  avisos: 4,
}
