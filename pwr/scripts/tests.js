import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { normalizeDateKey } from '../src/utils/dateKey.js'
import {
  applyOverridesToOperation,
  computeBarrierStatus,
  computeResult,
  inferOperationQuantityAtual,
  inferOperationQuantityBase,
  resolveOperationQuantities,
} from '../src/services/settlement.js'
import { updateOverride } from '../src/services/overrides.js'
import {
  buildBarrierSeriesInRange,
  findLowBarrierHit,
  hydrateBarrierHitDateInputs,
} from '../src/services/barrierHitAnalysis.js'
import { buildTagIndex as buildTagsPayloadIndex, enrichRow } from '../src/services/tags.js'
import {
  buildStrategyModel,
  createStrategyOptionEntry,
  getStrategyDefaults,
  getStrategyFields,
  getStrategyOptionForm,
  inferOptionSyncForTemplate,
  strategyTemplateOptions,
} from '../src/services/strategyTemplates.js'
import { extractCardDataFromImageText } from '../src/services/cardImageImport.js'
import {
  buildHistoricalRowFromVencimentoRow,
  buildHistoricalRowFromParsedRow,
  composeHistoricoRows,
  recalculateHistoricalWorkbookValues,
} from '../src/services/historicoOperacoes.js'
import {
  annotateSettlementMarket,
  mergeRowsPreservingExpired,
  shouldLoadSettlementClose,
} from '../src/services/vencimentoRows.js'
import {
  buildClientFilterMatchSet,
  buildClientFilterOptions,
  matchesClientFilter,
} from '../src/services/clientFilter.js'
import { inferBonusQuantities } from '../src/services/bonus.js'

const require = createRequire(import.meta.url)
const { sumDividendsInRange } = require('../../api/lib/dividends.js')
const { aggregateBonusEvents, parseStatusInvestBonusHtml } = require('../../api/lib/bonus.js')
const quotesApi = require('../../api/quotes.js')
const {
  buildSeriesFromBrapiHistory,
  resolveBrapiRange,
} = quotesApi._internal

const dateKey = normalizeDateKey('2026-01-28')
assert.equal(dateKey, '2026-01-28')
assert.equal(normalizeDateKey('28/01/2026'), '2026-01-28')

const sampleDividends = [
  { dataCom: '2026-01-05', amount: 0.1, type: 'DIVIDEND' },
  { dataCom: '2026-01-28', amount: 0.2, type: 'JCP' },
  { dataCom: '2026-02-02', amount: 0.3, type: 'DIVIDEND' },
]
const total = sumDividendsInRange(sampleDividends, '2026-01-01', '2026-01-31')
assert.ok(Math.abs(total - (0.1 + 0.2 * 0.825)) < 1e-9)

const sampleBonusHtml = `
  <div>
    <h3>BONIFICA\u00c7\u00c3O</h3>
    <div class="card-body">
      <div>
        <small>Data do anuncio</small><strong>18/12/2025</strong>
        <small>Data com</small><strong>23/12/2025</strong>
        <small>Data ex</small><strong>26/12/2025</strong>
        <small>Data de incorporacao</small><strong>30/12/2025</strong>
        <small>Valor base</small><strong>R$ 40,00</strong>
        <small>Proporcao</small><strong>3,00%</strong>
        <small>Ativo emitido</small><strong><span>ITUB4</span></strong>
      </div>
      <hr />
      <div>
        <small>Data do anuncio</small><strong>05/02/2025</strong>
        <small>Data com</small><strong>17/03/2025</strong>
        <small>Data ex</small><strong>18/03/2025</strong>
        <small>Data de incorporacao</small><strong>20/03/2025</strong>
        <small>Valor base</small><strong>R$ 34,00</strong>
        <small>Proporcao</small><strong>10,00%</strong>
        <small>Ativo emitido</small><strong><span>ITUB4</span></strong>
      </div>
    </div>
    <h3>DESDOBRAMENTO/GRUPAMENTO</h3>
  </div>
`
const parsedBonusEvents = parseStatusInvestBonusHtml(sampleBonusHtml)
assert.equal(parsedBonusEvents.length, 2)
assert.equal(parsedBonusEvents[0].dataCom, '2025-12-23')
assert.equal(parsedBonusEvents[1].dataCom, '2025-03-17')
const aggregatedBonus = aggregateBonusEvents(parsedBonusEvents, '2025-01-01', '2025-12-31')
assert.ok(Math.abs(aggregatedBonus.factor - 1.133) < 1e-9)
const inferredBonus = inferBonusQuantities(1133, aggregatedBonus.events)
assert.equal(inferredBonus.canInfer, true)
assert.equal(inferredBonus.qtyBase, 1000)
assert.equal(inferredBonus.qtyBonus, 133)

assert.equal(resolveBrapiRange(
  Math.floor(new Date('2026-01-13T00:00:00Z').getTime() / 1000),
  Math.floor(new Date('2026-03-10T00:00:00Z').getTime() / 1000),
), '2mo')

const brapiSeries = buildSeriesFromBrapiHistory({
  historyRows: [
    { date: 1768176000, open: 40.5, high: 41.2, low: 39.8, close: 40.1 },
    { date: 1768262400, open: 38.1, high: 38.5, low: 36.72, close: 37.15 },
  ],
  quote: {
    regularMarketTime: '2026-03-09T12:00:00Z',
    regularMarketDayHigh: 37.05,
    regularMarketDayLow: 36.68,
    regularMarketPrice: 36.91,
  },
  startDate: '2026-01-13',
  endDate: '2026-03-09',
})
assert.equal(brapiSeries.length, 2)
assert.equal(brapiSeries[0].date, '2026-01-13')
assert.equal(brapiSeries[1].date, '2026-03-09')
assert.equal(brapiSeries[1].low, 36.68)

const hydratedBarrierDates = hydrateBarrierHitDateInputs({
  savedState: {
    reportDate: '2026-03-08',
    analysisFrom: '2026-01-13',
    analysisTo: '2026-03-08',
  },
  todayKey: '2026-03-09',
})
assert.equal(hydratedBarrierDates.reportDate, '2026-03-09')
assert.equal(hydratedBarrierDates.analysisFrom, '2026-01-13')
assert.equal(hydratedBarrierDates.analysisTo, '2026-03-09')
assert.equal(hydratedBarrierDates.advancedReportDate, true)
assert.equal(hydratedBarrierDates.advancedAnalysisTo, true)
assert.equal(hydratedBarrierDates.adjustedInvalidRange, false)
assert.equal(hydratedBarrierDates.advancedToToday, true)

const hydratedBarrierInvalidRange = hydrateBarrierHitDateInputs({
  savedState: {
    reportDate: '2026-03-08',
    analysisFrom: '2026-03-10',
    analysisTo: '2026-03-08',
  },
  todayKey: '2026-03-09',
})
assert.equal(hydratedBarrierInvalidRange.reportDate, '2026-03-09')
assert.equal(hydratedBarrierInvalidRange.analysisFrom, '2026-03-10')
assert.equal(hydratedBarrierInvalidRange.analysisTo, '2026-03-10')
assert.equal(hydratedBarrierInvalidRange.adjustedInvalidRange, true)

const itlcBarrierSeries = buildSeriesFromBrapiHistory({
  historyRows: [
    { date: 1768176000, open: 43.17, high: 43.7, low: 42.6, close: 43.2 },
  ],
  quote: {
    regularMarketTime: '2026-03-09T12:00:00Z',
    regularMarketDayHigh: 39.28,
    regularMarketDayLow: 36.3,
    regularMarketPrice: 39.06,
  },
  startDate: '2026-01-13',
  endDate: '2026-03-09',
})
const itlcBarrierRows = buildBarrierSeriesInRange(itlcBarrierSeries, {
  start: '2026-01-13',
  end: '2026-03-09',
})
const itlcLowHit = findLowBarrierHit(itlcBarrierRows, [36.7])
assert.equal(itlcLowHit?.date, '2026-03-09')
assert.equal(itlcLowHit?.barrierValue, 36.7)
assert.ok(Math.abs((itlcLowHit?.marketValue || 0) - 36.3) < 1e-9)

const legacyHistoricalRow = buildHistoricalRowFromParsedRow({
  id: 'legacy-row-1',
  assessor: 'Assessor',
  broker: 'Broker',
  cliente: '12345',
  dataRegistro: '2026-02-03',
  ativo: 'ABCD3',
  estrutura: 'Rubi',
  valorCompra: 45,
  vencimento: '2026-03-21',
  quantidade: 100,
  custoUnitario: 1.1,
  callComprada: 45,
  putComprada: 55,
  vendaAtivoInformado: 1000,
  debitoInformado: 200,
  dividendosInformado: 50,
  cupomInformado: 25,
  pagouInformado: 1100,
  sourceSheet: 'mar_2026',
  sourceRow: 12,
})
const recalculatedHistoricalRow = recalculateHistoricalWorkbookValues(legacyHistoricalRow, 50)
assert.equal(recalculatedHistoricalRow.batchMonth, '2026-03')
assert.equal(recalculatedHistoricalRow.ganhoPut, 500)
assert.equal(recalculatedHistoricalRow.ganhoCall, 500)
assert.equal(recalculatedHistoricalRow.ganhosOpcoes, 1000)
assert.equal(recalculatedHistoricalRow.financeiroFinal, 2275)
assert.equal(recalculatedHistoricalRow.ganhoPrejuizo, 1175)
assert.ok(Math.abs((recalculatedHistoricalRow.lucroPercentual || 0) - (2275 / 1100 - 1)) < 1e-9)

const recurringCouponHistoricalBase = buildHistoricalRowFromParsedRow({
  id: 'legacy-recurring-1',
  assessor: 'Assessor',
  broker: 'Broker',
  cliente: '67890',
  dataRegistro: '2026-02-03',
  ativo: 'ABCD3',
  estrutura: 'Cupom Recorrente',
  valorCompra: 25,
  vencimento: '2026-03-21',
  quantidade: 100,
  barreiraKo: 20,
  spotInformado: 24,
  cupomInformado: 120,
  pagouInformado: 2500,
})
const recurringCouponHistoricalOpen = recalculateHistoricalWorkbookValues(recurringCouponHistoricalBase, 24)
assert.equal(recurringCouponHistoricalOpen.vendaAtivoMercado, 2500)
assert.equal(recurringCouponHistoricalOpen.financeiroFinal, 2620)
assert.equal(recurringCouponHistoricalOpen.ganhoPrejuizo, 120)

const recurringCouponHistoricalLowHit = recalculateHistoricalWorkbookValues(recurringCouponHistoricalBase, 19)
assert.equal(recurringCouponHistoricalLowHit.vendaAtivoMercado, 1900)
assert.equal(recurringCouponHistoricalLowHit.financeiroFinal, 2020)
assert.equal(recurringCouponHistoricalLowHit.ganhoPrejuizo, -480)

const recurringCouponFromVencimento = buildHistoricalRowFromVencimentoRow({
  id: 'venc-recurring-1',
  estrutura: 'Cupom Recorrente',
  vencimento: '2026-03-21',
  qtyAtual: 100,
  quantidade: 100,
  result: {
    spotFinal: 24,
    valorSaida: 2500,
    vendaAtivoBruta: 2400,
    ganho: 120,
    financeiroFinal: 120,
    percent: 0.048,
    pagou: 2500,
    cupomTotal: 120,
  },
  effectiveLegs: [
    { id: 'put-long', tipo: 'PUT', side: 'long', strike: 23, quantidade: 100 },
    { id: 'call-short', tipo: 'CALL', side: 'short', strike: 27, quantidade: -100, barreiraTipo: 'KO', barreiraValor: 20 },
  ],
})
assert.equal(recurringCouponFromVencimento.vendaAtivoMercado, 2500)

const composedHistoricalRows = composeHistoricoRows({
  version: 2,
  savedAt: '2026-03-10T00:00:00.000Z',
  legacyRows: [
    buildHistoricalRowFromParsedRow({
      id: 'legacy-feb',
      cliente: '1',
      ativo: 'ABCD3',
      estrutura: 'Rubi',
      vencimento: '2026-02-20',
      quantidade: 100,
    }),
    buildHistoricalRowFromParsedRow({
      id: 'legacy-mar',
      cliente: '2',
      ativo: 'ITLC34',
      estrutura: 'Rubi',
      vencimento: '2026-03-21',
      quantidade: 100,
    }),
  ],
  monthlyBatches: {
    '2026-03': {
      monthKey: '2026-03',
      monthLabel: 'mar. de 2026',
      origin: 'vencimento',
      pushedAt: '2026-03-10T12:00:00.000Z',
      rows: [
        {
          id: 'batch-mar',
          cliente: '3',
          ativo: 'ITLC34',
          estrutura: 'Rubi',
          dataVencimento: '2026-03-21',
          quantidade: 100,
          origin: 'vencimento',
          batchMonth: '2026-03',
        },
      ],
    },
  },
  importMeta: { fileName: 'historico.xlsx', importedAt: '2026-03-10T12:00:00.000Z' },
})
assert.equal(composedHistoricalRows.length, 2)
assert.equal(composedHistoricalRows.some((row) => row.id === 'legacy-mar'), false)
assert.equal(composedHistoricalRows.some((row) => row.id === 'batch-mar'), true)
assert.equal(composedHistoricalRows.some((row) => row.id === 'legacy-feb'), true)

const mergedVencimentoRows = mergeRowsPreservingExpired({
  previousRows: [
    { id: 'expired-keep', ativo: 'ABCD3', vencimento: '2026-03-10' },
    { id: 'future-drop', ativo: 'EFGH4', vencimento: '2026-03-25' },
    { id: 'refresh-me', ativo: 'IJKL3', vencimento: '2026-03-12', broker: 'old' },
  ],
  nextRows: [
    { id: 'refresh-me', ativo: 'IJKL3', vencimento: '2026-03-12', broker: 'new' },
    { id: 'new-live', ativo: 'MNOP3', vencimento: '2026-04-01' },
  ],
  referenceDate: '2026-03-21',
})
assert.deepEqual(mergedVencimentoRows.map((row) => row.id), ['refresh-me', 'new-live', 'expired-keep'])
assert.equal(mergedVencimentoRows.find((row) => row.id === 'refresh-me')?.broker, 'new')
assert.equal(mergedVencimentoRows.some((row) => row.id === 'future-drop'), false)

const settlementOperation = {
  id: 'settlement-op',
  ativo: 'ABCD3',
  dataRegistro: '2026-03-01',
  vencimento: '2026-03-21',
}
assert.equal(shouldLoadSettlementClose(settlementOperation, null, '2026-03-21'), true)
const settlementSameDay = annotateSettlementMarket(settlementOperation, { close: 22.15 }, '2026-03-21')
assert.equal(shouldLoadSettlementClose(settlementOperation, settlementSameDay, '2026-03-21'), false)
assert.equal(shouldLoadSettlementClose(settlementOperation, settlementSameDay, '2026-03-22'), true)
const settlementNextDay = annotateSettlementMarket(settlementOperation, { close: 22.15 }, '2026-03-22')
assert.equal(shouldLoadSettlementClose(settlementOperation, settlementNextDay, '2026-03-22'), false)

const tagsPayload = {
  rows: [
    {
      cliente: '000123',
      nomeCliente: 'Cliente Exemplo',
      assessor: 'Assessor Exemplo',
      broker: 'Broker Exemplo',
    },
  ],
}
const tagsIndex = buildTagsPayloadIndex(tagsPayload)
const enrichedByCode = enrichRow({
  codigoCliente: '123',
  cliente: '123',
  nomeCliente: '',
  assessor: '',
  broker: '',
}, tagsIndex)
assert.equal(enrichedByCode.broker, 'Broker Exemplo')
assert.equal(enrichedByCode.assessor, 'Assessor Exemplo')
assert.equal(enrichedByCode.nomeCliente, 'Cliente Exemplo')

const enrichedByName = enrichRow({
  codigoCliente: '',
  cliente: '',
  nomeCliente: 'Cliente Exemplo',
  assessor: '',
  broker: '',
}, tagsIndex)
assert.equal(enrichedByName.broker, 'Broker Exemplo')
assert.equal(enrichedByName.assessor, 'Assessor Exemplo')

const baseOperation = {
  id: 'op-test-1',
  estrutura: 'Kite',
  quantidade: 1,
  custoUnitario: 0,
  spotInicial: 100,
  pernas: [
    {
      id: 'leg-1',
      tipo: 'CALL',
      side: 'long',
      strike: 100,
      barreiraTipo: 'UO',
      barreiraValor: 110,
    },
  ],
}
const market = { close: 100, high: 111, low: 95, dividendsTotal: 0 }

const statusBase = computeBarrierStatus(baseOperation, market, { high: 'auto', low: 'auto' })
assert.equal(statusBase.high, true)
const statusSticky = computeBarrierStatus(
  baseOperation,
  { close: 100, high: 108, low: 95, dividendsTotal: 0 },
  { high: 'auto', low: 'auto', stickyHighHit: true },
)
assert.equal(statusSticky.high, true)
assert.equal(statusSticky.source.high, 'sticky')
const statusStickyManualNoHit = computeBarrierStatus(
  baseOperation,
  { close: 100, high: 108, low: 95, dividendsTotal: 0 },
  { high: 'nohit', low: 'auto', stickyHighHit: true },
)
assert.equal(statusStickyManualNoHit.high, false)

const overriddenParams = applyOverridesToOperation(baseOperation, {
  strikeOverride: 120,
  barrierValueOverride: 95,
  barrierTypeOverride: 'KI',
})
assert.notEqual(overriddenParams, baseOperation)
assert.notEqual(overriddenParams.pernas, baseOperation.pernas)
assert.equal(baseOperation.pernas[0].strike, 100)
assert.equal(overriddenParams.pernas[0].strikeAjustado, 120)
assert.equal(overriddenParams.pernas[0].barreiraValor, 95)
assert.equal(overriddenParams.pernas[0].barreiraTipo, 'KI')

const statusAutoWithOverrides = computeBarrierStatus(overriddenParams, market, { high: 'auto', low: 'auto' })
assert.equal(statusAutoWithOverrides.low, true)

const statusManualHit = computeBarrierStatus(overriddenParams, market, { high: 'hit', low: 'auto' })
assert.equal(statusManualHit.high, true)

const opUi = {
  id: 'op-test-ui',
  spotInicial: 100,
  pernas: [{ id: 'ui-leg', tipo: 'CALL', side: 'long', strike: 100, barreiraTipo: 'UI', barreiraValor: 110 }],
}
const statusUi = computeBarrierStatus(opUi, { close: 100, high: 112, low: 98 }, { high: 'auto', low: 'auto' })
assert.equal(statusUi.high, true)

const opKo = {
  id: 'op-test-ko',
  spotInicial: 100,
  pernas: [{ id: 'ko-leg', tipo: 'PUT', side: 'long', strike: 100, barreiraTipo: 'KO', barreiraValor: 95 }],
}
const statusKo = computeBarrierStatus(opKo, { close: 100, high: 102, low: 94 }, { high: 'auto', low: 'auto' })
assert.equal(statusKo.low, true)

const sideOperation = {
  id: 'op-test-side',
  estrutura: 'Kite',
  quantidade: 1,
  custoUnitario: 0,
  spotInicial: 100,
  pernas: [
    { id: 'call-1', tipo: 'CALL', side: 'long', strike: 100, quantidade: 1 },
    { id: 'put-1', tipo: 'PUT', side: 'long', strike: 100, quantidade: 1 },
  ],
}

const sideOverridden = applyOverridesToOperation(sideOperation, {
  optionSide: 'PUT',
  optionQtyOverride: 7,
  strikeOverride: 120,
})
assert.equal(sideOverridden.pernas[0].strike, 100)
assert.equal(sideOverridden.pernas[1].strike, 120)
assert.equal(sideOverridden.pernas[0].quantidade, 1)
assert.equal(sideOverridden.pernas[1].quantidade, 7)

const simpleCall = {
  id: 'op-test-simple-call',
  estrutura: 'Call',
  quantidade: 1,
  custoUnitario: 0,
  spotInicial: 100,
  pernas: [{ id: 'call-simple', tipo: 'CALL', side: 'long', strike: 100, quantidade: 1 }],
}
const simpleCallStatus = computeBarrierStatus(simpleCall, { close: 110, high: 110, low: 100 }, { high: 'auto', low: 'auto' })
assert.equal(simpleCallStatus.list.length, 0)
const simpleCallResult = computeResult(simpleCall, { close: 110, high: 110, low: 100, dividendsTotal: 0 }, simpleCallStatus, {})
assert.equal(simpleCallResult.ganhoCall, 10)
const simpleCallLocked = {
  ...simpleCall,
  pernas: [{ ...simpleCall.pernas[0], settlementSpotOverride: 105 }],
}
const simpleCallLockedResult = computeResult(
  simpleCallLocked,
  { close: 130, high: 130, low: 100, dividendsTotal: 0 },
  simpleCallStatus,
  {},
)
assert.equal(simpleCallLockedResult.ganhoCall, 5)
const simpleCallOverridden = applyOverridesToOperation(simpleCall, { optionQtyOverride: 3, optionSide: 'CALL' })
const simpleCallResultOverridden = computeResult(
  simpleCallOverridden,
  { close: 110, high: 110, low: 100, dividendsTotal: 0 },
  simpleCallStatus,
  {},
)
assert.equal(simpleCallResultOverridden.ganhoCall, 30)

const callSpread = {
  id: 'op-test-call-spread',
  estrutura: 'Call Spread',
  quantidade: 0,
  custoUnitario: 4.35,
  custoUnitarioCliente: -0.04,
  spotInicial: 4.35,
  pernas: [
    { id: 'call-short', tipo: 'CALL', side: 'short', strike: 6.09, quantidade: -200 },
    { id: 'call-long', tipo: 'CALL', side: 'long', strike: 5.44, quantidade: 200 },
  ],
}
const callSpreadStatus = computeBarrierStatus(callSpread, { close: 5.7, high: 5.7, low: 4.35 }, { high: 'auto', low: 'auto' })
const callSpreadResult = computeResult(callSpread, { close: 5.7, high: 5.7, low: 4.35, dividendsTotal: 0 }, callSpreadStatus, {})
assert.ok(Math.abs(callSpreadResult.valorEntrada - 34.8) < 1e-9)
assert.ok(Math.abs(callSpreadResult.vendaAtivo - 51.99999999999996) < 1e-9)
assert.ok(Math.abs(callSpreadResult.financeiroFinal - 17.19999999999996) < 1e-9)
assert.equal(callSpreadResult.valorEntradaIncomplete, false)
assert.equal(callSpreadResult.valorEntradaComponents.optionQty, 200)
assert.ok(Math.abs(callSpreadResult.valorEntradaComponents.optionUnitCost - 0.174) < 1e-9)
assert.equal(callSpreadResult.valorEntradaComponents.stockValue, 4.35)

const putSpread = {
  id: 'op-test-put-spread',
  estrutura: 'Put Spread',
  quantidade: 0,
  custoUnitario: 155.3,
  custoUnitarioCliente: -6.13,
  spotInicial: 155.3,
  pernas: [
    { id: 'put-long', tipo: 'PUT', side: 'long', strike: 155.3, quantidade: 850 },
    { id: 'put-short', tipo: 'PUT', side: 'short', strike: 139.77, quantidade: -850 },
  ],
}
const putSpreadStatus = computeBarrierStatus(putSpread, { close: 145, high: 155.3, low: 145 }, { high: 'auto', low: 'auto' })
const putSpreadResult = computeResult(putSpread, { close: 145, high: 155.3, low: 145, dividendsTotal: 0 }, putSpreadStatus, {})
assert.ok(Math.abs(putSpreadResult.valorEntrada - 8091.9065) < 1e-6)
assert.ok(Math.abs(putSpreadResult.vendaAtivo - 8755.00000000001) < 1e-6)
assert.ok(Math.abs(putSpreadResult.financeiroFinal - 663.093500000009) < 1e-6)
assert.equal(putSpreadResult.valorEntradaIncomplete, false)
assert.ok(Math.abs(putSpreadResult.valorEntradaComponents.optionUnitCost - 9.51989) < 1e-6)

const putSpreadQtyAtualOnly = {
  id: 'op-test-put-spread-qty-atual',
  estrutura: 'Put Spread',
  quantidade: 0,
  quantidadeAtual: 850,
  qtyAtual: 850,
  custoUnitario: 155.3,
  custoUnitarioCliente: -6.13,
  spotInicial: 155.3,
  pernas: [
    { id: 'put-long', tipo: 'PUT', side: 'long', strike: 155.3, quantidade: 0, quantidadeEfetiva: 0 },
    { id: 'put-short', tipo: 'PUT', side: 'short', strike: 139.77, quantidade: 0, quantidadeEfetiva: 0 },
  ],
}
const putSpreadQtyAtualOnlyStatus = computeBarrierStatus(
  putSpreadQtyAtualOnly,
  { close: 145, high: 155.3, low: 145 },
  { high: 'auto', low: 'auto' },
)
const putSpreadQtyAtualOnlyResult = computeResult(
  putSpreadQtyAtualOnly,
  { close: 145, high: 155.3, low: 145, dividendsTotal: 0 },
  putSpreadQtyAtualOnlyStatus,
  {},
)
assert.equal(putSpreadQtyAtualOnlyResult.valorEntradaIncomplete, false)
assert.ok(Math.abs((putSpreadQtyAtualOnlyResult.valorEntrada || 0) - (6.13 * 850)) < 1e-9)
assert.equal(putSpreadQtyAtualOnlyResult.valorEntradaComponents.optionQty, 850)

const recurringCouponEuropean = {
  id: 'op-test-cupom-recorrente-europeia',
  estrutura: 'Cupom Recorrente Europeia',
  quantidade: 0,
  custoUnitario: 25.71,
  spotInicial: 25.71,
  pernas: [
    {
      id: 'put-long',
      tipo: 'PUT',
      side: 'long',
      quantidade: 1300,
      quantidadeAtiva: 1300,
      quantidadeContratada: 1300,
      strike: 23.39,
      barreiraTipo: 'KO',
      barreiraValor: 20.66,
    },
    {
      id: 'call-short-1',
      tipo: 'CALL',
      side: 'short',
      quantidade: -1300,
      quantidadeAtiva: -1300,
      quantidadeContratada: -1300,
      strike: 23.39,
      barreiraTipo: 'KO',
      barreiraValor: 20.66,
    },
    {
      id: 'call-short-2',
      tipo: 'CALL',
      side: 'short',
      quantidade: -1300,
      quantidadeAtiva: -1300,
      quantidadeContratada: -1300,
      strike: 20.33,
    },
  ],
}
assert.equal(inferOperationQuantityBase(recurringCouponEuropean), 1300)
assert.equal(inferOperationQuantityAtual(recurringCouponEuropean), 1300)
const popWithHalfShortCall = {
  id: 'op-test-pop-prioridade-put',
  estrutura: 'POP',
  quantidade: 0,
  pernas: [
    { id: 'call-short-half', tipo: 'CALL', side: 'short', quantidadeAtiva: -500, quantidadeContratada: -500, quantidade: -500 },
    { id: 'put-long-full', tipo: 'PUT', side: 'long', quantidadeAtiva: 1000, quantidadeContratada: 1000, quantidade: 1000 },
  ],
}
assert.equal(inferOperationQuantityBase(popWithHalfShortCall), 1000)
assert.equal(inferOperationQuantityAtual(popWithHalfShortCall), 1000)
const recurringCouponClosed = {
  ...recurringCouponEuropean,
  id: 'op-test-cupom-recorrente-fechado',
  pernas: recurringCouponEuropean.pernas.map((leg) => ({
    ...leg,
    quantidadeAtiva: 0,
  })),
}
assert.equal(inferOperationQuantityBase(recurringCouponClosed), 0)
assert.equal(inferOperationQuantityAtual(recurringCouponClosed), 0)
const recurringCouponStatus = computeBarrierStatus(
  recurringCouponEuropean,
  { close: 19, high: 25.71, low: 19, dividendsTotal: 0 },
  { high: 'auto', low: 'auto' },
)
assert.equal(recurringCouponStatus.low, true)
const recurringCouponResult = computeResult(
  recurringCouponEuropean,
  { close: 19, high: 25.71, low: 19, dividendsTotal: 0 },
  recurringCouponStatus,
  {},
)
assert.equal(recurringCouponResult.qtyBase, 1300)
assert.equal(recurringCouponResult.qtyAtual, 1300)
assert.equal(recurringCouponResult.pagou, 33423)
assert.equal(recurringCouponResult.valorSaida, 24700)
assert.equal(recurringCouponResult.vendaAtivo, 24700)

const legacyBarrierOverridden = applyOverridesToOperation(baseOperation, {
  barrierTypeOverride: 'KO',
  legacyBarrierType: true,
})
assert.equal(legacyBarrierOverridden.pernas[0].barreiraTipo, 'UO')

const opNoBarrier = {
  id: 'op-test-2',
  estrutura: 'Kite',
  quantidade: 1,
  custoUnitario: 0,
  spotInicial: 100,
  pernas: [
    {
      id: 'leg-2',
      tipo: 'CALL',
      side: 'long',
      strike: 100,
      quantidade: 1,
    },
  ],
}
const resultMarket = { close: 110, dividendsTotal: 0 }
const noBarrierStatus = computeBarrierStatus(opNoBarrier, resultMarket, { high: 'auto', low: 'auto' })
assert.equal(noBarrierStatus.list.length, 0)
const resultBase = computeResult(opNoBarrier, resultMarket, noBarrierStatus, {})
const opStrikeOverridden = applyOverridesToOperation(opNoBarrier, { strikeOverride: 120 })
const noBarrierStatusOverridden = computeBarrierStatus(opStrikeOverridden, resultMarket, { high: 'auto', low: 'auto' })
const resultOverridden = computeResult(opStrikeOverridden, resultMarket, noBarrierStatusOverridden, {})
assert.equal(resultBase.ganhoCall, 10)
assert.equal(resultOverridden.ganhoCall, 0)

const normalizedOverride = updateOverride({}, 'op-test-3', {
  optionQtyOverride: '2,5',
  optionExpiryDateOverride: '31/01/2026',
  strikeOverride: '1.234,56',
  barrierValueOverride: '2.345,67',
  barrierTypeOverride: 'ko',
  optionSide: 'put',
})
assert.equal(normalizedOverride['op-test-3'].optionQtyOverride, 2.5)
assert.equal(normalizedOverride['op-test-3'].optionExpiryDateOverride, '2026-01-31')
assert.equal(normalizedOverride['op-test-3'].strikeOverride, 1234.56)
assert.equal(normalizedOverride['op-test-3'].barrierValueOverride, 2345.67)
assert.equal(normalizedOverride['op-test-3'].barrierTypeOverride, 'KO')
assert.equal(normalizedOverride['op-test-3'].optionSide, 'PUT')
assert.equal(normalizedOverride['op-test-3'].structure.target.side, 'PUT')
assert.equal(normalizedOverride['op-test-3'].structure.optionQty, 2.5)
assert.equal(normalizedOverride['op-test-3'].structure.optionExpiryDate, '2026-01-31')
assert.equal(normalizedOverride['op-test-3'].manualCouponBRL, null)
const normalizedQtyOverride = updateOverride({}, 'op-test-qty-base', {
  qtyBaseOverride: '1000',
  qtyBonus: '200',
  bonusDate: '04/04/2024',
})
assert.equal(normalizedQtyOverride['op-test-qty-base'].qtyBaseOverride, 1000)
assert.equal(normalizedQtyOverride['op-test-qty-base'].qtyBonus, 200)
assert.equal(normalizedQtyOverride['op-test-qty-base'].bonusDate, '04/04/2024')
const stickyOverride = updateOverride({}, 'op-test-sticky', {
  stickyHighHit: true,
  stickyLowHit: true,
  stickyHighHitAt: '31/01/2026',
  stickyLowHitAt: '2026-02-01',
})
assert.equal(stickyOverride['op-test-sticky'].stickyHighHit, true)
assert.equal(stickyOverride['op-test-sticky'].stickyLowHit, true)
assert.equal(stickyOverride['op-test-sticky'].stickyHighHitAt, '2026-01-31')
assert.equal(stickyOverride['op-test-sticky'].stickyLowHitAt, '2026-02-01')

assert.ok(strategyTemplateOptions.length >= 10)
assert.ok(strategyTemplateOptions.some((entry) => entry.value === 'put_spread'))
assert.ok(strategyTemplateOptions.some((entry) => entry.value === 'smart_coupon' && entry.label === 'Smart Coupon'))
assert.deepEqual(
  strategyTemplateOptions.map((entry) => entry.label),
  [...strategyTemplateOptions.map((entry) => entry.label)].sort((left, right) => left.localeCompare(right, 'pt-BR', { sensitivity: 'base' })),
)
assert.ok(strategyTemplateOptions.some((entry) => entry.value === 'call'))
assert.ok(strategyTemplateOptions.some((entry) => entry.value === 'put'))
assert.ok(strategyTemplateOptions.some((entry) => entry.value === 'collar_ui'))
assert.ok(strategyTemplateOptions.some((entry) => entry.value === 'rubi_black'))

const collarDefaults = getStrategyDefaults('collar_ui')
assert.equal(collarDefaults.ticker, 'BCPX39')
assert.ok(Array.isArray(collarDefaults.options))
assert.ok(collarDefaults.options.length >= 2)

const collarUiBidirecionalDefaults = getStrategyDefaults('collar_ui_bidirecional')
assert.equal(collarUiBidirecionalDefaults.options.length, 3)
assert.deepEqual(
  collarUiBidirecionalDefaults.options.map((entry) => `${entry.optionType}:${entry.side}:${entry.strike}:${entry.barrierType}:${entry.barrierValue}`),
  [
    'PUT:long:100::',
    'PUT:long:100:KO:85',
    'CALL:short:114:UI:150',
  ],
)

const docBidirecionalDefaults = getStrategyDefaults('doc_bidirecional')
assert.equal(docBidirecionalDefaults.options.length, 4)
assert.deepEqual(
  docBidirecionalDefaults.options.map((entry) => `${entry.optionType}:${entry.side}:${entry.strike}:${entry.barrierType}:${entry.barrierValue}`),
  [
    'PUT:long:100:KO:70',
    'PUT:long:107:UI:125',
    'CALL:long:100:UO:125',
    'CALL:short:107:UI:125',
  ],
)

const collarFields = getStrategyFields('collar_ui')
assert.ok(collarFields.some((field) => field.key === 'barrierUpPct'))
assert.ok(collarFields.some((field) => field.key === 'capAfterPct'))
assert.ok(collarFields.some((field) => field.key === 'stockQuantity'))
const putSpreadFields = getStrategyFields('put_spread')
assert.ok(putSpreadFields.some((field) => field.key === 'optionCostPct'))
const callSpreadFields = getStrategyFields('call_spread')
assert.ok(callSpreadFields.some((field) => field.key === 'optionCostPct'))
const alocacaoFields = getStrategyFields('alocacao_protegida')
assert.ok(alocacaoFields.some((field) => field.key === 'optionCostPct'))

const collarOptionForm = getStrategyOptionForm('collar_ui')
assert.equal(collarOptionForm.enabled, true)
assert.equal(collarOptionForm.showStrike, true)
assert.equal(collarOptionForm.showBarrier, true)

const cupomOptionForm = getStrategyOptionForm('cupom_recorrente')
assert.equal(cupomOptionForm.showBarrier, true)
assert.equal(cupomOptionForm.showCoupon, true)

const rubiBlackOptionForm = getStrategyOptionForm('rubi_black')
assert.equal(rubiBlackOptionForm.enabled, true)
assert.equal(rubiBlackOptionForm.showStrike, true)
assert.equal(rubiBlackOptionForm.showBarrier, true)

const smartCouponOptionForm = getStrategyOptionForm('smart_coupon')
assert.equal(smartCouponOptionForm.enabled, true)
assert.equal(smartCouponOptionForm.showStrike, true)
assert.equal(smartCouponOptionForm.showBarrier, true)
assert.equal(smartCouponOptionForm.showCoupon, false)

const rubiBlackDefaults = getStrategyDefaults('rubi_black')
assert.equal(rubiBlackDefaults.options.length, 2)
assert.deepEqual(
  rubiBlackDefaults.options.map((entry) => `${entry.optionType}:${entry.side}:${entry.barrierType}`),
  ['CALL:short:KO', 'PUT:long:KO'],
)

const smartCouponDefaults = getStrategyDefaults('smart_coupon')
assert.equal(smartCouponDefaults.options.length, 2)
assert.deepEqual(
  smartCouponDefaults.options.map((entry) => `${entry.optionType}:${entry.side}:${entry.barrierType}`),
  ['CALL:short:KO', 'PUT:long:KO'],
)

const cupomDefaults = getStrategyDefaults('cupom_recorrente')
assert.equal(cupomDefaults.options.length, 1)
assert.equal(cupomDefaults.options[0].optionType, 'PUT')
assert.equal(cupomDefaults.options[0].barrierType, 'KO')
assert.equal(cupomDefaults.options[0].coupon, '8')

const cupomRecorrenteModel = buildStrategyModel('cupom_recorrente', cupomDefaults)
assert.equal(cupomRecorrenteModel.metrics.find((metric) => metric.label === 'Cupom nominal')?.value, '8,00%')
assert.ok(cupomRecorrenteModel.highlights.includes('Cupons recorrentes de 2,00% ao mes'))
assert.ok(cupomRecorrenteModel.generatedMessage.includes('cupons recorrentes de 2,00% ao mes'))

const smartCouponModel = buildStrategyModel('smart_coupon', getStrategyDefaults('smart_coupon'))
assert.equal(smartCouponModel.templateLabel, 'Smart Coupon')
assert.equal(smartCouponModel.metrics.find((metric) => metric.label === 'Cupom')?.value, '8,00%')
assert.ok(smartCouponModel.highlights.includes('Barreira validada apenas no vencimento'))
assert.ok(smartCouponModel.generatedMessage.includes('Apenas no vencimento'))

const smartCouponImported = extractCardDataFromImageText({
  text: 'Smart Coupon\nCupom nominal 8%\nBarreira de baixa 20%',
})
assert.equal(smartCouponImported.templateId, 'smart_coupon')
assert.deepEqual(
  smartCouponImported.options.map((entry) => `${entry.optionType}:${entry.side}:${entry.strike}:${entry.barrierType}:${entry.barrierValue}`),
  [
    'CALL:short:108:KO:80',
    'PUT:long:108:KO:80',
  ],
)

const cupomRecorrenteImported = extractCardDataFromImageText({
  text: 'Cupom Recorrente\nCupom nominal 8%\nBarreira de baixa 16,65%',
})
assert.equal(cupomRecorrenteImported.templateId, 'cupom_recorrente')
assert.deepEqual(
  cupomRecorrenteImported.options.map((entry) => `${entry.optionType}:${entry.side}:${entry.strike}:${entry.barrierType}:${entry.barrierValue}:${entry.coupon}`),
  ['PUT:long:100:KO:83,35:8'],
)

const putSpreadOptionForm = getStrategyOptionForm('put_spread')
assert.equal(putSpreadOptionForm.showBarrier, false)

const callOptionForm = getStrategyOptionForm('call')
assert.equal(callOptionForm.enabled, true)
assert.equal(callOptionForm.showStrike, true)
assert.equal(callOptionForm.showBarrier, false)

const putOptionForm = getStrategyOptionForm('put')
assert.equal(putOptionForm.enabled, true)
assert.equal(putOptionForm.showStrike, true)
assert.equal(putOptionForm.showBarrier, false)

const genericOption = createStrategyOptionEntry('collar_ui', { optionType: 'put', side: 'short', barrierType: 'ki', barrierValue: '20' })
assert.equal(genericOption.optionType, 'PUT')
assert.equal(genericOption.side, 'short')
assert.equal(genericOption.barrierType, 'KI')
assert.equal(genericOption.barrierValue, '20')

const collarModel = buildStrategyModel('collar_ui', {
  ticker: 'BCPX39',
  maturityDate: '2026-09-29',
  barrierUpPct: '36,99',
  capAfterPct: '7',
  protectionPct: '90',
})
assert.ok(collarModel.generatedMessage.includes('*Collar UI em BCPX39*'))
assert.ok(collarModel.generatedMessage.includes('igual ou superior a 36,99%'))
assert.ok(collarModel.generatedMessage.includes('limitado a 7,00%'))
assert.ok(collarModel.payoffRows.some((row) => Math.abs(row.underlyingVarPct - 36.99) < 1e-9))
assert.equal(collarModel.optionForm.enabled, true)
assert.ok(Array.isArray(collarModel.optionEntries))
assert.ok(collarModel.optionEntries.length >= 2)
assert.ok(collarModel.payoffRows.length >= 2)
assert.ok(collarModel.payoffRows[0].underlyingVarPct >= collarModel.payoffRows[1].underlyingVarPct)

const docBidirecionalModel = buildStrategyModel('doc_bidirecional', docBidirecionalDefaults)
assert.equal(docBidirecionalModel.optionEntries.length, 4)
assert.ok(!docBidirecionalModel.validations.some((message) => String(message).includes('Inclua')))

const collarUiBidirecionalModel = buildStrategyModel('collar_ui_bidirecional', collarUiBidirecionalDefaults)
assert.equal(collarUiBidirecionalModel.optionEntries.length, 3)
assert.ok(collarUiBidirecionalModel.generatedMessage.includes('*Collar UI Bidirecional em'))
const collarUiBidiHighBeforeBarrier = collarUiBidirecionalModel.payoffRows.filter((row) => row.underlyingVarPct > 0 && row.underlyingVarPct < 50)
const collarUiBidiHighAfterBarrier = collarUiBidirecionalModel.payoffRows.filter((row) => row.underlyingVarPct >= 50)
const collarUiBidiLowBeforeBarrier = collarUiBidirecionalModel.payoffRows.filter((row) => row.underlyingVarPct < 0 && row.underlyingVarPct > -15)
const collarUiBidiLowAfterBarrier = collarUiBidirecionalModel.payoffRows.filter((row) => row.underlyingVarPct <= -15)
assert.ok(collarUiBidirecionalModel.payoffRows.some((row) => row.underlyingVarPct === 50))
assert.equal(collarUiBidiHighBeforeBarrier.length, 3)
assert.equal(collarUiBidiHighAfterBarrier.length, 3)
assert.equal(collarUiBidiLowBeforeBarrier.length, 3)
assert.equal(collarUiBidiLowAfterBarrier.length, 3)
assert.ok(collarUiBidirecionalModel.payoffRows.some((row) => row.underlyingVarPct === 5))
assert.ok(collarUiBidirecionalModel.payoffRows.some((row) => row.underlyingVarPct === 25))
assert.ok(collarUiBidirecionalModel.payoffRows.some((row) => row.underlyingVarPct === 49.99))
assert.ok(collarUiBidirecionalModel.payoffRows.some((row) => row.underlyingVarPct === -5))
assert.ok(collarUiBidirecionalModel.payoffRows.some((row) => row.underlyingVarPct === -7.5))
assert.ok(collarUiBidirecionalModel.payoffRows.some((row) => row.underlyingVarPct === -14.99))

const popQtyRatioModel = buildStrategyModel('pop', {
  ...getStrategyDefaults('pop'),
  options: [
    { optionType: 'CALL', side: 'long', strike: '100', useCustomQuantity: true, quantity: '500' },
    { optionType: 'CALL', side: 'short', strike: '100', useCustomQuantity: true, quantity: '1000' },
  ],
})
const popQtyInverseModel = buildStrategyModel('pop', {
  ...getStrategyDefaults('pop'),
  options: [
    { optionType: 'CALL', side: 'long', strike: '100', useCustomQuantity: true, quantity: '1000' },
    { optionType: 'CALL', side: 'short', strike: '100', useCustomQuantity: true, quantity: '500' },
  ],
})
const popQtyRatioRow = popQtyRatioModel.payoffRows.find((row) => row.underlyingVarPct === 20)
const popQtyInverseRow = popQtyInverseModel.payoffRows.find((row) => row.underlyingVarPct === 20)
const popQtyRatioTopRow = popQtyRatioModel.payoffRows.find((row) => row.underlyingVarPct === 30)
const popQtyRatioBottomRow = popQtyRatioModel.payoffRows.find((row) => row.underlyingVarPct === -30)
assert.ok(popQtyRatioRow)
assert.ok(popQtyInverseRow)
assert.ok(popQtyRatioTopRow)
assert.ok(popQtyRatioBottomRow)
assert.equal(popQtyRatioRow.strategyVarPct, 10)
assert.equal(popQtyInverseRow.strategyVarPct, 30)

const qtyAdjustedOperation = {
  id: 'op-test-qty-adjusted',
  estrutura: 'POP',
  quantidade: 1200,
  quantidadeAtual: 1200,
}
const qtyAdjustedResolved = resolveOperationQuantities(qtyAdjustedOperation, 200, 1000)
assert.equal(qtyAdjustedResolved.displayQtyBase, 1000)
assert.equal(qtyAdjustedResolved.displayQtyBonus, 200)
assert.equal(qtyAdjustedResolved.displayQtyAtual, 1200)
assert.equal(qtyAdjustedResolved.settlementQtyBase, 1000)
assert.equal(qtyAdjustedResolved.settlementQtyBonus, 200)
assert.equal(qtyAdjustedResolved.settlementQtyAtual, 1200)

const qtyAdjustedDividendStatus = computeBarrierStatus(
  qtyAdjustedOperation,
  { close: 17.85, high: 21.2, low: 17.85 },
  { high: 'auto', low: 'auto' },
)
const qtyAdjustedDividendResult = computeResult(
  {
    ...qtyAdjustedOperation,
    qtyBase: qtyAdjustedResolved.settlementQtyBase,
    qtyBonus: qtyAdjustedResolved.settlementQtyBonus,
    qtyAtual: qtyAdjustedResolved.settlementQtyAtual,
  },
  { close: 17.85, high: 21.2, low: 17.85, dividendsTotal: 0.8 },
  qtyAdjustedDividendStatus,
  {},
)
assert.equal(qtyAdjustedDividendResult.qtyBase, 1000)
assert.equal(qtyAdjustedDividendResult.qtyBonus, 200)
assert.equal(qtyAdjustedDividendResult.qtyAtual, 1200)
assert.equal(qtyAdjustedDividendResult.dividends, 960)

const popBaseQtyRefModel = buildStrategyModel('pop', {
  ...getStrategyDefaults('pop'),
  stockQuantity: '2000',
  options: [
    { optionType: 'CALL', side: 'short', strike: '100', useCustomQuantity: true, quantity: '1000' },
  ],
})
const popBaseQtyRefRow = popBaseQtyRefModel.payoffRows.find((row) => row.underlyingVarPct === 20)
assert.ok(popBaseQtyRefRow)
assert.equal(popBaseQtyRefRow.strategyVarPct, 10)

const clientFilterOptions = buildClientFilterOptions([
  { codigoCliente: '2568493', cliente: 'Cliente Exemplo' },
  { codigoCliente: '0002568493', cliente: 'Cliente Exemplo' },
  { codigoCliente: '', cliente: 'Cliente Sem Codigo' },
])
assert.ok(clientFilterOptions.some((option) => option.value === '2568493' && option.label.includes('Cliente Exemplo')))
const clientFilterSet = buildClientFilterMatchSet(['2568493'], new Set(['2568493', 'Cliente Exemplo']))
assert.equal(matchesClientFilter({ codigoCliente: '0002568493', cliente: 'Cliente Exemplo' }, clientFilterSet), true)
assert.equal(matchesClientFilter({ codigoCliente: '777', cliente: 'Outro Cliente' }, clientFilterSet), false)

const popAdjustedDebitOperation = {
  id: 'op-test-pop-adjusted-debit',
  estrutura: 'POP',
  quantidade: 1200,
  custoUnitario: 21.2,
  spotInicial: 21.2,
  pernas: [
    { id: 'call-short-adjusted', tipo: 'CALL', side: 'short', strike: 16.35, quantidade: 600 },
  ],
}
const popAdjustedDebitStatus = computeBarrierStatus(
  popAdjustedDebitOperation,
  { close: 17.85, high: 21.2, low: 17.85 },
  { high: 'auto', low: 'auto' },
)
const popAdjustedDebitResult = computeResult(
  popAdjustedDebitOperation,
  { close: 17.85, high: 21.2, low: 17.85, dividendsTotal: 0 },
  popAdjustedDebitStatus,
  {},
)
assert.ok(Math.abs(popAdjustedDebitResult.ganhoCall + 900) < 1e-9)
assert.ok(Math.abs(popAdjustedDebitResult.debito + 900) < 1e-9)

const nonPopDebitOperation = {
  id: 'op-test-non-pop-debit',
  estrutura: 'Collar',
  quantidade: 1200,
  custoUnitario: 21.2,
  spotInicial: 21.2,
  pernas: [
    { id: 'call-short-full', tipo: 'CALL', side: 'short', strike: 16.35, quantidade: 1200 },
  ],
}
const nonPopDebitStatus = computeBarrierStatus(
  nonPopDebitOperation,
  { close: 17.85, high: 21.2, low: 17.85 },
  { high: 'auto', low: 'auto' },
)
const nonPopDebitResult = computeResult(
  nonPopDebitOperation,
  { close: 17.85, high: 21.2, low: 17.85, dividendsTotal: 0 },
  nonPopDebitStatus,
  {},
)
assert.ok(Math.abs(nonPopDebitResult.debito + 1800) < 1e-9)

const nonPopPutDebitOperation = {
  id: 'op-test-non-pop-put-debit',
  estrutura: 'Collar',
  quantidade: 1000,
  custoUnitario: 21.2,
  spotInicial: 21.2,
  pernas: [
    { id: 'put-short-full', tipo: 'PUT', side: 'short', strike: 20, quantidade: 1000 },
  ],
}
const nonPopPutDebitStatus = computeBarrierStatus(
  nonPopPutDebitOperation,
  { close: 14.8, high: 21.2, low: 14.8 },
  { high: 'auto', low: 'auto' },
)
const nonPopPutDebitResult = computeResult(
  nonPopPutDebitOperation,
  { close: 14.8, high: 21.2, low: 14.8, dividendsTotal: 0 },
  nonPopPutDebitStatus,
  {},
)
assert.ok(Math.abs(nonPopPutDebitResult.ganhoPut + 5200) < 1e-9)
assert.ok(Math.abs(nonPopPutDebitResult.debito + 5200) < 1e-9)

const putSpreadModel = buildStrategyModel('put_spread', {
  ticker: 'PETR4',
  maturityDate: '2026-12-15',
  startDownPct: '-5',
  limitDownPct: '-25',
  maxGainPct: '18',
  premiumPct: '3',
})
const positivePutSpreadRow = putSpreadModel.payoffRows.find((row) => row.underlyingVarPct === 10)
assert.ok(positivePutSpreadRow)
assert.ok(positivePutSpreadRow.strategyVarPct < 0)
assert.equal(putSpreadModel.validations.length, 0)
assert.ok(putSpreadModel.payoffRows.length >= 2)
assert.ok(putSpreadModel.payoffRows[0].underlyingVarPct >= putSpreadModel.payoffRows[1].underlyingVarPct)

const callSpreadCostModel = buildStrategyModel('call_spread', {
  ...getStrategyDefaults('call_spread'),
  optionCostPct: '4',
})
const callSpreadZeroRow = callSpreadCostModel.payoffRows.find((row) => row.underlyingVarPct === 0)
assert.ok(callSpreadZeroRow)
assert.equal(callSpreadZeroRow.strategyVarPct, -4)

const callModel = buildStrategyModel('call', {
  ...getStrategyDefaults('call'),
  optionCostPct: '4',
  options: [{ optionType: 'CALL', side: 'long', strike: '100', useCustomQuantity: true, quantity: '1000' }],
})
const callModelZeroRow = callModel.payoffRows.find((row) => row.underlyingVarPct === 0)
const callModelUpRow = callModel.payoffRows.find((row) => row.underlyingVarPct === 10)
assert.ok(callModelZeroRow)
assert.ok(callModelUpRow)
assert.equal(callModelZeroRow.strategyVarPct, -100)
assert.equal(callModelUpRow.strategyVarPct, 150)

const callSpreadLeveragedModel = buildStrategyModel('call_spread', {
  ...getStrategyDefaults('call_spread'),
  optionCostPct: '4',
  options: [
    { optionType: 'CALL', side: 'long', strike: '100', useCustomQuantity: true, quantity: '1000' },
    { optionType: 'CALL', side: 'short', strike: '130', useCustomQuantity: true, quantity: '1000' },
  ],
})
const callSpreadLeveragedNear = callSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === 5)
const callSpreadLeveragedMid = callSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === 15)
const callSpreadLeveragedBeforeCap = callSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === 29.99)
const callSpreadLeveragedAfterCap1 = callSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === 35)
const callSpreadLeveragedAfterCap2 = callSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === 40)
const callSpreadLeveragedBreakeven = callSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === 4)
assert.ok(callSpreadLeveragedNear)
assert.ok(callSpreadLeveragedMid)
assert.ok(callSpreadLeveragedBeforeCap)
assert.ok(callSpreadLeveragedAfterCap1)
assert.ok(callSpreadLeveragedAfterCap2)
assert.ok(callSpreadLeveragedBreakeven)
assert.equal(callSpreadLeveragedNear.strategyVarPct, 25)
assert.equal(callSpreadLeveragedMid.strategyVarPct, 275)
assert.equal(callSpreadLeveragedBeforeCap.strategyVarPct, 649.75)
assert.equal(callSpreadLeveragedAfterCap1.strategyVarPct, 650)
assert.equal(callSpreadLeveragedAfterCap2.strategyVarPct, 650)
assert.equal(callSpreadLeveragedBreakeven.strategyVarPct, 0)

const putSpreadCostModel = buildStrategyModel('put_spread', {
  ...getStrategyDefaults('put_spread'),
  optionCostPct: '6',
})
const putSpreadZeroRow = putSpreadCostModel.payoffRows.find((row) => row.underlyingVarPct === 0)
assert.ok(putSpreadZeroRow)
assert.equal(putSpreadZeroRow.strategyVarPct, -6)

const putSpreadFeeRealModel = buildStrategyModel('put_spread', {
  ...getStrategyDefaults('put_spread'),
  optionCostPct: '3,39',
  feeAai: '0,68%',
})
assert.equal(putSpreadFeeRealModel.footer.feeAaiReal, '20,059%')

const putSpreadBreakevenModel = buildStrategyModel('put_spread', {
  ...getStrategyDefaults('put_spread'),
  optionCostPct: '3,39',
  feeAai: '0,68%',
  options: [
    { optionType: 'PUT', side: 'long', strike: '100', useCustomQuantity: true, quantity: '1000' },
    { optionType: 'PUT', side: 'short', strike: '92,02', useCustomQuantity: true, quantity: '1000' },
  ],
})
const putSpreadBreakevenRow = putSpreadBreakevenModel.payoffRows.find((row) => row.strategyVarPct === 0)
assert.ok(putSpreadBreakevenRow)
assert.equal(putSpreadBreakevenRow.underlyingVarPct, -3.39)

const putModel = buildStrategyModel('put', {
  ...getStrategyDefaults('put'),
  optionCostPct: '4',
  options: [{ optionType: 'PUT', side: 'long', strike: '100', useCustomQuantity: true, quantity: '1000' }],
})
const putModelZeroRow = putModel.payoffRows.find((row) => row.underlyingVarPct === 0)
const putModelDownRow = putModel.payoffRows.find((row) => row.underlyingVarPct === -10)
assert.ok(putModelZeroRow)
assert.ok(putModelDownRow)
assert.equal(putModelZeroRow.strategyVarPct, -100)
assert.equal(putModelDownRow.strategyVarPct, 150)

const putSpreadLeveragedModel = buildStrategyModel('put_spread', {
  ...getStrategyDefaults('put_spread'),
  optionCostPct: '6',
  options: [
    { optionType: 'PUT', side: 'long', strike: '100', useCustomQuantity: true, quantity: '1000' },
    { optionType: 'PUT', side: 'short', strike: '80', useCustomQuantity: true, quantity: '1000' },
  ],
})
const putSpreadLeveragedNear = putSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === -5)
const putSpreadLeveragedMid = putSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === -10)
const putSpreadLeveragedBeforeCap = putSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === -19.99)
const putSpreadLeveragedAfterCap1 = putSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === -25)
const putSpreadLeveragedAfterCap2 = putSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === -30)
const putSpreadLeveragedBreakeven = putSpreadLeveragedModel.payoffRows.find((row) => row.underlyingVarPct === -6)
assert.ok(putSpreadLeveragedNear)
assert.ok(putSpreadLeveragedMid)
assert.ok(putSpreadLeveragedBeforeCap)
assert.ok(putSpreadLeveragedAfterCap1)
assert.ok(putSpreadLeveragedAfterCap2)
assert.ok(putSpreadLeveragedBreakeven)
assert.equal(putSpreadLeveragedNear.strategyVarPct, -16.67)
assert.equal(putSpreadLeveragedMid.strategyVarPct, 66.67)
assert.equal(putSpreadLeveragedBeforeCap.strategyVarPct, 233.17)
assert.equal(putSpreadLeveragedAfterCap1.strategyVarPct, 233.33)
assert.equal(putSpreadLeveragedAfterCap2.strategyVarPct, 233.33)
assert.equal(putSpreadLeveragedBreakeven.strategyVarPct, 0)

const alocacaoCostModel = buildStrategyModel('alocacao_protegida', {
  ...getStrategyDefaults('alocacao_protegida'),
  optionCostPct: '2',
})
const alocacaoZeroRow = alocacaoCostModel.payoffRows.find((row) => row.underlyingVarPct === 0)
assert.ok(alocacaoZeroRow)
assert.equal(alocacaoZeroRow.strategyVarPct, -1.96)

const collarUiSync = inferOptionSyncForTemplate('collar_ui', {
  ...getStrategyDefaults('collar_ui'),
  options: [
    { optionType: 'CALL', side: 'short', strike: '112', barrierType: 'UI', barrierValue: '130' },
    { optionType: 'PUT', side: 'long', strike: '90' },
  ],
})
assert.equal(collarUiSync.mode, 'template')
assert.equal(collarUiSync.appliedPatch.barrierUpPct, '30')
assert.equal(collarUiSync.appliedPatch.capAfterPct, '12')
assert.equal(collarUiSync.appliedPatch.protectionPct, '90')

const collarUiRowsFromOptions = buildStrategyModel('collar_ui', {
  ...getStrategyDefaults('collar_ui'),
  options: [
    { optionType: 'CALL', side: 'short', strike: '112', barrierType: 'UI', barrierValue: '130' },
    { optionType: 'PUT', side: 'long', strike: '90' },
  ],
})
const collarUiHasBarrierRow = collarUiRowsFromOptions.payoffRows.some((row) => row.underlyingVarPct === 30)
assert.equal(collarUiHasBarrierRow, true)

const collarUiRoundedBarrierRows = buildStrategyModel('collar_ui', {
  ...getStrategyDefaults('collar_ui'),
  options: [
    { optionType: 'CALL', side: 'short', strike: '107', barrierType: 'UI', barrierValue: '137' },
    { optionType: 'PUT', side: 'long', strike: '90' },
  ],
})
assert.ok(collarUiRoundedBarrierRows.payoffRows.some((row) => row.underlyingVarPct === 36.99))

const fenceUiRowsFromOptions = buildStrategyModel('fence_ui', {
  ...getStrategyDefaults('fence_ui'),
  options: [
    { optionType: 'CALL', side: 'short', strike: '108', barrierType: 'UI', barrierValue: '126' },
    { optionType: 'PUT', side: 'short', strike: '92' },
    { optionType: 'PUT', side: 'long', strike: '86' },
  ],
})
assert.ok(fenceUiRowsFromOptions.payoffRows.some((row) => row.underlyingVarPct === 26))

const boosterRowsFromOptions = buildStrategyModel('booster_ko', {
  ...getStrategyDefaults('booster_ko'),
  options: [
    { optionType: 'CALL', side: 'long', strike: '104' },
    { optionType: 'CALL', side: 'short', strike: '118', barrierType: 'UI', barrierValue: '132' },
  ],
})
assert.ok(boosterRowsFromOptions.payoffRows.some((row) => row.underlyingVarPct === 32))

const popNarrativeMode = buildStrategyModel('pop', {
  ...getStrategyDefaults('pop'),
  options: [
    { optionType: 'CALL', side: 'long', strike: '100', useCustomQuantity: true, quantity: '1000' },
    { optionType: 'CALL', side: 'short', strike: '115', useCustomQuantity: true, quantity: '700' },
  ],
})
assert.equal(popNarrativeMode.optionSync.mode, 'payoff')
assert.ok(popNarrativeMode.generatedMessage.includes('payoff'))

const invalidTemplateModel = buildStrategyModel('put_spread', {
  ticker: '',
  maturityDate: '',
  startDownPct: 'abc',
})
assert.ok(invalidTemplateModel.validations.length >= 2)

console.log('tests ok')
