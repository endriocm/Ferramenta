import { getHydratedStorageValue, persistLocalStorage, setHydratedStorageValue } from './nativeStorage'
import { normalizeDateKey } from '../utils/dateKey'
import { normalizeAssessorName } from '../utils/assessor'

const XP_STORAGE_KEY = 'pwr.receita.xp'
const XP_OVERRIDE_KEY = 'pwr.receita.xp.override'

// ── In-memory cache to avoid redundant JSON.parse + normalizeXpEntries ──
let _xpCache = null       // { entries: [...], stamp: number }
let _xpOverrideCache = null // { state: { enabled }, stamp: number }

export const XP_TEMPLATE_HEADERS = [
  'Data Referência',
  'Data Operação',
  'Cliente',
  'Tipo Pessoa',
  'Comissão XP',
  'Linha Receita',
  'Receita AI',
  'Nome AI',
  'Cod AI XP',
  'Cod AI Liberta',
  'Tipo do Serviço',
  'Produto/Categoria XP',
  'Nível 1',
  'Nível 2',
  'Nível 3',
  'Nível 4',
  'Receita Bruta',
  'Receita Líquida',
  'Repasse XP (%)',
  'Escritório',
  'Senioridade',
  'Squad',
]

const XP_SOURCE = 'xp-commission'

const normalizeToken = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '')

const normalizeLine = (value) => {
  const token = normalizeToken(value)
  if (token === 'bovespa') return 'Bovespa'
  if (token === 'bmf') return 'BMF'
  if (token === 'estruturadas') return 'Estruturadas'
  return ''
}

export const mapXpProductCategoryToLine = (value) => {
  const token = normalizeToken(value)
  if (!token) return ''
  if (token === 'operacoesestruturadas') return 'Estruturadas'
  if (token === 'bmf') return 'BMF'
  if (
    token === 'bovespa'
    || token === 'bovespafiis'
    || token === 'btc'
    || token === 'bovespaempacotados'
    || token === 'bovespafiisempacotados'
  ) {
    return 'Bovespa'
  }
  return ''
}

const toSafeNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const normalizeMonthKey = (value) => {
  const key = normalizeDateKey(value)
  return key ? key.slice(0, 7) : ''
}

const normalizeMonthLike = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}$/.test(raw)) return raw
  return normalizeMonthKey(raw)
}

const resolveEntryDate = (entry) => {
  return normalizeDateKey(entry?.data || entry?.dataEntrada || entry?.vencimento || '') || ''
}

const isObject = (value) => value && typeof value === 'object'

const safeParse = (raw) => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const normalizeXpEntry = (entry, index = 0) => {
  if (!isObject(entry)) return null
  const dataOperacao = normalizeDateKey(entry.dataOperacao || '')
  const dataReferencia = normalizeDateKey(entry.dataReferencia || entry.dataEntrada || '')
  const data = normalizeDateKey(dataOperacao || entry.data || dataReferencia || '')
  const mesApuracao = data ? data.slice(0, 7) : normalizeMonthLike(entry.mesApuracao)
  const line = normalizeLine(entry.linha || entry.line)
  if (!data || !mesApuracao || !line) return null
  const codigoCliente = String(entry.codigoCliente || entry.conta || entry.cliente || '')
    .replace(/\D/g, '')
    .trim()
  if (!codigoCliente) return null
  const comissao = toSafeNumber(entry.comissao ?? entry.receitaLiquida ?? entry.receita ?? entry.valor)
  if (!(comissao > 0)) return null
  const id = String(entry.id || `xp-${Date.now()}-${index}`).trim()
  const nomeCliente = String(entry.nomeCliente || entry.clienteNome || '').trim()
  const assessor = normalizeAssessorName(String(entry.assessor || '').trim(), '')
  const broker = String(entry.broker || '').trim()
  const time = String(entry.time || entry.equipe || '').trim()
  const unit = String(entry.unit || entry.unidade || '').trim()
  const seniority = String(entry.seniority || entry.senioridade || '').trim()

  return {
    id,
    data,
    dataOperacao,
    dataReferencia,
    mesApuracao,
    line,
    linhaReceita: String(entry.linhaReceita || '').trim(),
    produtoCategoria: String(entry.produtoCategoria || entry.produto || '').trim(),
    codigoCliente,
    conta: codigoCliente,
    cliente: codigoCliente,
    nomeCliente: '',
    tipoPessoa: String(entry.tipoPessoa || '').trim(),
    receitaAi: String(entry.receitaAi || '').trim(),
    tipoServico: String(entry.tipoServico || '').trim(),
    nivel1: String(entry.nivel1 || '').trim(),
    nivel2: String(entry.nivel2 || '').trim(),
    nivel3: String(entry.nivel3 || '').trim(),
    nivel4: String(entry.nivel4 || '').trim(),
    comissao: Number(comissao.toFixed(6)),
    receitaBruta: Number(toSafeNumber(entry.receitaBruta ?? comissao).toFixed(6)),
    receitaLiquida: Number(toSafeNumber(entry.receitaLiquida ?? comissao).toFixed(6)),
    repasseXp: entry.repasseXp == null ? null : Number(toSafeNumber(entry.repasseXp).toFixed(6)),
    escritorio: String(entry.escritorio || '').trim(),
    codAiXp: String(entry.codAiXp || '').trim(),
    codAiLiberta: String(entry.codAiLiberta || '').trim(),
    nomeAi: String(entry.nomeAi || '').trim(),
    squad: String(entry.squad || '').trim(),
    assessor,
    broker,
    time,
    unit,
    seniority,
    source: XP_SOURCE,
    importedAt: Number(entry.importedAt) || Date.now(),
  }
}

const normalizeXpEntries = (entries) => {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => normalizeXpEntry(entry, index))
    .filter(Boolean)
}

const readOverride = () => {
  const parseOverride = (value) => {
    if (!value) return { enabled: false }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        return { enabled: parsed?.enabled === true }
      } catch {
        return { enabled: false }
      }
    }
    return { enabled: value?.enabled === true }
  }

  try {
    const raw = localStorage.getItem(XP_OVERRIDE_KEY)
    if (raw) return parseOverride(raw)
  } catch {
    // noop
  }
  return parseOverride(getHydratedStorageValue(XP_OVERRIDE_KEY))
}

const saveOverride = async (enabled) => {
  const payload = { enabled: Boolean(enabled), updatedAt: Date.now() }
  setHydratedStorageValue(XP_OVERRIDE_KEY, payload)
  try {
    localStorage.setItem(XP_OVERRIDE_KEY, JSON.stringify(payload))
  } catch {
    // noop
  }
  await persistLocalStorage(XP_OVERRIDE_KEY, payload)
}

const saveXpEntries = async (entries) => {
  const normalized = normalizeXpEntries(entries)
  // Prime the in-memory cache so subsequent loadXpRevenue() calls are free
  _xpCache = { entries: normalized, stamp: Date.now() }
  setHydratedStorageValue(XP_STORAGE_KEY, normalized)
  try {
    localStorage.setItem(XP_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Se nao conseguir salvar no localStorage (quota), remove dado antigo para
    // evitar leitura de snapshot desatualizado.
    try {
      localStorage.removeItem(XP_STORAGE_KEY)
    } catch {
      // noop
    }
  }
  await persistLocalStorage(XP_STORAGE_KEY, normalized)
  return normalized
}

const emitRevenueUpdate = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
}

const resolveOverlayContext = (options = {}) => {
  const forceOverlay = options?.forceOverlay === true
  const xpEntries = loadXpRevenue()
  const overrideState = loadXpOverrideState()
  const months = new Set(listXpMonths(xpEntries))
  const enabled = (forceOverlay || overrideState.enabled) && months.size > 0
  return { xpEntries, months, enabled }
}

const filterRawByMonths = (entries, months, resolveDateValue) => {
  if (!months?.size) return Array.isArray(entries) ? [...entries] : []
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const month = normalizeMonthKey(resolveDateValue?.(entry))
    if (!month) return true
    return !months.has(month)
  })
}

const sortByDateDesc = (entries, resolveDateValue) => {
  return [...entries].sort((left, right) => {
    const leftDate = String(resolveDateValue?.(left) || '')
    const rightDate = String(resolveDateValue?.(right) || '')
    if (leftDate !== rightDate) return rightDate.localeCompare(leftDate)
    return String(right.id || '').localeCompare(String(left.id || ''))
  })
}

const toBovespaOrBmfEntry = (entry, line) => {
  const isBmf = line === 'BMF'
  return {
    id: `xp-${line.toLowerCase()}-${entry.id}`,
    codigoCliente: entry.codigoCliente,
    conta: entry.codigoCliente,
    data: entry.data,
    nomeCliente: '',
    cliente: entry.codigoCliente,
    assessor: entry.assessor || 'Sem assessor',
    broker: entry.broker || '',
    corretagem: entry.comissao,
    receitaBrutaBase: entry.comissao,
    repasse: 1,
    volumeNegociado: 0,
    tipoCorretagem: 'variavel',
    mercado: isBmf ? 'BMF' : 'BOV',
    receita: entry.comissao,
    origem: line,
    origemOperacao: `XP ${line}`,
    estrategia: entry.nivel1 || entry.produtoCategoria || line,
    operacao: entry.produtoCategoria || `XP ${line}`,
    source: XP_SOURCE,
    ativo: entry.nivel2 || '',
    time: entry.time || '',
    unit: entry.unit || '',
    seniority: entry.seniority || '',
    importedAt: entry.importedAt,
  }
}

const toStructuredEntry = (entry) => {
  return {
    id: `xp-estr-${entry.id}`,
    codigoCliente: entry.codigoCliente,
    dataEntrada: entry.data,
    estrutura: entry.nivel1 || entry.produtoCategoria || 'XP Estruturadas',
    ativo: entry.nivel2 || '',
    vencimento: '',
    comissao: entry.comissao,
    comissaoBaseBruta: entry.comissao,
    repasse: 1,
    quantidade: null,
    precoCompra: null,
    nomeCliente: '',
    cliente: entry.codigoCliente,
    assessor: entry.assessor || 'Sem assessor',
    broker: entry.broker || '',
    origem: 'Estruturadas',
    origemOperacao: 'XP Estruturadas',
    estrategia: entry.nivel1 || entry.produtoCategoria || 'Estruturada',
    operacao: entry.produtoCategoria || 'XP Estruturadas',
    source: XP_SOURCE,
    time: entry.time || '',
    unit: entry.unit || '',
    seniority: entry.seniority || '',
    importedAt: entry.importedAt,
  }
}

const toManualEntry = (entry) => {
  return {
    id: `xp-manual-${entry.id}`,
    data: entry.data,
    dataEntrada: entry.data,
    origem: entry.line,
    tipoCorretagem: 'variavel',
    codigoCliente: entry.codigoCliente,
    conta: entry.codigoCliente,
    cliente: entry.codigoCliente,
    nomeCliente: '',
    assessor: entry.assessor || 'Sem assessor',
    broker: entry.broker || '',
    ativo: entry.nivel2 || '',
    corretagem: entry.comissao,
    receita: entry.comissao,
    valor: entry.comissao,
    source: XP_SOURCE,
    time: entry.time || '',
    unit: entry.unit || '',
    seniority: entry.seniority || '',
    createdAt: entry.importedAt,
  }
}

export const loadXpRevenue = () => {
  // Return cached result if available (cache is invalidated on save/clear/event)
  if (_xpCache) return _xpCache.entries

  const parseHydrated = (value) => {
    if (Array.isArray(value)) return value
    if (Array.isArray(value?.entries)) return value.entries
    if (typeof value === 'string') return safeParse(value)
    return []
  }

  let result = []
  const hydratedRaw = getHydratedStorageValue(XP_STORAGE_KEY)
  if (hydratedRaw !== null) {
    result = normalizeXpEntries(parseHydrated(hydratedRaw))
  } else {
    try {
      const raw = localStorage.getItem(XP_STORAGE_KEY)
      if (raw) result = normalizeXpEntries(safeParse(raw))
    } catch {
      // noop
    }
  }

  _xpCache = { entries: result, stamp: Date.now() }
  return result
}

export const saveXpRevenue = async (entries) => {
  const normalized = await saveXpEntries(entries)
  emitRevenueUpdate()
  return normalized
}

export const clearXpRevenue = async () => {
  _xpCache = { entries: [], stamp: Date.now() }
  setHydratedStorageValue(XP_STORAGE_KEY, [])
  try {
    localStorage.removeItem(XP_STORAGE_KEY)
  } catch {
    // noop
  }
  await persistLocalStorage(XP_STORAGE_KEY, [])
  emitRevenueUpdate()
}

export const loadXpOverrideState = () => {
  if (_xpOverrideCache) return _xpOverrideCache.state
  const state = readOverride()
  _xpOverrideCache = { state, stamp: Date.now() }
  return state
}

export const setXpOverrideEnabled = async (enabled) => {
  _xpOverrideCache = { state: { enabled: Boolean(enabled) }, stamp: Date.now() }
  await saveOverride(enabled)
  emitRevenueUpdate()
}

export const listXpMonths = (entries = null) => {
  const source = entries || loadXpRevenue()
  const months = new Set(
    (Array.isArray(source) ? source : [])
      .map((entry) => normalizeMonthKey(entry?.data || entry?.dataEntrada) || normalizeMonthLike(entry?.mesApuracao))
      .filter(Boolean),
  )
  return Array.from(months).sort()
}

export const stripEntriesByXpMonths = (entries, resolveDateValue = resolveEntryDate, options = {}) => {
  const { months, enabled } = resolveOverlayContext(options)
  if (!enabled) return Array.isArray(entries) ? [...entries] : []
  return filterRawByMonths(entries, months, resolveDateValue)
}

export const buildEffectiveBovespaEntries = (rawEntries, options = {}) => {
  const { xpEntries, months, enabled } = resolveOverlayContext(options)
  const baseEntries = Array.isArray(rawEntries) ? rawEntries : []
  if (!enabled) return baseEntries
  const filtered = filterRawByMonths(baseEntries, months, (entry) => entry?.data || entry?.dataEntrada)
  const injected = xpEntries
    .filter((entry) => entry.line === 'Bovespa')
    .map((entry) => toBovespaOrBmfEntry(entry, 'Bovespa'))
  return sortByDateDesc([...filtered, ...injected], (entry) => entry?.data || entry?.dataEntrada)
}

export const buildEffectiveBmfEntries = (rawEntries, options = {}) => {
  const { xpEntries, months, enabled } = resolveOverlayContext(options)
  const baseEntries = Array.isArray(rawEntries) ? rawEntries : []
  if (!enabled) return baseEntries
  const filtered = filterRawByMonths(baseEntries, months, (entry) => entry?.data || entry?.dataEntrada)
  const injected = xpEntries
    .filter((entry) => entry.line === 'BMF')
    .map((entry) => toBovespaOrBmfEntry(entry, 'BMF'))
  return sortByDateDesc([...filtered, ...injected], (entry) => entry?.data || entry?.dataEntrada)
}

export const buildEffectiveStructuredEntries = (rawEntries, options = {}) => {
  const { xpEntries, months, enabled } = resolveOverlayContext(options)
  const baseEntries = Array.isArray(rawEntries) ? rawEntries : []
  if (!enabled) return baseEntries
  const filtered = filterRawByMonths(baseEntries, months, (entry) => entry?.dataEntrada || entry?.data)
  const injected = xpEntries
    .filter((entry) => entry.line === 'Estruturadas')
    .map((entry) => toStructuredEntry(entry))
  return sortByDateDesc([...filtered, ...injected], (entry) => entry?.dataEntrada || entry?.data)
}

export const buildEffectiveManualEntries = (rawEntries, options = {}) => {
  const { xpEntries, months, enabled } = resolveOverlayContext(options)
  const baseEntries = Array.isArray(rawEntries) ? rawEntries : []
  if (!enabled) return baseEntries
  const filtered = filterRawByMonths(baseEntries, months, (entry) => entry?.data || entry?.dataEntrada)
  const injected = xpEntries.map((entry) => toManualEntry(entry))
  return sortByDateDesc([...filtered, ...injected], (entry) => entry?.data || entry?.dataEntrada)
}

export const isXpRevenueEntry = (entry) => String(entry?.source || '').trim().toLowerCase() === XP_SOURCE

export const getXpStorageKeys = () => [XP_STORAGE_KEY, XP_OVERRIDE_KEY]
