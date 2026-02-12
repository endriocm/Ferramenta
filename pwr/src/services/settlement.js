import { normalizeDateKey } from '../utils/dateKey.js'

const parsePercent = (value) => {
  if (value == null) return 0
  if (typeof value === 'number') return value
  const cleaned = String(value).replace('%', '').replace(',', '.')
  const parsed = Number(cleaned)
  if (Number.isNaN(parsed)) return 0
  return parsed / 100
}

const toNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeDateOverride = (value) => {
  if (value == null) return null
  const normalized = normalizeDateKey(String(value).trim())
  return normalized || null
}

const normalizeOptionSide = (value) => {
  if (value == null) return null
  const raw = String(value).trim().toUpperCase()
  if (!raw) return null
  if (raw === 'CALL' || raw === 'PUT') return raw
  return null
}

const normalizeBarrierTypeOverride = (value, directionHint = null) => {
  if (value == null) return null
  const raw = String(value).trim().toUpperCase()
  if (!raw || raw === 'AUTO') return null
  if (raw === 'NONE' || raw === 'SEM BARREIRA' || raw === 'SEM_BARRERA' || raw === 'NO_BARRIER') return 'NONE'

  if (raw === 'UI' || raw === 'UO' || raw === 'KI' || raw === 'KO') return raw
  if (raw === 'DI') return 'KI'
  if (raw === 'DO') return 'KO'

  const isUp = raw.includes('UP') || raw.startsWith('U')
  const isDown = raw.includes('DOWN') || raw.startsWith('D')
  const isOut = raw.includes('OUT') || raw.includes('KNOCK-OUT') || raw.includes('KNOCKOUT') || raw.endsWith('O')
  const isIn = raw.includes('IN') || raw.includes('KNOCK-IN') || raw.includes('KNOCKIN') || raw.endsWith('I')

  if (isUp && isOut) return 'UO'
  if (isUp && isIn) return 'UI'
  if (isDown && isOut) return 'KO'
  if (isDown && isIn) return 'KI'

  if (raw === 'OUT' || isOut) {
    return directionHint === 'high' ? 'UO' : 'KO'
  }
  if (raw === 'IN' || isIn) {
    return directionHint === 'high' ? 'UI' : 'KI'
  }
  return null
}

const resolveBarrierDirection = (type, barrierValue, spotInicial) => {
  const normalized = normalizeBarrierTypeOverride(type)
  if (normalized === 'NONE') return 'unknown'
  if (normalized === 'UI' || normalized === 'UO') return 'high'
  if (normalized === 'KI' || normalized === 'KO') return 'low'

  const upper = (type || '').toUpperCase()
  if (upper.includes('UP')) return 'high'
  if (upper.includes('DOWN')) return 'low'

  if (barrierValue != null && spotInicial != null) {
    return Number(barrierValue) >= Number(spotInicial) ? 'high' : 'low'
  }
  return 'unknown'
}

const resolveBarrierMode = (type) => {
  const normalized = normalizeBarrierTypeOverride(type)
  if (normalized === 'NONE') return 'none'
  if (normalized === 'UO' || normalized === 'KO') return 'out'
  if (normalized === 'UI' || normalized === 'KI') return 'in'
  return 'none'
}

const hasStrikeField = (leg) => {
  const type = String(leg?.tipo || '').toUpperCase()
  if (type === 'CALL' || type === 'PUT') return true
  const strike = leg?.strikeAjustado ?? leg?.strikeAdjusted ?? leg?.strike ?? leg?.precoStrike
  return strike != null && Number.isFinite(Number(strike))
}

const hasOptionLegType = (leg) => {
  const type = String(leg?.tipo || '').toUpperCase()
  return type === 'CALL' || type === 'PUT'
}

const hasBarrierField = (leg) => {
  if (!leg) return false
  if (hasOptionLegType(leg)) return true
  if (leg.barreiraValor != null) return true
  return String(leg?.barreiraTipo || '').trim() !== ''
}

const normalizeLegSide = (side) => {
  const raw = String(side || '').trim().toLowerCase()
  if (raw === 'short' || raw === 'vendida' || raw === 'venda') return 'short'
  return 'long'
}

export const getLegOverrideKey = (leg, index = 0) => {
  if (!leg || typeof leg !== 'object') return `LEG:${index}`
  const type = String(leg?.tipo || 'LEG').trim().toUpperCase() || 'LEG'
  const side = normalizeLegSide(leg?.side)
  const id = leg?.id != null && String(leg.id).trim() !== '' ? String(leg.id).trim() : `idx-${index}`
  return `${type}:${side}:${id}`
}

const resolveLegacyBarrierType = (typeOverride, leg, operation) => {
  const normalized = normalizeBarrierTypeOverride(typeOverride)
  if (normalized !== 'KO' && normalized !== 'KI') return normalized
  const direction = resolveBarrierDirection(leg?.barreiraTipo, leg?.barreiraValor, operation?.spotInicial)
  if (direction === 'high') return normalized === 'KO' ? 'UO' : 'UI'
  if (direction === 'unknown' && import.meta?.env?.DEV) {
    console.info('[vencimento] legacy barrier type fallback to DOWN', {
      operationId: operation?.id || null,
      legId: leg?.id || null,
      typeOverride: normalized,
    })
  }
  return normalized
}

const normalizeManualLegOverride = (value) => {
  if (!value || typeof value !== 'object') return null
  const structure = value.structure && typeof value.structure === 'object' ? value.structure : null
  const strikeOverride = toNumber(value.strikeOverride ?? value.strike ?? structure?.strike)
  const barrierValueOverride = toNumber(value.barrierValueOverride ?? value.barreiraValorOverride ?? structure?.barrierValue ?? structure?.barreiraValor)
  const optionQtyOverride = toNumber(value.optionQtyOverride ?? value.optionQty ?? value.quantidadeOpcaoOverride ?? structure?.optionQty ?? structure?.qty)
  const optionExpiryDateOverride = normalizeDateOverride(
    value.optionExpiryDateOverride
    ?? value.optionExpiryDate
    ?? value.vencimentoOpcaoOverride
    ?? value.vencimentoOpcao
    ?? structure?.optionExpiryDate
    ?? structure?.vencimentoOpcao,
  )
  const rawType = normalizeBarrierTypeOverride(value.barreiraTipo ?? structure?.barrierType ?? structure?.tipoBarreira, null)
  const directionHint = rawType === 'UI' || rawType === 'UO' ? 'high' : null
  const barrierTypeOverride = normalizeBarrierTypeOverride(
    value.barrierTypeOverride ?? value.barreiraTipoOverride ?? structure?.barrierType ?? structure?.tipoBarreira,
    directionHint,
  )
  const optionSide = normalizeOptionSide(value.optionSide ?? value.tipo ?? value.optionType ?? structure?.target?.side ?? structure?.side)
  const legKeyRaw = value.legKey ?? structure?.target?.legKey
  const legKey = legKeyRaw != null && String(legKeyRaw).trim() !== '' ? String(legKeyRaw).trim() : null
  if (
    strikeOverride == null
    && optionQtyOverride == null
    && barrierValueOverride == null
    && barrierTypeOverride == null
    && optionExpiryDateOverride == null
    && optionSide == null
    && legKey == null
  ) return null
  return {
    optionQtyOverride: optionQtyOverride != null ? optionQtyOverride : null,
    strikeOverride: strikeOverride != null ? strikeOverride : null,
    barrierValueOverride: barrierValueOverride != null ? barrierValueOverride : null,
    barrierTypeOverride: barrierTypeOverride != null ? barrierTypeOverride : null,
    optionExpiryDateOverride,
    optionSide,
    legKey,
  }
}

const matchesLegTarget = (leg, index, targetLegKey) => {
  if (!targetLegKey) return false
  const rawTarget = String(targetLegKey).trim()
  if (!rawTarget) return false
  if (String(index) === rawTarget) return true
  if (leg?.id != null && String(leg.id) === rawTarget) return true
  if (getLegOverrideKey(leg, index) === rawTarget) return true
  return false
}

export const applyOverridesToOperation = (operation, override = {}) => {
  if (!operation || typeof operation !== 'object') return operation
  const legs = Array.isArray(operation?.pernas) ? operation.pernas : []
  if (!legs.length) return operation

  const structure = override?.structure && typeof override.structure === 'object' ? override.structure : null
  const strikeOverrideGlobal = toNumber(override?.strikeOverride ?? override?.strike ?? structure?.strike)
  const barrierValueOverrideGlobal = toNumber(
    override?.barrierValueOverride ?? override?.barreiraValorOverride ?? structure?.barrierValue ?? structure?.barreiraValor,
  )
  const optionQtyOverrideGlobal = toNumber(
    override?.optionQtyOverride ?? override?.optionQty ?? override?.quantidadeOpcaoOverride ?? structure?.optionQty ?? structure?.qty,
  )
  const optionExpiryDateOverrideGlobal = normalizeDateOverride(
    override?.optionExpiryDateOverride
    ?? override?.optionExpiryDate
    ?? override?.vencimentoOpcaoOverride
    ?? override?.vencimentoOpcao
    ?? structure?.optionExpiryDate
    ?? structure?.vencimentoOpcao,
  )
  const globalSideHint = normalizeOptionSide(override?.optionSide ?? override?.optionType ?? structure?.target?.side ?? structure?.side)
  const directionHintGlobal = globalSideHint === 'CALL' ? 'high' : null
  const barrierTypeOverrideGlobal = normalizeBarrierTypeOverride(
    override?.barrierTypeOverride ?? override?.barreiraTipoOverride ?? structure?.barrierType ?? structure?.tipoBarreira,
    directionHintGlobal,
  )
  const optionSideGlobal = globalSideHint
  const legKeyRaw = override?.legKey ?? structure?.target?.legKey
  const legKeyGlobal = legKeyRaw != null && String(legKeyRaw).trim() !== '' ? String(legKeyRaw).trim() : null
  const legsOverrides = (
    override?.legs && typeof override.legs === 'object'
      ? override.legs
      : (override?.structureByLeg && typeof override.structureByLeg === 'object' ? override.structureByLeg : null)
  )
  const legacyBarrierType = Boolean(override?.legacyBarrierType)

  const hasGlobal =
    strikeOverrideGlobal != null
    || optionQtyOverrideGlobal != null
    || barrierValueOverrideGlobal != null
    || barrierTypeOverrideGlobal != null
    || optionExpiryDateOverrideGlobal != null
    || Boolean(legsOverrides)

  if (!hasGlobal) return operation

  let changed = false
  const nextLegs = legs.map((leg, index) => {
    if (!leg || typeof leg !== 'object') return leg

    const legKey = getLegOverrideKey(leg, index)
    const sideKey = normalizeOptionSide(leg?.tipo)
    const legOverride = normalizeManualLegOverride(
      legsOverrides?.[legKey]
      ?? legsOverrides?.[String(leg?.id)]
      ?? legsOverrides?.[String(index)]
      ?? (sideKey ? legsOverrides?.[sideKey] : null)
      ?? null,
    )

    const legScopeByKey = matchesLegTarget(leg, index, legKeyGlobal)
    const legScopeBySide = !legKeyGlobal && optionSideGlobal && sideKey === optionSideGlobal
    const applyGlobalToLeg = !legKeyGlobal && !optionSideGlobal ? true : (legScopeByKey || legScopeBySide)

    const strikeOverride = legOverride?.strikeOverride ?? (applyGlobalToLeg ? strikeOverrideGlobal : null)
    const optionQtyOverride = legOverride?.optionQtyOverride ?? (applyGlobalToLeg ? optionQtyOverrideGlobal : null)
    const optionExpiryDateOverride = legOverride?.optionExpiryDateOverride ?? (applyGlobalToLeg ? optionExpiryDateOverrideGlobal : null)
    const barrierValueOverride = legOverride?.barrierValueOverride ?? (applyGlobalToLeg ? barrierValueOverrideGlobal : null)
    const barrierTypeOverrideRaw = legOverride?.barrierTypeOverride ?? (applyGlobalToLeg ? barrierTypeOverrideGlobal : null)
    const barrierTypeOverride = legacyBarrierType
      ? resolveLegacyBarrierType(barrierTypeOverrideRaw, leg, operation)
      : barrierTypeOverrideRaw

    let nextLeg = leg

    if (barrierTypeOverride === 'NONE' && hasBarrierField(leg)) {
      const currentBarrierNum = Number(nextLeg?.barreiraValor)
      const currentBarrierType = String(nextLeg?.barreiraTipo || '').trim()
      if (Number.isFinite(currentBarrierNum) || currentBarrierType) {
        if (nextLeg === leg) nextLeg = { ...leg }
        nextLeg.barreiraValor = null
        nextLeg.barreiraTipo = ''
        changed = true
      }
    }

    if (optionQtyOverride != null && hasOptionLegType(leg)) {
      const qtyMagnitude = Math.abs(Number(optionQtyOverride))
      if (Number.isFinite(qtyMagnitude) && qtyMagnitude > 0) {
        const currentQty = Number(nextLeg?.quantidade)
        const defaultSign = normalizeLegSide(nextLeg?.side) === 'short' ? -1 : 1
        const currentSign = Number.isFinite(currentQty) && currentQty !== 0 ? Math.sign(currentQty) : defaultSign
        const nextQty = qtyMagnitude * (currentSign === 0 ? defaultSign : currentSign)
        if (!Number.isFinite(currentQty) || Math.abs(currentQty - nextQty) >= 1e-9) {
          if (nextLeg === leg) nextLeg = { ...leg }
          if (nextLeg.quantidadeOriginal == null && Number.isFinite(currentQty)) {
            nextLeg.quantidadeOriginal = currentQty
          }
          nextLeg.quantidade = nextQty
          changed = true
        }
      }
    }

    if (strikeOverride != null && hasStrikeField(leg)) {
      const currentStrike = nextLeg?.strikeAjustado ?? nextLeg?.strikeAdjusted ?? nextLeg?.strike ?? nextLeg?.precoStrike
      const currentNum = Number(currentStrike)
      if (
        !Number.isFinite(currentNum)
        || Math.abs(currentNum - strikeOverride) >= 1e-9
      ) {
        if (nextLeg === leg) nextLeg = { ...leg }
        if (nextLeg.strikeOriginal == null && Number.isFinite(currentNum)) {
          nextLeg.strikeOriginal = currentNum
        }
        nextLeg.strikeAjustado = strikeOverride
        nextLeg.strikeAdjusted = strikeOverride
        nextLeg.strike = strikeOverride
        changed = true
      }
    }

    if (optionExpiryDateOverride != null && hasOptionLegType(leg)) {
      const currentExpiry = normalizeDateOverride(nextLeg?.optionExpiryDateOverride ?? nextLeg?.optionExpiryDate ?? nextLeg?.vencimentoOpcao)
      if (currentExpiry !== optionExpiryDateOverride) {
        if (nextLeg === leg) nextLeg = { ...leg }
        nextLeg.optionExpiryDateOverride = optionExpiryDateOverride
        changed = true
      }
    }

    if (barrierTypeOverride !== 'NONE' && barrierValueOverride != null && hasBarrierField(leg)) {
      const currentBarrier = Number(nextLeg?.barreiraValor)
      if (
        !Number.isFinite(currentBarrier)
        || Math.abs(currentBarrier - barrierValueOverride) >= 1e-9
      ) {
        if (nextLeg === leg) nextLeg = { ...leg }
        nextLeg.barreiraValor = barrierValueOverride
        changed = true
      }
    }

    if (barrierTypeOverride && barrierTypeOverride !== 'NONE' && hasBarrierField(leg)) {
      const nextType = normalizeBarrierTypeOverride(barrierTypeOverride)
      if (String(nextLeg?.barreiraTipo || '').toUpperCase() !== String(nextType).toUpperCase()) {
        if (nextLeg === leg) nextLeg = { ...leg }
        nextLeg.barreiraTipo = nextType
        changed = true
      }
    }

    return nextLeg
  })

  if (!changed) return operation
  return {
    ...operation,
    pernas: nextLegs,
  }
}

export const computeBarrierStatus = (operation, market, override) => {
  const legs = operation?.pernas || []
  const barriers = legs
    .filter((leg) => leg?.barreiraValor != null)
    .map((leg) => ({
      ...leg,
      direction: resolveBarrierDirection(leg.barreiraTipo, leg.barreiraValor, operation.spotInicial),
    }))
  const hasBarriers = barriers.length > 0 && operation?.hasBarrier !== false
  if (!hasBarriers) {
    return {
      high: null,
      low: null,
      source: { high: 'none', low: 'none' },
      list: [],
    }
  }

  const highBarriers = barriers.filter((item) => item.direction === 'high')
  const lowBarriers = barriers.filter((item) => item.direction === 'low')
  const marketHigh = toNumber(market?.high ?? market?.close ?? operation?.spotInicial)
  const marketLow = toNumber(market?.low ?? market?.close ?? operation?.spotInicial)

  const autoHigh = highBarriers.length && marketHigh != null
    ? highBarriers.some((item) => Number(marketHigh) >= Number(item.barreiraValor))
    : null
  const autoLow = lowBarriers.length && marketLow != null
    ? lowBarriers.some((item) => Number(marketLow) <= Number(item.barreiraValor))
    : null

  const highOverride = override?.high && override.high !== 'auto' ? override.high === 'hit' : null
  const lowOverride = override?.low && override.low !== 'auto' ? override.low === 'hit' : null

  const high = highOverride != null ? highOverride : autoHigh
  const low = lowOverride != null ? lowOverride : autoLow

  const source = {
    high: highOverride != null ? 'manual' : 'auto',
    low: lowOverride != null ? 'manual' : 'auto',
  }

  return {
    high,
    low,
    source,
    list: barriers,
  }
}

const isLegActive = (leg, barrierStatus) => {
  if (!leg?.barreiraValor) return true
  const direction = resolveBarrierDirection(leg.barreiraTipo, leg.barreiraValor)
  const mode = resolveBarrierMode(leg.barreiraTipo)
  if (direction === 'high') {
    if (barrierStatus.high == null) return true
    if (mode === 'out') return !barrierStatus.high
    if (mode === 'in') return barrierStatus.high
  }
  if (direction === 'low') {
    if (barrierStatus.low == null) return true
    if (mode === 'out') return !barrierStatus.low
    if (mode === 'in') return barrierStatus.low
  }
  return true
}

const isShortLeg = (leg) => {
  const side = String(leg?.side || '').toLowerCase()
  if (side === 'short' || side === 'vendida' || side === 'venda') return true
  const qty = Number(leg?.quantidade || 0)
  return qty < 0
}

const normalizeEstrutura = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

export const isBooster = (estrutura) => {
  const normalized = normalizeEstrutura(estrutura)
  return normalized === 'booster' || normalized === 'booster sob custodia'
}

const isAlocacaoProtegida = (estrutura) => {
  const normalized = normalizeEstrutura(estrutura)
  return normalized.includes('alocacao protegida')
}

const isCallPutStructure = (estrutura) => {
  const normalized = normalizeEstrutura(estrutura)
  if (isAlocacaoProtegida(normalized)) return false
  return normalized.includes('call') || normalized.includes('put')
}

const getFirstNumber = (obj, keys) => {
  for (const key of keys) {
    const value = toNumber(obj?.[key])
    if (value != null) return value
  }
  return null
}

const getOptionQty = (operation, legs) => {
  const direct = getFirstNumber(operation, [
    'qtdAtivaOpcao',
    'quantidadeAtivaOpcao',
    'quantidadeOpcao',
    'qtdOpcao',
    'qtdOpcoes',
  ])
  if (direct != null && direct !== 0) return Math.abs(direct)
  const fromLegs = (legs || [])
    .filter((leg) => ['CALL', 'PUT'].includes(String(leg?.tipo || '').toUpperCase()))
    .map((leg) => Math.abs(resolveLegQuantity(leg, 0)))
    .filter((qty) => qty > 0)
  if (fromLegs.length) return Math.max(...fromLegs)
  return null
}

const resolveUnitCost = (operation) => {
  const direct = getFirstNumber(operation, [
    'custoUnitarioOpcao',
    'custoOpcao',
    'premioOpcao',
  ])
  if (direct != null) return direct
  return null
}

const resolvePutUnitCost = (operation) => {
  return getFirstNumber(operation, [
    'custoUnitarioPut',
    'custoPut',
    'premioPut',
  ])
}

const resolveStockValue = (operation) => {
  return getFirstNumber(operation, ['valorAtivo', 'precoAtivo', 'spotInicial', 'spotEntrada'])
}

const computeValorEntrada = (operation, legs, fallbackValue) => {
  const estrutura = operation?.estrutura
  if (isAlocacaoProtegida(estrutura)) {
    const stockQty = getFirstNumber(operation, [
      'qtdAtivaEstoque',
      'quantidadeEstoque',
      'quantidadeAcoes',
      'quantidadeAcao',
      'quantidade',
      'qtyBase',
    ])
    const stockValue = resolveStockValue(operation)
    const putQty = getFirstNumber(operation, [
      'qtdAtivaPut',
      'quantidadePut',
      'qtdPut',
    ]) ?? getOptionQty(operation, legs)
    const putUnitCost = resolvePutUnitCost(operation) ?? resolveUnitCost(operation)
    const missing = [stockQty, stockValue, putQty, putUnitCost]
      .some((value) => value == null || Number.isNaN(Number(value)) || Number(value) === 0)
    if (missing) {
      return {
        value: null,
        incomplete: true,
        components: {
          stockQty,
          stockValue,
          putQty,
          putUnitCost,
        },
      }
    }
    return {
      value: Number(stockQty) * Number(stockValue) + Number(putQty) * Number(putUnitCost),
      incomplete: false,
      components: {
        stockQty,
        stockValue,
        putQty,
        putUnitCost,
      },
    }
  }

  if (isCallPutStructure(estrutura)) {
    const optionQty = getOptionQty(operation, legs)
    const optionUnitCost = resolveUnitCost(operation)
    const missing = [optionQty, optionUnitCost]
      .some((value) => value == null || Number.isNaN(Number(value)) || Number(value) === 0)
    if (missing) {
      return {
        value: null,
        incomplete: true,
        components: {
          optionQty,
          optionUnitCost,
        },
      }
    }
    return {
      value: Number(optionQty) * Number(optionUnitCost),
      incomplete: false,
      components: {
        optionQty,
        optionUnitCost,
      },
    }
  }

  return {
    value: fallbackValue != null && !Number.isNaN(Number(fallbackValue)) ? Number(fallbackValue) : null,
    incomplete: false,
    components: null,
  }
}

const resolveLegQuantity = (leg, fallback) => {
  if (leg?.quantidadeEfetiva != null) return Number(leg.quantidadeEfetiva)
  if (leg?.quantidade != null) return Number(leg.quantidade)
  return Number(fallback || 0)
}

const resolveLegSettlementSpot = (leg, globalSpotFinal) => {
  const legSpot = toNumber(leg?.settlementSpotOverride ?? leg?.spotFinalOverride ?? leg?.spotFinal)
  if (legSpot != null) return legSpot
  return globalSpotFinal
}

export const getEffectiveLegs = (operation) => {
  const legs = Array.isArray(operation?.pernas) ? operation.pernas : []
  const booster = isBooster(operation?.estrutura)
  if (!booster) {
    return legs.map((leg) => ({ ...leg, quantidadeEfetiva: Number(leg?.quantidade || 0) }))
  }
  return legs.map((leg) => {
    const tipo = String(leg?.tipo || '').toUpperCase()
    const isCall = tipo === 'CALL'
    const rawQty = Number(leg?.quantidade || 0)
    const short = isShortLeg(leg)
    const effectiveQty = isCall && short ? rawQty * 2 : rawQty
    return { ...leg, quantidadeEfetiva: effectiveQty }
  })
}

const resolveStrike = (leg) => {
  const adjusted = leg?.strikeAjustado ?? leg?.strikeAdjusted
  if (adjusted != null && Number.isFinite(Number(adjusted))) return Number(adjusted)
  const raw = leg?.strike
  return Number.isFinite(Number(raw)) ? Number(raw) : 0
}

const isKoHit = (legs, barrierStatus, spotInicial) => {
  if (!barrierStatus) return false
  const koLegs = (legs || []).filter((leg) => resolveBarrierMode(leg?.barreiraTipo) === 'out')
  if (!koLegs.length) return false
  return koLegs.some((leg) => {
    const direction = resolveBarrierDirection(leg?.barreiraTipo, leg?.barreiraValor, spotInicial)
    if (direction === 'high') return barrierStatus.high === true
    if (direction === 'low') return barrierStatus.low === true
    return barrierStatus.high === true || barrierStatus.low === true
  })
}

const resolveDebitQuantity = (leg, fallback) => {
  const baseQty = Math.abs(Number(fallback || 0))
  if (baseQty) return baseQty
  const legQty = Math.abs(resolveLegQuantity(leg, 0))
  return legQty || 0
}

const isCupomRecorrente = (estrutura) => {
  const normalized = String(estrutura || '').trim().toLowerCase()
  return normalized === 'cupom recorrente' || normalized === 'cupom recorrente europeia'
}

export const computeResult = (operation, market, barrierStatus, override = {}) => {
  const qtyBaseRaw = operation.qtyBase ?? operation.quantidade ?? 0
  const qtyBonusRaw = operation.qtyBonus ?? 0
  const qtyBase = Math.max(0, Number(qtyBaseRaw || 0))
  const qtyBonus = Math.max(0, Number(qtyBonusRaw || 0))
  const qtyAtualOverride = toNumber(operation.qtyAtual ?? operation.quantidadeAtual)
  const hasQtyAtualOverride = qtyAtualOverride != null && qtyAtualOverride > 0
  const qtyAtual = hasQtyAtualOverride ? qtyAtualOverride : qtyBase + qtyBonus
  const qtyBonusResolved = hasQtyAtualOverride ? Math.max(0, qtyAtual - qtyBase) : qtyBonus
  const custoUnitario = Number(operation.custoUnitario || 0)
  const custoTotal = qtyBase * custoUnitario
  const pagouManual = operation.pagou != null && operation.pagou !== '' ? Number(operation.pagou) : null
  let effectiveLegs = getEffectiveLegs(operation)
  if (isBooster(operation?.estrutura) && isKoHit(effectiveLegs, barrierStatus, operation?.spotInicial)) {
    effectiveLegs = effectiveLegs.map((leg) => {
      const tipo = String(leg?.tipo || '').toUpperCase()
      if (tipo !== 'CALL' || isShortLeg(leg)) return leg
      return { ...leg, quantidadeEfetiva: 0, disabledByKo: true }
    })
  }
  const optionQtyList = effectiveLegs
    .filter((leg) => ['CALL', 'PUT'].includes(String(leg?.tipo || '').toUpperCase()))
    .map((leg) => Math.abs(resolveLegQuantity(leg, 0)))
    .filter((qty) => qty > 0)
  const optionQtyBase = optionQtyList.length ? Math.max(...optionQtyList) : 0
  const optionEntryUnit = Math.abs(custoUnitario || 0)
  const optionEntryTotal = optionEntryUnit && optionQtyBase ? optionEntryUnit * optionQtyBase : 0
  const pagou = pagouManual != null
    ? pagouManual
    : (!qtyBase && optionEntryTotal ? optionEntryTotal : custoTotal)

  const spotFinal = market?.close ?? operation.spotInicial ?? 0
  const vendaAtivoBruta = qtyAtual ? spotFinal * qtyAtual : 0

  const isRecorrente = isCupomRecorrente(operation.estrutura)
  let ganhoCall = 0
  let ganhoPut = 0

  const payoff = effectiveLegs.reduce((sum, leg) => {
    if (!isLegActive(leg, barrierStatus)) return sum
    const legSpotFinal = resolveLegSettlementSpot(leg, spotFinal)
    const strike = resolveStrike(leg)
    const rawQty = resolveLegQuantity(leg, qtyBase)
    if (!rawQty) return sum
    const qty = Math.abs(rawQty)
    const tipo = (leg.tipo || '').toUpperCase()
    let intrinsic = 0
    if (tipo === 'CALL') {
      intrinsic = Math.max(legSpotFinal - strike, 0)
    } else if (tipo === 'PUT') {
      intrinsic = Math.max(strike - legSpotFinal, 0)
    }
    const side = (leg.side || 'long').toLowerCase() === 'short' ? -1 : 1
    const signedSide = rawQty < 0 ? side * -1 : side
    const result = intrinsic * qty * signedSide
    if (tipo === 'CALL') ganhoCall += result
    if (tipo === 'PUT') ganhoPut += result
    return sum + result
  }, 0)

  const dividends = (market?.dividendsTotal || 0) * (qtyAtual || 0)
  const manualCouponBRL = toNumber(override?.manualCouponBRL ?? override?.manualCouponBrl)
  const manualOptionsGainBRL = toNumber(override?.manualOptionsGainBRL ?? override?.manualOptionsGainBrl)
  const legacyCoupon = override?.manualCouponPct ?? override?.cupomManual ?? override?.cupomManualPct
  const legacyRaw = legacyCoupon != null && String(legacyCoupon).trim() !== '' ? String(legacyCoupon).trim() : null
  const legacyConvertible = legacyRaw && legacyRaw.includes('%') && custoTotal
  const legacyNeedsInput = Boolean(legacyRaw && !legacyConvertible)
  const legacyConverted = Boolean(legacyConvertible)
  const cupomTotal = manualCouponBRL != null
    ? manualCouponBRL
    : legacyConvertible
      ? parsePercent(legacyRaw) * custoTotal
      : (custoTotal ? parsePercent(operation.cupom) * custoTotal : 0)

  const rebateTotal = effectiveLegs.reduce((sum, leg) => {
    if (!leg?.rebate) return sum
    if (!isLegActive(leg, barrierStatus)) return sum
    const rawQty = resolveLegQuantity(leg, qtyBase)
    const qty = Math.abs(rawQty)
    return sum + Number(leg.rebate || 0) * qty
  }, 0)

  const optionsSuppressed = isRecorrente && manualOptionsGainBRL == null

  if (optionsSuppressed) {
    ganhoCall = 0
    ganhoPut = 0
  }
  const ganhosOpcoesAuto = optionsSuppressed ? 0 : (ganhoCall + ganhoPut)
  const ganhosOpcoes = manualOptionsGainBRL != null ? manualOptionsGainBRL : ganhosOpcoesAuto
  const ganhosOpcoesSource = manualOptionsGainBRL != null ? 'manual' : optionsSuppressed ? 'suppressed' : 'auto'

  const debito = effectiveLegs.reduce((sum, leg) => {
    if (!isLegActive(leg, barrierStatus)) return sum
    const legSpotFinal = resolveLegSettlementSpot(leg, spotFinal)
    const tipo = String(leg?.tipo || '').toUpperCase()
    if (tipo !== 'CALL' && tipo !== 'PUT') return sum
    if (!isShortLeg(leg)) return sum
    const strike = resolveStrike(leg)
    if (!Number.isFinite(strike) || strike <= 0) return sum
    const liquidou = tipo === 'CALL' ? legSpotFinal >= strike : legSpotFinal <= strike
    if (!liquidou) return sum
    const qty = resolveDebitQuantity(leg, qtyBase)
    if (!qty) return sum
    return sum + strike * qty
  }, 0)

  const shouldAdjustCupomVenda = isCupomRecorrente(operation.estrutura) && dividends > 0
  const vendaAtivoAjustada = shouldAdjustCupomVenda ? vendaAtivoBruta - dividends : vendaAtivoBruta
  const valorSaida = isCupomRecorrente(operation.estrutura)
    ? (shouldAdjustCupomVenda ? vendaAtivoAjustada : pagou)
    : vendaAtivoBruta
  let financeiroFinal = valorSaida - pagou + ganhosOpcoes + dividends + cupomTotal + rebateTotal
  if (!Number.isFinite(financeiroFinal) || (!pagou && operation.pl != null)) {
    financeiroFinal = Number(operation.pl || 0)
  }

  const ganho = financeiroFinal
  const percent = pagou ? ganho / pagou : 0

  const valorEntradaInfo = computeValorEntrada(operation, effectiveLegs, pagou)

  return {
    effectiveLegs,
    spotFinal,
    vendaAtivo: valorSaida,
    vendaAtivoBruta,
    vendaAtivoAjustada,
    qtyBase,
    qtyBonus: qtyBonusResolved,
    qtyAtual,
    valorSaida,
    custoTotal,
    pagou,
    valorEntrada: valorEntradaInfo.value,
    valorEntradaIncomplete: valorEntradaInfo.incomplete,
    valorEntradaComponents: valorEntradaInfo.components,
    debito: Number.isFinite(debito) ? debito : 0,
    payoff: optionsSuppressed ? 0 : payoff,
    ganhoCall,
    ganhoPut,
    ganhosOpcoes,
    ganhosOpcoesSource,
    optionsSuppressed,
    dividends,
    cupomTotal,
    cupomSource: manualCouponBRL != null ? 'manual-brl' : legacyConverted ? 'legacy-percent' : legacyNeedsInput ? 'legacy-needs-input' : 'auto',
    cupomLegacyNeedsInput: legacyNeedsInput,
    cupomLegacyConverted: legacyConverted,
    rebateTotal,
    financeiroFinal,
    ganho,
    percent,
  }
}
