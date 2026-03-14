import { apiFetch } from './apiBase'
import { getCurrentUserKey } from './currentUser'

const API_BASE = '/api/hubxp/apuracao/bovespa'

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

const resolveUserKey = (userKey) => String(userKey || getCurrentUserKey() || 'guest').trim() || 'guest'

export const fetchHubxpApuracaoBovespa = async ({
  userKey,
  jobId,
  accounts,
  filters,
  accountMeta,
  timeoutMs,
  useRecordedFlow,
  concurrency,
  reuseSinglePage,
  perNoteRetries,
  preferPdfBytes,
  tableFallbackOnPdfError,
  tableFastPath,
  strictCompletion,
  adaptiveRateLimit,
  strictWorkerDistribution,
}) => {
  return postJson('/fetch', {
    userKey: resolveUserKey(userKey),
    jobId,
    accounts,
    filters,
    accountMeta,
    timeoutMs,
    useRecordedFlow,
    concurrency,
    reuseSinglePage,
    perNoteRetries,
    preferPdfBytes,
    tableFallbackOnPdfError,
    tableFastPath,
    strictCompletion,
    adaptiveRateLimit,
    strictWorkerDistribution,
  })
}

export const getHubxpApuracaoBovespaResults = async (jobId, userKey) => {
  const qs = new URLSearchParams({ userKey: resolveUserKey(userKey) })
  const response = await apiFetch(`${API_BASE}/results/${encodeURIComponent(jobId)}?${qs.toString()}`, {}, {
    retries: 2,
    backoffMs: 500,
    timeoutMs: 20000,
  })
  return parseResponse(response)
}

export const abortHubxpApuracaoBovespa = async (jobId, userKey) => {
  return postJson('/abort', { userKey: resolveUserKey(userKey), jobId })
}
