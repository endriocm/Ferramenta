import RevenueMarket from './RevenueMarket'

const BOVESPA_CONFIG = {
  key: 'bovespa',
  mercado: 'bov',
  fatorReceita: 0.9335 * 0.8285,
  label: 'Bovespa',
  subtitle: 'Importacao rapida e consolidacao para operacoes Bovespa.',
  defaultRepasse: '0,772',
  fileHint: 'bovespa',
  contextHelp: {
    triggerLabel: 'Ver instrucao do relatorio',
    title: 'Relatorio para Receita Bovespa',
    description: 'Use o caminho abaixo para acessar o relatorio desta pagina.',
    path: 'Menu > Gest\u00E3o > Renda vari\u00E1vel > corretagem.',
    url: 'https://hub.xpi.com.br/new/relatorios/#/renda-variavel',
  },
}

const RevenueBovespa = () => <RevenueMarket config={BOVESPA_CONFIG} />

export default RevenueBovespa
