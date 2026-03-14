import { apiFetch } from './apiBase'
import { getCurrentUserKey, normalizeUserKey } from './currentUser'

const API_BASE = '/api/hubxp/orders'

const parseResponse = async (response) => {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (response.ok) return payload

  const message = payload?.error?.message || payload?.message || 'Falha ao consultar HubXP.'
  const error = new Error(message)
  error.status = payload?.error?.status || response.status
  error.code = payload?.error?.code || 'HUBXP_REQUEST_FAILED'
  error.stage = payload?.error?.stage || payload?.job?.stage || null
  error.details = payload?.error?.details || null
  error.payload = payload
  throw error
}

const postJson = async (path, body = {}) => {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, { retries: 0, timeoutMs: 120000 })
  return parseResponse(response)
}

const resolveUserKey = (userKey) => normalizeUserKey(userKey || getCurrentUserKey(), 'guest')

export const startHubxpSession = async ({
  userKey,
  jobId,
  headless,
  keepVisible,
  username,
  password,
}) => {
  return postJson('/start', {
    userKey: resolveUserKey(userKey),
    jobId,
    headless,
    keepVisible,
    username,
    password,
  })
}

export const submitHubxpOtp = async ({ userKey, jobId, otp }) => {
  return postJson('/otp', { userKey: resolveUserKey(userKey), jobId, otp })
}

export const fetchHubxpOrders = async ({
  userKey,
  jobId,
  filters,
  timeoutMs,
  maxPages,
}) => {
  return postJson('/fetch', {
    userKey: resolveUserKey(userKey),
    jobId,
    filters,
    timeoutMs,
    maxPages,
  })
}

export const getHubxpJobStatus = async (jobId, userKey) => {
  const qs = new URLSearchParams({ userKey: resolveUserKey(userKey) })
  const response = await apiFetch(`${API_BASE}/status/${encodeURIComponent(jobId)}?${qs.toString()}`, {}, {
    retries: 2,
    backoffMs: 500,
    timeoutMs: 10000,
  })
  return parseResponse(response)
}

export const getHubxpResults = async (jobId, userKey) => {
  const qs = new URLSearchParams({ userKey: resolveUserKey(userKey) })
  const response = await apiFetch(`${API_BASE}/results/${encodeURIComponent(jobId)}?${qs.toString()}`, {}, {
    retries: 2,
    backoffMs: 500,
    timeoutMs: 15000,
  })
  return parseResponse(response)
}

export const cleanupHubxpSession = async (jobId, userKey) => {
  return postJson('/cleanup', { userKey: resolveUserKey(userKey), jobId })
}
