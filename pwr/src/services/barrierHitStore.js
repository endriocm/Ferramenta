const STORAGE_PREFIX = 'pwr.barrier-hit.state.'
const STORAGE_VERSION = 1
export const BARRIER_HIT_EVENT = 'pwr:barrier-hit-updated'

const buildKey = (userKey) => `${STORAGE_PREFIX}${String(userKey || 'guest').trim() || 'guest'}`

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const normalizeDateValue = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  return raw.slice(0, 10)
}

const normalizeNumberValue = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const normalizeLeg = (raw, index) => {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || `leg-${index + 1}`).trim() || `leg-${index + 1}`
  return {
    id,
    tipo: String(raw.tipo || '').trim(),
    side: String(raw.side || '').trim(),
    strike: normalizeNumberValue(raw.strike),
    barreiraValor: normalizeNumberValue(raw.barreiraValor),
    barreiraTipo: String(raw.barreiraTipo || '').trim(),
    rebate: normalizeNumberValue(raw.rebate) ?? 0,
    quantidade: normalizeNumberValue(raw.quantidade),
    quantidadeAtiva: normalizeNumberValue(raw.quantidadeAtiva),
    quantidadeBase: normalizeNumberValue(raw.quantidadeBase),
    quantidadeDiario: normalizeNumberValue(raw.quantidadeDiario),
    quantidadeContratada: normalizeNumberValue(raw.quantidadeContratada),
    quantidadeContratadaBase: normalizeNumberValue(raw.quantidadeContratadaBase),
    quantidadeContratadaDiario: normalizeNumberValue(raw.quantidadeContratadaDiario),
    quantidadeBoleta: normalizeNumberValue(raw.quantidadeBoleta),
  }
}

const normalizeOperation = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!id) return null
  return {
    id,
    codigoOperacao: String(raw.codigoOperacao || '').trim(),
    codigoCliente: String(raw.codigoCliente || '').trim(),
    cliente: String(raw.cliente || '').trim(),
    assessor: String(raw.assessor || '').trim(),
    broker: String(raw.broker || '').trim(),
    ativo: String(raw.ativo || '').trim(),
    estrutura: String(raw.estrutura || '').trim(),
    tipoEstrutura: String(raw.tipoEstrutura || '').trim(),
    modalidadeOperacao: String(raw.modalidadeOperacao || '').trim(),
    vencimento: normalizeDateValue(raw.vencimento),
    dataRegistro: normalizeDateValue(raw.dataRegistro),
    spotInicial: normalizeNumberValue(raw.spotInicial),
    quantidade: normalizeNumberValue(raw.quantidade),
    quantidadeAtual: normalizeNumberValue(raw.quantidadeAtual),
    pernas: Array.isArray(raw.pernas)
      ? raw.pernas.map((item, index) => normalizeLeg(item, index)).filter(Boolean)
      : [],
    hasHighBarrier: raw.hasHighBarrier === true,
    hasLowBarrier: raw.hasLowBarrier === true,
    highHit: raw.highHit === true,
    lowHit: raw.lowHit === true,
    highHitAt: normalizeDateValue(raw.highHitAt),
    lowHitAt: normalizeDateValue(raw.lowHitAt),
    highHitSeq: Number(raw.highHitSeq) || 0,
    lowHitSeq: Number(raw.lowHitSeq) || 0,
    highHitReason: String(raw.highHitReason || '').trim(),
    lowHitReason: String(raw.lowHitReason || '').trim(),
    active: raw.active === true,
    inactiveReason: String(raw.inactiveReason || '').trim(),
    firstSeenAt: normalizeDateValue(raw.firstSeenAt),
    lastSeenAt: normalizeDateValue(raw.lastSeenAt),
    lastUpdatedAt: normalizeDateValue(raw.lastUpdatedAt),
    seenInBase: raw.seenInBase === true,
    seenInDaily: raw.seenInDaily === true,
  }
}

const normalizePayload = (payload) => {
  if (!payload || typeof payload !== 'object') return null
  const operations = Array.isArray(payload.operations)
    ? payload.operations.map((item) => normalizeOperation(item)).filter(Boolean)
    : []
  return {
    version: STORAGE_VERSION,
    updatedAt: Number(payload.updatedAt) || Date.now(),
    reportDate: normalizeDateValue(payload.reportDate),
    analysisFrom: normalizeDateValue(payload.analysisFrom),
    analysisTo: normalizeDateValue(payload.analysisTo),
    baseFileName: String(payload.baseFileName || '').trim(),
    dailyFileName: String(payload.dailyFileName || '').trim(),
    baseCount: Number(payload.baseCount) || 0,
    dailyCount: Number(payload.dailyCount) || 0,
    operations,
  }
}

export const loadBarrierHitState = (userKey) => {
  if (!userKey || typeof window === 'undefined') return null
  try {
    const parsed = safeParse(window.localStorage.getItem(buildKey(userKey)))
    return normalizePayload(parsed)
  } catch {
    return null
  }
}

const emitBarrierHitUpdated = (userKey) => {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(BARRIER_HIT_EVENT, {
      detail: {
        userKey: String(userKey || 'guest').trim() || 'guest',
        updatedAt: Date.now(),
      },
    }))
  } catch {
    // noop
  }
}

export const saveBarrierHitState = (userKey, payload) => {
  if (!userKey || typeof window === 'undefined') return null
  const normalized = normalizePayload(payload)
  if (!normalized) return null
  try {
    window.localStorage.setItem(buildKey(userKey), JSON.stringify(normalized))
    emitBarrierHitUpdated(userKey)
    return normalized
  } catch {
    return null
  }
}

export const clearBarrierHitState = (userKey) => {
  if (!userKey || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(buildKey(userKey))
    emitBarrierHitUpdated(userKey)
  } catch {
    // noop
  }
}

const hashToInt = (value) => {
  const text = String(value || '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

const toDateAtMidday = (dateKey) => {
  const key = normalizeDateValue(dateKey)
  if (!key) return 0
  const value = new Date(`${key}T12:00:00`).getTime()
  return Number.isFinite(value) ? value : 0
}

const toLocalDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const getTodayKey = () => toLocalDateKey(new Date())

const isAllowedNotificationDate = (dateKey) => {
  const key = normalizeDateValue(dateKey)
  if (!key) return false
  return key === getTodayKey()
}

const buildSeqFallback = (operation, direction, hitAt) => {
  const base = toDateAtMidday(hitAt)
  const hash = hashToInt(`${operation?.id || ''}:${direction}`) % 1000
  return (base * 1000) + hash
}

const buildNotification = (operation, direction) => {
  const isHigh = direction === 'high'
  const hit = isHigh ? operation?.highHit : operation?.lowHit
  if (!hit) return null
  const hitAt = normalizeDateValue(isHigh ? operation?.highHitAt : operation?.lowHitAt)
  if (!isAllowedNotificationDate(hitAt)) return null

  const seq = Number(isHigh ? operation?.highHitSeq : operation?.lowHitSeq) || buildSeqFallback(operation, direction, hitAt)
  const broker = String(operation?.broker || '--').trim() || '--'
  const assessor = String(operation?.assessor || '--').trim() || '--'
  const codigoCliente = String(operation?.codigoCliente || '--').trim() || '--'
  const cliente = String(operation?.cliente || '--').trim() || '--'
  const estrutura = String(operation?.estrutura || '--').trim() || '--'
  const ativo = String(operation?.ativo || '--').trim() || '--'
  const directionLabel = isHigh ? 'Alta' : 'Baixa'

  const formatDateBr = (isoKey) => {
    const key = normalizeDateValue(isoKey)
    if (!key) return '--'
    const parts = key.split('-')
    if (parts.length !== 3) return key
    return `${parts[2]}/${parts[1]}/${parts[0]}`
  }

  const dataEntrada = formatDateBr(operation?.dataRegistro)
  const vencimento = formatDateBr(operation?.vencimento)

  return {
    id: `barrier-${direction}-${operation?.id || ''}-${hitAt}`,
    type: 'barrier_hit',
    sender: `Batimento de barreira (${directionLabel})`,
    subject: `Broker: ${broker} | Assessor: ${assessor} | Cod cliente: ${codigoCliente} | Cliente: ${cliente} | Estrutura: ${estrutura} | Ativo: ${ativo} | Data entrada: ${dataEntrada} | Vencimento: ${vencimento}`,
    at: `${hitAt}T12:00:00`,
    seq,
  }
}

export const listBarrierHitNotifications = (userKey) => {
  const state = loadBarrierHitState(userKey)
  const operations = Array.isArray(state?.operations) ? state.operations : []
  const notifications = []
  operations.forEach((operation) => {
    const high = buildNotification(operation, 'high')
    const low = buildNotification(operation, 'low')
    if (high) notifications.push(high)
    if (low) notifications.push(low)
  })
  notifications.sort((left, right) => Number(right.seq || 0) - Number(left.seq || 0))
  return notifications.slice(0, 60)
}
