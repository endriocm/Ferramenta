export const dashboardKpis = [
  {
    id: 'saldo',
    label: 'Saldo operacional',
    value: 12845000,
    delta: 0.14,
    trend: 'up',
  },
  {
    id: 'custos',
    label: 'Custos do mes',
    value: 3920000,
    delta: -0.06,
    trend: 'down',
  },
  {
    id: 'profit',
    label: 'Profit consolidado',
    value: 8920000,
    delta: 0.08,
    trend: 'up',
  },
]

export const dashboardMini = [
  { id: 'tickets', label: 'Tickets ativos', value: 182, change: '+12' },
  { id: 'alerts', label: 'Alertas criticos', value: 7, change: '-2' },
  { id: 'latency', label: 'Latencia media', value: '1.8s', change: '-0.3s' },
  { id: 'sync', label: 'Syncs concluidos', value: 42, change: '+5' },
  { id: 'coverage', label: 'Cobertura smart', value: '91%', change: '+3%' },
  { id: 'anomalies', label: 'Anomalias mapeadas', value: 15, change: '-4' },
]

export const dashboardSeries = [
  24, 22, 26, 30, 28, 34, 38, 36, 42, 45, 44, 49, 52, 54, 59, 61, 58, 62, 68, 71, 75,
]

export const dashboardSegments = [
  { label: 'Estruturadas', value: 42, tone: 'cyan' },
  { label: 'Bovespa', value: 27, tone: 'violet' },
  { label: 'BMF', value: 19, tone: 'amber' },
  { label: 'Manual', value: 12, tone: 'green' },
]
