import RevenueMarket from './RevenueMarket'

const BMF_CONFIG = {
  key: 'bmf',
  mercado: 'bmf',
  fatorReceita: 0.9435 * 0.8285,
  label: 'BMF',
  subtitle: 'Monitoramento de contratos futuros e consolidacao automatica.',
  defaultRepasse: '0,781',
  fileHint: 'bmf',
  contextHelp: {
    triggerLabel: 'Ver instrucao do relatorio',
    title: 'Relatorio para Receita BMF',
    description: 'Use o caminho abaixo para acessar o relatorio desta pagina.',
    path: 'Menu > Gest\u00E3o > Renda vari\u00E1vel > corretagem.',
    url: 'https://hub.xpi.com.br/new/relatorios/#/renda-variavel',
  },
}

const RevenueBmf = () => <RevenueMarket config={BMF_CONFIG} />

export default RevenueBmf
