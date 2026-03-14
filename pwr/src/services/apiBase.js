const DEFAULT_EMBEDDED_API_BASE = 'http://localhost:4170'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isAbsoluteUrl = (value) => /^https?:\/\//i.test(String(value || ''))

const normalizeBase = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return DEFAULT_EMBEDDED_API_BASE
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const normalizePath = (value) => {
  if (!value) return '/api'
  const raw = String(value).trim()
  if (!raw) return '/api'
  if (isAbsoluteUrl(raw)) return raw
  return raw.startsWith('/') ? raw : `/${raw}`
}

const normalizeNetworkError = (error) => {
  const original = error instanceof Error ? error : new Error('Falha ao consultar API.')
  const rawMessage = String(original?.message || '').toLowerCase()

  if (original?.name === 'AbortError' || rawMessage.includes('api_timeout')) {
    const timeoutError = new Error('API local nao respondeu a tempo. Verifique se o app/API estao ativos.')
    timeoutError.code = 'API_TIMEOUT'
    timeoutError.cause = original
    return timeoutError
  }

  if (
    rawMessage.includes('failed to fetch')
    || rawMessage.includes('networkerror')
    || rawMessage.includes('network request failed')
  ) {
    const unreachableError = new Error('Falha de conexao com a API local. Reinicie o app e tente novamente.')
    unreachableError.code = 'API_UNREACHABLE'
    unreachableError.cause = original
    return unreachableError
  }

  return original
}

let runtimeState = {
  initialized: false,
  ready: false,
  baseUrl: DEFAULT_EMBEDDED_API_BASE,
  error: '',
}
let runtimeInitPromise = null
let runtimeSubscribed = false

const syncRuntimeState = (payload = {}) => {
  runtimeState = {
    ...runtimeState,
    initialized: true,
    ready: payload.ready === true,
    baseUrl: normalizeBase(payload.baseUrl),
    error: payload.error ? String(payload.error) : '',
  }
  return runtimeState
}

const subscribeRuntimeEvents = () => {
  if (runtimeSubscribed) return
  const runtime = window?.electronAPI?.runtime
  if (!runtime?.onApiReady) return
  runtimeSubscribed = true
  runtime.onApiReady((payload) => {
    syncRuntimeState(payload)
  })
}

const initRuntimeState = async () => {
  if (runtimeState.initialized) return runtimeState
  if (runtimeInitPromise) return runtimeInitPromise

  runtimeInitPromise = (async () => {
    if (typeof window === 'undefined') {
      runtimeState = {
        initialized: true,
        ready: true,
        baseUrl: '',
        error: '',
      }
      return runtimeState
    }

    if (window.location.protocol !== 'file:') {
      runtimeState = {
        initialized: true,
        ready: true,
        baseUrl: '',
        error: '',
      }
      return runtimeState
    }

    subscribeRuntimeEvents()
    const runtime = window?.electronAPI?.runtime
    if (!runtime?.getApiState && !runtime?.getApiBaseUrl) {
      runtimeState = {
        initialized: true,
        ready: false,
        baseUrl: DEFAULT_EMBEDDED_API_BASE,
        error: 'Runtime API indisponivel no preload.',
      }
      return runtimeState
    }

    try {
      if (runtime?.getApiState) {
        const state = await runtime.getApiState()
        return syncRuntimeState(state)
      }
      const baseUrl = await runtime.getApiBaseUrl()
      runtimeState = {
        initialized: true,
        ready: false,
        baseUrl: normalizeBase(baseUrl),
        error: '',
      }
      return runtimeState
    } catch (error) {
      runtimeState = {
        initialized: true,
        ready: false,
        baseUrl: DEFAULT_EMBEDDED_API_BASE,
        error: error?.message ? String(error.message) : 'Falha ao obter estado da API.',
      }
      return runtimeState
    }
  })()

  return runtimeInitPromise
}

const resolveApiUrl = async (path) => {
  const normalizedPath = normalizePath(path)
  if (isAbsoluteUrl(normalizedPath)) return normalizedPath

  const state = await initRuntimeState()
  if (!state.baseUrl) return normalizedPath
  return `${state.baseUrl}${normalizedPath}`
}

export const getApiRuntimeState = async () => {
  return initRuntimeState()
}

export const apiFetch = async (path, options = {}, config = {}) => {
  const {
    retries = 2,
    backoffMs = 400,
    backoffFactor = 2,
    timeoutMs = 8000,
  } = config

  let attempt = 0
  let delay = backoffMs
  let lastError = null

  while (attempt <= retries) {
    const url = await resolveApiUrl(path)
    const controller = new AbortController()
    const timeout = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error('API_TIMEOUT')), timeoutMs)
      : null

    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      if (timeout) clearTimeout(timeout)
      return response
    } catch (error) {
      lastError = error
      if (timeout) clearTimeout(timeout)
      if (attempt >= retries) break
      await sleep(delay)
      delay *= backoffFactor
      attempt += 1
    }
  }

  throw normalizeNetworkError(lastError || new Error('Falha ao consultar API.'))
}
