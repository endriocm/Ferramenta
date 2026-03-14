const hasElectron = () => typeof window !== 'undefined' && Boolean(window.electronAPI)
const HYDRATED_STORAGE_KEY = '__PWR_HYDRATED_STORAGE__'

const ensureHydratedBucket = () => {
  if (typeof window === 'undefined') return {}
  if (!window[HYDRATED_STORAGE_KEY] || typeof window[HYDRATED_STORAGE_KEY] !== 'object') {
    window[HYDRATED_STORAGE_KEY] = {}
  }
  return window[HYDRATED_STORAGE_KEY]
}

export const isDesktop = () => hasElectron()

export const hydrateLocalStorage = async (keys = []) => {
  if (!hasElectron()) return {}
  if (window.electronAPI.storage?.getMultiple) {
    return window.electronAPI.storage.getMultiple(keys)
  }
  if (!window.electronAPI.storage?.get) return {}
  const entries = await Promise.all(keys.map(async (key) => [key, await window.electronAPI.storage.get(key)]))
  return Object.fromEntries(entries.filter(([, value]) => value != null))
}

export const persistLocalStorage = async (key, value) => {
  if (!hasElectron() || !window.electronAPI.storage?.set) return false
  try {
    await window.electronAPI.storage.set(key, value)
    return true
  } catch {
    return false
  }
}

export const removeLocalStorage = async (key) => {
  if (!hasElectron() || !window.electronAPI.storage?.remove) return false
  try {
    await window.electronAPI.storage.remove(key)
    return true
  } catch {
    return false
  }
}

export const getAppConfig = async () => {
  if (!hasElectron() || !window.electronAPI.config?.get) {
    return {
      workDir: '',
      updateBaseUrl: '',
      license: { enabled: false },
      auth: { enabled: false },
    }
  }
  return window.electronAPI.config.get()
}

export const setAppConfig = async (patch) => {
  if (!hasElectron() || !window.electronAPI.config?.set) return null
  return window.electronAPI.config.set(patch)
}

export const selectWorkDir = async () => {
  if (!hasElectron() || !window.electronAPI.config?.selectWorkDir) return null
  return window.electronAPI.config.selectWorkDir()
}

export const getHydratedStorageValue = (key) => {
  if (!key || typeof window === 'undefined') return null
  const bucket = ensureHydratedBucket()
  if (!Object.prototype.hasOwnProperty.call(bucket, key)) return null
  return bucket[key]
}

export const setHydratedStorageValue = (key, value) => {
  if (!key || typeof window === 'undefined') return
  const bucket = ensureHydratedBucket()
  bucket[key] = value
}
