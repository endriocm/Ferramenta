const STORAGE_PREFIX = 'pwr.global.folder.'
const HANDLE_DB_NAME = 'pwr-global-folder'
const HANDLE_STORE = 'folder-handles'
const HANDLE_VERSION = 1

export const GLOBAL_FOLDER_EVENT = 'pwr:global-folder-updated'

const buildKey = (userKey) => `${STORAGE_PREFIX}${userKey || 'anon'}`

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const normalizeToken = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const isSpreadsheetName = (name) => {
  const raw = String(name || '')
  const lower = raw.toLowerCase()
  return (lower.endsWith('.xlsx') || lower.endsWith('.xls')) && !raw.startsWith('~$')
}

const getFileName = (file) => String(
  file?.name
  || file?.fileName
  || file?.path
  || '',
)

const getFileTimestamp = (file) => {
  const value = Number(
    file?.lastModified
    || file?.lastModifiedMs
    || file?.mtimeMs
    || 0,
  )
  return Number.isFinite(value) ? value : 0
}

const sortByRecentDesc = (left, right) => {
  const byDate = getFileTimestamp(right) - getFileTimestamp(left)
  if (byDate !== 0) return byDate
  return getFileName(left).localeCompare(getFileName(right), 'pt-BR')
}

const scoreByHints = (name, hints) => {
  const normalized = normalizeToken(name)
  if (!normalized) return 0
  return hints.reduce((score, token) => (normalized.includes(token) ? score + 1 : score), 0)
}

const openHandleDb = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('indexeddb-unavailable'))
    return
  }
  const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(HANDLE_STORE)) {
      db.createObjectStore(HANDLE_STORE)
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const readHandle = async (userKey) => {
  try {
    const db = await openHandleDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly')
      const store = tx.objectStore(HANDLE_STORE)
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

const writeHandle = async (userKey, handle) => {
  try {
    const db = await openHandleDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite')
      const store = tx.objectStore(HANDLE_STORE)
      store.put(handle, userKey)
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

const deleteHandle = async (userKey) => {
  try {
    const db = await openHandleDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite')
      const store = tx.objectStore(HANDLE_STORE)
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

const resolveFolderNameFromPath = (folderPath) => {
  const parts = String(folderPath || '')
    .split(/[\\/]+/)
    .filter(Boolean)
  return parts[parts.length - 1] || ''
}

const toElectronFileDescriptor = (file) => ({
  source: 'electron',
  folderPath: file?.folderPath || '',
  filePath: file?.filePath || '',
  fileName: file?.fileName || '',
  name: file?.fileName || '',
  lastModified: Number(file?.lastModified || 0) || 0,
  size: Number(file?.size || 0) || 0,
})

const toElectronDirectoryDescriptor = (directory, { isRoot = false } = {}) => ({
  source: 'electron',
  folderPath: directory?.folderPath || '',
  folderName: directory?.folderName || resolveFolderNameFromPath(directory?.folderPath) || '',
  lastModified: Number(directory?.lastModified || 0) || 0,
  isRoot: Boolean(isRoot),
})

const sortDirectories = (left, right) => {
  const byDate = Number(right?.lastModified || 0) - Number(left?.lastModified || 0)
  if (byDate !== 0) return byDate
  return String(left?.folderName || '').localeCompare(String(right?.folderName || ''), 'pt-BR')
}

export const ensureGlobalFolderPermission = async (handle, { interactive = false } = {}) => {
  if (!handle || typeof handle.queryPermission !== 'function') return 'unavailable'
  try {
    let state = await handle.queryPermission({ mode: 'read' })
    if (state === 'granted') return state
    if (interactive && typeof handle.requestPermission === 'function') {
      state = await handle.requestPermission({ mode: 'read' })
    }
    return state
  } catch {
    return 'denied'
  }
}

export const saveGlobalFolderLink = async (userKey, link) => {
  if (!userKey || !link || typeof link !== 'object') return null
  const payload = {
    version: 1,
    source: link.source || 'electron',
    folderPath: link.folderPath || null,
    folderName: link.folderName || resolveFolderNameFromPath(link.folderPath) || null,
    savedAt: Date.now(),
  }
  try {
    localStorage.setItem(buildKey(userKey), JSON.stringify(payload))
  } catch {
    return null
  }

  if (payload.source === 'browser' && link.handle) {
    await writeHandle(userKey, link.handle)
  } else {
    await deleteHandle(userKey)
  }

  return payload
}

export const loadGlobalFolderLink = async (userKey) => {
  if (!userKey) return null
  let raw = null
  try {
    raw = localStorage.getItem(buildKey(userKey))
  } catch {
    raw = null
  }
  if (!raw) return null
  const parsed = safeParse(raw)
  if (!parsed) return null
  if (parsed.source === 'browser') {
    parsed.handle = await readHandle(userKey)
  }
  return parsed
}

export const clearGlobalFolderLink = async (userKey) => {
  if (!userKey) return
  try {
    localStorage.removeItem(buildKey(userKey))
  } catch {
    // noop
  }
  await deleteHandle(userKey)
}

export const emitGlobalFolderUpdated = (userKey, payload = {}) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(GLOBAL_FOLDER_EVENT, {
    detail: {
      userKey,
      updatedAt: Date.now(),
      ...payload,
    },
  }))
}

const listBrowserHandleFiles = async (handle) => {
  if (!handle) return []
  const permission = await ensureGlobalFolderPermission(handle, { interactive: false })
  if (permission !== 'granted') return []
  const files = []
  if (typeof handle.values === 'function') {
    for await (const entry of handle.values()) {
      if (!entry || entry.kind !== 'file') continue
      const file = await entry.getFile()
      if (!isSpreadsheetName(file?.name)) continue
      files.push(file)
    }
  }
  return files.sort(sortByRecentDesc)
}

const listElectronFolderFiles = async (folderPath) => {
  if (!folderPath) return []
  const listFn = window?.electronAPI?.listFolderFiles
  if (typeof listFn !== 'function') return []
  const files = await listFn(folderPath)
  if (!Array.isArray(files)) return []
  return files.map(toElectronFileDescriptor).filter((file) => isSpreadsheetName(file.name))
}

const listElectronFolderDirectories = async (folderPath) => {
  if (!folderPath) return []
  const listFn = window?.electronAPI?.listFolderDirectories
  if (typeof listFn !== 'function') return []
  const directories = await listFn(folderPath)
  if (!Array.isArray(directories)) return []
  return directories.map((directory) => toElectronDirectoryDescriptor(directory)).sort(sortDirectories)
}

export const listGlobalFolderFiles = async (link) => {
  if (!link) return []
  if (link.source === 'electron') {
    return listElectronFolderFiles(link.folderPath)
  }
  if (link.source === 'browser') {
    return listBrowserHandleFiles(link.handle)
  }
  return []
}

const listBrowserHandleDirectories = async (handle) => {
  if (!handle) return []
  const permission = await ensureGlobalFolderPermission(handle, { interactive: false })
  if (permission !== 'granted') return []
  const directories = []
  if (typeof handle.values === 'function') {
    for await (const entry of handle.values()) {
      if (!entry || entry.kind !== 'directory') continue
      directories.push({
        source: 'browser',
        folderName: entry.name || '',
        handle: entry,
        lastModified: 0,
        isRoot: false,
      })
    }
  }
  return directories.sort(sortDirectories)
}

export const listGlobalFolderDirectories = async (link, { includeRoot = true } = {}) => {
  if (!link) return []

  if (link.source === 'electron') {
    const root = includeRoot
      ? [toElectronDirectoryDescriptor({
        folderPath: link.folderPath || '',
        folderName: link.folderName || resolveFolderNameFromPath(link.folderPath) || '',
        lastModified: Date.now(),
      }, { isRoot: true })]
      : []
    const children = await listElectronFolderDirectories(link.folderPath)
    return [...root, ...children]
  }

  if (link.source === 'browser') {
    const root = includeRoot
      ? [{
        source: 'browser',
        folderName: link.folderName || 'Pasta global',
        handle: link.handle || null,
        lastModified: Date.now(),
        isRoot: true,
      }]
      : []
    const children = await listBrowserHandleDirectories(link.handle)
    return [...root, ...children]
  }

  return []
}

export const pickBestSpreadsheetFile = (files, { hints = [] } = {}) => {
  const candidates = (Array.isArray(files) ? files : [])
    .filter((file) => isSpreadsheetName(getFileName(file)))

  if (!candidates.length) return null

  const normalizedHints = (Array.isArray(hints) ? hints : [hints])
    .map(normalizeToken)
    .filter(Boolean)

  if (!normalizedHints.length) {
    return [...candidates].sort(sortByRecentDesc)[0]
  }

  const scored = candidates.map((file) => ({
    file,
    score: scoreByHints(getFileName(file), normalizedHints),
  }))
  const bestScore = Math.max(...scored.map((item) => item.score))
  const bestPool = bestScore > 0
    ? scored.filter((item) => item.score === bestScore).map((item) => item.file)
    : candidates

  return [...bestPool].sort(sortByRecentDesc)[0] || null
}

export const resolveGlobalFolderFile = async ({ userKey, hints = [] } = {}) => {
  const link = await loadGlobalFolderLink(userKey)
  if (!link) return null
  const files = await listGlobalFolderFiles(link)
  if (!files.length) return null
  return pickBestSpreadsheetFile(files, { hints })
}

export const resolveGlobalFolderFileFromDirectory = async ({ directory, hints = [] } = {}) => {
  if (!directory) return null
  let files = []
  if (directory.source === 'electron') {
    files = await listElectronFolderFiles(directory.folderPath)
  } else if (directory.source === 'browser') {
    files = await listBrowserHandleFiles(directory.handle)
  }
  if (!files.length) return null
  return pickBestSpreadsheetFile(files, { hints })
}

export const getGlobalFolderLabel = (link) => {
  if (!link) return 'Nenhuma pasta global vinculada'
  if (link.folderPath) return link.folderPath
  if (link.folderName) return link.folderName
  return 'Pasta global vinculada'
}
