const parsePercent = (value) => {
  if (value == null) return 0
  if (typeof value === 'number') return value
  const cleaned = String(value).replace('%', '').replace(',', '.')
  const parsed = Number(cleaned)
  if (Number.isNaN(parsed)) return 0
  return parsed / 100
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

  const autoHigh = highBarriers.length && market?.high != null
    ? highBarriers.some((item) => Number(market.high) >= Number(item.barreiraValor))
    : null
  const autoLow = lowBarriers.length && market?.low != null
    ? lowBarriers.some((item) => Number(market.low) <= Number(item.barreiraValor))
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

const isCupomRecorrente = (estrutura) => {
  const normalized = String(estrutura || '').trim().toLowerCase()
  return normalized === 'cupom recorrente' || normalized === 'cupom recorrente europeia'
}

export const computeResult = (operation, market, barrierStatus, override = {}) => {
  const quantidade = Number(operation.quantidade || 0)
  const custoUnitario = Number(operation.custoUnitario || 0)
  const custoTotal = quantidade * custoUnitario
  const pagouManual = operation.pagou != null && operation.pagou !== '' ? Number(operation.pagou) : null
  const optionQtyList = (operation.pernas || [])
    .filter((leg) => ['CALL', 'PUT'].includes(String(leg?.tipo || '').toUpperCase()))
    .map((leg) => Math.abs(Number(leg?.quantidade || 0)))
    .filter((qty) => qty > 0)
  const optionQtyBase = optionQtyList.length ? Math.max(...optionQtyList) : 0
  const optionEntryUnit = Math.abs(custoUnitario || 0)
  const optionEntryTotal = optionEntryUnit && optionQtyBase ? optionEntryUnit * optionQtyBase : 0
  const pagou = pagouManual != null
    ? pagouManual
    : (!quantidade && optionEntryTotal ? optionEntryTotal : custoTotal)

  const spotFinal = market?.close ?? operation.spotInicial ?? 0
  const vendaAtivo = quantidade ? spotFinal * quantidade : 0

  let ganhoCall = 0
  let ganhoPut = 0

  const payoff = (operation.pernas || []).reduce((sum, leg) => {
    if (!isLegActive(leg, barrierStatus)) return sum
    const strike = Number(leg.strike || 0)
    const rawQty = Number(leg.quantidade || quantidade)
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

  const dividends = (market?.dividendsTotal || 0) * (quantidade || 0)
  const cupomBase = override?.cupomManual != null && String(override.cupomManual).trim() !== ''
    ? override.cupomManual
    : operation.cupom
  const cupomTotal = custoTotal ? parsePercent(cupomBase) * custoTotal : 0

  const rebateTotal = (operation.pernas || []).reduce((sum, leg) => {
    if (!leg?.rebate) return sum
    if (!isLegActive(leg, barrierStatus)) return sum
    const rawQty = Number(leg.quantidade || quantidade)
    const qty = Math.abs(rawQty)
    return sum + Number(leg.rebate || 0) * qty
  }, 0)

  const ganhosOpcoes = ganhoCall + ganhoPut

  const valorSaida = isCupomRecorrente(operation.estrutura) ? pagou : vendaAtivo
  let financeiroFinal = valorSaida - pagou + ganhosOpcoes + dividends + cupomTotal + rebateTotal
  if (!Number.isFinite(financeiroFinal) || (!pagou && operation.pl != null)) {
    financeiroFinal = Number(operation.pl || 0)
  }

  const ganho = financeiroFinal
  const percent = pagou ? ganho / pagou : 0

  return {
    spotFinal,
    vendaAtivo: valorSaida,
    valorSaida,
    custoTotal,
    pagou,
    valorEntrada: pagou,
    debito: Math.max(0, pagou),
    payoff,
    ganhoCall,
    ganhoPut,
    ganhosOpcoes,
    dividends,
    cupomTotal,
    rebateTotal,
    financeiroFinal,
    ganho,
    percent,
  }
}
