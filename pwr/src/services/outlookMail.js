import { apiFetch } from './apiBase'
import { getCurrentUserKey, normalizeUserKey } from './currentUser'

const BASE = '/api/outlook'

const parseResponse = async (response) => {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (response.ok) return payload

  const message = payload?.error?.message || payload?.message || 'Falha no fluxo Outlook.'
  const error = new Error(message)
  error.status = payload?.error?.status || response.status
  error.code = payload?.error?.code || 'OUTLOOK_REQUEST_FAILED'
  error.stage = payload?.error?.stage || payload?.job?.stage || null
  error.details = payload?.error?.details || null
  error.payload = payload
  throw error
}

const resolveUserKey = (userKey) => normalizeUserKey(userKey || getCurrentUserKey(), 'guest')

const postJson = async (path, body = {}, timeoutMs = 120000) => {
  const response = await apiFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, { retries: 0, timeoutMs })
  return parseResponse(response)
}

export const startOutlookSession = async ({
  userKey,
  jobId,
  headless,
  username,
  password,
  loginUrl,
  loginTimeoutMs,
}) => {
  return postJson('/session/start', {
    userKey: resolveUserKey(userKey),
    jobId,
    headless,
    username,
    password,
    loginUrl,
    loginTimeoutMs,
  }, 360000)
}

export const getOutlookSessionStatus = async (jobId, userKey) => {
  const qs = new URLSearchParams({ userKey: resolveUserKey(userKey) })
  const response = await apiFetch(
    `${BASE}/session/status/${encodeURIComponent(jobId)}?${qs.toString()}`,
    {},
    { retries: 2, backoffMs: 500, timeoutMs: 10000 },
  )
  return parseResponse(response)
}

export const cleanupOutlookSession = async ({ userKey, jobId }) => {
  return postJson('/session/cleanup', {
    userKey: resolveUserKey(userKey),
    jobId,
  })
}

export const startOutlookMonitor = async ({
  userKey,
  jobId,
  intervalMs,
  startWindow = 'new_only',
  rules,
}) => {
  return postJson('/monitor/start', {
    userKey: resolveUserKey(userKey),
    jobId,
    intervalMs,
    startWindow,
    rules,
  })
}

export const stopOutlookMonitor = async ({ userKey, jobId }) => {
  return postJson('/monitor/stop', {
    userKey: resolveUserKey(userKey),
    jobId,
  })
}

export const getOutlookMonitorEvents = async ({ userKey, jobId, afterSeq = 0 }) => {
  const qs = new URLSearchParams({
    userKey: resolveUserKey(userKey),
    afterSeq: String(Number.isFinite(Number(afterSeq)) ? Math.max(0, Number(afterSeq)) : 0),
  })
  const response = await apiFetch(
    `${BASE}/monitor/events/${encodeURIComponent(jobId)}?${qs.toString()}`,
    {},
    { retries: 1, backoffMs: 400, timeoutMs: 12000 },
  )
  return parseResponse(response)
}

export const sendOutlookAccounts = async ({
  userKey,
  jobId,
  template,
  rows,
  retryPerAccount = 1,
}) => {
  return postJson('/send/accounts', {
    userKey: resolveUserKey(userKey),
    jobId,
    template,
    rows,
    retryPerAccount,
  }, 180000)
}
