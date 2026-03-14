import { debugLog } from './debug.js'
import { parseXlsxInWorker } from './xlsxWorkerClient.js'
import { normalizeAssessorName } from '../utils/assessor.js'
import { normalizeClientCode } from '../lib/tagResolver.js'

const TAGS_VERSION = 3
const TAGS_DB_NAME = 'pwr-tags'
const TAGS_STORE = 'tags'
const TAGS_DB_VERSION = 1
const ASSESSOR_OVERRIDE_PREFIX = 'pwr.tags.assessor-overrides.'
const memoryCache = new Map()

const normalizeKey = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '')

const normalizeValue = (value) => {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return String(value).trim()
}

const normalizeLabel = (value, fallback) => {
  const raw = normalizeValue(value)
  if (!raw || raw === '0') return fallback
  return raw
}

const normalizeTeamLabel = (value) => {
  const raw = normalizeValue(value)
  if (!raw || raw === '0') return ''
  return raw.replace(/\s+/g, ' ')
}

const BROKER_UNKNOWN = '--'
const INVALID_BROKER_KEYS = new Set([
  '',
  '-',
  '--',
  '0',
  'sembroker',
  'semcorretora',
  'naoinformado',
  'naoidentificado',
  'naoaplicavel',
  'cotizador',
])

const normalizeBrokerKey = (value) => normalizeKey(normalizeValue(value))

export const normalizeBrokerLabel = (value, fallback = BROKER_UNKNOWN) => {
  const raw = normalizeValue(value)
  if (!raw || raw === '0') return fallback
  const compact = normalizeBrokerKey(raw)
  if (!compact || INVALID_BROKER_KEYS.has(compact)) return fallback
  return raw.replace(/\s+/g, ' ')
}

const resolveBrokerFromCatalog = (value, brokerCatalog) => {
  const normalized = normalizeBrokerLabel(value, BROKER_UNKNOWN)
  if (normalized === BROKER_UNKNOWN) return BROKER_UNKNOWN
  if (!(brokerCatalog instanceof Map) || !brokerCatalog.size) return normalized
  const key = normalizeTagKey(normalized)
  if (!key) return BROKER_UNKNOWN
  return brokerCatalog.get(key) || BROKER_UNKNOWN
}

export const normalizeUnitLabel = (value) => {
  const raw = normalizeValue(value)
  if (!raw || raw === '0') return ''
  const compact = normalizeKey(raw)
  if (!compact) return ''
  if (compact.includes('porto')) return 'Porto'
  if (compact.includes('balneario')) return 'Balneario'
  return raw.replace(/\s+/g, ' ')
}

export const normalizeSeniorityLabel = (value) => {
  const raw = normalizeValue(value)
  if (!raw || raw === '0') return ''
  const compact = normalizeKey(raw)
  if (!compact) return ''
  if (compact.includes('senior')) return 'Senior'
  if (compact.includes('pleno')) return 'Pleno'
  if (compact.includes('junior') && compact.includes('acad')) return 'Junior Acad'
  if (compact === 'jr' || compact.startsWith('jr') || compact.includes('junior')) return 'Junior'
  if (compact.includes('acad') || compact.includes('estagi')) return 'Acad'
  return raw.replace(/\s+/g, ' ')
}

const toArrayBuffer = async (input) => {
  if (!input) return null
  if (input instanceof ArrayBuffer) return input
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
  }
  if (typeof input.arrayBuffer === 'function') {
    return input.arrayBuffer()
  }
  return null
}

const getValue = (row, keys, fallback) => {
  if (row) {
    for (const key of keys) {
      if (row[key] != null && row[key] !== '') return row[key]
    }
  }
  if (fallback != null && fallback !== '') return fallback
  return null
}

const CLIENTE_KEYS = ['cliente', 'codcliente', 'codigocliente', 'codigo', 'codigodocliente', 'conta', 'numerodaconta']
const ASSESSOR_KEYS = ['assessor', 'consultor', 'assessorresponsavel']
const BROKER_KEYS = ['broker', 'corretora', 'canaldeorigem', 'canal', 'origem']
const NOME_CLIENTE_KEYS = ['nomecliente', 'nomedocliente', 'razaosocial', 'clientenome']
const TIME_KEYS = ['time', 'equipe', 'team']
const UNIT_KEYS = ['unidade', 'unit', 'filial', 'escritorio', 'base']
const SENIORITY_KEYS = ['senioridade', 'seniority', 'nivel', 'niveldecarreira']

const isHeaderRow = (cliente, assessor, broker, nomeCliente) => {
  const header = [cliente, assessor, broker, nomeCliente]
    .filter(Boolean)
    .map((item) => normalizeKey(item))
  return header.includes('cliente') && (header.includes('assessor') || header.includes('broker') || header.includes('nomecliente'))
}

const normalizeTagKey = (value) => {
  const raw = normalizeValue(value)
  if (!raw) return ''
  return normalizeKey(raw)
}

export const normalizeAssessorOverrideKey = (value) => {
  const assessor = normalizeAssessorName(value, '')
  if (!assessor) return ''
  return normalizeKey(assessor)
}

const normalizeAssessorOverrideEntry = (value, keyHint = '') => {
  const source = value && typeof value === 'object' ? value : {}
  const assessor = normalizeAssessorName(source.assessor || keyHint, '')
  if (!assessor) return null
  const broker = normalizeBrokerLabel(source.broker, '')
  const time = normalizeTeamLabel(source.time || source.team)
  const unit = normalizeUnitLabel(source.unit || source.unidade)
  return {
    assessor,
    broker,
    time,
    unit,
  }
}

const normalizeAssessorOverrideMap = (value) => {
  if (!value || typeof value !== 'object') return {}
  const normalized = {}
  Object.entries(value).forEach(([rawKey, rawValue]) => {
    const entry = normalizeAssessorOverrideEntry(rawValue, rawKey)
    if (!entry) return
    const key = normalizeAssessorOverrideKey(entry.assessor || rawKey)
    if (!key) return
    if (!entry.broker && !entry.time && !entry.unit) return
    normalized[key] = entry
  })
  return normalized
}

const buildAssessorOverrideStorageKey = (userKey) => `${ASSESSOR_OVERRIDE_PREFIX}${userKey || 'anon'}`

const buildClientLookupKeys = (value) => {
  const keys = []
  const normalizedCode = normalizeClientCode(value)
  if (normalizedCode) keys.push(normalizedCode)
  const compact = normalizeTagKey(value)
  if (compact && !keys.includes(compact)) keys.push(compact)
  return keys
}

const resolveByLookupKeys = (map, keys) => {
  if (!map || !Array.isArray(keys) || !keys.length) return null
  for (const key of keys) {
    if (!key) continue
    const value = map.get(key)
    if (value) return value
  }
  return null
}

const looksLikeCode = (value) => {
  const raw = normalizeValue(value)
  if (!raw) return false
  return /^\d+$/.test(raw)
}

const normalizeTagRow = (row, index = 0) => {
  if (!row || typeof row !== 'object') return null
  const cliente = normalizeValue(row.cliente)
  if (!cliente) return null
  const key = normalizeTagKey(row.id || cliente || `row-${index}`)
  if (!key) return null
  return {
    id: key,
    cliente,
    assessor: normalizeAssessorName(normalizeLabel(row.assessor, 'Sem assessor'), 'Sem assessor'),
    broker: normalizeBrokerLabel(row.broker, BROKER_UNKNOWN),
    time: normalizeTeamLabel(row.time),
    unit: normalizeUnitLabel(row.unit || row.unidade),
    seniority: normalizeSeniorityLabel(row.seniority || row.senioridade),
  }
}

const normalizePayload = (payload) => {
  if (!payload || typeof payload !== 'object') return null
  const normalizedRows = Array.isArray(payload.rows)
    ? payload.rows
      .map((row, index) => normalizeTagRow(row, index))
      .filter(Boolean)
    : []
  return {
    version: Number(payload.version) || TAGS_VERSION,
    importedAt: payload.importedAt || Date.now(),
    rows: normalizedRows,
    stats: payload.stats || null,
    source: payload.source || 'unknown',
    sheetName: payload.sheetName || null,
  }
}

const openTagsDb = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('indexeddb-unavailable'))
    return
  }
  const request = indexedDB.open(TAGS_DB_NAME, TAGS_DB_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(TAGS_STORE)) {
      db.createObjectStore(TAGS_STORE)
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const readPayload = async (userKey) => {
  try {
    const db = await openTagsDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(TAGS_STORE, 'readonly')
      const store = tx.objectStore(TAGS_STORE)
      const request = store.get(userKey)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => resolve(null)
      tx.oncomplete = () => db.close()
      tx.onabort = () => {
        db.close()
        resolve(null)
      }
    })
  } catch {
    return null
  }
}

const writePayload = async (userKey, payload) => {
  try {
    const db = await openTagsDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(TAGS_STORE, 'readwrite')
      const store = tx.objectStore(TAGS_STORE)
      store.put(payload, userKey)
      tx.oncomplete = () => {
        db.close()
        resolve(true)
      }
      tx.onabort = () => {
        db.close()
        resolve(false)
      }
    })
  } catch {
    return false
  }
}

const deletePayload = async (userKey) => {
  try {
    const db = await openTagsDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(TAGS_STORE, 'readwrite')
      const store = tx.objectStore(TAGS_STORE)
      store.delete(userKey)
      tx.oncomplete = () => {
        db.close()
        resolve(true)
      }
      tx.onabort = () => {
        db.close()
        resolve(false)
      }
    })
  } catch {
    return false
  }
}

export const parseTagsXlsx = async (input) => {
  const buffer = await toArrayBuffer(input)
  if (!buffer) throw new Error('buffer-invalid')
  const { sheetNames, sheets } = await parseXlsxInWorker(buffer)
  const sheetName = sheetNames?.find((name) => normalizeKey(name) === 'planilha1') || sheetNames?.[0]
  if (!sheetName) throw new Error('sheet-missing')
  const { rows, rawRows } = sheets[sheetName]
  const rowOffset = rawRows.length > rows.length ? 1 : 0

  const parsedRows = []
  const seen = new Set()
  const stats = { importados: 0, duplicados: 0, rejeitados: 0, avisos: 0 }

  rows.forEach((row, index) => {
    const normalizedRow = Object.keys(row).reduce((acc, key) => {
      acc[normalizeKey(key)] = row[key]
      return acc
    }, {})
    const fallbackRow = rawRows[rowOffset + index] || []

    const cliente = normalizeValue(getValue(normalizedRow, CLIENTE_KEYS, fallbackRow[0]))
    const assessor = normalizeAssessorName(
      normalizeLabel(getValue(normalizedRow, ASSESSOR_KEYS, fallbackRow[1]), 'Sem assessor'),
      'Sem assessor',
    )
    const broker = normalizeBrokerLabel(getValue(normalizedRow, BROKER_KEYS, fallbackRow[2]), BROKER_UNKNOWN)
    const nomeCliente = normalizeValue(getValue(normalizedRow, NOME_CLIENTE_KEYS, fallbackRow[3]))
    const time = normalizeTeamLabel(getValue(normalizedRow, TIME_KEYS, fallbackRow[4]))
    const unitFallback = fallbackRow.length > 6 ? fallbackRow[5] : null
    const seniorityFallback = fallbackRow[6] != null && fallbackRow[6] !== '' ? fallbackRow[6] : fallbackRow[5]
    const unit = normalizeUnitLabel(getValue(normalizedRow, UNIT_KEYS, unitFallback))
    const seniority = normalizeSeniorityLabel(getValue(normalizedRow, SENIORITY_KEYS, seniorityFallback))

    if (isHeaderRow(cliente, assessor, broker, nomeCliente)) return
    if (!cliente) {
      stats.rejeitados += 1
      return
    }

    const key = normalizeTagKey(cliente)
    if (!key) {
      stats.rejeitados += 1
      return
    }
    if (seen.has(key)) {
      stats.duplicados += 1
      return
    }
    seen.add(key)
    if (assessor === 'Sem assessor' || broker === BROKER_UNKNOWN) stats.avisos += 1

    parsedRows.push({
      id: key,
      cliente: cliente || '',
      assessor,
      broker,
      time,
      unit,
      seniority,
    })
  })

  stats.importados = parsedRows.length

  debugLog('tags.import.parse', { total: parsedRows.length, duplicados: stats.duplicados, rejeitados: stats.rejeitados })

  return {
    version: TAGS_VERSION,
    importedAt: Date.now(),
    rows: parsedRows,
    stats,
    source: 'xlsx',
    sheetName,
  }
}

export const saveTags = async (userKey, payload) => {
  if (!userKey || !payload) return null
  const stored = normalizePayload(payload)
  if (!stored) return null
  const ok = await writePayload(userKey, stored)
  if (!ok) return null
  memoryCache.set(userKey, stored)
  debugLog('tags.import.saved', { total: stored.rows.length })
  return stored
}

export const loadTags = async (userKey) => {
  if (!userKey) return null
  if (memoryCache.has(userKey)) return memoryCache.get(userKey)
  const payload = await readPayload(userKey)
  const normalized = normalizePayload(payload)
  if (normalized) memoryCache.set(userKey, normalized)
  return normalized
}

export const clearTags = async (userKey) => {
  if (!userKey) return
  memoryCache.delete(userKey)
  await deletePayload(userKey)
}

export const loadAssessorOverrides = (userKey) => {
  if (!userKey || typeof window === 'undefined') return {}
  const key = buildAssessorOverrideStorageKey(userKey)
  const raw = window.localStorage.getItem(key)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return normalizeAssessorOverrideMap(parsed)
  } catch {
    return {}
  }
}

export const saveAssessorOverrides = (userKey, overrides) => {
  if (!userKey || typeof window === 'undefined') return null
  const key = buildAssessorOverrideStorageKey(userKey)
  const normalized = normalizeAssessorOverrideMap(overrides)
  try {
    window.localStorage.setItem(key, JSON.stringify(normalized))
    return normalized
  } catch {
    return null
  }
}

export const buildTagIndex = (payload, options = {}) => {
  const rows = Array.isArray(payload?.rows) ? payload.rows : []
  const assessorOverrides = normalizeAssessorOverrideMap(options?.assessorOverrides)
  const assessorOverrideMap = new Map(Object.entries(assessorOverrides))
  const brokerCatalog = new Map()
  rows.forEach((row) => {
    const broker = normalizeBrokerLabel(row?.broker, BROKER_UNKNOWN)
    if (broker === BROKER_UNKNOWN) return
    const key = normalizeTagKey(broker)
    if (key && !brokerCatalog.has(key)) brokerCatalog.set(key, broker)
  })
  const effectiveRows = []
  const byCliente = new Map()
  const byAssessor = new Map()
  const brokers = new Set(Array.from(brokerCatalog.values()))
  const assessors = new Set()
  const teams = new Set()
  const units = new Set()
  const seniorities = new Set()
  let hasUnknownBroker = false

  rows.forEach((row) => {
    const assessorKey = normalizeAssessorOverrideKey(row?.assessor)
    const override = assessorKey ? assessorOverrideMap.get(assessorKey) : null
    const effectiveRow = {
      ...(row || {}),
      assessor: override?.assessor || row?.assessor,
      broker: resolveBrokerFromCatalog(override?.broker || row?.broker, brokerCatalog),
      time: override?.time || row?.time,
      unit: override?.unit || row?.unit,
    }
    effectiveRows.push(effectiveRow)

    if (effectiveRow?.broker === BROKER_UNKNOWN) hasUnknownBroker = true
    if (effectiveRow?.assessor) assessors.add(effectiveRow.assessor)
    if (effectiveRow?.time) teams.add(effectiveRow.time)
    if (effectiveRow?.unit) units.add(effectiveRow.unit)
    if (effectiveRow?.seniority) seniorities.add(effectiveRow.seniority)
    const assessorLookupKey = normalizeAssessorOverrideKey(effectiveRow?.assessor)
    if (assessorLookupKey && !byAssessor.has(assessorLookupKey)) {
      byAssessor.set(assessorLookupKey, effectiveRow)
    }
    const clienteKeys = buildClientLookupKeys(effectiveRow?.cliente)
    clienteKeys.forEach((key) => {
      if (key && !byCliente.has(key)) byCliente.set(key, effectiveRow)
    })
  })

  Object.values(assessorOverrides).forEach((entry) => {
    if (entry?.assessor) assessors.add(entry.assessor)
    if (entry?.time) teams.add(entry.time)
    if (entry?.unit) units.add(entry.unit)
  })

  const brokerOptions = Array.from(brokers).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  if (hasUnknownBroker && !brokerOptions.includes(BROKER_UNKNOWN)) brokerOptions.push(BROKER_UNKNOWN)

  return {
    rows: effectiveRows,
    byCliente,
    byAssessor,
    assessorOverrides,
    brokerCatalog,
    brokers: brokerOptions,
    assessors: Array.from(assessors).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    teams: Array.from(teams).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    units: Array.from(units).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    seniorities: Array.from(seniorities).sort((a, b) => a.localeCompare(b, 'pt-BR')),
  }
}

const applyAssessorOverride = (row, assessorOverrides) => {
  if (!row || !assessorOverrides || typeof assessorOverrides !== 'object') return row
  const assessorKey = normalizeAssessorOverrideKey(row?.assessor)
  if (!assessorKey) return row
  const override = assessorOverrides[assessorKey]
  if (!override) return row
  const next = { ...row }
  if (override.assessor) next.assessor = override.assessor
  if (override.broker) next.broker = normalizeBrokerLabel(override.broker, BROKER_UNKNOWN)
  if (override.time) next.time = override.time
  if (override.unit) {
    next.unit = override.unit
    next.unidade = override.unit
  }
  return next
}

export const enrichRow = (row, tagIndex) => {
  if (!row) return row

  const baseAssessor = normalizeAssessorName(row.assessor)
  const baseBroker = normalizeBrokerLabel(row.broker, BROKER_UNKNOWN)
  const baseRow = baseAssessor && baseAssessor !== String(row.assessor || '').trim()
    ? { ...row, assessor: baseAssessor, broker: baseBroker }
    : { ...row, broker: baseBroker }

  const resolveFinalBroker = (value) => {
    const catalog = tagIndex?.brokerCatalog
    if (catalog instanceof Map && catalog.size) return resolveBrokerFromCatalog(value, catalog)
    return normalizeBrokerLabel(value, BROKER_UNKNOWN)
  }

  if (!tagIndex) {
    return {
      ...baseRow,
      broker: resolveFinalBroker(baseRow.broker),
    }
  }

  const rawCode = baseRow.codigoCliente || baseRow.clienteCodigo || baseRow.codCliente || baseRow.cliente
  const codeKeys = buildClientLookupKeys(rawCode)
  const directTag = resolveByLookupKeys(tagIndex.byCliente, codeKeys)
  const assessorLookupKey = normalizeAssessorOverrideKey(baseRow.assessor)
  const assessorTag = assessorLookupKey ? tagIndex.byAssessor?.get(assessorLookupKey) : null
  const matchedByAssessor = !directTag && Boolean(assessorTag)
  const tag = directTag || assessorTag
  if (!tag) {
    const overridden = applyAssessorOverride(baseRow, tagIndex.assessorOverrides)
    return {
      ...overridden,
      broker: resolveFinalBroker(overridden?.broker),
    }
  }

  const next = { ...baseRow }
  if (tag.assessor) next.assessor = normalizeAssessorName(tag.assessor, 'Sem assessor')
  if (tag.broker && (!matchedByAssessor || !next.broker)) next.broker = tag.broker
  if (tag.time && (!matchedByAssessor || !next.time)) next.time = tag.time
  if (tag.unit && (!matchedByAssessor || !next.unit)) next.unit = tag.unit
  if (tag.seniority && (!matchedByAssessor || !next.seniority)) next.seniority = tag.seniority

  if (!matchedByAssessor) {
    if (tag.cliente && !next.codigoCliente) next.codigoCliente = tag.cliente
    if (!next.cliente || looksLikeCode(next.cliente)) {
      next.cliente = tag.cliente || next.cliente
    }
  }

  const overridden = applyAssessorOverride(next, tagIndex.assessorOverrides)
  return {
    ...overridden,
    broker: resolveFinalBroker(overridden?.broker),
  }
}

export const normalizeTagLookup = (value) => normalizeTagKey(value)
