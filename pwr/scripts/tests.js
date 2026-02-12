import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { normalizeDateKey } from '../src/utils/dateKey.js'
import { applyOverridesToOperation, computeBarrierStatus, computeResult } from '../src/services/settlement.js'
import { updateOverride } from '../src/services/overrides.js'
import {
  buildStrategyModel,
  createStrategyOptionEntry,
  getStrategyDefaults,
  getStrategyFields,
  getStrategyOptionForm,
  strategyTemplateOptions,
} from '../src/services/strategyTemplates.js'

const require = createRequire(import.meta.url)
const { sumDividendsInRange } = require('../../api/lib/dividends.js')

const dateKey = normalizeDateKey('2026-01-28')
assert.equal(dateKey, '2026-01-28')
assert.equal(normalizeDateKey('28/01/2026'), '2026-01-28')

const sampleDividends = [
  { dataCom: '2026-01-05', amount: 0.1, type: 'DIVIDEND' },
  { dataCom: '2026-01-28', amount: 0.2, type: 'JCP' },
  { dataCom: '2026-02-02', amount: 0.3, type: 'DIVIDEND' },
]
const total = sumDividendsInRange(sampleDividends, '2026-01-01', '2026-01-31')
assert.ok(Math.abs(total - (0.1 + 0.2 * 0.85)) < 1e-9)

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

assert.ok(strategyTemplateOptions.length >= 10)
assert.ok(strategyTemplateOptions.some((entry) => entry.value === 'put_spread'))
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

const rubiBlackDefaults = getStrategyDefaults('rubi_black')
assert.equal(rubiBlackDefaults.options.length, 2)
assert.deepEqual(
  rubiBlackDefaults.options.map((entry) => `${entry.optionType}:${entry.side}:${entry.barrierType}`),
  ['CALL:short:KO', 'PUT:long:'],
)

const cupomDefaults = getStrategyDefaults('cupom_recorrente')
assert.equal(cupomDefaults.options.length, 1)
assert.equal(cupomDefaults.options[0].optionType, 'PUT')
assert.equal(cupomDefaults.options[0].barrierType, 'KO')
assert.equal(cupomDefaults.options[0].coupon, '8')

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
assert.equal(collarUiBidiHighAfterBarrier.length, 2)
assert.equal(collarUiBidiLowBeforeBarrier.length, 3)
assert.equal(collarUiBidiLowAfterBarrier.length, 2)
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

const invalidTemplateModel = buildStrategyModel('put_spread', {
  ticker: '',
  maturityDate: '',
  startDownPct: 'abc',
})
assert.ok(invalidTemplateModel.validations.length >= 2)

console.log('tests ok')
