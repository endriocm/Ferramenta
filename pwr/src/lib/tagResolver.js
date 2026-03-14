import { normalizeAssessorName } from '../utils/assessor.js'

const removeAccents = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

export const normalizeClientCode = (value) => {
  const raw = removeAccents(value).trim().toUpperCase()
  if (!raw) return ''
  const cleaned = raw.replace(/[.\s-]/g, '')
  if (!cleaned) return ''
  if (/^\d+$/.test(cleaned)) {
    const stripped = cleaned.replace(/^0+/, '')
    return stripped || '0'
  }
  return cleaned
}

export const normalizeName = (value) => {
  const raw = removeAccents(value).trim().toUpperCase()
  if (!raw) return ''
  return raw.replace(/\s+/g, ' ')
}

const buildEntry = (tag) => {
  const codigoCliente = String(tag?.codigoCliente || tag?.cliente || tag?.conta || '').trim()
  return {
    codigoCliente,
    assessor: normalizeAssessorName(tag?.assessor || ''),
    broker: tag?.broker || '',
    time: String(tag?.time || '').trim(),
    unit: String(tag?.unit || tag?.unidade || '').trim(),
    seniority: String(tag?.seniority || tag?.senioridade || '').trim(),
  }
}

export const buildTagIndex = (tags) => {
  const list = Array.isArray(tags) ? tags : []
  const byCode = new Map()

  list.forEach((tag) => {
    const entry = buildEntry(tag)
    const codeKey = normalizeClientCode(entry.codigoCliente)
    if (codeKey && !byCode.has(codeKey)) byCode.set(codeKey, entry)
  })

  return {
    byCode,
    size: list.length,
  }
}

export const resolveByClientCode = (tagIndex, codigoCliente) => {
  if (!tagIndex || !codigoCliente) return null
  const key = normalizeClientCode(codigoCliente)
  if (!key) return null
  return tagIndex.byCode?.get(key) || null
}

export const resolveByClientName = (tagIndex, nomeCliente) => {
  return null
}
