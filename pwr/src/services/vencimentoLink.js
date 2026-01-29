const STORAGE_PREFIX = 'pwr.vencimento.link.'
const HANDLE_DB_NAME = 'pwr-vencimento'
const HANDLE_STORE = 'folder-handles'
const HANDLE_VERSION = 1

const buildKey = (userKey) => `${STORAGE_PREFIX}${userKey}`

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
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

export const isValidElectronPath = (value) => {
  if (!value || typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 2
}

export const ensurePermission = async (handle, { interactive = false } = {}) => {
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

export const saveLink = async (userKey, link) => {
  if (!userKey) return null
  if (!link || typeof link !== 'object') return null
  const payload = {
    version: 1,
    source: link.source || 'browser',
    folderPath: link.folderPath || null,
    folderName: link.folderName || null,
    fileName: link.fileName || null,
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

export const loadLink = async (userKey) => {
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

export const clearLink = async (userKey) => {
  if (!userKey) return
  try {
    localStorage.removeItem(buildKey(userKey))
  } catch {
    // noop
  }
  await deleteHandle(userKey)
}
