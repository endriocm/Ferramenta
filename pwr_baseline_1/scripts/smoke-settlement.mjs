import { computeBarrierStatus, computeResult } from '../pwr/src/services/settlement.js'

const logCase = (label, payload) => {
  console.log(`\n${label}`)
  console.log(JSON.stringify(payload, null, 2))
}

const baseOperation = {
  ativo: 'BBAS3',
  estrutura: 'Teste',
  quantidade: 100,
  spotInicial: 25.24,
  pernas: [
    { id: 'barreira-up', barreiraValor: 25.51, barreiraTipo: 'UI' },
  ],
}

const case1Market = { close: 25.24, high: 25.8, low: 25.0 }
const case1Barrier = computeBarrierStatus(baseOperation, case1Market, { high: 'auto', low: 'auto' })
logCase('Caso 1 - close < barreiraAlta (esperado: high=false)', {
  spotFinal: case1Market.close,
  barreira: 25.51,
  barrierStatus: case1Barrier,
})

const case2Market = { close: 25.6, high: 25.8, low: 25.0 }
const case2Barrier = computeBarrierStatus(baseOperation, case2Market, { high: 'auto', low: 'auto' })
logCase('Caso 2 - close >= barreiraAlta (esperado: high=true)', {
  spotFinal: case2Market.close,
  barreira: 25.51,
  barrierStatus: case2Barrier,
})

const debitOperationCall = {
  ativo: 'BBAS3',
  estrutura: 'CALL short',
  quantidade: 100,
  spotInicial: 25.0,
  pernas: [
    { id: 'call-short', tipo: 'CALL', side: 'short', strike: 25.0, quantidade: 100 },
  ],
}
const debitMarketCall = { close: 26.0 }
const debitBarrierCall = computeBarrierStatus(debitOperationCall, debitMarketCall, { high: 'auto', low: 'auto' })
const debitResultCall = computeResult(debitOperationCall, debitMarketCall, debitBarrierCall, {})
logCase('Caso 3 - CALL short liquidada (esperado: debito=2500)', {
  spotFinal: debitResultCall.spotFinal,
  debito: debitResultCall.debito,
})

const debitOperationPut = {
  ativo: 'BBAS3',
  estrutura: 'PUT short',
  quantidade: 100,
  spotInicial: 25.0,
  pernas: [
    { id: 'put-short', tipo: 'PUT', side: 'short', strike: 24.0, quantidade: 100 },
  ],
}
const debitMarketPut = { close: 25.0 }
const debitBarrierPut = computeBarrierStatus(debitOperationPut, debitMarketPut, { high: 'auto', low: 'auto' })
const debitResultPut = computeResult(debitOperationPut, debitMarketPut, debitBarrierPut, {})
logCase('Caso 4 - PUT short nao liquidada (esperado: debito=0)', {
  spotFinal: debitResultPut.spotFinal,
  debito: debitResultPut.debito,
})
