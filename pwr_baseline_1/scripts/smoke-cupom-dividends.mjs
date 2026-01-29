import { computeResult } from '../pwr/src/services/settlement.js'

const operation = {
  estrutura: 'Cupom Recorrente',
  quantidade: 200,
  qtyBase: 200,
  qtyBonus: 0,
  custoUnitario: 50,
  spotInicial: 50,
  pernas: [],
}

const market = {
  close: 50,
  dividendsTotal: 10,
}

const barrierStatus = { high: null, low: null }
const result = computeResult(operation, market, barrierStatus, {})

console.log(JSON.stringify({
  vendaAtivoBruta: result.vendaAtivoBruta,
  vendaAtivoAjustada: result.vendaAtivoAjustada,
  dividends: result.dividends,
  custoTotal: result.custoTotal,
  financeiroFinal: result.financeiroFinal,
}, null, 2))
