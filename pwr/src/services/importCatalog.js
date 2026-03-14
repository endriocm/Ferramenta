import { getCurrentUserKey } from './currentUser'
import { loadGlobalFolderLink } from './globalFolderLink'
import { loadAllMenuMappings } from './globalFolderMapping'

const CATALOG_PREFIX = 'pwr.import.catalog.'
const BINDINGS_PREFIX = 'pwr.import.bindings.'
const VERSION = 1

export const IMPORT_CATALOG_EVENT = 'pwr:import-catalog-updated'
export const IMPORT_BINDINGS_EVENT = 'pwr:import-bindings-updated'

const buildCatalogKey = (userKey) => `${CATALOG_PREFIX}${userKey || 'anon'}`
const buildBindingsKey = (userKey) => `${BINDINGS_PREFIX}${userKey || 'anon'}`

const normalizeToken = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const normalizePathToken = (value) => normalizeToken(String(value || '').replace(/[\\/]+/g, '/'))

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const toArray = (value) => (Array.isArray(value) ? value : [])

const isSpreadsheetName = (name) => {
  const raw = String(name || '')
  const lower = raw.toLowerCase()
  return (lower.endsWith('.xlsx') || lower.endsWith('.xls')) && !raw.startsWith('~$')
}

const getFileName = (file) => String(file?.fileName || file?.name || '')

const getFileTimestamp = (file) => Number(file?.lastModified || 0) || 0

const sortRecentDesc = (left, right) => {
  const byDate = getFileTimestamp(right) - getFileTimestamp(left)
  if (byDate !== 0) return byDate
  return getFileName(left).localeCompare(getFileName(right), 'pt-BR')
}

const scoreFile = (file, hints = []) => {
  const normalizedHints = toArray(hints).map(normalizeToken).filter(Boolean)
  if (!normalizedHints.length) return 0
  const haystack = normalizeToken([
    file?.fileName,
    file?.relativePath,
    file?.folderPath,
    file?.filePath,
  ].filter(Boolean).join(' '))
  if (!haystack) return 0
  return normalizedHints.reduce((score, token) => (haystack.includes(token) ? score + 1 : score), 0)
}

const sortFilesForBinding = (files, hints = []) => {
  return [...toArray(files)].sort((left, right) => {
    const scoreDiff = scoreFile(right, hints) - scoreFile(left, hints)
    if (scoreDiff !== 0) return scoreDiff
    return sortRecentDesc(left, right)
  })
}

const normalizeCatalogFile = (file, rootPath = '') => {
  const fileName = String(file?.fileName || file?.name || '').trim()
  const filePath = String(file?.filePath || '').trim()
  if (!fileName || !filePath || !isSpreadsheetName(fileName)) return null
  return {
    id: String(file?.id || '').trim() || filePath,
    source: 'electron',
    rootPath: String(file?.rootPath || rootPath || '').trim(),
    folderPath: String(file?.folderPath || '').trim(),
    filePath,
    fileName,
    name: fileName,
    relativePath: String(file?.relativePath || fileName).trim() || fileName,
    lastModified: Number(file?.lastModified || 0) || 0,
    size: Number(file?.size || 0) || 0,
  }
}

const normalizeCatalogPayload = (payload = {}) => {
  const rootPath = String(payload?.rootPath || '').trim()
  const files = toArray(payload?.files)
    .map((file) => normalizeCatalogFile(file, rootPath))
    .filter(Boolean)
    .sort(sortRecentDesc)
  return {
    version: VERSION,
    rootPath,
    rootName: String(payload?.rootName || '').trim() || resolveFolderName(rootPath),
    scannedAt: Number(payload?.scannedAt || Date.now()) || Date.now(),
    fileCount: files.length,
    files,
  }
}

const normalizeBindingEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null
  const bindingKey = String(entry.bindingKey || '').trim()
  const roleKey = String(entry.roleKey || 'default').trim() || 'default'
  const fileId = String(entry.fileId || '').trim()
  if (!bindingKey || !fileId) return null
  return {
    bindingKey,
    roleKey,
    fileId,
    updatedAt: Number(entry.updatedAt || Date.now()) || Date.now(),
  }
}

const normalizeBindingsPayload = (payload) => {
  const entries = toArray(payload?.entries)
    .map(normalizeBindingEntry)
    .filter(Boolean)
  return {
    version: VERSION,
    entries,
  }
}

const writeStorage = (key, payload) => {
  try {
    localStorage.setItem(key, JSON.stringify(payload))
    return payload
  } catch {
    return null
  }
}

const removeStorage = (key) => {
  try {
    localStorage.removeItem(key)
  } catch {
    // noop
  }
}

const resolveFolderName = (folderPath) => {
  const parts = String(folderPath || '')
    .split(/[\\/]+/)
    .filter(Boolean)
  return parts[parts.length - 1] || ''
}

const emitEvent = (eventName, detail = {}) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: {
      updatedAt: Date.now(),
      ...detail,
    },
  }))
}

export const IMPORT_BINDING_REGISTRY = [
  { bindingKey: 'estruturadas', roleKey: 'default', label: 'Estruturadas', hints: ['estrutur', 'operac', 'export'] },
  { bindingKey: 'bovespa', roleKey: 'default', label: 'Bovespa', hints: ['bovespa', 'bov'] },
  { bindingKey: 'bmf', roleKey: 'default', label: 'BMF', hints: ['bmf', 'futuro'] },
  { bindingKey: 'comissao-xp', roleKey: 'default', label: 'Comissao XP', hints: ['xp', 'comissao'] },
  { bindingKey: 'consolidado', roleKey: 'default', label: 'Consolidado', hints: ['consolid', 'receita'] },
  { bindingKey: 'tags', roleKey: 'default', label: 'Tags e Vinculos', hints: ['tags', 'tag', 'vincul'] },
  { bindingKey: 'vencimento', roleKey: 'default', label: 'Vencimento', hints: ['vencimento', 'relatorio', 'posicao'] },
  { bindingKey: 'historico-operacoes', roleKey: 'default', label: 'Historico de Operacoes', hints: ['historico', 'vencimento', 'estruturas'] },
  { bindingKey: 'antecipacao', roleKey: 'default', label: 'Antecipacao', hints: ['antecipacao', 'antecip', 'posicoesdisponiveis'] },
  { bindingKey: 'batimento-barreira', roleKey: 'base', label: 'Batimento de barreira (base)', hints: ['base', 'inicio', 'mes', 'relatorio', 'posicao'] },
  { bindingKey: 'batimento-barreira', roleKey: 'diario', label: 'Batimento de barreira (diario)', hints: ['diario', 'relatorio', 'posicao'] },
]

const IMPORT_BINDING_ALIASES = {
  'clientes-operando.default': { bindingKey: 'estruturadas', roleKey: 'default' },
  'projecao-vencimento.default': { bindingKey: 'vencimento', roleKey: 'default' },
}

const LEGACY_MENU_TO_BINDING = {
  estruturadas: { bindingKey: 'estruturadas', roleKey: 'default' },
  bovespa: { bindingKey: 'bovespa', roleKey: 'default' },
  bmf: { bindingKey: 'bmf', roleKey: 'default' },
  'comissao-xp': { bindingKey: 'comissao-xp', roleKey: 'default' },
  tags: { bindingKey: 'tags', roleKey: 'default' },
  vencimento: { bindingKey: 'vencimento', roleKey: 'default' },
  'historico-operacoes': { bindingKey: 'historico-operacoes', roleKey: 'default' },
  antecipacao: { bindingKey: 'antecipacao', roleKey: 'default' },
  'projecao-vencimento': { bindingKey: 'projecao-vencimento', roleKey: 'default' },
}

export const resolveBindingTarget = (bindingKey, roleKey = 'default') => {
  const rawBindingKey = String(bindingKey || '').trim()
  const rawRoleKey = String(roleKey || 'default').trim() || 'default'
  const alias = IMPORT_BINDING_ALIASES[`${rawBindingKey}.${rawRoleKey}`]
  if (alias) return alias
  return { bindingKey: rawBindingKey, roleKey: rawRoleKey }
}

export const resolveBindingSpec = (bindingKey, roleKey = 'default') => {
  const target = resolveBindingTarget(bindingKey, roleKey)
  return IMPORT_BINDING_REGISTRY.find((item) => (
    item.bindingKey === target.bindingKey && item.roleKey === target.roleKey
  )) || null
}

export const loadImportCatalog = (userKey) => {
  if (!userKey) return null
  try {
    const parsed = safeParse(localStorage.getItem(buildCatalogKey(userKey)))
    if (!parsed) return null
    return normalizeCatalogPayload(parsed)
  } catch {
    return null
  }
}

export const loadImportBindings = (userKey) => {
  if (!userKey) return { version: VERSION, entries: [] }
  try {
    const parsed = safeParse(localStorage.getItem(buildBindingsKey(userKey)))
    return normalizeBindingsPayload(parsed)
  } catch {
    return { version: VERSION, entries: [] }
  }
}

const writeBindingsPayload = (userKey, payload, { emit = true } = {}) => {
  if (!userKey) return { version: VERSION, entries: [] }
  const normalized = normalizeBindingsPayload(payload)
  const stored = writeStorage(buildBindingsKey(userKey), normalized) || normalized
  if (emit) emitEvent(IMPORT_BINDINGS_EVENT, { userKey })
  return stored
}

export const clearImportCatalog = (userKey) => {
  if (!userKey) return
  removeStorage(buildCatalogKey(userKey))
  emitEvent(IMPORT_CATALOG_EVENT, { userKey, catalog: null })
}

export const clearImportBindings = (userKey) => {
  if (!userKey) return
  removeStorage(buildBindingsKey(userKey))
  emitEvent(IMPORT_BINDINGS_EVENT, { userKey, bindings: { version: VERSION, entries: [] } })
}

export const loadImportBinding = (userKey, bindingKey, roleKey = 'default') => {
  if (!userKey) return null
  const target = resolveBindingTarget(bindingKey, roleKey)
  return loadImportBindings(userKey).entries.find((entry) => (
    entry.bindingKey === target.bindingKey && entry.roleKey === target.roleKey
  )) || null
}

export const saveImportBinding = (userKey, bindingKey, roleKey = 'default', fileId = '') => {
  if (!userKey) return null
  const target = resolveBindingTarget(bindingKey, roleKey)
  const nextFileId = String(fileId || '').trim()
  const bindings = loadImportBindings(userKey)
  const filtered = bindings.entries.filter((entry) => !(
    entry.bindingKey === target.bindingKey && entry.roleKey === target.roleKey
  ))
  if (nextFileId) {
    filtered.push({
      bindingKey: target.bindingKey,
      roleKey: target.roleKey,
      fileId: nextFileId,
      updatedAt: Date.now(),
    })
  }
  return writeBindingsPayload(userKey, {
    ...bindings,
    entries: filtered,
  })
}

const pickUniqueSuggestion = (files, hints = []) => {
  const scored = toArray(files)
    .map((file) => ({ file, score: scoreFile(file, hints) }))
    .filter((item) => item.score > 0)
  if (!scored.length) return null
  const bestScore = Math.max(...scored.map((item) => item.score))
  const matches = scored
    .filter((item) => item.score === bestScore)
    .map((item) => item.file)
    .sort(sortRecentDesc)
  if (matches.length !== 1) return null
  return matches[0]
}

const pruneBindingsForCatalog = (bindings, catalog) => {
  const validIds = new Set(toArray(catalog?.files).map((file) => file.id))
  return normalizeBindingsPayload({
    entries: toArray(bindings?.entries).filter((entry) => validIds.has(entry.fileId)),
  })
}

const applyAutoSuggestions = (bindings, catalog) => {
  const nextEntries = [...toArray(bindings?.entries)]
  const occupied = new Set(nextEntries.map((entry) => `${entry.bindingKey}.${entry.roleKey}`))
  for (const spec of IMPORT_BINDING_REGISTRY) {
    const key = `${spec.bindingKey}.${spec.roleKey}`
    if (occupied.has(key)) continue
    const suggestion = pickUniqueSuggestion(catalog?.files, spec.hints)
    if (!suggestion?.id) continue
    nextEntries.push({
      bindingKey: spec.bindingKey,
      roleKey: spec.roleKey,
      fileId: suggestion.id,
      updatedAt: Date.now(),
    })
    occupied.add(key)
  }
  return normalizeBindingsPayload({ entries: nextEntries })
}

export const saveImportCatalog = (userKey, payload = {}) => {
  if (!userKey) return null
  const catalog = normalizeCatalogPayload(payload)
  const storedCatalog = writeStorage(buildCatalogKey(userKey), catalog) || catalog
  const prunedBindings = pruneBindingsForCatalog(loadImportBindings(userKey), storedCatalog)
  const nextBindings = applyAutoSuggestions(prunedBindings, storedCatalog)
  writeBindingsPayload(userKey, nextBindings, { emit: false })
  emitEvent(IMPORT_CATALOG_EVENT, { userKey, catalog: storedCatalog })
  emitEvent(IMPORT_BINDINGS_EVENT, { userKey, bindings: nextBindings })
  return storedCatalog
}

export const findCatalogFilesForBinding = (userKey, bindingKey, roleKey = 'default', { catalog } = {}) => {
  const sourceCatalog = catalog || loadImportCatalog(userKey)
  const spec = resolveBindingSpec(bindingKey, roleKey)
  return sortFilesForBinding(sourceCatalog?.files, spec?.hints || [])
}

export const getBindingFile = (userKey, bindingKey, roleKey = 'default', { catalog } = {}) => {
  const sourceCatalog = catalog || loadImportCatalog(userKey)
  const binding = loadImportBinding(userKey, bindingKey, roleKey)
  if (!binding?.fileId) return null
  return toArray(sourceCatalog?.files).find((file) => file.id === binding.fileId) || null
}

export const readImportedFileAsArrayBuffer = async (file) => {
  if (!file) return null
  if (file instanceof ArrayBuffer) return file
  if (ArrayBuffer.isView(file)) {
    return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
  }
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer()
  }
  if (file?.source === 'electron' && file?.filePath && typeof window !== 'undefined') {
    const readFn = window?.electronAPI?.readFile
    if (typeof readFn !== 'function') return null
    const raw = await readFn(file.filePath)
    if (!raw) return null
    if (raw instanceof ArrayBuffer) return raw
    if (ArrayBuffer.isView(raw)) {
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    }
    if (raw?.buffer instanceof ArrayBuffer) {
      return raw.buffer.slice(raw.byteOffset || 0, (raw.byteOffset || 0) + (raw.byteLength || raw.length || 0))
    }
  }
  return null
}

const filterFilesInsideFolder = (files, folderPath) => {
  const folderToken = normalizePathToken(folderPath)
  if (!folderToken) return []
  return toArray(files).filter((file) => {
    const fileFolder = normalizePathToken(file?.folderPath)
    const filePath = normalizePathToken(file?.filePath)
    return fileFolder === folderToken || filePath.startsWith(`${folderToken}/`)
  })
}

const migrateLegacyBindings = (userKey, catalog) => {
  const current = loadImportBindings(userKey)
  const mappings = loadAllMenuMappings(userKey)
  if (!mappings || typeof mappings !== 'object') return current

  const orderedMenus = [
    'estruturadas',
    'bovespa',
    'bmf',
    'comissao-xp',
    'tags',
    'vencimento',
    'historico-operacoes',
    'antecipacao',
    'projecao-vencimento',
  ]

  const migratedEntries = [...current.entries]

  for (const menuKey of orderedMenus) {
    const mapping = mappings[menuKey]
    const target = LEGACY_MENU_TO_BINDING[menuKey]
    if (!mapping || !target) continue
    const canonical = resolveBindingTarget(target.bindingKey, target.roleKey)
    const spec = resolveBindingSpec(canonical.bindingKey, canonical.roleKey)
    const scopedFiles = mapping?.folderPath
      ? filterFilesInsideFolder(catalog?.files, mapping.folderPath)
      : toArray(catalog?.files)
    const ranked = sortFilesForBinding(scopedFiles, spec?.hints || [])
    const match = ranked[0] || null
    if (!match?.id) continue
    const nextEntry = {
      bindingKey: canonical.bindingKey,
      roleKey: canonical.roleKey,
      fileId: match.id,
      updatedAt: Date.now(),
    }
    const existingIndex = migratedEntries.findIndex((entry) => (
      entry.bindingKey === canonical.bindingKey && entry.roleKey === canonical.roleKey
    ))
    if (existingIndex >= 0) migratedEntries.splice(existingIndex, 1, nextEntry)
    else migratedEntries.push(nextEntry)
  }

  const normalized = normalizeBindingsPayload({ entries: migratedEntries })
  if (normalized.entries.length) {
    writeBindingsPayload(userKey, normalized, { emit: false })
  }
  return normalized
}

const migrationTasks = new Map()

export const ensureImportCatalogMigrated = async (userKey = getCurrentUserKey()) => {
  if (!userKey || typeof window === 'undefined') return loadImportCatalog(userKey)
  if (loadImportCatalog(userKey)) return loadImportCatalog(userKey)
  if (migrationTasks.has(userKey)) return migrationTasks.get(userKey)

  const task = (async () => {
    const legacyLink = await loadGlobalFolderLink(userKey)
    const rootPath = String(legacyLink?.folderPath || '').trim()
    if (!rootPath) return null

    const scanFn = window?.electronAPI?.scanImportFolder
    if (typeof scanFn !== 'function') return null

    try {
      const files = await scanFn(rootPath)
      const catalog = saveImportCatalog(userKey, {
        rootPath,
        rootName: legacyLink?.folderName || resolveFolderName(rootPath),
        scannedAt: Date.now(),
        files,
      })
      if (catalog) {
        migrateLegacyBindings(userKey, catalog)
        emitEvent(IMPORT_BINDINGS_EVENT, {
          userKey,
          bindings: loadImportBindings(userKey),
        })
      }
      return catalog
    } catch {
      return null
    }
  })()

  migrationTasks.set(userKey, task)
  try {
    return await task
  } finally {
    migrationTasks.delete(userKey)
  }
}
