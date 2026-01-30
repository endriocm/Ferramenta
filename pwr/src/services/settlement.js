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

const resolveBarrierDirection = (type, barrierValue, spotInicial) => {
  const upper = (type || '').toUpperCase()
  if (upper.includes('UP') || upper.includes('UO') || upper.includes('UI')) return 'high'
  if (upper.includes('DOWN') || upper.includes('DO') || upper.includes('DI')) return 'low'
  if (upper.includes('KO') || upper.includes('KI')) {
    if (barrierValue != null && spotInicial != null) {
      return Number(barrierValue) >= Number(spotInicial) ? 'high' : 'low'
    }
  }
  if (barrierValue != null && spotInicial != null) {
    return Number(barrierValue) >= Number(spotInicial) ? 'high' : 'low'
  }
  return 'unknown'
}

const resolveBarrierMode = (type) => {
  const upper = (type || '').toUpperCase()
  if (upper.includes('OUT') || upper.includes('KO') || upper.includes('UO') || upper.includes('DO')) return 'out'
  if (upper.includes('IN') || upper.includes('KI') || upper.includes('UI') || upper.includes('DI')) return 'in'
  return 'none'
}

export const computeBarrierStatus = (operation, market, override) => {
  const legs = operation?.pernas || []
  const barriers = legs
    .filter((leg) => leg?.barreiraValor != null)
    .map((leg) => ({
      ...leg,
      direction: resolveBarrierDirection(leg.barreiraTipo, leg.barreiraValor, operation.spotInicial),
    }))

  const highBarriers = barriers.filter((item) => item.direction === 'high')
  const lowBarriers = barriers.filter((item) => item.direction === 'low')
  const spotFinal = market?.close ?? operation?.spotInicial ?? null

  const autoHigh = highBarriers.length && spotFinal != null
    ? highBarriers.some((item) => Number(spotFinal) >= Number(item.barreiraValor))
    : null
  const autoLow = lowBarriers.length && spotFinal != null
    ? lowBarriers.some((item) => Number(spotFinal) <= Number(item.barreiraValor))
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

const getOptionQty = (operation, legs, fallback) => {
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
  const fallbackQty = toNumber(fallback)
  if (fallbackQty != null && fallbackQty !== 0) return Math.abs(fallbackQty)
  return null
}

const resolveUnitCost = (operation, fallback) => {
  const direct = getFirstNumber(operation, [
    'custoUnitarioOpcao',
    'custoOpcao',
    'premioOpcao',
  ])
  if (direct != null) return direct
  const next = toNumber(fallback)
  if (next != null) return next
  return getFirstNumber(operation, ['custoUnitario', 'custoUnit', 'custo'])
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

const computeValorEntrada = (operation, legs, fallbackUnitCost, fallbackQty, fallbackValue) => {
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
    ]) ?? getOptionQty(operation, legs, null)
    const putUnitCost = resolvePutUnitCost(operation) ?? resolveUnitCost(operation, null)
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
    const optionQty = getOptionQty(operation, legs, fallbackQty)
    const optionUnitCost = resolveUnitCost(operation, fallbackUnitCost)
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
    const strike = resolveStrike(leg)
    const rawQty = resolveLegQuantity(leg, qtyBase)
    if (!rawQty) return sum
    const qty = Math.abs(rawQty)
    const tipo = (leg.tipo || '').toUpperCase()
    let intrinsic = 0
    if (tipo === 'CALL') {
      intrinsic = Math.max(spotFinal - strike, 0)
    } else if (tipo === 'PUT') {
      intrinsic = Math.max(strike - spotFinal, 0)
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

  if (isRecorrente) {
    ganhoCall = 0
    ganhoPut = 0
  }
  const ganhosOpcoes = isRecorrente ? 0 : (ganhoCall + ganhoPut)

  const debito = effectiveLegs.reduce((sum, leg) => {
    if (!isLegActive(leg, barrierStatus)) return sum
    const tipo = String(leg?.tipo || '').toUpperCase()
    if (tipo !== 'CALL' && tipo !== 'PUT') return sum
    if (!isShortLeg(leg)) return sum
    const strike = resolveStrike(leg)
    if (!Number.isFinite(strike) || strike <= 0) return sum
    const liquidou = tipo === 'CALL' ? spotFinal >= strike : spotFinal <= strike
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

  const valorEntradaInfo = computeValorEntrada(
    operation,
    effectiveLegs,
    optionEntryUnit || custoUnitario,
    optionQtyBase || qtyBase,
    pagou,
  )

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
    payoff: isRecorrente ? 0 : payoff,
    ganhoCall,
    ganhoPut,
    ganhosOpcoes,
    optionsSuppressed: isRecorrente,
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
