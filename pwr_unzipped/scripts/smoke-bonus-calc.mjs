import { computeResult } from '../pwr/src/services/settlement.js'

const operation = {
  estrutura: 'Teste',
  quantidade: 200,
  qtyBase: 200,
  qtyBonus: 26,
  custoUnitario: 10,
  spotInicial: 100,
  pernas: [],
}

const market = { close: 100, dividendsTotal: 0 }
const barrierStatus = { high: null, low: null }

const result = computeResult(operation, market, barrierStatus, {})

console.log(JSON.stringify({
  qtyBase: result.qtyBase,
  qtyBonus: result.qtyBonus,
  qtyAtual: result.qtyAtual,
  custoTotal: result.custoTotal,
  vendaAtivoBruta: result.vendaAtivoBruta,
}, null, 2))
