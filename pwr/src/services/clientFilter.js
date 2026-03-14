import { normalizeClientCode } from '../lib/tagResolver.js'

const normalizeClientText = (value) => String(value ?? '').trim()

const normalizeClientLabelKey = (value) => normalizeClientText(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const addClientToken = (target, value) => {
  const raw = normalizeClientText(value)
  if (!raw) return
  target.add(raw)
  const normalizedCode = normalizeClientCode(raw)
  if (normalizedCode) target.add(normalizedCode)
}

const buildClientLabel = (code, name) => {
  if (!code) return name
  if (!name) return code
  const sameCode = normalizeClientCode(code) && normalizeClientCode(code) === normalizeClientCode(name)
  const sameLabel = code.localeCompare(name, 'pt-BR', { sensitivity: 'base' }) === 0
  if (sameCode || sameLabel) return code
  return `${code} - ${name}`
}

export const collectClientFilterTokens = (entry) => {
  const tokens = new Set()
  addClientToken(tokens, entry?.codigoCliente)
  addClientToken(tokens, entry?.cliente)
  return Array.from(tokens)
}

export const buildClientFilterMatchSet = (values, availableTokens = null) => {
  const matches = new Set()
  ;(Array.isArray(values) ? values : []).forEach((value) => {
    const tokens = collectClientFilterTokens({ codigoCliente: value, cliente: value })
    if (!tokens.length) return
    const hasAvailableMatch = !(availableTokens instanceof Set) || !availableTokens.size
      || tokens.some((token) => availableTokens.has(token))
    if (!hasAvailableMatch) return
    tokens.forEach((token) => {
      if (!(availableTokens instanceof Set) || !availableTokens.size || availableTokens.has(token)) {
        matches.add(token)
      }
    })
  })
  return matches
}

export const matchesClientFilter = (entry, selectedTokens) => {
  if (!(selectedTokens instanceof Set) || !selectedTokens.size) return true
  return collectClientFilterTokens(entry).some((token) => selectedTokens.has(token))
}

export const buildClientFilterOptions = (rows) => {
  const optionsMap = new Map()
  ;(Array.isArray(rows) ? rows : []).forEach((entry) => {
    const code = normalizeClientText(entry?.codigoCliente)
    const name = normalizeClientText(entry?.cliente)
    const value = code || name
    if (!value) return
    const mapKey = normalizeClientCode(code) || normalizeClientLabelKey(name || value)
    const option = {
      value,
      label: buildClientLabel(code, name),
    }
    const previous = optionsMap.get(mapKey)
    if (!previous || (previous.label === previous.value && option.label !== option.value)) {
      optionsMap.set(mapKey, option)
    }
  })
  return Array.from(optionsMap.values())
    .sort((left, right) => String(left.label || '').localeCompare(String(right.label || ''), 'pt-BR'))
}
