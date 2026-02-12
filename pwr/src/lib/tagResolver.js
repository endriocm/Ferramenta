import { normalizeAssessorName } from '../utils/assessor'

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
  const nomeCliente = String(tag?.nomeCliente || tag?.clienteNome || tag?.nome || '').trim()
  return {
    codigoCliente,
    nomeCliente,
    assessor: normalizeAssessorName(tag?.assessor || ''),
    broker: tag?.broker || '',
    time: String(tag?.time || '').trim(),
  }
}

export const buildTagIndex = (tags) => {
  const list = Array.isArray(tags) ? tags : []
  const byCode = new Map()
  const byName = new Map()

  list.forEach((tag) => {
    const entry = buildEntry(tag)
    const codeKey = normalizeClientCode(entry.codigoCliente)
    const nameKey = normalizeName(entry.nomeCliente)
    if (codeKey && !byCode.has(codeKey)) byCode.set(codeKey, entry)
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, entry)
  })

  return {
    byCode,
    byName,
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
  if (!tagIndex || !nomeCliente) return null
  const key = normalizeName(nomeCliente)
  if (!key) return null
  return tagIndex.byName?.get(key) || null
}
