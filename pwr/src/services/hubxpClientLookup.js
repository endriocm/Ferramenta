import { apiFetch } from './apiBase'
import { getCurrentUserKey, normalizeUserKey } from './currentUser'

const API_PATH = '/api/hubxp/clients/resolve'

const parseResponse = async (response) => {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (response.ok) return payload

  const message = payload?.error?.message || payload?.message || 'Falha ao resolver clientes no HubXP.'
  const error = new Error(message)
  error.status = payload?.error?.status || response.status
  error.code = payload?.error?.code || 'HUBXP_CLIENT_LOOKUP_FAILED'
  error.stage = payload?.error?.stage || null
  error.details = payload?.error?.details || null
  error.payload = payload
  throw error
}

const resolveUserKey = (userKey) => normalizeUserKey(userKey || getCurrentUserKey(), 'guest')

export const resolveHubxpClients = async ({
  userKey,
  accounts,
  mode = 'shared',
  jobId,
  credentials,
  loginTimeoutMs,
  minWaitMs = 2000,
  timeoutMs = 10000,
  retryPerAccount = 1,
}) => {
  const normalizedMode = String(mode || 'shared').trim().toLowerCase() || 'shared'
  const response = await apiFetch(API_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userKey: resolveUserKey(userKey),
      accounts,
      mode: normalizedMode,
      jobId: normalizedMode === 'shared' ? String(jobId || '').trim() || undefined : undefined,
      credentials: normalizedMode === 'dedicated' && credentials && typeof credentials === 'object'
        ? credentials
        : {},
      loginTimeoutMs: Number.isFinite(Number(loginTimeoutMs)) ? Number(loginTimeoutMs) : undefined,
      minWaitMs,
      timeoutMs,
      retryPerAccount,
    }),
  }, { retries: 0, timeoutMs: 180000 })

  return parseResponse(response)
}
