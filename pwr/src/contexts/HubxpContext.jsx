/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  cleanupHubxpSession,
  getHubxpJobStatus,
  startHubxpSession,
  submitHubxpOtp,
} from '../services/hubxpOrders'
import { getCurrentUserKey, normalizeUserKey } from '../services/currentUser'

const HubxpContext = createContext(null)

const LEGACY_JOB_KEY = 'hubxp_job_id'
const LEGACY_CREDENTIALS_KEY = 'hubxp_credentials'

const safeJsonParse = (value) => {
  try { return JSON.parse(value) } catch { return null }
}

const readLocal = (key) => {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(key) } catch { return null }
}

const writeLocal = (key, value) => {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, value) } catch { /* ignore */ }
}

const removeLocal = (key) => {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(key) } catch { /* ignore */ }
}

const hubxpStorageKeys = (userKey) => ({
  jobId: `pwr.hubxp.job_id.${userKey}`,
  credentials: `pwr.hubxp.credentials.${userKey}`,
})

const buildLegacyUserKeyVariants = (userKey) => {
  const normalized = normalizeUserKey(userKey, '')
  if (!normalized || normalized === 'guest') return []
  const out = []
  if (normalized.startsWith('email:')) {
    let candidate = normalized
    for (let i = 0; i < 3; i += 1) {
      candidate = `email:${candidate}`
      out.push(candidate)
    }
  } else if (normalized.startsWith('id:')) {
    let candidate = normalized
    for (let i = 0; i < 3; i += 1) {
      candidate = `id:${candidate}`
      out.push(candidate)
    }
  }
  return out.filter((candidate) => candidate && candidate !== normalized)
}

const migrateUserScopedHubxpStorage = (userKey) => {
  if (typeof window === 'undefined') return
  const target = hubxpStorageKeys(userKey)
  const legacyUsers = buildLegacyUserKeyVariants(userKey)
  if (!legacyUsers.length) return

  for (const legacyUser of legacyUsers) {
    const legacy = hubxpStorageKeys(legacyUser)

    const legacyJobId = readLocal(legacy.jobId)
    if (!readLocal(target.jobId) && legacyJobId) {
      writeLocal(target.jobId, legacyJobId)
    }

    const legacyCredentials = readLocal(legacy.credentials)
    if (!readLocal(target.credentials) && legacyCredentials) {
      writeLocal(target.credentials, legacyCredentials)
    }
  }
}

const migrateLegacyHubxpStorage = (userKey) => {
  if (typeof window === 'undefined') return
  const keys = hubxpStorageKeys(userKey)
  migrateUserScopedHubxpStorage(userKey)

  const legacyJobId = readLocal(LEGACY_JOB_KEY)
  if (!readLocal(keys.jobId) && legacyJobId) {
    writeLocal(keys.jobId, legacyJobId)
  }

  const legacyCredentials = readLocal(LEGACY_CREDENTIALS_KEY)
  if (!readLocal(keys.credentials) && legacyCredentials) {
    writeLocal(keys.credentials, legacyCredentials)
  }

  removeLocal(LEGACY_JOB_KEY)
  removeLocal(LEGACY_CREDENTIALS_KEY)
}

const readCredentials = (credentialsKey) => {
  const raw = readLocal(credentialsKey)
  const parsed = raw ? safeJsonParse(raw) : null
  return {
    username: parsed?.username || '',
    password: parsed?.password || '',
  }
}

export const HubxpProvider = ({ children }) => {
  const [userKey] = useState(() => normalizeUserKey(getCurrentUserKey(), 'guest'))
  const storageKeys = useMemo(() => hubxpStorageKeys(userKey), [userKey])

  const [jobId, setJobId] = useState(() => {
    migrateLegacyHubxpStorage(userKey)
    return readLocal(storageKeys.jobId) || ''
  })
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lastError, setLastError] = useState(null)
  const [credentials, setCredentials] = useState(() => readCredentials(storageKeys.credentials))
  const currentJobIdRef = useRef('')

  useEffect(() => {
    currentJobIdRef.current = String(jobId || '').trim()
  }, [jobId])

  useEffect(() => {
    migrateLegacyHubxpStorage(userKey)
    setJobId(readLocal(storageKeys.jobId) || '')
    setCredentials(readCredentials(storageKeys.credentials))
    setJob(null)
    setLastError(null)
  }, [storageKeys.credentials, storageKeys.jobId, userKey])

  const updateCredential = useCallback((field, value) => {
    setCredentials((prev) => {
      const next = { ...prev, [field]: value }
      writeLocal(storageKeys.credentials, JSON.stringify(next))
      return next
    })
  }, [storageKeys.credentials])

  const storeJobId = useCallback((nextJobId) => {
    const value = String(nextJobId || '').trim()
    setJobId(value)
    if (value) writeLocal(storageKeys.jobId, value)
    else removeLocal(storageKeys.jobId)
  }, [storageKeys.jobId])

  const clearSessionLocal = useCallback(() => {
    storeJobId('')
    setJob(null)
    setLastError(null)
  }, [storeJobId])

  const syncStatus = useCallback(async (id, { silent = false } = {}) => {
    const target = String(id || currentJobIdRef.current || '').trim()
    if (!target) return null
    try {
      const payload = await getHubxpJobStatus(target, userKey)
      if (payload?.job) {
        const activeJobId = String(currentJobIdRef.current || '').trim()
        const payloadJobId = String(payload.job.id || '').trim()
        // Ignorar retorno de polling antigo para nao sobrescrever sessao atual.
        if (activeJobId && target !== activeJobId && payloadJobId !== activeJobId) {
          return payload.job
        }
        setJob(payload.job)
        if (payloadJobId && payloadJobId !== activeJobId) {
          storeJobId(payloadJobId)
        }
        return payload.job
      }
      return null
    } catch (error) {
      if (!silent) setLastError(error)
      if (error?.status === 404 || error?.code === 'JOB_NOT_FOUND') {
        const activeJobId = String(currentJobIdRef.current || '').trim()
        // Evitar "deslogar" por 404 de um job antigo em polling atrasado.
        if (!activeJobId || target === activeJobId) {
          clearSessionLocal()
        }
      }
      return null
    }
  }, [clearSessionLocal, storeJobId, userKey])

  const startSession = useCallback(async ({ headless = false, keepVisible = false } = {}) => {
    setBusy(true)
    setLastError(null)
    try {
      let payload = null
      try {
        payload = await startHubxpSession({
          userKey,
          jobId: jobId || undefined,
          headless,
          keepVisible,
          username: credentials.username || undefined,
          password: credentials.password || undefined,
        })
      } catch (error) {
        const staleSession = error?.status === 404 || error?.code === 'JOB_NOT_FOUND'
        if (!staleSession) throw error

        clearSessionLocal()
        payload = await startHubxpSession({
          userKey,
          headless,
          keepVisible,
          username: credentials.username || undefined,
          password: credentials.password || undefined,
        })
      }
      if (payload?.job?.id) {
        storeJobId(payload.job.id)
        setJob(payload.job)
      }
      return payload
    } catch (error) {
      setLastError(error)
      throw error
    } finally {
      setBusy(false)
    }
  }, [clearSessionLocal, credentials.password, credentials.username, jobId, storeJobId, userKey])

  const submitOtp = useCallback(async (otp) => {
    if (!jobId) throw new Error('Sessao HubXP nao iniciada.')
    setBusy(true)
    setLastError(null)
    try {
      const payload = await submitHubxpOtp({ userKey, jobId, otp })
      if (payload?.job) setJob(payload.job)
      return payload
    } catch (error) {
      setLastError(error)
      throw error
    } finally {
      setBusy(false)
    }
  }, [jobId, userKey])

  const cleanupSession = useCallback(async () => {
    if (!jobId) return
    setBusy(true)
    setLastError(null)
    try {
      await cleanupHubxpSession(jobId, userKey)
      clearSessionLocal()
    } catch (error) {
      if (error?.status === 404 || error?.code === 'JOB_NOT_FOUND') {
        clearSessionLocal()
        return
      }
      setLastError(error)
      throw error
    } finally {
      setBusy(false)
    }
  }, [clearSessionLocal, jobId, userKey])

  const keepAliveTimer = useRef(null)
  useEffect(() => {
    if (!jobId) return undefined
    void syncStatus(jobId, { silent: true })

    if (keepAliveTimer.current) clearInterval(keepAliveTimer.current)
    keepAliveTimer.current = setInterval(() => {
      void syncStatus(jobId, { silent: true })
    }, 30000)

    return () => {
      if (keepAliveTimer.current) clearInterval(keepAliveTimer.current)
      keepAliveTimer.current = null
    }
  }, [jobId, syncStatus])

  // FAILED e COLLECTING sao retentaveis — o browser continua aberto
  const isAuthenticated = job?.status === 'AUTHENTICATED' || job?.status === 'SUCCESS' || job?.status === 'FAILED' || job?.status === 'COLLECTING'

  const value = useMemo(() => ({
    userKey,
    jobId,
    job,
    busy,
    lastError,
    credentials,
    isAuthenticated,
    setJob,
    updateCredential,
    storeJobId,
    clearSessionLocal,
    syncStatus,
    startSession,
    submitOtp,
    cleanupSession,
  }), [
    busy,
    clearSessionLocal,
    credentials,
    isAuthenticated,
    job,
    jobId,
    lastError,
    cleanupSession,
    startSession,
    storeJobId,
    submitOtp,
    syncStatus,
    updateCredential,
    userKey,
  ])

  return (
    <HubxpContext.Provider value={value}>
      {children}
    </HubxpContext.Provider>
  )
}

export const useHubxp = () => {
  const ctx = useContext(HubxpContext)
  if (!ctx) {
    throw new Error('useHubxp deve ser usado dentro de <HubxpProvider>.')
  }
  return ctx
}
