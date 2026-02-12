import { debugLog } from './debug'
import { loadXlsx } from './xlsxLoader'
import { normalizeAssessorName } from '../utils/assessor'

const TAGS_VERSION = 2
const TAGS_DB_NAME = 'pwr-tags'
const TAGS_STORE = 'tags'
const TAGS_DB_VERSION = 1
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

const looksLikeCode = (value) => {
  const raw = normalizeValue(value)
  if (!raw) return false
  return /^\d+$/.test(raw)
}

const normalizeTagRow = (row, index = 0) => {
  if (!row || typeof row !== 'object') return null
  const cliente = normalizeValue(row.cliente)
  const nomeCliente = normalizeValue(row.nomeCliente)
  const key = normalizeTagKey(row.id || cliente || nomeCliente || `row-${index}`)
  if (!key) return null
  return {
    id: key,
    cliente,
    assessor: normalizeAssessorName(normalizeLabel(row.assessor, 'Sem assessor'), 'Sem assessor'),
    broker: normalizeLabel(row.broker, 'Sem broker'),
    nomeCliente,
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
  const XLSX = await loadXlsx()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames?.find((name) => normalizeKey(name) === 'planilha1') || workbook.SheetNames?.[0]
  if (!sheetName) throw new Error('sheet-missing')
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
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
    const broker = normalizeLabel(getValue(normalizedRow, BROKER_KEYS, fallbackRow[2]), 'Sem broker')
    const nomeCliente = normalizeValue(getValue(normalizedRow, NOME_CLIENTE_KEYS, fallbackRow[3]))
    const time = normalizeTeamLabel(getValue(normalizedRow, TIME_KEYS, fallbackRow[4]))
    const unitFallback = fallbackRow.length > 6 ? fallbackRow[5] : null
    const seniorityFallback = fallbackRow[6] != null && fallbackRow[6] !== '' ? fallbackRow[6] : fallbackRow[5]
    const unit = normalizeUnitLabel(getValue(normalizedRow, UNIT_KEYS, unitFallback))
    const seniority = normalizeSeniorityLabel(getValue(normalizedRow, SENIORITY_KEYS, seniorityFallback))

    if (isHeaderRow(cliente, assessor, broker, nomeCliente)) return
    if (!cliente && !nomeCliente) {
      stats.rejeitados += 1
      return
    }

    const key = normalizeTagKey(cliente || nomeCliente)
    if (!key) {
      stats.rejeitados += 1
      return
    }
    if (seen.has(key)) {
      stats.duplicados += 1
      return
    }
    seen.add(key)
    if (assessor === 'Sem assessor' || broker === 'Sem broker') stats.avisos += 1

    parsedRows.push({
      id: key,
      cliente: cliente || '',
      assessor,
      broker,
      nomeCliente: nomeCliente || '',
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

export const buildTagIndex = (payload) => {
  const rows = Array.isArray(payload?.rows) ? payload.rows : []
  const byCliente = new Map()
  const byNome = new Map()
  const brokers = new Set()
  const assessors = new Set()
  const teams = new Set()
  const units = new Set()
  const seniorities = new Set()

  rows.forEach((row) => {
    if (row?.broker) brokers.add(row.broker)
    if (row?.assessor) assessors.add(row.assessor)
    if (row?.time) teams.add(row.time)
    if (row?.unit) units.add(row.unit)
    if (row?.seniority) seniorities.add(row.seniority)
    const clienteKey = normalizeTagKey(row?.cliente)
    if (clienteKey && !byCliente.has(clienteKey)) byCliente.set(clienteKey, row)
    const nomeKey = normalizeTagKey(row?.nomeCliente)
    if (nomeKey && !byNome.has(nomeKey)) byNome.set(nomeKey, row)
  })

  return {
    rows,
    byCliente,
    byNome,
    brokers: Array.from(brokers).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    assessors: Array.from(assessors).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    teams: Array.from(teams).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    units: Array.from(units).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    seniorities: Array.from(seniorities).sort((a, b) => a.localeCompare(b, 'pt-BR')),
  }
}

export const enrichRow = (row, tagIndex) => {
  if (!row) return row

  const baseAssessor = normalizeAssessorName(row.assessor)
  const baseRow = baseAssessor && baseAssessor !== String(row.assessor || '').trim()
    ? { ...row, assessor: baseAssessor }
    : row

  if (!tagIndex) return baseRow

  const rawCode = baseRow.codigoCliente || baseRow.clienteCodigo || baseRow.codCliente || baseRow.cliente
  const codeKey = normalizeTagKey(rawCode)
  const nameKey = normalizeTagKey(baseRow.nomeCliente || baseRow.cliente)
  const tag = (codeKey && tagIndex.byCliente?.get(codeKey)) || (nameKey && tagIndex.byNome?.get(nameKey))
  if (!tag) return baseRow

  const next = { ...baseRow }
  if (tag.assessor) next.assessor = normalizeAssessorName(tag.assessor, 'Sem assessor')
  if (tag.broker) next.broker = tag.broker
  if (tag.time) next.time = tag.time
  if (tag.unit) next.unit = tag.unit
  if (tag.seniority) next.seniority = tag.seniority
  if (tag.nomeCliente) next.nomeCliente = tag.nomeCliente
  if (tag.cliente && !next.codigoCliente) next.codigoCliente = tag.cliente

  if (!next.cliente || looksLikeCode(next.cliente)) {
    next.cliente = tag.nomeCliente || tag.cliente || next.cliente
  }

  return next
}

export const normalizeTagLookup = (value) => normalizeTagKey(value)
