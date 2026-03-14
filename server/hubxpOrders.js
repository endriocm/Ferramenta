const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')


const DEFAULT_ENTRY_URL = 'https://hub.xpi.com.br/'
const DEFAULT_LOGIN_URL = 'https://advisor.xpi.com.br/login'
const DEFAULT_COLLECT_TIMEOUT_MS = 180000
const HUBXP_RUNTIME_DIR = process.env.HUBXP_RUNTIME_DIR
  ? path.resolve(process.env.HUBXP_RUNTIME_DIR)
  : path.resolve(process.env.HUBXP_DEBUG_DIR || path.join(process.cwd(), 'tmp', 'hubxp-debug'))
const LEGACY_SESSION_FILE = process.env.HUBXP_SESSION_FILE
  ? path.resolve(process.env.HUBXP_SESSION_FILE)
  : path.join(HUBXP_RUNTIME_DIR, 'hubxp-session.json')
const DEFAULT_JOB_TTL_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 30 * 1000
const MAX_LOG_ITEMS = 400
const OTP_DIGIT_SELECTOR = 'input[inputmode="numeric"][maxlength="1"]'
const DEBUG_HUBXP = String(process.env.DEBUG_HUBXP || '').trim() === '1'
const ALLOW_LEGACY_GUEST = String(process.env.HUBXP_ALLOW_LEGACY_GUEST || '').trim() === '1'
const DEBUG_HUBXP_DIR = process.env.HUBXP_DEBUG_DIR
  ? path.resolve(process.env.HUBXP_DEBUG_DIR)
  : HUBXP_RUNTIME_DIR

const LOGIN_USER_SELECTORS = [
  'input[name="account"]',
  'input[aria-label*="digite seu codigo de usuario" i]',
  'input[placeholder*="digite seu codigo de usuario" i]',
  'input[aria-label*="codigo de usuario" i]',
  'input[placeholder*="codigo de usuario" i]',
  'input[placeholder*="Código de Usuário" i]',
  'input[placeholder*="código de usuário" i]',
  'input[placeholder*="Código" i]',
  'input[aria-label*="Código de Usuário" i]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[name*="email" i]',
  'input[name*="account" i]',
  'input[id*="user" i]',
  'input[id*="login" i]',
  'input[id*="account" i]',
]

const LOGIN_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name*="senha" i]',
  'input[name*="password" i]',
  'input[placeholder*="Senha de Acesso" i]',
  'input[placeholder*="senha" i]',
  'input[aria-label*="Senha de Acesso" i]',
  'input[id*="senha" i]',
  'input[id*="password" i]',
]

const OTP_SELECTORS = [
  OTP_DIGIT_SELECTOR,
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[name*="token" i]',
  'input[name*="code" i]',
  'input[id*="otp" i]',
  'input[id*="token" i]',
  'input[id*="code" i]',
]

const TABLE_SELECTORS = [
  'table',
  '[role="table"]',
  '[role="grid"]',
  '[role="treegrid"]',
  '.ag-root-wrapper',
  '.ag-body-viewport',
  'div[class*="DataGrid" i]',
  'div[class*="datatable" i]',
]

const jobs = new Map()
let sweepTimer = null
let playwrightLoader = null

const STATUS = {
  CREATED: 'CREATED',
  STARTING: 'STARTING',
  OTP_REQUIRED: 'OTP_REQUIRED',
  AUTHENTICATED: 'AUTHENTICATED',
  COLLECTING: 'COLLECTING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CLEANED: 'CLEANED',
}

const now = () => Date.now()

const shortId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const createHttpError = (status, code, message, details = null, stage = null) => {
  const error = new Error(message || 'Erro na requisicao.')
  error.status = status || 500
  error.code = code || 'INTERNAL_ERROR'
  if (details) error.details = details
  if (stage) error.stage = stage
  return error
}

const toBoolean = (value, fallback = false) => {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'sim'].includes(normalized)) return true
  if (['0', 'false', 'no', 'nao', 'não'].includes(normalized)) return false
  return fallback
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let notasFilterLock = Promise.resolve()
const withNotasFilterLock = async (factory, options = {}) => {
  const cooldownMs = Number.isFinite(Number(options.cooldownMs))
    ? Math.max(0, Math.min(2500, Number(options.cooldownMs)))
    : 320
  const previous = notasFilterLock
  let releaseLock = null
  notasFilterLock = new Promise((resolve) => {
    releaseLock = resolve
  })
  await previous.catch(() => null)
  try {
    return await Promise.resolve().then(factory)
  } finally {
    if (cooldownMs > 0) {
      await delay(cooldownMs)
    }
    if (releaseLock) releaseLock()
  }
}

const scrubText = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()

const normalizeUserKey = (value) => {
  const raw = scrubText(value).toLowerCase()
  if (!raw) return 'guest'
  const collapsed = raw
    .replace(/^(email:)+/, 'email:')
    .replace(/^(id:)+/, 'id:')
  if (collapsed.includes('@') && !collapsed.startsWith('email:')) return `email:${collapsed}`
  if (collapsed.startsWith('email:') || collapsed.startsWith('id:')) return collapsed
  if (collapsed === 'guest') return 'guest'
  return `id:${collapsed}`
}

const buildLegacyUserKeyVariants = (userKey) => {
  const normalized = normalizeUserKey(userKey)
  const out = new Set([normalized])
  if (normalized.startsWith('email:')) {
    let candidate = normalized
    for (let i = 0; i < 3; i += 1) {
      candidate = `email:${candidate}`
      out.add(candidate)
    }
  } else if (normalized.startsWith('id:')) {
    let candidate = normalized
    for (let i = 0; i < 3; i += 1) {
      candidate = `id:${candidate}`
      out.add(candidate)
    }
  }
  return Array.from(out)
}

const resolveUserSessionFileCandidates = (userKey = 'guest') => {
  const normalized = normalizeUserKey(userKey)
  const variants = buildLegacyUserKeyVariants(normalized)
  const candidates = []
  const seen = new Set()
  const canonicalFile = getSessionFileForUser(normalized)
  candidates.push(canonicalFile)
  seen.add(canonicalFile)
  for (const key of variants) {
    const file = getSessionFileForExactUserKey(key)
    if (!file || seen.has(file)) continue
    candidates.push(file)
    seen.add(file)
  }
  return {
    normalized,
    sessionFile: canonicalFile,
    candidates,
  }
}

const migrateSessionFileToCanonical = async (sourceFile, targetFile, state) => {
  if (!sourceFile || !targetFile || sourceFile === targetFile) return false
  let migrated = false
  try {
    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.rename(sourceFile, targetFile)
    migrated = true
  } catch {
    try {
      await fs.mkdir(path.dirname(targetFile), { recursive: true })
      await fs.writeFile(targetFile, JSON.stringify(state, null, 2), 'utf-8')
      migrated = true
    } catch {
      migrated = false
    }
    if (migrated) {
      await fs.unlink(sourceFile).catch(() => null)
    }
  }
  return migrated
}

const resolveLegacySessionState = async (sessionFile, candidates) => {
  for (const candidate of candidates) {
    if (!candidate || candidate === sessionFile) continue
    const state = await readStorageStateFile(candidate)
    if (state) {
      const migrated = await migrateSessionFileToCanonical(candidate, sessionFile, state)
      const migratedState = migrated ? await readStorageStateFile(sessionFile) : null
      return {
        state: migratedState || state,
        sourceFile: candidate,
        migratedFromLegacy: migrated,
      }
    }
  }
  return null
}

const sanitizeUserKey = (userKey) => normalizeUserKey(userKey)
  .replace(/[^a-z0-9._:-]/gi, '_')
  .replace(/[:]/g, '__')

const sanitizeUserKeyExact = (userKey) => scrubText(userKey).toLowerCase()
  .replace(/[^a-z0-9._:-]/gi, '_')
  .replace(/[:]/g, '__')

const getSessionFileForUser = (userKey) => path.join(
  HUBXP_RUNTIME_DIR,
  `hubxp-session-${sanitizeUserKey(userKey)}.json`,
)

const getSessionFileForExactUserKey = (userKey) => path.join(
  HUBXP_RUNTIME_DIR,
  `hubxp-session-${sanitizeUserKeyExact(userKey)}.json`,
)

const normalizeDateInput = (value) => {
  if (!value) return ''
  const raw = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (match) {
    const [, day, month, year] = match
    return `${year}-${month}-${day}`
  }
  return raw
}

const resolveToday = () => {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const sanitizeHeader = (value, index, used) => {
  const base = scrubText(value).replace(/\s+/g, ' ') || `coluna_${index + 1}`
  const key = base
  if (!used.has(key)) {
    used.add(key)
    return key
  }
  let suffix = 2
  while (used.has(`${base} (${suffix})`)) {
    suffix += 1
  }
  const next = `${base} (${suffix})`
  used.add(next)
  return next
}

const serializeError = (error) => ({
  code: error?.code || 'INTERNAL_ERROR',
  stage: error?.stage || null,
  message: error?.message || 'Falha inesperada.',
  status: error?.status || 500,
  details: error?.details || null,
})

const cleanLogMeta = (meta = {}) => {
  const out = {}
  Object.entries(meta).forEach(([key, value]) => {
    if (value == null) return
    if (typeof value === 'string') {
      out[key] = scrubText(value).slice(0, 200)
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
      return
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 8)
      return
    }
    if (typeof value === 'object') {
      out[key] = '[object]'
    }
  })
  return out
}

const getPageUrl = (page) => {
  try {
    return scrubText(page?.url?.() || '')
  } catch {
    return ''
  }
}

const debugTimestamp = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const captureDebugScreenshot = async (job, page, label) => {
  if (!DEBUG_HUBXP || !page) return null
  try {
    await fs.mkdir(DEBUG_HUBXP_DIR, { recursive: true })
    const ts = debugTimestamp()
    const jobTag = (job?.id || 'job').slice(0, 8)
    const fileName = `${ts}_${jobTag}_${label || 'step'}.png`
    const filePath = path.join(DEBUG_HUBXP_DIR, fileName)
    await page.screenshot({ path: filePath, fullPage: true })
    appendJobLog(job, 'debug', `Screenshot salvo: ${label}`, { filePath })
    return filePath
  } catch {
    return null
  }
}

const debugShot = captureDebugScreenshot

const captureDebugHtml = async (job, page, label) => {
  if (!DEBUG_HUBXP || !page) return null
  try {
    await fs.mkdir(DEBUG_HUBXP_DIR, { recursive: true })
    const ts = debugTimestamp()
    const jobTag = (job?.id || 'job').slice(0, 8)
    const fileName = `${ts}_${jobTag}_${label || 'step'}.html`
    const filePath = path.join(DEBUG_HUBXP_DIR, fileName)
    const html = await page.content().catch(() => '')
    if (!html) return null
    await fs.writeFile(filePath, html, 'utf8')
    appendJobLog(job, 'debug', `HTML salvo: ${label}`, { filePath })
    return filePath
  } catch {
    return null
  }
}

const runWithTimeout = async (factory, timeoutMs, errorFactory) => {
  const maxMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(1000, Number(timeoutMs))
    : 10000
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(typeof errorFactory === 'function'
            ? errorFactory(maxMs)
            : createHttpError(504, 'STEP_TIMEOUT', `Etapa excedeu ${maxMs}ms.`))
        }, maxMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const appendJobLog = (job, stage, message, meta = {}) => {
  job.logs.push({
    at: new Date().toISOString(),
    stage,
    message,
    meta: cleanLogMeta(meta),
  })
  if (job.logs.length > MAX_LOG_ITEMS) {
    job.logs.splice(0, job.logs.length - MAX_LOG_ITEMS)
  }
}

const touchJob = (job) => {
  job.updatedAt = now()
  job.expiresAt = job.updatedAt + DEFAULT_JOB_TTL_MS
}

const buildJobSnapshot = (job) => ({
  id: job.id,
  userKey: job.userKey,
  status: job.status,
  stage: job.stage,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  expiresAt: job.expiresAt,
  running: Boolean(job.running),
  progress: {
    currentPage: job.progress.currentPage,
    totalPages: job.progress.totalPages,
    rowsCollected: job.progress.rowsCollected,
    accountsProcessed: job.progress.accountsProcessed,
    accountsFailed: job.progress.accountsFailed,
    accountsTotal: job.progress.accountsTotal,
    message: job.progress.message,
    startedAt: job.progress.startedAt,
    finishedAt: job.progress.finishedAt,
    elapsedMs: job.progress.elapsedMs,
  },
  error: job.error,
  manualFlow: {
    recording: Boolean(job._manualFlowRecording?.active),
    hasFlow: Boolean(job._manualFlow?.events?.length),
    steps: Array.isArray(job._manualFlow?.events) ? job._manualFlow.events.length : 0,
    updatedAt: job._manualFlow?.updatedAt || null,
  },
  lastResult: job.lastResult
    ? {
        totalRows: job.lastResult.totalRows,
        columns: job.lastResult.columns,
        collectedAt: job.lastResult.collectedAt,
      }
    : null,
  logs: job.logs,
})

const setJobStatus = (job, status, stage, message = '', extra = {}) => {
  job.status = status
  job.stage = stage
  if (message) job.progress.message = message
  Object.assign(job.progress, extra)
  touchJob(job)
}

const createJob = (userKey = 'guest') => {
  const createdAt = now()
  const normalizedUser = normalizeUserKey(userKey)
  const job = {
    id: shortId(),
    userKey: normalizedUser,
    status: STATUS.CREATED,
    stage: 'idle',
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + DEFAULT_JOB_TTL_MS,
    running: false,
    browser: null,
    browserHeadless: null,
    context: null,
    page: null,
    logs: [],
    error: null,
    progress: {
      currentPage: 0,
      totalPages: null,
      rowsCollected: 0,
      accountsProcessed: 0,
      accountsFailed: 0,
      accountsTotal: 0,
      message: 'Aguardando inicio.',
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
    },
    lastResult: null,
    _collectedData: null,
    _manualFlowRecording: null,
    _manualFlow: null,
  }
  jobs.set(job.id, job)
  appendJobLog(job, 'job', 'Job criado', { userKey: normalizedUser })
  return job
}

const resolveJob = (jobId, userKey = null) => {
  const key = String(jobId || '').trim()
  if (!key) throw createHttpError(400, 'JOB_ID_REQUIRED', 'jobId nao informado.')
  const job = jobs.get(key)
  if (!job) throw createHttpError(404, 'JOB_NOT_FOUND', 'Sessao nao encontrada.')
  const requestedUser = normalizeUserKey(userKey)
  if (requestedUser && job.userKey !== requestedUser) {
    throw createHttpError(403, 'JOB_FORBIDDEN', 'Este job nao pertence ao usuario informado.')
  }
  return job
}

const closeJobResources = async (job) => {
  const closeSafe = async (target) => {
    if (!target) return
    try {
      await target.close()
    } catch {
      // noop
    }
  }

  await closeSafe(job.page)
  await closeSafe(job.context)
  await closeSafe(job.browser)
  job.page = null
  job.context = null
  job.browser = null
  job.browserHeadless = null
}

const destroyJob = async (jobId, reason = 'cleanup') => {
  const job = jobs.get(jobId)
  if (!job) return
  await closeJobResources(job)
  job.running = false
  job.status = STATUS.CLEANED
  job.stage = 'finished'
  job.progress.message = `Sessao encerrada (${reason}).`
  job.progress.finishedAt = now()
  job.progress.elapsedMs = Math.max(0, job.progress.finishedAt - (job.progress.startedAt || job.createdAt))
  appendJobLog(job, 'job', 'Sessao encerrada', { reason })
  jobs.delete(jobId)
}

const ensureSweep = () => {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const nowMs = now()
    for (const [jobId, job] of jobs.entries()) {
      if (job.running) continue
      if (job.expiresAt > nowMs) continue
      void destroyJob(jobId, 'ttl')
    }
  }, SWEEP_INTERVAL_MS)
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref()
  }
}

const getPlaywright = async () => {
  if (!playwrightLoader) {
    playwrightLoader = import('playwright')
      .catch(() => import('playwright-core'))
      .then((mod) => {
        // Se carregou playwright-core (sem browsers bundled), marcar para usar channel do sistema
        if (!mod?.chromium?._browserType) {
          // playwright-core precisa de browser channel (msedge, chrome, etc)
          if (!process.env.HUBXP_BROWSER_CHANNEL) {
            process.env.HUBXP_BROWSER_CHANNEL = 'msedge'
          }
        }
        return mod
      })
      .catch((error) => {
        throw createHttpError(
          503,
          'PLAYWRIGHT_UNAVAILABLE',
          'Playwright nao encontrado. Instale com: npm i playwright (ou npm i playwright-core e configure HUBXP_BROWSER_CHANNEL).',
          error?.message,
        )
      })
  }
  const moduleRef = await playwrightLoader
  const chromium = moduleRef?.chromium || moduleRef?.default?.chromium
  if (!chromium) {
    throw createHttpError(503, 'PLAYWRIGHT_UNAVAILABLE', 'Chromium do Playwright indisponivel.')
  }
  return chromium
}

const isVisible = async (locator) => {
  try {
    return await locator.isVisible({ timeout: 300 })
  } catch {
    return false
  }
}

const pickVisibleLocator = async (page, selectors) => {
  // Uma unica chamada ao browser para encontrar selector visivel
  const found = await page.evaluate((sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return sel
    }
    return null
  }, selectors).catch(() => null)
  if (found) return { locator: page.locator(found).first(), selector: found }
  return null
}

// Clicar em item do sidebar/nav lateral — prioriza elementos dentro de nav/sidebar
const clickSidebarItem = async (page, texts, opts = {}) => {
  const list = Array.isArray(texts) ? texts.filter(Boolean) : [texts]
  if (!list.length) return false

  const sidebarSelectors = [
    'nav', '[role="navigation"]', '.sidebar', '.menu-lateral',
    '[class*="sidebar"]', '[class*="Sidebar"]', '[class*="nav"]',
    'aside', '[class*="menu"]',
  ]

  for (const value of list) {
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'i')

    // Tentar primeiro dentro de containers de sidebar
    for (const sel of sidebarSelectors) {
      try {
        const container = page.locator(sel).first()
        if (await container.count() === 0) continue
        const link = container.getByText(regex).first()
        if (await link.count() === 0) continue
        if (!(await isVisible(link))) continue
        await link.click({ timeout: opts.timeout || 3000 })
        return true
      } catch {
        // continua
      }
    }

    // Fallback: clickByTexts normal
    if (await clickByTexts(page, [value], opts)) return true
  }

  return false
}

// Clicar em aba/tab — prioriza role=tab e elementos dentro de tablists
const clickTab = async (page, texts, opts = {}) => {
  const list = Array.isArray(texts) ? texts.filter(Boolean) : [texts]
  if (!list.length) return false

  for (const value of list) {
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'i')

    const candidates = [
      page.getByRole('tab', { name: regex }).first(),
      page.locator('[role="tablist"] >> text=' + value).first(),
      page.locator('[class*="tab" i]').getByText(regex).first(),
      page.locator('button, a, [role="tab"]').filter({ hasText: regex }).first(),
    ]

    for (const locator of candidates) {
      try {
        if (await locator.count() === 0) continue
        if (!(await isVisible(locator))) continue
        await locator.click({ timeout: opts.timeout || 3000 })
        return true
      } catch {
        // continua
      }
    }
  }

  // Fallback generico
  return clickByTexts(page, texts, opts)
}

const clickByTexts = async (page, texts, opts = {}) => {
  const list = Array.isArray(texts) ? texts.filter(Boolean) : [texts]
  if (!list.length) return false

  for (const value of list) {
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'i')
    const candidates = [
      page.getByRole('button', { name: regex }).first(),
      page.getByRole('link', { name: regex }).first(),
      page.getByText(regex).first(),
    ]

    for (const locator of candidates) {
      try {
        if (await locator.count() === 0) continue
        if (!(await isVisible(locator))) continue
        await locator.click({ timeout: opts.timeout || 2000 })
        return true
      } catch {
        // continua tentando outras opcoes
      }
    }
  }

  return false
}

const compressManualFlowEvents = (events = []) => {
  if (!Array.isArray(events)) return []
  const out = []
  for (const item of events) {
    if (!item || typeof item !== 'object') continue
    const selector = scrubText(item.selector || '')
    if (!selector || selector === 'html' || selector === 'body') continue

    const normalized = {
      type: scrubText(item.type || ''),
      selector,
      value: item.value == null ? '' : String(item.value),
      text: scrubText(item.text || ''),
      intent: scrubText(item.intent || ''),
      variableKey: scrubText(item.variableKey || ''),
      at: Number(item.at || 0),
    }

    if (!normalized.type) continue
    if ((normalized.type === 'input' || normalized.type === 'change') && !normalized.value && !normalized.variableKey) {
      continue
    }

    const prev = out[out.length - 1]
    if (prev
      && prev.type === normalized.type
      && prev.selector === normalized.selector
      && prev.value === normalized.value
      && prev.intent === normalized.intent
      && prev.variableKey === normalized.variableKey) {
      continue
    }

    out.push(normalized)
    if (out.length >= 260) break
  }
  return out
}

const getManualFlowSummary = (job) => ({
  recording: Boolean(job?._manualFlowRecording?.active),
  hasFlow: Boolean(job?._manualFlow?.events?.length),
  steps: Array.isArray(job?._manualFlow?.events) ? job._manualFlow.events.length : 0,
  updatedAt: job?._manualFlow?.updatedAt || null,
  startedAt: job?._manualFlowRecording?.startedAt || null,
})

const buildDefaultManualFlowEvents = () => ([
  {
    type: 'click',
    selector: 'soma-button[aria-label="Filtrar"]',
    value: '',
    text: 'Filtrar',
    intent: 'filter_action',
    variableKey: '',
    at: now(),
  },
])

const startManualFlowRecording = async (job) => {
  if (!job?.page) {
    throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para gravacao.', null, 'flow_record_start')
  }

  await job.page.evaluate(() => {
    const KEY = '__hubxpFlowRecorder'
    const now = () => Date.now()
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()
    const safeAttr = (el, name) => clean(el?.getAttribute?.(name) || '')
    const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    const isOtpField = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false
      const tag = String(el.tagName || '').toLowerCase()
      if (tag !== 'input') return false
      const inputMode = String(el.getAttribute('inputmode') || '').toLowerCase()
      const maxLength = String(el.getAttribute('maxlength') || '')
      const name = safeAttr(el, 'name')
      const id = safeAttr(el, 'id')
      return (inputMode === 'numeric' && maxLength === '1') || /otp|token|one-time|seguranca/.test(`${name} ${id}`.toLowerCase())
    }

    const buildSelector = (el) => {
      if (!el || !(el instanceof Element)) return ''
      const tag = String(el.tagName || '').toLowerCase()
      if (!tag || tag === 'html' || tag === 'body') return tag

      const id = safeAttr(el, 'id')
      if (id && !/\s/.test(id)) return `#${CSS.escape ? CSS.escape(id) : id}`

      const name = safeAttr(el, 'name')
      if (name) return `${tag}[name="${esc(name)}"]`

      const aria = safeAttr(el, 'aria-label')
      if (aria) return `${tag}[aria-label="${esc(aria)}"]`

      const ph = safeAttr(el, 'placeholder')
      if (ph) return `${tag}[placeholder="${esc(ph)}"]`

      const dataTestId = safeAttr(el, 'data-testid')
      if (dataTestId) return `${tag}[data-testid="${esc(dataTestId)}"]`

      const classes = clean(el.className || '')
        .split(' ')
        .filter(Boolean)
        .slice(0, 2)
      if (classes.length) {
        const classSelector = classes.map((c) => `.${CSS.escape ? CSS.escape(c) : c}`).join('')
        if (classSelector) return `${tag}${classSelector}`
      }

      const parts = []
      let node = el
      let depth = 0
      while (node && depth < 6 && node.nodeType === 1) {
        const t = String(node.tagName || '').toLowerCase()
        if (!t || t === 'html' || t === 'body') break
        let part = t
        const parent = node.parentElement
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => String(c.tagName || '').toLowerCase() === t)
          if (siblings.length > 1) {
            const idx = siblings.indexOf(node) + 1
            part += `:nth-of-type(${idx})`
          }
        }
        parts.unshift(part)
        node = parent
        depth += 1
      }
      return parts.join(' > ')
    }

    const inferVariableKey = (el, selector, dateFieldOrder) => {
      if (!el || !(el instanceof HTMLElement)) return ''
      const type = String(el.getAttribute('type') || '').toLowerCase()
      const combined = [
        safeAttr(el, 'placeholder'),
        safeAttr(el, 'aria-label'),
        safeAttr(el, 'name'),
        safeAttr(el, 'id'),
        clean(el.textContent || ''),
      ].join(' ').toLowerCase()

      if (/conta|c[oó]digo|codigo|cliente|account/.test(combined)) return 'account'

      if (/data/.test(combined) || type === 'date') {
        if (/inicial|inicio|from|de\b/.test(combined)) return 'date_from'
        if (/final|fim|ate|até|to\b/.test(combined)) return 'date_to'
        if (!dateFieldOrder[selector]) {
          dateFieldOrder[selector] = Object.keys(dateFieldOrder).length + 1
        }
        return dateFieldOrder[selector] === 1 ? 'date_from' : 'date_to'
      }

      return ''
    }

    const inferClickIntent = (el) => {
      const combined = [
        clean(el?.textContent || ''),
        safeAttr(el, 'aria-label'),
        safeAttr(el, 'title'),
        safeAttr(el, 'class'),
      ].join(' ').toLowerCase()

      if (/filtrar|buscar|pesquisar|aplicar|atualizar/.test(combined)) return 'filter_action'
      if (/pdf|nota|download|visualizar|imprimir|arquivo|document/.test(combined)) return 'note_action'
      if (/conta|c[oó]digo|codigo|cliente/.test(combined)) return 'account_pick'
      return ''
    }

    const ensureRecorder = () => {
      if (window[KEY]) return window[KEY]
      const recorder = {
        active: false,
        startedAt: 0,
        seq: 0,
        events: [],
        dateFieldOrder: {},
        handlers: {},
      }

      const pushEvent = (payload) => {
        if (!recorder.active) return
        recorder.seq += 1
        recorder.events.push({
          ...payload,
          seq: recorder.seq,
          at: now(),
        })
        if (recorder.events.length > 500) {
          recorder.events = recorder.events.slice(recorder.events.length - 500)
        }
      }

      recorder.handlers.click = (event) => {
        const target = event?.target instanceof Element ? event.target.closest('button, a, [role="button"], td, div, span, input, label') : null
        if (!target || !isVisible(target)) return
        const selector = buildSelector(target)
        if (!selector) return
        pushEvent({
          type: 'click',
          selector,
          text: clean(target.textContent || ''),
          intent: inferClickIntent(target),
          variableKey: '',
          value: '',
        })
      }

      recorder.handlers.input = (event) => {
        const target = event?.target
        if (!(target instanceof HTMLElement)) return
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(String(target.tagName || '').toUpperCase())) return
        if (!isVisible(target)) return
        if (isOtpField(target)) return
        const inputType = String(target.getAttribute?.('type') || '').toLowerCase()
        if (inputType === 'password') return

        const selector = buildSelector(target)
        if (!selector) return
        const value = target.value == null ? '' : String(target.value)
        pushEvent({
          type: 'input',
          selector,
          text: '',
          intent: '',
          variableKey: inferVariableKey(target, selector, recorder.dateFieldOrder),
          value: value.slice(0, 180),
        })
      }

      recorder.handlers.change = (event) => {
        const target = event?.target
        if (!(target instanceof HTMLElement)) return
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(String(target.tagName || '').toUpperCase())) return
        if (!isVisible(target)) return
        if (isOtpField(target)) return
        const inputType = String(target.getAttribute?.('type') || '').toLowerCase()
        if (inputType === 'password') return

        const selector = buildSelector(target)
        if (!selector) return
        const value = target.value == null ? '' : String(target.value)
        pushEvent({
          type: 'change',
          selector,
          text: '',
          intent: '',
          variableKey: inferVariableKey(target, selector, recorder.dateFieldOrder),
          value: value.slice(0, 180),
        })
      }

      document.addEventListener('click', recorder.handlers.click, true)
      document.addEventListener('input', recorder.handlers.input, true)
      document.addEventListener('change', recorder.handlers.change, true)
      window[KEY] = recorder
      return recorder
    }

    const recorder = ensureRecorder()
    recorder.active = true
    recorder.startedAt = now()
    recorder.seq = 0
    recorder.events = []
    recorder.dateFieldOrder = {}
    return { startedAt: recorder.startedAt }
  }).catch((error) => {
    throw new Error(error?.message || 'Falha ao iniciar gravacao do fluxo manual.')
  })

  job._manualFlowRecording = { active: true, startedAt: now() }
  appendJobLog(job, 'flow_record', 'Gravacao manual iniciada.')
  touchJob(job)
  return getManualFlowSummary(job)
}

const stopManualFlowRecording = async (job) => {
  if (!job?.page) {
    throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para gravacao.', null, 'flow_record_stop')
  }

  const payload = await job.page.evaluate(() => {
    const KEY = '__hubxpFlowRecorder'
    const recorder = window[KEY]
    if (!recorder) return { events: [], startedAt: null, found: false }
    recorder.active = false
    const events = Array.isArray(recorder.events) ? recorder.events.slice() : []
    return {
      found: true,
      events,
      startedAt: recorder.startedAt || null,
    }
  }).catch((error) => {
    throw new Error(error?.message || 'Falha ao finalizar gravacao do fluxo manual.')
  })

  const events = compressManualFlowEvents(payload?.events || [])
  const updatedAt = now()
  job._manualFlow = {
    version: 1,
    startedAt: payload?.startedAt || null,
    updatedAt,
    events,
  }
  job._manualFlowRecording = { active: false, startedAt: null }

  appendJobLog(job, 'flow_record', `Gravacao manual finalizada com ${events.length} passos.`, {
    steps: events.length,
  })
  touchJob(job)
  return getManualFlowSummary(job)
}

const replayManualFlow = async (job, page, variables = {}, options = {}) => {
  const events = Array.isArray(job?._manualFlow?.events) ? job._manualFlow.events : []
  if (!events.length) return { ok: false, reason: 'FLOW_EMPTY', executed: 0 }

  const mode = scrubText(options.mode || 'full') || 'full'
  const maxEvents = Number.isFinite(Number(options.maxEvents))
    ? Math.max(1, Math.min(260, Number(options.maxEvents)))
    : 180
  const applyDateFallback = toBoolean(options.applyDateFallback, true)

  const accountValue = variables?.account == null ? '' : String(variables.account).trim()
  const dateFromValue = variables?.date_from == null ? '' : String(variables.date_from).trim()
  const dateToValue = variables?.date_to == null ? '' : String(variables.date_to).trim()

  const hasAccountInputStep = events.some((step) => {
    const type = scrubText(step?.type || '')
    const key = scrubText(step?.variableKey || '')
    return (type === 'input' || type === 'change') && key === 'account'
  })
  const hasDateInputSteps = events.some((step) => {
    const type = scrubText(step?.type || '')
    const key = scrubText(step?.variableKey || '')
    return (type === 'input' || type === 'change') && (key === 'date_from' || key === 'date_to')
  })

  // Fallback: quando a gravacao nao capturou input de conta/data (apenas cliques),
  // aplica conta e periodo usando os helpers robustos antes do replay.
  if (mode === 'prepare_filters') {
    if (accountValue && !hasAccountInputStep) {
      const contaOk = await selectContaOnNotas(job, page, accountValue)
      if (!contaOk) {
        return { ok: false, reason: 'REPLAY_ACCOUNT_FALLBACK_FAILED', executed: 0, stoppedAt: null }
      }
      await delay(120)
    }
    if (applyDateFallback && dateFromValue && dateToValue && !hasDateInputSteps) {
      await tryApplyDateFilters(job, page, {
        dateFrom: dateFromValue,
        dateTo: dateToValue,
      })
      await delay(120)
    }
  }

  let executed = 0
  for (let i = 0; i < events.length && executed < maxEvents; i += 1) {
    const step = events[i]
    if (!step?.selector || !step?.type) continue
    if (mode === 'prepare_filters' && step.intent === 'note_action') break
    if (mode === 'prepare_filters' && step.intent === 'account_pick' && accountValue && !hasAccountInputStep) {
      continue
    }

    const selector = String(step.selector)
    const type = String(step.type)

    if (type === 'input' || type === 'change') {
      const variableKey = scrubText(step.variableKey || '')
      const rawValue = (variableKey && variables[variableKey] != null)
        ? variables[variableKey]
        : step.value
      const nextValue = rawValue == null ? '' : String(rawValue)
      if (!nextValue) continue

      const locator = page.locator(selector).first()
      const visible = await isVisible(locator)
      if (!visible) continue
      const filled = await fillInputRobust(locator, nextValue)
      if (!filled) continue
      executed += 1
      await delay(80)
      continue
    }

    if (type === 'click') {
      let clicked = false
      const locator = page.locator(selector).first()
      if (await isVisible(locator)) {
        clicked = await locator.click({ timeout: 1500 }).then(() => true).catch(() => false)
      }
      if (!clicked) {
        clicked = await page.evaluate((sel) => {
          try {
            const el = document.querySelector(sel)
            if (!el) return false
            el.click()
            return true
          } catch {
            return false
          }
        }, selector).catch(() => false)
      }
      if (!clicked) continue

      executed += 1
      if (step.intent === 'filter_action') {
        await Promise.race([
          waitForOrdersResponse(page, 3500),
          page.waitForSelector('table tbody tr, [role="row"]', { timeout: 4200 }).catch(() => null),
          delay(900),
        ])
        if (mode === 'prepare_filters') {
          return { ok: true, executed, stoppedAt: 'filter_action' }
        }
      } else {
        await delay(120)
      }
    }
  }

  return { ok: executed > 0, executed, stoppedAt: null }
}

const waitForEnabled = async (locator, timeout = 12000) => {
  const startedAt = now()
  while (now() - startedAt < timeout) {
    try {
      if (await locator.count() === 0) {
        await delay(80)
        continue
      }
      if (!(await isVisible(locator))) {
        await delay(80)
        continue
      }
      const disabled = await locator.isDisabled().catch(() => false)
      const ariaDisabled = await locator.getAttribute('aria-disabled').catch(() => null)
      const disabledAttr = await locator.getAttribute('disabled').catch(() => null)
      if (!disabled && ariaDisabled !== 'true' && disabledAttr == null) {
        return true
      }
    } catch {
      // continua
    }
    await delay(100)
  }
  return false
}

const getOtpDigitInputs = (page) => page.locator(OTP_DIGIT_SELECTOR)

const getOtpDigitCount = async (page) => {
  try {
    return await getOtpDigitInputs(page).count()
  } catch {
    return 0
  }
}

const findPasswordField = async (page) => {
  const containerPassword = page.locator('#wl-form--pwd input[type="password"], #wl-form--pwd input').first()
  if (await isVisible(containerPassword)) return { locator: containerPassword, selector: '#wl-form--pwd input' }
  return pickVisibleLocator(page, LOGIN_PASSWORD_SELECTORS)
}

const findUserField = async (page) => {
  const direct = await pickVisibleLocator(page, LOGIN_USER_SELECTORS)
  if (direct) return direct

  const marker = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    const scoreInput = (el) => {
      const type = String(el.getAttribute('type') || '').toLowerCase()
      if (type === 'password' || type === 'hidden') return -1
      if (!isVisible(el)) return -1
      const ph = String(el.getAttribute('placeholder') || '').toLowerCase()
      const aria = String(el.getAttribute('aria-label') || '').toLowerCase()
      const name = String(el.getAttribute('name') || '').toLowerCase()
      const id = String(el.getAttribute('id') || '').toLowerCase()
      const combined = `${ph} ${aria} ${name} ${id}`

      let score = 1
      if (/codigo|c[oó]digo|usuario|usu[aá]rio|account|login|email/.test(combined)) score += 8
      if (type === 'email' || type === 'text') score += 2
      if (type === 'search') score += 1
      return score
    }

    const inputs = Array.from(document.querySelectorAll('input'))
      .map((el) => ({ el, score: scoreInput(el) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)

    if (!inputs.length) return null
    const best = inputs[0].el
    best.setAttribute('data-hubxp-user-field', '1')
    return 'input[data-hubxp-user-field="1"]'
  }).catch(() => null)

  if (!marker) return null
  return { locator: page.locator(marker).first(), selector: marker }
}

const readLocatorValue = async (locator) => {
  try {
    const value = await locator.inputValue({ timeout: 800 })
    if (typeof value === 'string') return value
  } catch {
    // fallback below
  }
  try {
    return await locator.evaluate((el) => String(el.value || ''))
  } catch {
    return ''
  }
}

const fillInputRobust = async (locator, value) => {
  const expected = String(value ?? '')
  if (!expected) return true

  try { await locator.click({ timeout: 1200 }) } catch {}
  try { await locator.fill('') } catch {}
  try { await locator.fill(expected) } catch {}
  if (await readLocatorValue(locator) === expected) return true

  try { await locator.press('Control+A') } catch {}
  try { await locator.press('Backspace') } catch {}
  try { await locator.type(expected, { delay: 20 }) } catch {}
  if (await readLocatorValue(locator) === expected) return true

  try {
    await locator.evaluate((el, next) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(el, next)
      else el.value = next
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.dispatchEvent(new Event('blur', { bubbles: true }))
    }, expected)
  } catch {
    // noop
  }

  return (await readLocatorValue(locator)) === expected
}

const centerLoginForm = async (page) => {
  return page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('form'),
      ...document.querySelectorAll('[class*="login" i]'),
      ...document.querySelectorAll('[id*="login" i]'),
    ]
    const target = candidates.find((el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 300 && r.height > 120
    })
    if (!target) return false
    target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
    window.scrollBy(0, -80)
    return true
  }).catch(() => false)
}

const centerOtpForm = async (page) => {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    const otpCandidates = Array.from(document.querySelectorAll([
      'input[inputmode="numeric"]',
      'input[maxlength="1"]',
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[name*="token" i]',
      'input[id*="otp" i]',
      'input[id*="token" i]',
    ].join(','))).filter(isVisible)

    if (!otpCandidates.length) return false

    let target = otpCandidates[0]
    let parent = target.parentElement
    for (let i = 0; i < 7 && parent; i += 1) {
      const r = parent.getBoundingClientRect()
      if (r.width >= 360 && r.height >= 220 && r.width <= window.innerWidth * 0.95 && r.height <= window.innerHeight * 0.95) {
        target = parent
      }
      parent = parent.parentElement
    }

    target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
    window.scrollBy(0, -80)
    return true
  }).catch(() => false)
}

const centerAuthViewport = async (page) => {
  const otpCentered = await centerOtpForm(page)
  if (otpCentered) return true
  return centerLoginForm(page)
}

const runLoginAutofill = async (job, page, { username = '', password = '' } = {}) => {
  const result = { usernameFilled: false, passwordFilled: false }

  if (username) {
    const userField = await findUserField(page)
    if (userField?.locator) {
      result.usernameFilled = await fillInputRobust(userField.locator, username)
      appendJobLog(job, 'autofill', result.usernameFilled ? 'Usuario preenchido automaticamente' : 'Falha ao preencher usuario', {
        selector: userField.selector || 'unknown',
      })
    } else {
      appendJobLog(job, 'autofill', 'Campo de usuario nao encontrado para preenchimento automatico')
    }
  }

  if (password) {
    const passField = await findPasswordField(page)
    if (passField?.locator) {
      result.passwordFilled = await fillInputRobust(passField.locator, password)
      appendJobLog(job, 'autofill', result.passwordFilled ? 'Senha preenchida automaticamente' : 'Falha ao preencher senha', {
        selector: passField.selector || 'unknown',
      })
    } else {
      appendJobLog(job, 'autofill', 'Campo de senha nao encontrado para preenchimento automatico')
    }
  }

  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur()
    }
  }).catch(() => null)

  return result
}

const waitForPotentialAuthState = async (page, timeout = 30000) => {
  const startedAt = now()
  while (now() - startedAt < timeout) {
    if (await detectOtpRequired(page)) return 'otp'
    if (await isAuthenticated(page)) return 'authenticated'
    await delay(200)
  }
  return 'unknown'
}

const isLoginScreenVisible = async (page) => {
  const hasPassword = await findPasswordField(page)
  if (hasPassword) return true
  const hasUser = await pickVisibleLocator(page, LOGIN_USER_SELECTORS)
  return Boolean(hasUser)
}

const detectOtpRequired = async (page) => {
  const otpDigits = await getOtpDigitCount(page)
  if (otpDigits >= 6) return true

  const otpInput = await pickVisibleLocator(page, OTP_SELECTORS)
  if (otpInput) return true
  try {
    const bodyText = scrubText(await page.locator('body').innerText())
    if (/token hub mobile|token|otp|autenticacao|autentica\w+|codigo de seguranca|c[oó]digo de seguran/i.test(bodyText)) {
      const possibleInput = await page.locator('input').count()
      return possibleInput > 0
    }
  } catch {
    // noop
  }
  return false
}

const isAuthenticated = async (page) => {
  const currentUrl = String(page.url() || '').toLowerCase()

  // URL indica pagina autenticada — retornar imediato sem verificar campos
  if (currentUrl.includes('dashboard') || currentUrl.includes('performance')) return true
  if (currentUrl.includes('central') && currentUrl.includes('ordens')) return true
  if (currentUrl.includes('hub.xpi.com.br/new/')) return true

  // URL de login explícita
  if (/advisor\.xpi\.com\.br\/login/.test(currentUrl)) return false

  // Verificar se é tela de login/otp antes de checar conteúdo
  if (await isLoginScreenVisible(page)) return false

  // hub.xpi.com.br raiz sem login NÃO é suficiente — precisa de conteúdo autenticado
  try {
    const body = scrubText(await page.locator('body').innerText())
    if (/central de ordens|investimento|estruturad|opera[cç][oõ]es|dashboard|favoritos|clientes/i.test(body)) {
      if (!/entrar|login|senha|password/i.test(body)) {
        return true
      }
      const hasNav = await page.locator('nav, [role="navigation"], .sidebar, .menu-lateral').count().catch(() => 0)
      if (hasNav > 0) return true
    }
  } catch {
    // noop
  }

  return false
}

const findPageIndicator = async (page) => {
  try {
    return await page.evaluate(() => {
      function deepFind(root, selector) {
        const results = []
        try { results.push(...root.querySelectorAll(selector)) } catch {}
        const allEls = root.querySelectorAll('*')
        for (const el of allEls) {
          if (el.shadowRoot) {
            try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return results
      }

      // Estrategia 1: ler atributos do <soma-pagination> (HubXP)
      const somaPags = deepFind(document, 'soma-pagination')
      for (const sp of somaPags) {
        const pageAttr = parseInt(sp.getAttribute('page'), 10)
        const totalItems = parseInt(sp.getAttribute('total'), 10)
        const perPage = parseInt(sp.getAttribute('itemsperpage') || '10', 10)
        if (Number.isFinite(pageAttr) && Number.isFinite(totalItems) && totalItems > 0 && perPage > 0) {
          return { current: pageAttr, total: Math.ceil(totalItems / perPage) }
        }
      }

      // Estrategia 2: texto "X - Y de Z" (extrair pagina e total)
      function deepTexts(root) {
        const texts = []
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) texts.push(walker.currentNode.textContent || '')
        const allEls = root.querySelectorAll('*')
        for (const el of allEls) {
          if (el.shadowRoot) texts.push(...deepTexts(el.shadowRoot))
        }
        return texts
      }

      const rangeRegex = /(\d+)\s*[-–]\s*(\d+)\s+de\s+(\d+)/i
      const pageRegex = /p[aá]gina\s*(\d+)\s*(?:de|\/)\s*(\d+)/i
      const texts = deepTexts(document.body)
      for (const text of texts) {
        const rangeMatch = text.match(rangeRegex)
        if (rangeMatch) {
          const start = Number(rangeMatch[1])
          const end = Number(rangeMatch[2])
          const totalItems = Number(rangeMatch[3])
          if (Number.isFinite(start) && Number.isFinite(totalItems) && totalItems > 0) {
            const perPage = end - start + 1
            const currentPage = Math.ceil(start / perPage)
            const totalPages = Math.ceil(totalItems / perPage)
            return { current: currentPage, total: totalPages }
          }
        }
        const pageMatch = text.match(pageRegex)
        if (pageMatch) {
          const current = Number(pageMatch[1])
          const total = Number(pageMatch[2])
          if (Number.isFinite(current) && Number.isFinite(total)) return { current, total }
        }
      }
      return null
    })
  } catch {
    return null
  }
}

const pickTableLocator = async (page) => {
  // Detectar tabela via evaluate() — busca profunda com Shadow DOM
  const bestSelector = await page.evaluate(() => {
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    // Busca no light DOM primeiro (mais comum)
    const selectors = [
      'table', '[role="table"]', '[role="grid"]', '[role="treegrid"]',
      '.ag-root-wrapper', '.ag-body-viewport',
    ]
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel)
      for (const el of els) {
        if (!isVis(el)) continue
        const trs = el.querySelectorAll('tbody tr')
        const ths = el.querySelectorAll('thead th')
        if (trs.length > 0 || ths.length > 1) return sel
        const roleRows = el.querySelectorAll('[role="row"]')
        const roleCells = el.querySelectorAll('[role="gridcell"], [role="cell"]')
        if (roleRows.length > 1 || roleCells.length > 0) return sel
      }
    }
    // Busca profunda em Shadow DOM
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }
    for (const sel of selectors) {
      const found = deepFind(document, sel)
      for (const el of found) {
        if (!isVis(el)) continue
        const trs = el.querySelectorAll('tbody tr')
        const ths = el.querySelectorAll('thead th')
        if (trs.length > 0 || ths.length > 1) {
          el.setAttribute('data-hubxp-table', 'found')
          return '[data-hubxp-table="found"]'
        }
        const roleRows = el.querySelectorAll('[role="row"]')
        const roleCells = el.querySelectorAll('[role="gridcell"], [role="cell"]')
        if (roleRows.length > 1 || roleCells.length > 0) {
          el.setAttribute('data-hubxp-table', 'found')
          return '[data-hubxp-table="found"]'
        }
      }
    }
    return null
  }).catch(() => null)

  if (!bestSelector) return null
  return page.locator(bestSelector).first()
}

const readCentralOrdersFilterUiState = async (page) => {
  return page.evaluate(() => {
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      const style = window.getComputedStyle(el)
      if (!style) return true
      if (style.display === 'none' || style.visibility === 'hidden') return false
      if (style.pointerEvents === 'none') return false
      return true
    }
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()

    const hasDatepicker = deepFind(document, 'soma-datepicker, [class*="datepicker" i], input[type="date"]')
      .some((el) => isVis(el))

    const filterCandidates = deepFind(document, 'button, a, [role="button"], soma-button')
    const hasFilterButton = filterCandidates.some((el) => {
      if (!isVis(el)) return false
      const text = normalize(el.textContent || '')
      if (!text || /limpar/.test(text)) return false
      return /^filtrar$/.test(text) || /\bfiltrar\b/.test(text) || /^buscar$/.test(text) || /\bbuscar\b/.test(text)
    })

    const inputCandidates = deepFind(document, 'input, soma-text-field, textarea')
    const hasFilterInputs = inputCandidates.some((el) => {
      if (!isVis(el)) return false
      const attrs = normalize([
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('placeholder') || '',
        el.getAttribute?.('name') || '',
        el.getAttribute?.('id') || '',
      ].join(' '))
      return /periodo|cliente|conta|codigo|c[oó]d|status|assessor/.test(attrs)
    })

    return {
      ready: Boolean(hasDatepicker || (hasFilterButton && hasFilterInputs)),
      hasDatepicker,
      hasFilterButton,
      hasFilterInputs,
    }
  }).catch(() => ({
    ready: false,
    hasDatepicker: false,
    hasFilterButton: false,
    hasFilterInputs: false,
  }))
}

const waitForCentralOrdersFilterUi = async (page, timeoutMs = 12000) => {
  const maxMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(1000, Math.min(30000, Number(timeoutMs)))
    : 12000
  const startedAt = now()
  let lastState = {
    ready: false,
    hasDatepicker: false,
    hasFilterButton: false,
    hasFilterInputs: false,
  }
  while (now() - startedAt < maxMs) {
    lastState = await readCentralOrdersFilterUiState(page)
    if (lastState.ready) return lastState
    await delay(220)
  }
  return lastState
}

const extractTableRows = async (table) => {
  // Extract everything in a single page.evaluate() call — massively faster than per-row Playwright calls
  const result = await table.evaluate((el) => {
    const scrub = (v) => String(v || '').replace(/\s+/g, ' ').trim()

    // 1) Try standard <table>
    let rawHeaders = []
    let dataRows = []

    const theadThs = el.querySelectorAll('thead th')
    const tbodyTrs = el.querySelectorAll('tbody tr')

    if (tbodyTrs.length > 0) {
      rawHeaders = Array.from(theadThs).map((th) => scrub(th.innerText))
      dataRows = Array.from(tbodyTrs).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => scrub(td.innerText))
      )
    }

    // 2) Try role-based grid (AG Grid etc)
    if (dataRows.length === 0) {
      const roleRows = el.querySelectorAll('[role="row"]')
      if (roleRows.length > 0) {
        const headerRow = roleRows[0]
        const headerCells = headerRow.querySelectorAll('[role="columnheader"], [role="gridcell"], [role="cell"], th')
        if (headerCells.length > 0) {
          rawHeaders = Array.from(headerCells).map((c) => scrub(c.innerText))
        }
        dataRows = Array.from(roleRows).slice(1).map((row) =>
          Array.from(row.querySelectorAll('[role="gridcell"], [role="cell"], td')).map((c) => scrub(c.innerText))
        )
      }
    }

    // 3) Try AG Grid / div-based structure
    if (dataRows.length === 0) {
      const headerEls = el.querySelectorAll('.ag-header-cell, [class*="header"] [class*="cell"], [class*="columnHeader"]')
      if (headerEls.length > 0) {
        rawHeaders = Array.from(headerEls).map((c) => scrub(c.innerText))
      }
      const agRows = el.querySelectorAll('.ag-row, [class*="row"][class*="data"]')
      if (agRows.length > 0) {
        dataRows = Array.from(agRows).map((row) =>
          Array.from(row.querySelectorAll('.ag-cell, [class*="cell"]')).map((c) => scrub(c.innerText))
        )
      }
    }

    return { rawHeaders, dataRows }
  })

  const used = new Set()
  const headers = (result.rawHeaders || []).map((header, index) => sanitizeHeader(header, index, used))

  const rows = []
  for (const cells of result.dataRows) {
    if (!cells.length) continue
    const mapped = {}
    const maxLen = Math.max(headers.length, cells.length)
    for (let c = 0; c < maxLen; c += 1) {
      const key = headers[c] || `coluna_${c + 1}`
      mapped[key] = cells[c]
    }
    const hasValue = Object.values(mapped).some((value) => value)
    if (hasValue) rows.push(mapped)
  }

  const normalizedHeaders = headers.length
    ? headers
    : rows[0]
      ? Object.keys(rows[0])
      : []

  return { headers: normalizedHeaders, rows }
}

// Voltar para a primeira pagina da paginacao (antes de iniciar coleta)
const clickFirstPage = async (page) => {
  return await page.evaluate(() => {
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }

    // Estrategia 1: <soma-pagination> — clicar em button.button-pagination-first
    const somaPags = deepFind(document, 'soma-pagination')
    for (const sp of somaPags) {
      sp.scrollIntoView({ behavior: 'instant', block: 'center' })
      const sr = sp.shadowRoot
      if (!sr) continue
      const firstBtn = sr.querySelector('button.button-pagination-first')
        || sr.querySelector('button[aria-label*="Primeir" i]')
        || sr.querySelector('button[aria-label*="first" i]')
      if (firstBtn && !firstBtn.disabled) {
        firstBtn.scrollIntoView({ behavior: 'instant', block: 'center' })
        firstBtn.click()
        return true
      }
      // Ja esta na primeira pagina (botao disabled)
      return false
    }

    // Estrategia 2: qualquer botao "primeiro" no DOM
    const allBtns = deepFind(document, 'button, a, [role="button"]')
    for (const el of allBtns) {
      if (el.disabled) continue
      const cl = (el.className || '').toLowerCase()
      if (/pagination-first|page-first|first-page/i.test(cl)) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        el.click()
        return true
      }
    }

    return false
  }).catch(() => false)
}

// Clicar no botao de proxima pagina diretamente via evaluate (sem locators que podem falhar com Shadow DOM)
const clickNextPage = async (page) => {
  return await page.evaluate(() => {
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const isDisabled = (el) => {
      if (el.disabled) return true
      if (el.getAttribute('aria-disabled') === 'true') return true
      if (el.getAttribute('disabled') != null) return true
      if (/disabled|is-disabled/i.test(el.className || '')) return true
      return false
    }

    // Estrategia 1: <soma-pagination> — clicar em button.button-pagination-next dentro do shadow root
    const somaPags = deepFind(document, 'soma-pagination')
    for (const sp of somaPags) {
      // Scroll o componente para view antes de tudo
      sp.scrollIntoView({ behavior: 'instant', block: 'center' })
      const sr = sp.shadowRoot
      if (!sr) continue
      // Tentar pela classe especifica primeiro
      const nextBtn = sr.querySelector('button.button-pagination-next')
        || sr.querySelector('button[aria-label*="Pr" i]')
        || sr.querySelector('button[aria-label*="next" i]')
      if (nextBtn && !isDisabled(nextBtn)) {
        nextBtn.scrollIntoView({ behavior: 'instant', block: 'center' })
        nextBtn.click()
        return true
      }
    }

    // Estrategia 2: qualquer botao "proximo" em todo o DOM (incluindo shadow)
    const allBtns = deepFind(document, 'button, a, [role="button"]')
    for (const el of allBtns) {
      if (isDisabled(el)) continue
      const text = (el.textContent || '').trim()
      const ariaLabel = (el.getAttribute('aria-label') || '')
      const title = (el.getAttribute('title') || '')
      const cl = (el.className || '').toLowerCase()
      // Verificar se e botao de paginacao next
      if (/pagination-next|page-next|next-page/i.test(cl)) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        el.click()
        return true
      }
      const label = text + ' ' + ariaLabel + ' ' + title
      if (/pr[o\u00f3]xim|next(?!.*prev)|avanc/i.test(label) || /^[>\u203a\u00bb]$/.test(text)) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        el.click()
        return true
      }
    }

    // Estrategia 3: li.next (Bootstrap style)
    const liNexts = deepFind(document, 'li.next:not(.disabled) button, li.next:not(.disabled) a')
    for (const el of liNexts) {
      if (isVis(el) && !isDisabled(el)) {
        el.click()
        return true
      }
    }

    return false
  }).catch(() => false)
}

const waitForTableStability = async (page, timeoutMs = 2000) => {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => null)
}

const waitForOrdersResponse = async (page, timeout = 3000) => {
  try {
    await page.waitForResponse((response) => {
      const url = String(response?.url?.() || '').toLowerCase()
      if (!url) return false
      if (!/ordens|orders|estruturad|operation|operacao|notas|negociacao|corretagem|brokerage/i.test(url)) return false
      const type = response.request()?.resourceType?.()
      return type === 'xhr' || type === 'fetch'
    }, { timeout })
    return true
  } catch {
    // fallback silencioso para nao quebrar quando a tela nao dispara request visivel
    return false
  }
}

const isHubxpDataRequest = (url) => {
  const normalized = String(url || '').toLowerCase()
  if (!normalized) return false
  return /api-advisor\.xpi\.com\.br|ordens|orders|estruturad|operation|operacao|notas|negociacao|corretagem|brokerage|hubreports|equities/.test(normalized)
}

const waitForRateLimitResponse = async (page, timeout = 2800) => {
  try {
    const response = await page.waitForResponse((resp) => {
      const url = String(resp?.url?.() || '')
      if (!isHubxpDataRequest(url)) return false
      const status = Number(resp?.status?.())
      return status === 429 || status === 403
    }, { timeout })
    return {
      status: Number(response?.status?.() || 0),
      url: String(response?.url?.() || ''),
    }
  } catch {
    return null
  }
}

const clickNotasFilterButton = async (page, options = {}) => {
  const variant = Number.isFinite(Number(options.variant))
    ? Math.max(0, Number(options.variant))
    : 0
  const baseCandidates = [
    page.getByRole('button', { name: /^\s*filtrar\s*$/i }).first(),
    page.locator('soma-button[aria-label*="filtrar" i]').first(),
    page.locator('button, a, [role="button"]').filter({ hasText: /^\s*Filtrar\s*$/i }).first(),
  ]

  const rotateBy = baseCandidates.length ? (variant % baseCandidates.length) : 0
  const candidates = baseCandidates.slice(rotateBy).concat(baseCandidates.slice(0, rotateBy))

  for (const locator of candidates) {
    try {
      if (await locator.count() === 0) continue
      if (!(await isVisible(locator))) continue
      await locator.click({ timeout: 2000 })
      return true
    } catch {
      // tentar proximo candidato
    }
  }

  // Fallback robusto para componentes SOMA/Shadow DOM
  const clickedDeep = await page.evaluate((tryIndex) => {
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    const nodes = deepFind(document, 'button, a, [role="button"], soma-button, span, div')
    const filtered = []
    for (const node of nodes) {
      if (!isVis(node)) continue
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
      if (!text) continue
      if (/limpar/.test(text)) continue
      if (!/^filtrar$/.test(text) && !/\bfiltrar\b/.test(text)) continue
      filtered.push(node.closest('button, a, [role="button"], soma-button') || node)
    }
    const unique = [...new Set(filtered)]
    if (!unique.length) return false
    const idx = Math.max(0, Number(tryIndex || 0)) % unique.length
    const target = unique[idx]
    if (!target) return false
    target.click()
    return true
  }, variant).catch(() => false)
  if (clickedDeep) return true

  // Fallback restrito
  const order = variant % 2 === 0 ? ['Filtrar', 'Buscar'] : ['Buscar', 'Filtrar']
  for (const text of order) {
    const clicked = await clickByTexts(page, [text]).catch(() => false)
    if (clicked) return true
  }
  return false
}

const getNotasTableSignature = async (page) => {
  return page.evaluate(() => {
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()

    const table = deepFind(document, 'table, [role="grid"], [role="table"], .ag-root-wrapper')
      .find((el) => isVis(el))
    if (!table) return ''

    const rows = deepFind(table, 'tbody tr, tr, [role="row"]')
      .filter((el) => isVis(el))
      .slice(0, 3)
      .map((row) => normalize(row.textContent || ''))
      .filter(Boolean)

    const containerText = normalize(table.textContent || '').slice(0, 420)
    return `${rows.length}|${rows.join('||')}|${containerText}`
  }).catch(() => '')
}

const readNotasSelectedAccountDigits = async (page) => {
  return page.evaluate(() => {
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()

    const inputs = deepFind(document, 'input')
    for (const inp of inputs) {
      if (!isVis(inp)) continue
      const val = normalize(inp.value || '')
      const ph = normalize(inp.placeholder || '')
      const aria = normalize(inp.getAttribute?.('aria-label') || '')
      const combo = `${val} ${ph} ${aria}`.toLowerCase()
      if (!/conta|cliente|cod|c[oó]d/.test(combo)) continue
      const digits = val.replace(/\D/g, '')
      if (digits) return digits
    }

    const chips = deepFind(document, '[role="combobox"], [class*="selected" i], [class*="chip" i], [role="option"], span, div')
      .filter((el) => isVis(el))
    for (const node of chips) {
      const txt = normalize(node.textContent || '')
      if (!txt) continue
      if (!/conta\s*xp|xp\s*:|cliente|conta/i.test(txt)) continue
      const digits = txt.replace(/\D/g, '')
      if (digits) return digits
    }

    return ''
  }).catch(() => '')
}

const hasNotasGridVisible = async (page) => {
  return page.evaluate(() => {
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const table = deepFind(document, 'table, [role="grid"], [role="table"], .ag-root-wrapper')
      .find((el) => isVis(el))
    if (!table) return false
    const rows = deepFind(table, 'tbody tr, tr, [role="row"]').filter((el) => isVis(el))
    return rows.length > 0
  }).catch(() => false)
}

const runNotasFilterSearch = async (job, page, options = {}) => {
  const expectedAccountDigits = String(options.expectedAccount || '').replace(/\D/g, '')
  const maxAttempts = Number.isFinite(Number(options.maxAttempts))
    ? Math.max(1, Math.min(6, Number(options.maxAttempts)))
    : 4
  const stats = options.stats && typeof options.stats === 'object' ? options.stats : null
  if (stats) {
    if (!Number.isFinite(Number(stats.rateLimitHits))) stats.rateLimitHits = 0
    if (!Number.isFinite(Number(stats.attempts))) stats.attempts = 0
    stats.lastRateLimitStatus = stats.lastRateLimitStatus || null
    stats.lastRateLimitUrl = stats.lastRateLimitUrl || null
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (stats) stats.attempts = attempt
    const signatureBefore = await getNotasTableSignature(page)
    const selectedBefore = await readNotasSelectedAccountDigits(page)
    const responseWatch = waitForOrdersResponse(page, 4200)
    const rateLimitWatch = waitForRateLimitResponse(page, 3000)
    const clickedFilter = await clickNotasFilterButton(page, { variant: attempt - 1 })
    if (!clickedFilter) {
      appendJobLog(job, 'notas_filter', 'Botao Filtrar nao encontrado na tela de Notas.')
      return false
    }
    await Promise.race([
      waitForOrdersResponse(page, 4200),
      page.waitForSelector('table tbody tr, [role="row"]', { timeout: 4200 }).catch(() => null),
      delay(1300),
    ])

    const hadResponse = await responseWatch.catch(() => false)
    const signatureAfter = await getNotasTableSignature(page)
    const selectedAfter = await readNotasSelectedAccountDigits(page)
    const gridVisible = await hasNotasGridVisible(page)
    const tableChanged = Boolean(signatureBefore && signatureAfter && signatureBefore !== signatureAfter)
    const rateLimited = await rateLimitWatch
    const selectedMatches = expectedAccountDigits
      ? (selectedAfter === expectedAccountDigits || selectedAfter.endsWith(expectedAccountDigits))
      : Boolean(selectedAfter)
    const selectedBeforeMatches = expectedAccountDigits
      ? (selectedBefore === expectedAccountDigits || selectedBefore.endsWith(expectedAccountDigits))
      : Boolean(selectedBefore)
    const canFallbackBySelection = !rateLimited && (selectedMatches || selectedBeforeMatches) && gridVisible && attempt >= 2
    if (!rateLimited && (hadResponse || tableChanged || canFallbackBySelection)) {
      return true
    }

    if (!rateLimited && (selectedMatches || selectedBeforeMatches) && attempt >= 2) {
      appendJobLog(job, 'notas_filter', 'Filtro sem delta detectavel, mas conta permaneceu selecionada; seguindo fluxo.', {
        attempt,
        selectedBefore,
        selectedAfter,
        expectedAccountDigits: expectedAccountDigits || null,
      })
      return true
    }

    if (!rateLimited) {
      const uiBlocked = await hasBlockingNotasOverlay(page)
      if (uiBlocked) {
        const closedOverlay = await closeInlineNotaViewer(job, page, {
          strictX: false,
          allowFallbackEscape: true,
          maxAttempts: 3,
          settleTimeoutMs: 2800,
        }).catch(() => false)
        appendJobLog(job, 'ui_reset', closedOverlay
          ? 'Overlay bloqueante detectado durante filtro; fechamento executado antes do retry.'
          : 'Overlay bloqueante detectado durante filtro, mas fechamento nao confirmou.', {
          attempt,
          expectedAccountDigits: expectedAccountDigits || null,
        })
      }
      appendJobLog(job, 'notas_filter', 'Filtro sem resposta/troca de tabela detectavel; repetindo tentativa.', {
        attempt,
        maxAttempts,
        hadResponse,
        tableChanged,
        selectedAfter,
        expectedAccountDigits: expectedAccountDigits || null,
      })
      await page.keyboard.press('Enter').catch(() => null)
      await delay(650 + (attempt * 220))
      continue
    }

    const backoffMs = 1700 * attempt
    if (stats) {
      stats.rateLimitHits += 1
      stats.lastRateLimitStatus = rateLimited.status
      stats.lastRateLimitUrl = rateLimited.url || null
    }
    appendJobLog(job, 'notas_rate_limit', `HubXP retornou ${rateLimited.status} ao filtrar. Retry ${attempt}/${maxAttempts}.`, {
      backoffMs,
      url: String(rateLimited.url || '').slice(0, 160),
    })
    await delay(backoffMs)
  }

  return false
}

const MONTH_NAMES_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

// Minimizar janela do browser via CDP (esconde do desktop sem fechar)
const minimizeBrowserWindow = async (page) => {
  try {
    const cdp = await page.context().newCDPSession(page)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    })
    await cdp.detach().catch(() => null)
    return true
  } catch {
    // Fallback: mover window para fora da tela
    try {
      await page.evaluate(() => {
        if (typeof window.moveTo === 'function') window.moveTo(-3000, -3000)
      })
      return true
    } catch {
      return false
    }
  }
}

const ensureBrowserWindowVisible = async (page) => {
  if (!page) return false
  try {
    const cdp = await page.context().newCDPSession(page)
    const target = await cdp.send('Browser.getWindowForTarget')
    if (target?.windowId != null) {
      await cdp.send('Browser.setWindowBounds', {
        windowId: target.windowId,
        bounds: { windowState: 'normal' },
      }).catch(() => null)
      await cdp.send('Browser.setWindowBounds', {
        windowId: target.windowId,
        bounds: {
          left: 50,
          top: 50,
          width: 1440,
          height: 900,
        },
      }).catch(() => null)
    }
    await cdp.detach().catch(() => null)
  } catch {
    // ignore CDP failures (headless/unsupported browser)
  }
  try {
    await page.bringToFront()
    return true
  } catch {
    return false
  }
}

const tryApplyCalendarDatePicker = async (job, page, filters) => {
  const dateFrom = normalizeDateInput(filters?.dateFrom || resolveToday())
  const dateTo = normalizeDateInput(filters?.dateTo || dateFrom)
  const parseISO = (iso) => {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) return null
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  }
  const startDate = parseISO(dateFrom)
  const endDate = parseISO(dateTo)
  if (!startDate || !endDate) return false

  const fmtBR = (d) => `${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')}/${d.year}`
  const startBR = fmtBR(startDate)
  const endBR = fmtBR(endDate)

  appendJobLog(job, 'date_filter', 'Aplicando filtro de data no HubXP (soma-datepicker + Shadow DOM)', {
    dateFrom, dateTo, startBR, endBR,
  })

  // ====== Utilidade: busca recursiva que penetra Shadow DOM ======
  // O HubXP usa web components SOMA com shadow roots aninhados.
  // document.querySelectorAll NAO penetra shadow DOM, entao precisamos
  // de uma busca recursiva manual.
  const deepQueryAll = `
    function deepQueryAll(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepQueryAll(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }
  `

  // ====== PASSO 1: Encontrar o soma-datepicker ======
  // Esperar o elemento aparecer no DOM antes de procurar
  await page.waitForSelector('soma-datepicker, [class*="datepicker" i], input[type="date"]', { timeout: 4000 }).catch(() => null)
  let dpFound = false
  for (let retry = 0; retry < 5; retry++) {
    if (retry > 0) {
      await delay(400)
    }

    dpFound = await page.evaluate(() => {
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (!style) return true
        if (style.display === 'none' || style.visibility === 'hidden') return false
        if (style.opacity && Number(style.opacity) <= 0.02) return false
        return true
      }

      const candidates = Array.from(document.querySelectorAll('soma-datepicker, [class*="datepicker" i]'))
        .filter((el) => isVis(el))
      if (!candidates.length) {
        return { found: false }
      }

      const scoreDp = (el) => {
        const attrs = normalize([
          el.getAttribute('aria-label') || '',
          el.getAttribute('label') || '',
          el.getAttribute('name') || '',
          el.getAttribute('id') || '',
          el.getAttribute('placeholder') || '',
          el.getAttribute('type') || '',
        ].join(' '))
        const parent = el.closest('form, section, div')
        const parentText = normalize(parent?.textContent || '').slice(0, 1200)
        const r = el.getBoundingClientRect()
        let score = 0
        if (/periodo/.test(attrs)) score += 45
        if (/selecione/.test(attrs)) score += 8
        if (/range/.test(attrs)) score += 8
        if (/filtrar/.test(parentText)) score += 10
        if (/cod.*cliente|cliente/.test(parentText)) score += 6
        if (r.width >= 150 && r.width <= 420) score += 8
        if (r.height >= 24 && r.height <= 80) score += 5
        if (r.top >= 0 && r.top < (window.innerHeight * 0.65)) score += 4
        return score
      }

      candidates.sort((a, b) => scoreDp(b) - scoreDp(a))
      const dp = candidates[0]
      if (dp) {
        dp.setAttribute('data-hubxp-dp', 'trigger')
        return {
          found: true,
          tag: dp.tagName.toLowerCase(),
          ariaLabel: dp.getAttribute('aria-label') || '',
          label: dp.getAttribute('label') || '',
          score: scoreDp(dp),
        }
      }
      return { found: false }
    }).catch(() => ({ found: false }))

    if (dpFound.found) break
  }

  if (!dpFound.found) {
    appendJobLog(job, 'date_filter', 'soma-datepicker NAO encontrado apos 3 tentativas')
    await debugShot(job, page, 'date_filter_00_no_soma_dp')
    return false
  }

  appendJobLog(job, 'date_filter', `soma-datepicker encontrado: <${dpFound.tag}> aria-label="${dpFound.ariaLabel}"`, {
    label: dpFound.label || '',
    score: Number(dpFound.score || 0),
  })

  // ====== PASSO 2: Evitar mutacao direta de props do componente ======
  // Atribuir "value/open" diretamente em componentes SOMA gera comportamento instavel
  // e warnings de props imutaveis. Seguir apenas por interacao de UI (inputs/calendario).
  appendJobLog(job, 'date_filter', 'Pulando ajuste programatico de props; usando fluxo de UI para evitar limpeza indevida de periodo.')

  // ====== PASSO 3: seguir fluxo visual (nao preencher input por script) ======
  // Requisito funcional: clicar campo de data e escolher no calendario.
  appendJobLog(job, 'date_filter', 'Fluxo visual de data: sem preenchimento programatico do input.')

  // ====== PASSO 4: Clicar no picker para abrir calendario visual ======
  appendJobLog(job, 'date_filter', 'Abrindo calendario visual para selecionar data inicial e data final...')

  const dpEl = page.locator('[data-hubxp-dp="trigger"]').first()
  await dpEl.scrollIntoViewIfNeeded().catch(() => null)

  const tryOpenPeriodPicker = async (attempt) => {
    appendJobLog(job, 'date_filter', 'Clicando no campo Período para abrir calendario.', { attempt })
    const openInfo = await page.evaluate(() => {
      function deepFind(root, selector) {
        const results = []
        try { results.push(...root.querySelectorAll(selector)) } catch {}
        const allEls = root.querySelectorAll('*')
        for (const el of allEls) {
          if (el.shadowRoot) {
            try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return results
      }
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (!style) return true
        if (style.display === 'none' || style.visibility === 'hidden') return false
        if (style.pointerEvents === 'none') return false
        return true
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const getCalendarSignal = () => {
        const monthRe = /(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+\d{4}/i
        const roots = deepFind(document, 'soma-datepicker, [role="dialog"], [class*="calendar" i], [class*="datepicker" i], [class*="popover" i], [class*="overlay" i], body')
        let bestDayCount = 0
        let hasMonthHeader = false
        for (const root of roots) {
          if (!isVis(root)) continue
          const dayNodes = deepFind(root, 'button, td, [role="gridcell"], [role="button"], span, div')
          const days = new Set()
          for (const node of dayNodes) {
            if (!isVis(node)) continue
            const text = (node.textContent || '').trim()
            if (/^\d{1,2}$/.test(text)) {
              const day = Number(text)
              if (day >= 1 && day <= 31) days.add(day)
            }
          }
          const dayCount = days.size
          if (dayCount > bestDayCount) bestDayCount = dayCount
          const txt = normalize(root.textContent || '').slice(0, 2600)
          if (monthRe.test(txt)) hasMonthHeader = true
        }
        return {
          dayCount: bestDayCount,
          hasMonthHeader,
          opened: bestDayCount >= 20 || (bestDayCount >= 12 && hasMonthHeader),
        }
      }
      const fireClick = (node) => {
        if (!node || !isVis(node)) return false
        try { node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }) } catch {}
        try { node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true })) } catch {}
        try { node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true })) } catch {}
        try { node.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, composed: true })) } catch {}
        try { node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true })) } catch {}
        try { node.click() } catch {}
        try { node.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })) } catch {}
        return true
      }

      const dp = document.querySelector('[data-hubxp-dp="trigger"]')
      if (!dp) return { clicked: false, opened: false, method: 'no-dp', signal: getCalendarSignal() }

      const candidates = []
      const pushCandidate = (node, method) => {
        if (!node) return
        const target = node.closest ? (node.closest('button, [role="button"], input, soma-text-field, soma-icon') || node) : node
        if (!target || !isVis(target)) return
        candidates.push({ node: target, method })
      }

      pushCandidate(dp, 'host')
      const parent = dp.parentElement
      if (parent) {
        const near = parent.querySelector('input, button, [role="button"], soma-text-field, [class*="field" i], [class*="trigger" i]')
        pushCandidate(near, 'parent-near')
      }
      if (dp.shadowRoot) {
        const shadowNodes = deepFind(dp.shadowRoot, 'input, button, [role="button"], soma-text-field, [class*="field" i], [class*="trigger" i], [part*="input" i], [part*="control" i]')
        for (const node of shadowNodes.slice(0, 10)) {
          pushCandidate(node, 'shadow')
        }
      }

      const unique = []
      const seen = new Set()
      for (const item of candidates) {
        if (!item?.node) continue
        if (seen.has(item.node)) continue
        seen.add(item.node)
        unique.push(item)
      }
      if (!unique.length) unique.push({ node: dp, method: 'fallback-host' })

      let usedMethod = 'none'
      for (const item of unique) {
        usedMethod = item.method
        fireClick(item.node)
        const signal = getCalendarSignal()
        if (signal.opened) {
          return { clicked: true, opened: true, method: usedMethod, signal }
        }
      }

      return {
        clicked: unique.length > 0,
        opened: getCalendarSignal().opened,
        method: usedMethod,
        signal: getCalendarSignal(),
      }
    }).catch(() => ({ clicked: false, opened: false, method: 'eval-error', signal: { dayCount: 0, hasMonthHeader: false } }))

    appendJobLog(job, 'date_filter', openInfo.opened
      ? 'Campo Período clicado e calendario aberto.'
      : 'Campo Período clicado, mas calendario ainda nao abriu.', {
      attempt,
      method: openInfo.method || 'unknown',
      dayCount: Number(openInfo?.signal?.dayCount || 0),
      hasMonthHeader: Boolean(openInfo?.signal?.hasMonthHeader),
    })
    return Boolean(openInfo.opened)
  }

  // ====== PASSO 4b: Tentar abrir calendario com clicks nativos do Playwright ======
  // Playwright auto-pierce shadow DOM — clica no input real dentro do shadow root
  // o que e mais confiavel que eventos sinteticos via page.evaluate()
  const checkCalendarOpen = async () => {
    return page.evaluate(() => {
      function deepFind(root, selector) {
        const results = []
        try { results.push(...root.querySelectorAll(selector)) } catch {}
        const allEls = root.querySelectorAll('*')
        for (const el of allEls) {
          if (el.shadowRoot) {
            results.push(...deepFind(el.shadowRoot, selector))
          }
        }
        return results
      }
      const isVis = (el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const monthRe = /(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+\d{4}/i
      // Verificar se existe um wrapper de datepicker aberto (soma-datepicker-wrapper.open ou similar)
      const wrapperOpen = deepFind(document, '[class*="datepicker-wrapper"], [class*="calendar-popup"], [class*="datepicker"][class*="open"]')
        .some(el => isVis(el) && (el.classList?.contains('open') || el.querySelector?.('table, [role="grid"]')))
      const roots = deepFind(document, 'soma-datepicker, [role="dialog"], [class*="calendar" i], [class*="datepicker" i], [class*="popover" i], [class*="overlay" i], body')
      let bestSignal = { dayCount: 0, hasMonthHeader: false }
      for (const root of roots) {
        if (!isVis(root)) continue
        const allCells = deepFind(root, 'td, button, [role="gridcell"], span, div')
        const dayNumbers = new Set()
        for (const cell of allCells) {
          if (!isVis(cell)) continue
          const text = (cell.textContent || '').trim()
          if (/^\d{1,2}$/.test(text)) {
            const n = Number(text)
            if (n >= 1 && n <= 31) dayNumbers.add(n)
          }
        }
        const dayCount = dayNumbers.size
        const rootText = normalize(root.textContent || '').slice(0, 2600)
        const hasMonthHeader = monthRe.test(rootText)
        if (dayCount > bestSignal.dayCount || (dayCount === bestSignal.dayCount && hasMonthHeader && !bestSignal.hasMonthHeader)) {
          bestSignal = { dayCount, hasMonthHeader }
        }
      }
      return { opened: wrapperOpen || bestSignal.dayCount >= 20 || (bestSignal.dayCount >= 12 && bestSignal.hasMonthHeader), ...bestSignal, wrapperOpen }
    }).catch(() => ({ opened: false, dayCount: 0, hasMonthHeader: false, wrapperOpen: false }))
  }

  // Estrategias de click nativo do Playwright (auto-pierce shadow DOM)
  const playwrightClickTargets = [
    'soma-datepicker input[type="text"]',
    'soma-datepicker input',
    '[data-hubxp-dp="trigger"] input',
    'soma-datepicker soma-text-field',
    'soma-datepicker',
  ]

  let calendarReady = false
  for (let attempt = 1; attempt <= 6; attempt++) {
    // Primeiro tentar clicks nativos do Playwright (auto-pierce shadow DOM)
    if (attempt <= playwrightClickTargets.length) {
      const sel = playwrightClickTargets[attempt - 1]
      try {
        const el = page.locator(sel).first()
        const vis = await el.isVisible({ timeout: 800 }).catch(() => false)
        if (vis) {
          appendJobLog(job, 'date_filter', `Clicando via Playwright nativo: ${sel}`, { attempt })
          await el.click({ timeout: 2000, force: attempt > 3 })
          await delay(500)
        }
      } catch {}
    } else {
      // Fallback: clicks sinteticos via page.evaluate
      await tryOpenPeriodPicker(attempt)
      await delay(300)
    }

    const signal = await checkCalendarOpen()
    if (signal.opened) {
      appendJobLog(job, 'date_filter', 'Calendario ABERTO', { attempt, dayCount: signal.dayCount, wrapperOpen: signal.wrapperOpen })
      calendarReady = true
      break
    }
    appendJobLog(job, 'date_filter', 'Calendario ainda nao abriu', { attempt, dayCount: signal.dayCount, wrapperOpen: signal.wrapperOpen })
    await delay(200)
  }

  // Se ainda nao abriu, tentar force click + focus no dpEl
  if (!calendarReady) {
    try {
      await dpEl.focus({ timeout: 1000 }).catch(() => null)
      await dpEl.click({ timeout: 2000, force: true }).catch(() => null)
      await delay(600)
      const signal = await checkCalendarOpen()
      if (signal.opened) {
        calendarReady = true
        appendJobLog(job, 'date_filter', 'Calendario aberto apos force click + focus no trigger')
      }
    } catch {}
  }

  appendJobLog(job, 'date_filter', `Calendario ${calendarReady ? 'ABERTO' : 'NAO abriu'}`)

  if (!calendarReady) {
    // ====== FALLBACK: Definir valor do datepicker programaticamente ======
    appendJobLog(job, 'date_filter', 'Calendario nao abriu. Tentando definir valor do datepicker programaticamente...')
    const directValueOk = await page.evaluate(({ dateFrom, dateTo }) => {
      const dp = document.querySelector('[data-hubxp-dp="trigger"]') || document.querySelector('soma-datepicker')
      if (!dp) return false
      try {
        const startISO = dateFrom + 'T03:00:00.000Z'
        const endISO = dateTo + 'T03:00:00.000Z'
        // Tentar setar propriedade value diretamente
        dp.value = { start: startISO, end: endISO }
        // Disparar eventos de mudanca
        dp.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
        dp.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        try { dp.dispatchEvent(new CustomEvent('soma-change', { bubbles: true, composed: true, detail: { start: startISO, end: endISO } })) } catch {}
        try { dp.dispatchEvent(new CustomEvent('soma-datepicker-change', { bubbles: true, composed: true, detail: { start: startISO, end: endISO } })) } catch {}
        // Tentar tambem setar o atributo value como string
        try { dp.setAttribute('value', `${dateFrom} - ${dateTo}`) } catch {}
        // Setar o input interno se acessivel
        function deepFind(root, selector) {
          const results = []
          try { results.push(...root.querySelectorAll(selector)) } catch {}
          const allEls = root.querySelectorAll('*')
          for (const el of allEls) {
            if (el.shadowRoot) {
              try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
            }
          }
          return results
        }
        const inputs = deepFind(dp, 'input')
        const fmtBR = (iso) => {
          const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/)
          return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
        }
        const rangeText = `${fmtBR(dateFrom)} - ${fmtBR(dateTo)}`
        for (const inp of inputs) {
          try {
            const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            if (nativeSet) nativeSet.call(inp, rangeText)
            else inp.value = rangeText
            inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
            inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
          } catch {}
        }
        return true
      } catch { return false }
    }, { dateFrom, dateTo }).catch(() => false)

    if (directValueOk) {
      appendJobLog(job, 'date_filter', 'Valor do datepicker definido programaticamente. Aguardando resposta...')
      await Promise.race([
        waitForOrdersResponse(page, 4000),
        delay(2000),
      ])
      return true
    }
    appendJobLog(job, 'date_filter', 'Fallback programatico tambem falhou')
    return false
  }

  // ====== PASSO 6: Navegar meses e clicar nos dias ======
  // Busca profunda que penetra shadow DOM para encontrar header do mes,
  // botoes de navegacao, e celulas de dias

  const clickDayInCalendar = async (targetDate, label) => {
    const maxNavigation = 24

    for (let nav = 0; nav < maxNavigation; nav++) {
      // Detectar mes/ano exibido (busca profunda com Shadow DOM)
      const calState = await page.evaluate((payload = {}) => {
        const targetYear = Number(payload?.targetYear || 0)
        const targetMonthName = String(payload?.targetMonthName || '')
        function deepFind(root, selector) {
          const results = []
          try { results.push(...root.querySelectorAll(selector)) } catch {}
          const allEls = root.querySelectorAll('*')
          for (const el of allEls) {
            if (el.shadowRoot) {
              results.push(...deepFind(el.shadowRoot, selector))
            }
          }
          return results
        }
        const fullMonthRe = /(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+(\d{4})/i
        const isVis = (el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const countVisibleDays = (root) => {
          const nodes = deepFind(root, 'button, td, [role="gridcell"], [role="button"], span, div')
          const days = new Set()
          for (const node of nodes) {
            if (!isVis(node)) continue
            const text = (node.textContent || '').trim()
            if (!/^\d{1,2}$/.test(text)) continue
            const n = Number(text)
            if (n >= 1 && n <= 31) days.add(n)
          }
          return days.size
        }

        const roots = deepFind(document, 'soma-datepicker, [role="dialog"], [class*="calendar" i], [class*="datepicker" i], [class*="popover" i], [class*="overlay" i], body')
        let bestRoot = null
        let bestScore = -1
        for (const root of roots) {
          if (!isVis(root)) continue
          const text = (root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 3200)
          const monthMatch = text.match(fullMonthRe)
          const dayCount = countVisibleDays(root)
          const score = dayCount + (monthMatch ? 30 : 0)
          if (score > bestScore) {
            bestScore = score
            bestRoot = root
          }
        }
        if (!bestRoot) return null

        // Preferir heading curto dentro do proprio calendario.
        const headingNodes = deepFind(bestRoot, 'h1, h2, h3, [role="heading"], div, span')
        for (const node of headingNodes) {
          if (!isVis(node)) continue
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
          if (!text || text.length > 80) continue
          const m = text.match(fullMonthRe)
          if (!m) continue
          return {
            monthName: m[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
            year: Number(m[2]),
            text,
            dayCount: countVisibleDays(bestRoot),
          }
        }

        const fallbackText = (bestRoot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600)
        const fallback = fallbackText.match(fullMonthRe)
        if (fallback) {
          return {
            monthName: fallback[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
            year: Number(fallback[2]),
            text: `${fallback[1]} ${fallback[2]}`,
            dayCount: countVisibleDays(bestRoot),
          }
        }

        const dayCount = countVisibleDays(bestRoot)
        // Alguns temas SOMA nao exibem heading textual de mes/ano.
        // Se a grade de dias esta visivel, assume o mes/ano alvo do filtro.
        if (dayCount >= 15 && targetYear && targetMonthName) {
          return {
            monthName: targetMonthName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
            year: targetYear,
            text: `mes inferido ${targetMonthName} ${targetYear}`,
            dayCount,
            inferred: true,
          }
        }
        return null
      }, {
        targetYear: targetDate.year,
        targetMonthName: MONTH_NAMES_PT[targetDate.month - 1] || '',
      }).catch(() => null)

      if (!calState) {
        if (nav === 0) appendJobLog(job, 'date_filter', `Header mes/ano nao encontrado na busca profunda (${label})`)
        // O calendario pode fechar apos clicar uma data; tentar reabrir para seguir com o 2o clique.
        if (nav === 0 || nav % 3 === 2) {
          await dpEl.click({ timeout: 1200 }).catch(() => null)
          await delay(120)
        }
        await delay(400)
        continue
      }

      const fullNames = MONTH_NAMES_PT.map(m => m.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
      const displayedMonth = fullNames.indexOf(calState.monthName) + 1
      const displayedYear = calState.year

      if (displayedMonth === 0) {
        appendJobLog(job, 'date_filter', `Mes "${calState.monthName}" nao reconhecido`)
        return false
      }

      appendJobLog(job, 'date_filter', `Calendario mostra: ${calState.text} (mes=${displayedMonth}, ano=${displayedYear}) target=${targetDate.month}/${targetDate.year}`)

      // Se ja estamos no mes/ano correto => clicar no dia
      if (displayedMonth === targetDate.month && displayedYear === targetDate.year) {
        const clicked = await page.evaluate((payload) => {
          const dayNum = Number(payload?.dayNum || 0)
          const monthName = String(payload?.monthName || '')
          const year = Number(payload?.year || 0)
          function deepFind(root, selector) {
            const results = []
            try { results.push(...root.querySelectorAll(selector)) } catch {}
            const allEls = root.querySelectorAll('*')
            for (const el of allEls) {
              if (el.shadowRoot) {
                results.push(...deepFind(el.shadowRoot, selector))
              }
            }
            return results
          }
          const normalize = (v) => String(v || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
          const isVis = (el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }
          const targetMonth = normalize(monthName)
          const fullMonthRe = /(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+(\d{4})/i
          const countVisibleDays = (root) => {
            const nodes = deepFind(root, 'button, td, [role="gridcell"], [role="button"], span, div')
            const days = new Set()
            for (const node of nodes) {
              if (!isVis(node)) continue
              const text = (node.textContent || '').trim()
              if (!/^\d{1,2}$/.test(text)) continue
              const n = Number(text)
              if (n >= 1 && n <= 31) days.add(n)
            }
            return days.size
          }
          const pickCalendarRoot = () => {
            const roots = deepFind(document, 'soma-datepicker, [role="dialog"], [class*="calendar" i], [class*="datepicker" i], [class*="popover" i], [class*="overlay" i], body')
            let bestRoot = null
            let bestScore = -1
            for (const root of roots) {
              if (!isVis(root)) continue
              const text = normalize(root.textContent || '').slice(0, 3000)
              const dayCount = countVisibleDays(root)
              const monthHit = fullMonthRe.test(text)
              const score = dayCount + (monthHit ? 30 : 0)
              if (score > bestScore) {
                bestScore = score
                bestRoot = root
              }
            }
            return bestRoot || document
          }
          const calendarRoot = pickCalendarRoot()
          // Buscar celulas de dia APENAS dentro do calendario detectado.
          const candidates = deepFind(calendarRoot, 'button, td, [role="gridcell"], [role="button"], span, div')
          const matches = []
          for (const cell of candidates) {
            if (!isVis(cell)) continue
            const textRaw = (cell.textContent || '').trim()
            const ariaRaw = (cell.getAttribute('aria-label') || cell.getAttribute('title') || '').trim()
            const textDay = Number((textRaw.match(/\b(\d{1,2})\b/) || [])[1] || 0)
            const ariaDay = Number((ariaRaw.match(/\b(\d{1,2})\b/) || [])[1] || 0)
            if (textDay !== dayNum && ariaDay !== dayNum) continue

            const cl = normalize(cell.className || '')
            if (cell.getAttribute('aria-disabled') === 'true') continue
            if (cell.getAttribute('disabled') != null) continue
            if (/disabled|is-disabled|inactive|unavailable/.test(cl)) continue

            const parentText = normalize((cell.closest('table, [role="grid"], [class*="calendar" i], [class*="datepicker" i]')?.textContent || '').slice(0, 2000))
            let score = 0
            if (textDay === dayNum && textRaw.length <= 4) score += 4
            if (ariaDay === dayNum) score += 3
            const ariaNorm = normalize(ariaRaw)
            if (targetMonth && ariaNorm.includes(targetMonth)) score += 4
            if (year && ariaNorm.includes(String(year))) score += 2
            if (targetMonth && parentText.includes(targetMonth)) score += 2
            if (/outside|other-month|adjacent/.test(cl)) score -= 3

            const clickable = cell.closest('button, [role="button"], [role="gridcell"], td') || cell
            matches.push({ clickable, score, tag: clickable.tagName || cell.tagName })
          }
          if (!matches.length) return { clicked: false, found: 0 }
          matches.sort((a, b) => b.score - a.score)
          const best = matches[0].clickable
          best.scrollIntoView({ behavior: 'instant', block: 'center' })
          best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
          best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }))
          best.click()
          best.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
          return { clicked: true, found: matches.length, tag: matches[0].tag, score: matches[0].score }
        }, {
          dayNum: targetDate.day,
          monthName: MONTH_NAMES_PT[targetDate.month - 1] || '',
          year: targetDate.year,
        }).catch(() => ({ clicked: false, found: 0 }))

        if (clicked.clicked) {
          appendJobLog(job, 'date_filter', `Dia ${targetDate.day} clicado com sucesso (${label}), tag=${clicked.tag}, matches=${clicked.found}, score=${clicked.score ?? 0}`)
          return true
        }
        appendJobLog(job, 'date_filter', `Dia ${targetDate.day} NAO encontrado no calendario (${label})`)
        return false
      }

      // Navegar para o mes correto
      const targetIdx = targetDate.year * 12 + targetDate.month
      const currentIdx = displayedYear * 12 + displayedMonth
      const goBack = targetIdx < currentIdx

      const navOk = await page.evaluate((goBack) => {
        function deepFind(root, selector) {
          const results = []
          try { results.push(...root.querySelectorAll(selector)) } catch {}
          const allEls = root.querySelectorAll('*')
          for (const el of allEls) {
            if (el.shadowRoot) {
              results.push(...deepFind(el.shadowRoot, selector))
            }
          }
          return results
        }
        const isVis = (el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const normalize = (value) => String(value || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        const fullMonthRe = /(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+(\d{4})/i
        const countVisibleDays = (root) => {
          const nodes = deepFind(root, 'button, td, [role="gridcell"], [role="button"], span, div')
          const days = new Set()
          for (const node of nodes) {
            if (!isVis(node)) continue
            const text = (node.textContent || '').trim()
            if (!/^\d{1,2}$/.test(text)) continue
            const n = Number(text)
            if (n >= 1 && n <= 31) days.add(n)
          }
          return days.size
        }
        const roots = deepFind(document, 'soma-datepicker, [role="dialog"], [class*="calendar" i], [class*="datepicker" i], [class*="popover" i], [class*="overlay" i], body')
        let calendarRoot = document
        let bestScore = -1
        for (const root of roots) {
          if (!isVis(root)) continue
          const txt = normalize(root.textContent || '').slice(0, 3000)
          const dayCount = countVisibleDays(root)
          const score = dayCount + (fullMonthRe.test(txt) ? 30 : 0)
          if (score > bestScore) {
            bestScore = score
            calendarRoot = root
          }
        }
        // Buscar botoes de navegacao dentro do calendario detectado.
        const allBtns = deepFind(calendarRoot, 'button, a, [role="button"]')
        for (const btn of allBtns) {
          if (!isVis(btn)) continue
          const text = (btn.textContent || '').trim()
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase()
          const title = (btn.getAttribute('title') || '').toLowerCase()
          if (goBack) {
            if (/^[<‹◀←«]$/.test(text) || /anterior|prev|voltar|back/i.test(ariaLabel + ' ' + title)) {
              btn.click()
              return true
            }
          } else {
            if (/^[>›▶→»]$/.test(text) || /pr[oó]xim|next|avan[cç]/i.test(ariaLabel + ' ' + title)) {
              btn.click()
              return true
            }
          }
        }
        return false
      }, goBack).catch(() => false)

      if (!navOk) {
        appendJobLog(job, 'date_filter', `Botao de navegacao ${goBack ? 'anterior' : 'proximo'} nao encontrado`)
        return false
      }
      await delay(100)
    }
    return false
  }

  // Clicar na data INICIAL
  const startOk = await clickDayInCalendar(startDate, 'data_inicial')
  if (!startOk) {
    appendJobLog(job, 'date_filter', 'Falha ao clicar na data inicial')
    return false
  }
  await delay(150)

  // Clicar na data FINAL (sempre, mesmo se for o mesmo dia — confirma o range)
  const endOk = await clickDayInCalendar(endDate, 'data_final')
  if (!endOk) {
    appendJobLog(job, 'date_filter', 'Falha ao clicar na data final')
    return false
  }
  await delay(150)

  // ====== PASSO 7: Confirmar se existe botao de aplicar (busca profunda) ======
  const confirmed = await page.evaluate(() => {
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          results.push(...deepFind(el.shadowRoot, selector))
        }
      }
      return results
    }
    const isVis = (el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const allBtns = deepFind(document, 'button, a, [role="button"]')
    for (const btn of allBtns) {
      if (!isVis(btn)) continue
      const text = (btn.textContent || '').trim().toLowerCase()
      if (/^(aplicar|ok|confirmar|done|apply|salvar)$/.test(text)) {
        btn.click()
        return text
      }
    }
    return null
  }).catch(() => null)

  appendJobLog(job, 'date_filter', 'Filtro de data aplicado com sucesso!', {
    dateFrom, dateTo, confirmed: confirmed || 'autoaplicado (sem botao)',
  })

  // ====== PASSO 8: Aguardar tabela recarregar ======
  await Promise.race([
    waitForOrdersResponse(page, 3000),
    delay(1000),
  ])
  return true
}

const tryApplyDateFilters = async (job, page, filters) => {
  // O HubXP usa calendar date range picker, tentar primeiro
  appendJobLog(job, 'date_filter', 'Iniciando aplicacao do filtro de data')
  const calendarOk = await tryApplyCalendarDatePicker(job, page, filters)
  if (calendarOk) return true

  appendJobLog(job, 'date_filter', 'Calendario nao funcionou, tentando inputs padrao...')

  const dateFrom = normalizeDateInput(filters?.dateFrom || resolveToday())
  const dateTo = normalizeDateInput(filters?.dateTo || dateFrom)
  const toDateBR = (isoLike) => {
    const match = String(isoLike || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!match) return isoLike
    const [, year, month, day] = match
    return `${day}/${month}/${year}`
  }
  const dateFromBR = toDateBR(dateFrom)
  const dateToBR = toDateBR(dateTo)
  const fillSmart = async (locator, value) => {
    if (!locator) return false
    try {
      await locator.fill(String(value))
      return true
    } catch {
      return false
    }
  }

  // Tentar input[type="date"]
  const dateInputs = page.locator('input[type="date"]')
  const totalDateInputs = await dateInputs.count().catch(() => 0)
  if (totalDateInputs >= 1) {
    await fillSmart(dateInputs.nth(0), dateFrom)
    if (totalDateInputs >= 2) await fillSmart(dateInputs.nth(1), dateTo)
    return true
  }

  appendJobLog(job, 'date_filter', 'Nenhum metodo de filtro de data funcionou')
  return false
}

const toDateBR = (isoLike) => {
  const match = String(isoLike || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return String(isoLike || '')
  const [, year, month, day] = match
  return `${day}/${month}/${year}`
}

const readDisplayedDateRange = async (page) => {
  return page.evaluate(() => {
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }

    const pickers = deepFind(document, 'soma-datepicker, [class*="datepicker" i], input[type="date"]')
    for (const p of pickers) {
      const val = p.value
      if (val) return JSON.stringify(val).slice(0, 200)
      const texts = deepFind(p.shadowRoot || p, 'input, span, div')
      for (const t of texts) {
        const txt = (t.value || t.textContent || '').trim()
        if (/\d{2}\/\d{2}\/\d{4}/.test(txt)) return txt
      }
    }

    const body = document.body.innerText || ''
    const rangeMatch = body.match(/(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{4})/)
    if (rangeMatch) return rangeMatch[0]
    return null
  }).catch(() => null)
}

const verifyExpectedDateRange = async (job, page, filters = {}, stage = 'date_verify') => {
  const expectedFrom = normalizeDateInput(filters?.dateFrom || resolveToday())
  const expectedTo = normalizeDateInput(filters?.dateTo || expectedFrom)
  const expectedFromBR = toDateBR(expectedFrom)
  const expectedToBR = toDateBR(expectedTo)
  // ISO format (YYYY-MM-DD) for when soma-datepicker returns ISO date objects
  const expectedFromISO = expectedFrom.slice(0, 10)
  const expectedToISO = expectedTo.slice(0, 10)

  const displayedDate = await readDisplayedDateRange(page)
  const correct = Boolean(displayedDate && (
    displayedDate.includes(expectedFromBR) || displayedDate.includes(expectedToBR) ||
    displayedDate.includes(expectedFromISO) || displayedDate.includes(expectedToISO)
  ))

  appendJobLog(job, 'date_verify', `Verificacao da data (${stage})`, {
    expected: `${expectedFromBR} - ${expectedToBR}`,
    displayed: displayedDate,
    correct,
  })

  return correct
}

const tryApplyTextFilter = async (page, selectors, value) => {
  const normalized = scrubText(value)
  if (!normalized) return false
  const target = await pickVisibleLocator(page, selectors)
  if (!target) return false
  await target.locator.fill(normalized).catch(() => null)
  return true
}

const clickCentralOrdersFilterButton = async (page, options = {}) => {
  const variant = Number.isFinite(Number(options.variant))
    ? Math.max(0, Number(options.variant))
    : 0

  const baseCandidates = [
    page.locator('soma-button[aria-label*="filtrar" i]').first(),
    page.getByRole('button', { name: /^\s*filtrar\s*$/i }).first(),
    page.locator('button, a, [role="button"]').filter({ hasText: /^\s*Filtrar\s*$/i }).first(),
  ]

  const rotateBy = baseCandidates.length ? (variant % baseCandidates.length) : 0
  const candidates = baseCandidates.slice(rotateBy).concat(baseCandidates.slice(0, rotateBy))

  for (const locator of candidates) {
    try {
      if (await locator.count() === 0) continue
      if (!(await isVisible(locator))) continue
      await locator.click({ timeout: 2200 })
      return true
    } catch {
      // tentar proximo candidato
    }
  }

  const clickedDeep = await page.evaluate((tryIndex) => {
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()

    const nodes = deepFind(document, 'button, a, [role="button"], soma-button, span, div')
    const filtered = []
    for (const node of nodes) {
      if (!isVis(node)) continue
      const text = normalize(node.textContent || '')
      if (!text) continue
      if (/limpar/.test(text)) continue
      if (!/^filtrar$/.test(text) && !/\bfiltrar\b/.test(text)) continue
      filtered.push(node.closest('button, a, [role="button"], soma-button') || node)
    }
    const unique = [...new Set(filtered)]
    if (!unique.length) return false
    const idx = Math.max(0, Number(tryIndex || 0)) % unique.length
    const target = unique[idx]
    if (!target) return false
    target.click()
    return true
  }, variant).catch(() => false)
  if (clickedDeep) return true

  return clickByTexts(page, ['Filtrar', 'Buscar', 'Atualizar'])
}

const runCentralOrdersInitialFilter = async (job, page) => {
  appendJobLog(job, 'prefilter', 'Central de Ordens aberta. Executando filtro inicial antes de coletar.', {
    url: getPageUrl(page),
  })

  const prefilterUi = await waitForCentralOrdersFilterUi(page, 12000)
  appendJobLog(job, 'prefilter', prefilterUi.ready
    ? 'UI de filtros detectada para pre-filtro inicial.'
    : 'UI de filtros ainda parcial; tentando pre-filtro mesmo assim.', {
    hasDatepicker: Boolean(prefilterUi?.hasDatepicker),
    hasFilterButton: Boolean(prefilterUi?.hasFilterButton),
    hasFilterInputs: Boolean(prefilterUi?.hasFilterInputs),
  })

  const signatureBefore = await getNotasTableSignature(page)
  const responseWatch = waitForOrdersResponse(page, 4200)
  let clicked = false
  let clickAttemptUsed = 0
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    clicked = await clickCentralOrdersFilterButton(page, { variant: attempt - 1 })
    if (clicked) {
      clickAttemptUsed = attempt
      break
    }
    await delay(220)
  }
  if (!clicked) {
    appendJobLog(job, 'prefilter', 'Botao Filtrar inicial nao encontrado; seguindo fluxo padrao.', {
      hasDatepicker: Boolean(prefilterUi?.hasDatepicker),
      hasFilterInputs: Boolean(prefilterUi?.hasFilterInputs),
    })
    return false
  }

  await Promise.race([
    responseWatch,
    page.waitForSelector('table tbody tr, [role="row"]', { timeout: 4200 }).catch(() => null),
    delay(1100),
  ])

  const signatureAfter = await getNotasTableSignature(page)
  appendJobLog(job, 'prefilter', 'Filtro inicial executado com sucesso.', {
    clickAttempt: clickAttemptUsed || 1,
    tableChanged: Boolean(signatureBefore && signatureAfter && signatureBefore !== signatureAfter),
  })
  return true
}

const applyFilters = async (job, page, filters = {}) => {
  appendJobLog(job, 'apply_filters', 'Aplicando filtros', { url: getPageUrl(page) })

  const applied = {}

  // Aguardar o soma-datepicker carregar no DOM antes de tentar filtrar data
  await page.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        function deepFind(root, selector) {
          const results = []
          try { results.push(...root.querySelectorAll(selector)) } catch {}
          const allEls = root.querySelectorAll('*')
          for (const el of allEls) {
            if (el.shadowRoot) {
              try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
            }
          }
          return results
        }
        const pickers = deepFind(document, 'soma-datepicker, [class*="datepicker" i], input[type="date"]')
        if (pickers.length > 0) return resolve(true)
        return false
      }
      if (check()) return
      let attempts = 0
      const interval = setInterval(() => {
        attempts++
        if (check() || attempts > 20) {
          clearInterval(interval)
          resolve(attempts <= 20)
        }
      }, 500)
    })
  }).catch(() => null)

  const hasDate = await tryApplyDateFilters(job, page, filters)
  applied.date = hasDate

  // Verificar se a data exibida no filtro confere com a data solicitada
  if (hasDate && (filters?.dateFrom || filters?.dateTo)) {
    const expectedFrom = normalizeDateInput(filters?.dateFrom || resolveToday())
    const expectedTo = normalizeDateInput(filters?.dateTo || expectedFrom)
    const toDateBR = (isoLike) => {
      const match = String(isoLike || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (!match) return isoLike
      const [, year, month, day] = match
      return `${day}/${month}/${year}`
    }
    const expectedFromBR = toDateBR(expectedFrom)
    const expectedToBR = toDateBR(expectedTo)

    // Ler a data atualmente exibida no filtro
    const displayedDate = await page.evaluate(() => {
      function deepFind(root, selector) {
        const results = []
        try { results.push(...root.querySelectorAll(selector)) } catch {}
        const allEls = root.querySelectorAll('*')
        for (const el of allEls) {
          if (el.shadowRoot) {
            try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return results
      }
      // Buscar texto do datepicker que mostra o range
      const pickers = deepFind(document, 'soma-datepicker, [class*="datepicker" i]')
      for (const p of pickers) {
        // Valor do componente
        const val = p.value
        if (val) return JSON.stringify(val).slice(0, 200)
        // Texto visivel
        const texts = deepFind(p.shadowRoot || p, 'input, span, div')
        for (const t of texts) {
          const txt = (t.value || t.textContent || '').trim()
          if (/\d{2}\/\d{2}\/\d{4}/.test(txt)) return txt
        }
      }
      // Fallback: buscar texto no body com formato de data range
      const body = document.body.innerText || ''
      const match = body.match(/(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{4})/)
      if (match) return match[0]
      return null
    }).catch(() => null)

    // Also check ISO format (YYYY-MM-DD) since soma-datepicker .value may return ISO date objects
    const expectedFromISO = expectedFrom.slice(0, 10)
    const expectedToISO = expectedTo.slice(0, 10)
    const dateCorrect = displayedDate && (
      displayedDate.includes(expectedFromBR) || displayedDate.includes(expectedToBR) ||
      displayedDate.includes(expectedFromISO) || displayedDate.includes(expectedToISO)
    )

    appendJobLog(job, 'date_verify', 'Verificacao da data aplicada', {
      expected: `${expectedFromBR} - ${expectedToBR}`,
      displayed: displayedDate,
      correct: dateCorrect,
    })

    // Se a data nao conferir, tentar aplicar novamente
    if (!dateCorrect) {
      appendJobLog(job, 'date_verify', 'Data incorreta! Tentando aplicar filtro novamente...')
      await delay(1000)
      const retryDate = await tryApplyDateFilters(job, page, filters)
      if (retryDate) {
        await delay(1500)
        appendJobLog(job, 'date_verify', 'Filtro de data reaplicado')
      }
    }
  }

  applied.status = await tryApplyTextFilter(page, [
    'input[name*="status" i]',
    'input[aria-label*="status" i]',
    'input[placeholder*="status" i]',
  ], filters.status)

  applied.client = await tryApplyTextFilter(page, [
    'input[name*="cliente" i]',
    'input[name*="conta" i]',
    'input[aria-label*="cliente" i]',
    'input[placeholder*="cliente" i]',
  ], filters.client)

  applied.account = await tryApplyTextFilter(page, [
    'input[name*="conta" i]',
    'input[aria-label*="conta" i]',
    'input[placeholder*="conta" i]',
  ], filters.account)

  applied.assessor = await tryApplyTextFilter(page, [
    'input[name*="assessor" i]',
    'input[aria-label*="assessor" i]',
    'input[placeholder*="assessor" i]',
  ], filters.assessor)

  const clickedFilter = await clickCentralOrdersFilterButton(page, { variant: 1 })
  if (!clickedFilter) {
    await clickByTexts(page, ['Filtrar', 'Buscar', 'Pesquisar', 'Atualizar'])
  }
  // Esperar resposta ou tabela — o que vier primeiro
  await Promise.race([
    waitForOrdersResponse(page, 2500),
    page.waitForSelector('table tbody tr, [role="row"]', { timeout: 3000 }).catch(() => null),
  ])

  appendJobLog(job, 'filters', 'Filtros aplicados', applied)
}

const fetchFromOfficialApi = async (job, payload = {}, filters = {}) => {
  const apiUrl = scrubText(payload.officialApiUrl || process.env.HUBXP_ORDERS_API_URL || '')
  if (!apiUrl) return null

  const timeoutMs = Number.isFinite(Number(payload.apiTimeoutMs))
    ? Math.max(5000, Math.min(120000, Number(payload.apiTimeoutMs)))
    : 25000

  appendJobLog(job, 'api', 'Coleta via API oficial iniciada', { apiUrl })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const token = scrubText(payload.apiToken || process.env.HUBXP_ORDERS_API_TOKEN || '')
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ filters }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const details = await response.text().catch(() => '')
      throw createHttpError(
        response.status,
        'OFFICIAL_API_FAILED',
        `API oficial retornou status ${response.status}.`,
        details.slice(0, 280),
        'collecting',
      )
    }

    const payloadJson = await response.json().catch(() => null)
    const rows = Array.isArray(payloadJson?.rows)
      ? payloadJson.rows
      : Array.isArray(payloadJson?.data)
        ? payloadJson.data
        : Array.isArray(payloadJson)
          ? payloadJson
          : []

    const columns = Array.isArray(payloadJson?.columns) && payloadJson.columns.length
      ? payloadJson.columns.map((value) => scrubText(value)).filter(Boolean)
      : rows[0]
        ? Object.keys(rows[0])
        : []

    const normalizedRows = rows.map((row, index) => ({
      id: row?.id || `row-${index + 1}`,
      ...(row && typeof row === 'object' ? row : {}),
    }))

    appendJobLog(job, 'api', 'Coleta via API oficial concluida', {
      rows: normalizedRows.length,
      columns: columns.length,
    })

    return {
      status: STATUS.SUCCESS,
      columns,
      rows: normalizedRows,
      totalRows: normalizedRows.length,
      pagesScanned: 1,
      collectedAt: now(),
      source: 'official_api',
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createHttpError(504, 'OFFICIAL_API_TIMEOUT', 'Tempo limite excedido ao consultar API oficial.', null, 'collecting')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const DEFAULT_CENTRAL_ORDENS_URL = 'https://hub.xpi.com.br/new/produtos-estruturados#/central-de-ordens'

const ensureCentralOrdersView = async (job, page, centralOrdersUrl) => {
  const targetUrl = centralOrdersUrl || process.env.HUBXP_CENTRAL_ORDERS_URL || DEFAULT_CENTRAL_ORDENS_URL

  // Helper: detecta se a pagina Central de Ordens esta visivel
  const detectCentralOrdens = async () => {
    // 1) Verificar URL hash — mais confiavel que texto do body
    const currentUrl = String(page.url() || '').toLowerCase()
    if (currentUrl.includes('central-de-ordens') || currentUrl.includes('central_de_ordens')) {
      appendJobLog(job, 'navigate_orders', 'Central de Ordens detectada via URL hash.', { url: currentUrl })
      return true
    }
    // 2) Verificar tabela (pode estar vazia ou com dados)
    if (await pickTableLocator(page)) return true
    // 3) Verificar elementos do body que confirmam a pagina
    try {
      const body = scrubText(await page.locator('body').innerText())
      if (/central de ordens|central ordens/i.test(body)) return true
      // O HubXP mostra estes elementos somente na Central de Ordens
      if (/tipo de opera[çc][oõ]es/i.test(body) && /c[oó]digo do cliente/i.test(body)) return true
      if (/linhas visualizadas/i.test(body)) return true
      if (/n[aã]o foi poss[ií]vel obter os tickets/i.test(body)) return true
    } catch {
      // noop
    }
    return false
  }

  // Helper: espera a pagina carregar (tabela ou networkidle)
  const waitForPage = async (timeoutMs = 15000) => {
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => null),
      page.waitForSelector('table, [role="grid"], [role="table"], .ag-root-wrapper, [role="row"]', { timeout: timeoutMs }).catch(() => null),
    ])
  }

  // Se ja estamos na Central de Ordens (ou em qualquer rota do mesmo SPA produtos-estruturados),
  // forcar reload para resetar estado do datepicker e garantir dados frescos.
  // Sem isso, o goto() para a mesma base URL faz apenas mudanca de hash (sem reload real),
  // e o datepicker/filtros ficam com estado sujo da coleta anterior.
  const currentUrl = String(page.url() || '').toLowerCase()
  const alreadyOnPage = currentUrl.includes('central-de-ordens') || currentUrl.includes('central_de_ordens') || currentUrl.includes('produtos-estruturados')
  if (alreadyOnPage) {
    appendJobLog(job, 'navigate_orders', 'Ja estamos no SPA de Produtos Estruturados. Recarregando pagina (F5) para resetar estado...', { url: currentUrl })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null)
    await delay(3000)
    // Aguardar tabela e filtros carregarem apos reload
    await page.waitForSelector('table, [role="grid"], [role="table"], .ag-root-wrapper, [role="row"], soma-datepicker', { timeout: 12000 }).catch(() => null)
    await delay(1000)
    if (await detectCentralOrdens()) {
      appendJobLog(job, 'navigate_orders', 'Central de Ordens recarregada com sucesso', { url: getPageUrl(page) })
      return true
    }
    appendJobLog(job, 'navigate_orders', 'Reload nao resolveu, tentando navegacao completa...')
  }

  const MAX_ATTEMPTS = 4
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    appendJobLog(job, 'navigate_orders', `Navegando para Central de Ordens (tentativa ${attempt}/${MAX_ATTEMPTS})`, { url: targetUrl })

    try {
      if (attempt <= 2) {
        // Tentativas 1-2: goto direto
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      } else {
        // Tentativas 3-4: primeiro volta para base do site, depois navega
        const baseUrl = 'https://hub.xpi.com.br/new/produtos-estruturados'
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
        await delay(2000)
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      }
    } catch (navError) {
      appendJobLog(job, 'navigate_orders', `Erro de navegacao na tentativa ${attempt}`, { error: scrubText(navError?.message) })
      if (attempt === MAX_ATTEMPTS) break
      await delay(3000)
      continue
    }

    // Esperar carregamento inicial
    await waitForPage(15000)
    // Aguardar SPA hash-routing processar (pagina usa #/central-de-ordens)
    await delay(3000)
    await debugShot(job, page, `07_navigate_attempt_${attempt}`)

    if (await detectCentralOrdens()) {
      appendJobLog(job, 'navigate_orders', 'Central de Ordens carregada com sucesso', { url: getPageUrl(page), attempt })
      return true
    }

    // Espera extra: pagina pode estar carregando lazy components
    appendJobLog(job, 'navigate_orders', `Tabela nao detectada na tentativa ${attempt}, aguardando mais...`)
    await page.waitForSelector('table, [role="grid"], [role="table"], .ag-root-wrapper, [role="row"]', { timeout: 12000 }).catch(() => null)
    await delay(2000)

    if (await detectCentralOrdens()) {
      appendJobLog(job, 'navigate_orders', 'Central de Ordens carregada com sucesso (apos espera extra)', { url: getPageUrl(page), attempt })
      return true
    }

    if (attempt < MAX_ATTEMPTS) {
      appendJobLog(job, 'navigate_orders', `Tentativa ${attempt} falhou, tentando novamente...`)
      await delay(2000)
    }
  }

  await debugShot(job, page, '07_navigate_failed_all')
  throw createHttpError(
    502,
    'CENTRAL_ORDERS_NOT_FOUND',
    'Nao foi possivel chegar na tela Central de Ordens apos autenticar.',
    { url: getPageUrl(page) },
    'navigate_orders',
  )
}

const diagnoseDom = async (job, page) => {
  try {
    const info = await page.evaluate(() => {
      const tables = document.querySelectorAll('table')
      const roleTables = document.querySelectorAll('[role="table"]')
      const agGrids = document.querySelectorAll('.ag-root-wrapper')
      const allDivTables = document.querySelectorAll('div[class*="table" i], div[class*="grid" i], div[class*="datagrid" i]')
      const trs = document.querySelectorAll('tr')
      const tds = document.querySelectorAll('td')
      const roleRows = document.querySelectorAll('[role="row"]')
      const roleCells = document.querySelectorAll('[role="gridcell"], [role="cell"]')
      const roleGrids = document.querySelectorAll('[role="grid"], [role="treegrid"]')

      const sample = (nodeList, max = 3) => {
        const out = []
        for (let i = 0; i < Math.min(nodeList.length, max); i++) {
          const el = nodeList[i]
          out.push({
            tag: el.tagName.toLowerCase(),
            classes: el.className?.toString?.()?.slice(0, 120) || '',
            role: el.getAttribute('role') || '',
            childCount: el.children.length,
            textSnippet: (el.innerText || '').slice(0, 80),
          })
        }
        return out
      }

      return {
        url: location.href,
        tables: tables.length,
        roleTables: roleTables.length,
        agGrids: agGrids.length,
        divTables: allDivTables.length,
        trs: trs.length,
        tds: tds.length,
        roleRows: roleRows.length,
        roleCells: roleCells.length,
        roleGrids: roleGrids.length,
        sampleTables: sample(tables),
        sampleRoleTables: sample(roleTables),
        sampleAgGrids: sample(agGrids),
        sampleDivTables: sample(allDivTables, 5),
        sampleRoleGrids: sample(roleGrids),
        sampleRoleRows: sample(roleRows, 5),
      }
    })
    appendJobLog(job, 'dom_diag', 'Diagnostico DOM da pagina', info)
    return info
  } catch (e) {
    appendJobLog(job, 'dom_diag', 'Falha no diagnostico DOM', { error: e.message })
    return null
  }
}

const collectRowsFromTable = async (job, page, options = {}) => {
  const maxPages = Number.isFinite(Number(options.maxPages))
    ? Math.max(1, Math.min(400, Number(options.maxPages)))
    : 200

  // Diagnostico apenas em modo debug
  if (DEBUG_HUBXP) {
    await diagnoseDom(job, page)
    await debugShot(job, page, '08_before_collect_table')
  }

  const allRows = []
  const dedupe = new Set()
  let headers = []
  let pageNumber = 1
  let totalPages = null

  // Funcao de hash rapida para deduplicacao (evita JSON.stringify em cada linha)
  const rowHash = (row) => {
    let hash = ''
    const keys = Object.keys(row)
    for (let i = 0; i < keys.length; i += 1) {
      hash += keys[i] + '=' + (row[keys[i]] || '') + '|'
    }
    return hash
  }

  // Garantir que estamos na pagina 1 antes de coletar
  const wentToFirst = await clickFirstPage(page)
  if (wentToFirst) {
    appendJobLog(job, 'paginate', 'Voltou para a primeira pagina antes de coletar')
    await Promise.race([
      waitForOrdersResponse(page, 3000),
      delay(1500),
    ])
    await delay(500)
  }

  while (pageNumber <= maxPages) {
    let table = await pickTableLocator(page)
    if (!table) {
      appendJobLog(job, 'collect_table', 'Tabela nao encontrada, aguardando selector...')
      await page.waitForSelector('table, [role="grid"], [role="table"], .ag-root-wrapper', { timeout: 5000 }).catch(() => null)
      table = await pickTableLocator(page)
      if (!table) {
        // Verificar se a ausencia de tabela indica estado vazio legitimo (sem registros no periodo)
        const bodyText = await page.evaluate(() => {
          try { return (document.body?.innerText || document.body?.textContent || '').toLowerCase() } catch { return '' }
        }).catch(() => '')
        const isEmptyState = /n[aã]o (foi poss[ií]vel obter|h[aá] registros|existem registros|foram encontrados)|nenhum resultado|sem registros|nenhuma ordem|no orders found|0 registros|0 linhas/.test(bodyText)
        if (isEmptyState) {
          appendJobLog(job, 'collect_table', 'Nenhum registro encontrado para o periodo filtrado (estado vazio detectado).')
          break
        }
        throw createHttpError(502, 'TABLE_NOT_FOUND', 'Tabela da Central de Ordens nao encontrada.', null, 'collect_table')
      }
      appendJobLog(job, 'collect_table', 'Tabela encontrada apos retry')
    }

    const extracted = await extractTableRows(table)
    if (!headers.length && extracted.headers.length) {
      headers = extracted.headers
    }

    extracted.rows.forEach((row) => {
      const key = rowHash(row)
      if (dedupe.has(key)) return
      dedupe.add(key)
      allRows.push(row)
    })

    const indicator = await findPageIndicator(page)
    if (indicator) {
      totalPages = indicator.total
      pageNumber = indicator.current
    }

    setJobStatus(job, STATUS.COLLECTING, 'collecting', `Coletando pagina ${pageNumber}${totalPages ? ` de ${totalPages}` : ''}.`, {
      currentPage: pageNumber,
      totalPages,
      rowsCollected: allRows.length,
    })

    appendJobLog(job, 'paginate', 'Pagina coletada', {
      page: pageNumber,
      totalPages: totalPages || undefined,
      rows: allRows.length,
    })

    // Clicar na proxima pagina diretamente via evaluate (penetra Shadow DOM)
    const clicked = await clickNextPage(page)
    if (!clicked) {
      appendJobLog(job, 'paginate', 'Botao de proxima pagina nao encontrado ou desabilitado — fim da paginacao', {
        page: pageNumber, totalPages, rows: allRows.length,
      })
      break
    }

    // Esperar resposta da API ou tabela atualizar
    await Promise.race([
      waitForOrdersResponse(page, 3000),
      delay(1500),
    ])
    // Aguardar estabilidade da tabela (evitar ler dados antigos)
    await delay(500)

    pageNumber += 1
    if (totalPages && pageNumber > totalPages) break
  }

  const finalizedRows = allRows.map((row, index) => ({
    id: `row-${index + 1}`,
    ...row,
  }))

  return {
    headers,
    rows: finalizedRows,
    pagesScanned: Math.max(1, pageNumber),
  }
}

const ensureJobPage = async (job, options = {}) => {
  if (job.page && job.context && job.browser) {
    const pageClosed = typeof job.page?.isClosed === 'function' ? job.page.isClosed() : false
    const browserConnected = typeof job.browser?.isConnected === 'function'
      ? job.browser.isConnected()
      : true
    if (!pageClosed && browserConnected) return
    appendJobLog(job, 'init_browser', 'Sessao HubXP anterior invalida; recriando navegador.')
    await closeJobResources(job)
  }

  const chromium = await getPlaywright()
  const launchHeadless = toBoolean(options.headless, toBoolean(process.env.HUBXP_HEADLESS, false))
  const savedState = options.storageState || null

  const browser = await chromium.launch({
    headless: launchHeadless,
    channel: process.env.HUBXP_BROWSER_CHANNEL || undefined,
    args: [
      '--disable-dev-shm-usage',
      ...(!launchHeadless ? ['--start-maximized', '--window-size=1440,900', '--window-position=50,50'] : []),
    ],
  })

  const contextOpts = {
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  }
  if (savedState) contextOpts.storageState = savedState

  const context = await browser.newContext(contextOpts)

  const page = await context.newPage()
  page.setDefaultTimeout(12000)

  // Manter a tela de login fiel ao navegador real; bloquear apenas recursos pesados não essenciais.
  await page.route(/\.(woff2?|ttf|eot|otf|mp4|webm|ogg)$/i, (route) => route.abort()).catch(() => null)
  // Bloquear analytics/tracking
  await page.route(/google-analytics|googletagmanager|hotjar|segment|amplitude|mixpanel|facebook.*pixel|doubleclick|datadog|datadoghq|ddsource=browser|ddtags=|\/pub[a-f0-9]{20,}/i, (route) => route.abort()).catch(() => null)

  job.browser = browser
  job.browserHeadless = Boolean(launchHeadless)
  job.context = context
  job.page = page
}

const MANUAL_LOGIN_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutos para o usuario fazer login manual

const readStorageStateFile = async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const state = JSON.parse(raw)
    if (state && Array.isArray(state.cookies)) return state
  } catch {
    // arquivo nao existe ou corrompido
  }
  return null
}

// Salvar storageState no disco para persistir entre reinicializacoes
const saveSessionToDisk = async (state, userKey = 'guest') => {
  const sessionFile = getSessionFileForUser(userKey)
  try {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true })
    await fs.writeFile(sessionFile, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // silencioso
  }
  return sessionFile
}

const loadSessionFromDisk = async (userKey = 'guest') => {
  const { sessionFile, candidates } = resolveUserSessionFileCandidates(userKey)
  const perUserState = await readStorageStateFile(sessionFile)
  if (perUserState) {
    return {
      state: perUserState,
      sessionFile,
      migratedFromLegacy: false,
    }
  }

  const aliasedState = await resolveLegacySessionState(sessionFile, candidates)
  if (aliasedState?.state) {
    return {
      state: aliasedState.state,
      sessionFile,
      migratedFromLegacy: Boolean(aliasedState.migratedFromLegacy),
      sourceSessionFile: aliasedState.sourceFile,
    }
  }

  const legacyState = await readStorageStateFile(LEGACY_SESSION_FILE)
  if (!legacyState) {
    return {
      state: null,
      sessionFile,
      migratedFromLegacy: false,
    }
  }

  let migrated = false
  if (sessionFile !== LEGACY_SESSION_FILE) {
    try {
      await fs.mkdir(path.dirname(sessionFile), { recursive: true })
      await fs.rename(LEGACY_SESSION_FILE, sessionFile)
      migrated = true
    } catch {
      try {
        await fs.mkdir(path.dirname(sessionFile), { recursive: true })
        await fs.writeFile(sessionFile, JSON.stringify(legacyState, null, 2), 'utf-8')
        migrated = true
      } catch {
        // compatibilidade: segue com estado legado mesmo se nao copiar
      }
      if (migrated) {
        await fs.unlink(LEGACY_SESSION_FILE).catch(() => null)
      }
    }
  }

  const migratedState = migrated ? await readStorageStateFile(sessionFile) : null
  return {
    state: migratedState || legacyState,
    sessionFile,
    migratedFromLegacy: migrated,
  }
}

// Salvar sessão atual sem fechar o browser
const saveCurrentSession = async (job) => {
  if (!job.context) return
  try {
    const state = await job.context.storageState()
    job._savedStorageState = state
    const sessionFile = await saveSessionToDisk(state, job.userKey)
    appendJobLog(job, 'save_session', 'Sessao salva no disco', { sessionFile })
  } catch (err) {
    appendJobLog(job, 'save_session', 'Erro ao salvar sessao: ' + (err?.message || err))
  }
}

// switchToHeadless mantido apenas para restore de sessão futura
const switchToHeadless = async (job) => {
  if (job.browserHeadless === true) return true
  if (!job.context || !job.browser) return
  try {
    const state = await job.context.storageState()
    job._savedStorageState = state
    await saveSessionToDisk(state, job.userKey)
    appendJobLog(job, 'switch_headless', 'Salvando sessao e fechando browser visivel...')

    // Fechar browser headed
    await job.page?.close().catch(() => null)
    await job.context?.close().catch(() => null)
    await job.browser?.close().catch(() => null)
    job.page = null
    job.context = null
    job.browser = null
    job.browserHeadless = null

    // Reabrir headless com sessão salva
    const chromium = await getPlaywright()
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.HUBXP_BROWSER_CHANNEL || undefined,
      args: ['--disable-dev-shm-usage'],
    })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 920 },
      ignoreHTTPSErrors: true,
      storageState: state,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)

    job.browser = browser
    job.browserHeadless = true
    job.context = context
    job.page = page
    appendJobLog(job, 'switch_headless', 'Browser headless reaberto com sessao salva')
    return true
  } catch (err) {
    appendJobLog(job, 'switch_headless', 'Erro ao trocar para headless: ' + (err?.message || err))
    return false
  }
}

const switchToVisible = async (job) => {
  if (!job?.browser || !job?.context || !job?.page) return false
  if (job.browserHeadless === false) {
    await ensureBrowserWindowVisible(job.page).catch(() => null)
    return true
  }
  try {
    const state = await job.context.storageState().catch(() => (job._savedStorageState || null))
    if (state) {
      job._savedStorageState = state
      await saveSessionToDisk(state, job.userKey).catch(() => null)
    }
    await closeJobResources(job)
    await ensureJobPage(job, {
      headless: false,
      storageState: state || undefined,
    })
    await ensureBrowserWindowVisible(job.page).catch(() => null)
    appendJobLog(job, 'switch_visible', 'Browser HubXP visivel reaberto com sessao salva.')
    return true
  } catch (err) {
    appendJobLog(job, 'switch_visible', 'Erro ao trocar para browser visivel: ' + (err?.message || err))
    return false
  }
}

const ensureHeadlessExecution = async (job, stage = 'headless') => {
  if (!job?.page || !job?.context || !job?.browser) return
  if (job.browserHeadless === true) {
    // Já headless — verificar se a sessao ainda esta autenticada
    const stillAuth = await isAuthenticated(job.page).catch(() => false)
    if (!stillAuth) {
      appendJobLog(job, stage, 'Sessao headless perdeu autenticacao; tentando restaurar...')
      const entryUrl = process.env.HUBXP_ENTRY_URL || DEFAULT_ENTRY_URL
      await job.page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
      await job.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null)
      const reAuth = await isAuthenticated(job.page).catch(() => false)
      if (!reAuth) {
        throw createHttpError(409, 'SESSION_EXPIRED', 'Sessao HubXP expirou. Faca login novamente.', null, stage)
      }
      appendJobLog(job, stage, 'Sessao headless re-autenticada com sucesso.')
    }
    return
  }
  appendJobLog(job, stage, 'Alternando sessao para modo headless (navegador invisivel)...')
  const switched = await switchToHeadless(job)
  if (switched) {
    appendJobLog(job, stage, 'Sessao em modo headless.')
    // Verificar autenticacao apos trocar para headless
    const entryUrl = process.env.HUBXP_ENTRY_URL || DEFAULT_ENTRY_URL
    await job.page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
    await job.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null)
    const postSwitchAuth = await isAuthenticated(job.page).catch(() => false)
    if (!postSwitchAuth) {
      appendJobLog(job, stage, 'Sessao perdeu autenticacao apos trocar para headless.')
      throw createHttpError(409, 'SESSION_EXPIRED', 'Sessao HubXP expirou ao trocar para headless. Faca login novamente.', null, stage)
    }
    appendJobLog(job, stage, 'Autenticacao confirmada apos trocar para headless.')
    return
  }
  appendJobLog(job, stage, 'Falha ao alternar para headless; mantendo sessao atual.')
}

const ensureVisibleExecution = async (job, stage = 'visible') => {
  if (!job?.page || !job?.context || !job?.browser) return false
  if (job.browserHeadless === true) {
    appendJobLog(job, stage, 'Sessao HubXP estava headless; tentando reabrir browser visivel...')
    const switched = await switchToVisible(job)
    if (!switched) {
      appendJobLog(job, stage, 'Falha ao reabrir browser visivel para sessao HubXP.')
      return false
    }
  }
  await ensureBrowserWindowVisible(job.page).catch(() => null)
  return true
}

const performLogin = async (job, payload = {}) => {
  const keepVisible = toBoolean(payload.keepVisible, false)
  const requestedHeadless = keepVisible
    ? false
    : toBoolean(payload.headless, toBoolean(process.env.HUBXP_HEADLESS, false))
  job._keepVisible = keepVisible

  if (keepVisible && job.page && !job.running && job.browserHeadless === true) {
    appendJobLog(job, 'open_login', 'Sessao HubXP estava headless; preparando browser visivel para login.')
    const switched = await ensureVisibleExecution(job, 'open_login').catch(() => false)
    if (!switched) {
      await closeJobResources(job).catch(() => null)
    }
  }

  // Tentar reaproveitar sessão em memória
  if (job.page && !job.running) {
    const stillAuthenticated = await isAuthenticated(job.page).catch(() => false)
    if (stillAuthenticated) {
      let reusable = true
      if (keepVisible) {
        const visibleReady = await ensureVisibleExecution(job, 'auth').catch(() => false)
        reusable = visibleReady && await isAuthenticated(job.page).catch(() => false)
        if (!reusable) {
          appendJobLog(job, 'auth', 'Sessao reaproveitada perdeu autenticacao ao alternar para modo visivel; continuando fluxo de login.')
          await closeJobResources(job).catch(() => null)
        }
      }
      if (reusable) {
        setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Sessao reaproveitada.')
        appendJobLog(job, 'auth', 'Sessao reaproveitada sem novo login')
        return { status: STATUS.AUTHENTICATED, reused: true }
      }
    }
  }

  // Tentar restaurar sessão salva do disco
  if (!job.page) {
    const sessionState = await loadSessionFromDisk(job.userKey)
    if (sessionState?.state) {
      try {
        appendJobLog(job, 'restore_session', 'Tentando restaurar sessao salva...', {
          sessionFile: sessionState.sessionFile,
          migratedFromLegacy: Boolean(sessionState.migratedFromLegacy),
        })
        await ensureJobPage(job, {
          headless: requestedHeadless,
          storageState: sessionState.state,
        })
        const entryUrl = process.env.HUBXP_ENTRY_URL || DEFAULT_ENTRY_URL
        await job.page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await job.page.waitForURL(/hub\.xpi\.com\.br|advisor\.xpi\.com\.br/i, { timeout: 15000 }).catch(() => null)
        await job.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null)
        if (await isAuthenticated(job.page).catch(() => false)) {
          let reusable = true
          if (!keepVisible) {
            await minimizeBrowserWindow(job.page)
          } else {
            const visibleReady = await ensureVisibleExecution(job, 'restore_session').catch(() => false)
            reusable = visibleReady && await isAuthenticated(job.page).catch(() => false)
            if (reusable) {
              appendJobLog(job, 'restore_session', 'Mantendo sessao HubXP visivel (keepVisible=true).')
            } else {
              appendJobLog(job, 'restore_session', 'Sessao restaurada perdeu autenticacao ao alternar para visivel; seguindo para login.')
              await closeJobResources(job).catch(() => null)
            }
          }
          if (reusable) {
            setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Sessao restaurada do ultimo login.')
            appendJobLog(job, 'restore_session', 'Sessao restaurada com sucesso')
            return { status: STATUS.AUTHENTICATED, reused: true }
          }
        }
        // Sessão expirou — mas manter o browser aberto para login manual
        appendJobLog(job, 'restore_session', 'Sessao salva expirou, aguardando login manual no browser ja aberto...')
        // NÃO fechar — o browser vai ser reusado no fluxo de login manual abaixo
      } catch (err) {
        appendJobLog(job, 'restore_session', 'Erro ao restaurar: ' + (err?.message || err))
        // Em caso de erro, fechar e deixar o fluxo normal recriar
        await job.page?.close().catch(() => null)
        await job.context?.close().catch(() => null)
        await job.browser?.close().catch(() => null)
        job.page = null
        job.context = null
        job.browser = null
      }
    }
  }

  if (job.running) {
    throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.')
  }

  job.running = true
  job.error = null
  job.progress.startedAt = now()
  job.progress.finishedAt = null

  const entryUrl = scrubText(
    payload.loginUrl
    || process.env.HUBXP_ENTRY_URL
    || process.env.HUBXP_LOGIN_URL
    || DEFAULT_ENTRY_URL,
  )
  const headless = requestedHeadless
  const loginTimeoutMs = Number.isFinite(Number(payload.loginTimeoutMs))
    ? Math.max(30000, Number(payload.loginTimeoutMs))
    : MANUAL_LOGIN_TIMEOUT_MS

  setJobStatus(job, STATUS.STARTING, 'open_login', 'Abrindo navegador para login manual...')
  appendJobLog(job, 'open_login', 'Abrindo navegador para login manual', { entryUrl, headless })

  try {
    await ensureJobPage(job, { headless })
    const page = job.page

    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // Aguardar redirect para pagina de login (hub.xpi -> advisor.xpi)
    await page.waitForURL(/advisor\.xpi\.com\.br|login/i, { timeout: 20000 }).catch(() => null)
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null)
    appendJobLog(job, 'open_login', 'Pagina de login aberta — aguardando login manual', { url: getPageUrl(page) })
    await debugShot(job, page, '01_entry_loaded')

    // Centralizar a tela de autenticacao (login/otp) na viewport
    await centerAuthViewport(page)

    // Auto-preencher credenciais se fornecidas
    const autoUsername = String(payload.username || '').trim()
    const autoPassword = payload.password == null ? '' : String(payload.password)
    if (autoUsername || autoPassword) {
      appendJobLog(job, 'autofill', 'Tentando auto-preencher credenciais...')
      try {
        const firstTry = await runLoginAutofill(job, page, { username: autoUsername, password: autoPassword })
        const shouldRetry = (autoUsername && !firstTry.usernameFilled) || (autoPassword && !firstTry.passwordFilled)
        if (shouldRetry) {
          await delay(450)
          appendJobLog(job, 'autofill', 'Repetindo auto-preenchimento apos renderizacao final da tela...')
          await runLoginAutofill(job, page, { username: autoUsername, password: autoPassword })
        }
        await centerAuthViewport(page)
      } catch (autoFillErr) {
        appendJobLog(job, 'autofill', 'Auto-preenchimento falhou (nao critico)', { error: autoFillErr.message })
      }
    }

    if (await isAuthenticated(page)) {
      await debugShot(job, page, '06_post_login_authenticated')
      // Salvar sessao no disco para reusar depois
      await saveCurrentSession(job)
      // Minimizar janela apenas quando keepVisible=false
      if (!keepVisible) {
        await minimizeBrowserWindow(page)
      } else {
        await ensureVisibleExecution(job, 'post_login').catch(() => false)
        appendJobLog(job, 'post_login', 'Mantendo sessao HubXP visivel (keepVisible=true).')
      }
      setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Sessao autenticada sem login adicional.')
      appendJobLog(job, 'post_login', 'Sessao ja autenticada apos abrir URL', { url: getPageUrl(page) })
      return { status: STATUS.AUTHENTICATED, reused: true }
    }

    // Aguardar o usuario fazer login manual no browser
    setJobStatus(job, STATUS.STARTING, 'waiting_manual_login', 'Aguardando login manual no navegador...')
    appendJobLog(job, 'waiting_manual_login', 'Aguardando usuario autenticar no navegador...')

    const startedWaiting = now()
    let authenticated = false
    let otpSeen = false

    while (now() - startedWaiting < loginTimeoutMs) {
      // Verificar se autenticou
      if (await isAuthenticated(page).catch(() => false)) {
        authenticated = true
        break
      }

      const otpVisible = await detectOtpRequired(page).catch(() => false)
      if (otpVisible) {
        await centerAuthViewport(page)
        if (!otpSeen) {
          otpSeen = true
          setJobStatus(job, STATUS.OTP_REQUIRED, 'waiting_otp', 'Token detectado. Informe o OTP no modal HubXP.')
          appendJobLog(job, 'waiting_otp', 'Tela de token detectada no HubXP')
        }
      } else if ((now() - startedWaiting) % 5000 < 1100) {
        // Manter formulario principal visivel durante espera longa.
        await centerAuthViewport(page)
      }

      // Tirar screenshot periódico a cada 30s para debug
      const elapsed = now() - startedWaiting
      if (DEBUG_HUBXP && elapsed > 0 && elapsed % 30000 < 2100) {
        const stepNum = String(Math.floor(elapsed / 30000) + 2).padStart(2, '0')
        await debugShot(job, page, `${stepNum}_waiting_login`)
      }

      await delay(1000)
    }

    if (!authenticated) {
      await debugShot(job, page, 'login_timeout')
      throw createHttpError(
        408,
        'LOGIN_TIMEOUT',
        `Login manual nao concluido em ${Math.round(loginTimeoutMs / 1000)}s. Tente novamente.`,
        { url: getPageUrl(page), elapsedMs: now() - startedWaiting },
        'waiting_manual_login',
      )
    }

    await debugShot(job, page, '06_post_login_authenticated')
    // Salvar sessao no disco para reusar depois
    await saveCurrentSession(job)
    // Minimizar janela apenas quando keepVisible=false
    if (!keepVisible) {
      const minimized = await minimizeBrowserWindow(page)
      appendJobLog(job, 'post_login', 'Browser minimizado: ' + (minimized ? 'sim' : 'nao'))
    } else {
      await ensureVisibleExecution(job, 'post_login').catch(() => false)
      appendJobLog(job, 'post_login', 'Mantendo browser HubXP visivel (keepVisible=true).')
    }
    setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Login manual concluido — sessao autenticada.')
    appendJobLog(job, 'post_login', 'Login manual concluido com sucesso', { url: getPageUrl(job.page) })
    return { status: STATUS.AUTHENTICATED }
  } catch (error) {
    await captureDebugScreenshot(job, job.page, 'login-failed')
    job.error = serializeError(error)
    setJobStatus(job, STATUS.FAILED, error?.stage || 'auth', job.error.message)
    appendJobLog(job, error?.stage || 'auth', 'Falha na autenticacao', {
      code: job.error.code,
      url: getPageUrl(job.page),
    })
    throw error
  } finally {
    job.running = false
    job.progress.elapsedMs = Math.max(0, now() - (job.progress.startedAt || now()))
  }
}

const submitOtp = async (job, otpCode) => {
  const otp = scrubText(otpCode)
  const otpDigits = otp.replace(/\D/g, '')
  if (!otpDigits) {
    throw createHttpError(400, 'OTP_REQUIRED', 'Informe o token OTP.', null, 'submit_otp')
  }

  if (!job.page) {
    throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para envio de OTP.', null, 'submit_otp')
  }

  if (job.running) {
    throw createHttpError(409, 'JOB_BUSY', 'Aguarde a operacao atual terminar.', null, 'submit_otp')
  }

  job.running = true
  job.error = null
  setJobStatus(job, STATUS.OTP_REQUIRED, 'submit_otp', 'Validando token...')

  try {
    await centerAuthViewport(job.page)

    const digitCount = await getOtpDigitCount(job.page)
    appendJobLog(job, 'submit_otp', 'Tela OTP detectada', {
      otpInputs: digitCount,
      url: getPageUrl(job.page),
    })

    if (digitCount >= 6) {
      const max = Math.min(6, otpDigits.length)
      if (max < 6) {
        throw createHttpError(400, 'OTP_LENGTH_INVALID', 'Informe os 6 digitos do token OTP.', null, 'submit_otp')
      }
      const otpInputs = getOtpDigitInputs(job.page)
      for (let i = 0; i < 6; i += 1) {
        const field = otpInputs.nth(i)
        await field.fill(otpDigits[i]).catch(async () => {
          await field.click({ timeout: 1000 }).catch(() => null)
          await field.type(otpDigits[i], { delay: 30 }).catch(() => null)
        })
      }
    } else {
      const otpInput = await pickVisibleLocator(job.page, OTP_SELECTORS)
      if (!otpInput) {
        throw createHttpError(502, 'OTP_FIELD_NOT_FOUND', 'Campos de OTP nao encontrados na tela.', null, 'submit_otp')
      }
      await otpInput.locator.fill(otpDigits)
    }

    const confirmButton = job.page.getByRole('button', {
      name: /confirmar e acessar conta|confirmar|validar|continuar|entrar/i,
    }).first()

    let submitted = false
    if (await isVisible(confirmButton)) {
      const enabled = await waitForEnabled(confirmButton, 12000)
      if (!enabled) {
        throw createHttpError(504, 'OTP_CONFIRM_DISABLED', 'Botao de confirmacao do OTP nao habilitou.', null, 'submit_otp')
      }
      await confirmButton.click({ timeout: 3000 })
      submitted = true
    } else {
      submitted = await clickByTexts(job.page, ['Confirmar e acessar conta', 'Confirmar', 'Validar', 'Continuar', 'Entrar'])
    }

    if (!submitted) {
      throw createHttpError(502, 'OTP_CONFIRM_NOT_FOUND', 'Botao para confirmar OTP nao encontrado.', null, 'submit_otp')
    }
    appendJobLog(job, 'submit_otp', 'OTP enviado', { url: getPageUrl(job.page) })
    await debugShot(job, job.page, '05_after_otp_submit')

    await waitForOrdersResponse(job.page, 3000)
    await waitForTableStability(job.page)
    const authState = await waitForPotentialAuthState(job.page, 30000)

    if (authState !== 'authenticated') {
      const stillOtp = await detectOtpRequired(job.page)
      if (stillOtp) {
        throw createHttpError(401, 'OTP_INVALID', 'Token OTP invalido ou expirado.', null, 'submit_otp')
      }
      throw createHttpError(401, 'OTP_AUTH_FAILED', 'Nao foi possivel concluir autenticacao com OTP.', { url: getPageUrl(job.page) }, 'post_login')
    }

    // Minimizar janela apenas quando keepVisible=false
    if (!job?._keepVisible) {
      const minimized = await minimizeBrowserWindow(job.page)
      appendJobLog(job, 'post_login', 'Browser minimizado apos OTP: ' + (minimized ? 'sim' : 'nao'))
    } else {
      await ensureVisibleExecution(job, 'post_login').catch(() => false)
      appendJobLog(job, 'post_login', 'Mantendo browser HubXP visivel apos OTP (keepVisible=true).')
    }
    setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Sessao autenticada com OTP.')
    appendJobLog(job, 'post_login', 'OTP validado com sucesso', { url: getPageUrl(job.page) })
    return { status: STATUS.AUTHENTICATED }
  } catch (error) {
    await captureDebugScreenshot(job, job.page, 'otp-failed')
    job.error = serializeError(error)
    setJobStatus(job, STATUS.FAILED, error?.stage || 'otp', job.error.message)
    appendJobLog(job, error?.stage || 'otp', 'Falha na validacao do OTP', {
      code: job.error.code,
      url: getPageUrl(job.page),
    })
    throw error
  } finally {
    job.running = false
    touchJob(job)
  }
}

const fetchOrders = async (job, payload = {}) => {
  if (!job.page) {
    throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para coleta.', null, 'navigate_orders')
  }

  if (job.running) {
    throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, 'collecting')
  }

  // Permitir re-coleta apos FAILED (o browser ainda esta aberto, so a navegacao/coleta falhou)
  const allowedStatuses = new Set([STATUS.AUTHENTICATED, STATUS.SUCCESS, STATUS.FAILED])
  if (!allowedStatuses.has(job.status)) {
    throw createHttpError(409, 'JOB_NOT_AUTHENTICATED', 'Sessao nao autenticada. Inicie login antes de coletar.', null, 'post_login')
  }

  job.running = true
  job.error = null
  job.progress.startedAt = now()
  job.progress.finishedAt = null
  // Limpar dados da coleta anterior para evitar servir dados antigos
  // se o endpoint /results for chamado durante a nova coleta
  job._collectedData = null
  job.lastResult = null

  const collectTimeout = Number.isFinite(Number(payload.timeoutMs))
    ? Math.max(10000, Math.min(10 * 60 * 1000, Number(payload.timeoutMs)))
    : DEFAULT_COLLECT_TIMEOUT_MS

  const filters = payload.filters && typeof payload.filters === 'object' ? payload.filters : {}
  const centralOrdersUrl = scrubText(payload.centralOrdersUrl || process.env.HUBXP_CENTRAL_ORDERS_URL || '') || null

  setJobStatus(job, STATUS.COLLECTING, 'navigate_orders', 'Navegando para Central de Ordens...', {
    currentPage: 0,
    totalPages: null,
    rowsCollected: 0,
  })

  appendJobLog(job, 'collecting', 'Coleta iniciada', { url: getPageUrl(job.page) })

  try {
    // Se o browser esta visivel (headless=false), NAO trocar para headless
    // pois a troca destroi tokens SSO/session que nao sobrevivem apenas via storageState
    if (job._keepVisible || job.browserHeadless === false) {
      appendJobLog(job, 'collecting', 'Mantendo browser visivel para coleta (keepVisible ou sessao visivel).')
      const authOk = await isAuthenticated(job.page).catch(() => false)
      if (!authOk) {
        appendJobLog(job, 'collecting', 'Sessao visivel perdeu autenticacao.')
        throw createHttpError(409, 'SESSION_EXPIRED', 'Sessao HubXP expirou. Faca login novamente.', null, 'collecting')
      }
    } else {
      await ensureHeadlessExecution(job, 'collecting')
    }

    let officialApiResult = null
    try {
      officialApiResult = await fetchFromOfficialApi(job, payload, filters)
    } catch (apiError) {
      const allowFallback = toBoolean(payload.allowOfficialApiFallback, true)
      const fallbackCodes = new Set([
        'OFFICIAL_API_FAILED',
        'OFFICIAL_API_TIMEOUT',
        'OFFICIAL_API_UNREACHABLE',
      ])
      const fallbackStatus = Number(apiError?.status || 0)
      const shouldFallback = allowFallback && (
        fallbackCodes.has(String(apiError?.code || '').trim())
        || fallbackStatus >= 500
        || fallbackStatus === 0
      )
      if (!shouldFallback) throw apiError

      appendJobLog(job, 'api', 'API oficial indisponivel; seguindo com coleta por pagina na Central de Ordens.', {
        code: apiError?.code || 'OFFICIAL_API_FAILED',
        status: fallbackStatus || null,
        message: scrubText(apiError?.message || 'Falha na API oficial.'),
      })
    }
    if (officialApiResult) {
      const collectedAt = officialApiResult.collectedAt || now()
      // Guardar dados coletados no job para buscar via /results (modo async)
      job._collectedData = {
        columns: officialApiResult.columns,
        rows: officialApiResult.rows,
        totalRows: officialApiResult.totalRows,
        pagesScanned: officialApiResult.pagesScanned,
        collectedAt,
      }
      job.lastResult = {
        columns: officialApiResult.columns,
        totalRows: officialApiResult.totalRows,
        pagesScanned: officialApiResult.pagesScanned,
        collectedAt,
      }
      setJobStatus(job, STATUS.SUCCESS, 'done', `Coleta concluida com ${officialApiResult.totalRows} linhas.`, {
        currentPage: officialApiResult.pagesScanned,
        totalPages: officialApiResult.pagesScanned,
        rowsCollected: officialApiResult.totalRows,
        finishedAt: collectedAt,
        elapsedMs: Math.max(0, collectedAt - (job.progress.startedAt || collectedAt)),
      })
      return {
        status: STATUS.SUCCESS,
        columns: officialApiResult.columns,
        rows: officialApiResult.rows,
        totalRows: officialApiResult.totalRows,
        pagesScanned: officialApiResult.pagesScanned,
        collectedAt,
      }
    }

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(createHttpError(504, 'COLLECT_TIMEOUT', 'Tempo limite excedido durante coleta da Central de Ordens.'))
      }, collectTimeout)
    })

    const collectPromise = (async () => {
      // Navegar para Central de Ordens (forca recarregamento para dados atualizados)
      appendJobLog(job, 'fetch', 'Navegando para Central de Ordens para coleta por pagina...')
      await ensureCentralOrdersView(job, job.page, centralOrdersUrl)
      // Primeira acao apos abrir a tela: disparar filtro base para estabilizar a grade.
      await runCentralOrdersInitialFilter(job, job.page)
      // Aguardar componentes de filtro carregarem apos o filtro inicial.
      await delay(1200)

      // Se a pagina carregou mas sem tabela (ex: "Nao foi possivel obter os tickets"),
      // tentar recarregar ate 2x antes de prosseguir
      let tableReady = await pickTableLocator(job.page)
      if (!tableReady) {
        const filtersUi = await waitForCentralOrdersFilterUi(job.page, 5000)
        if (filtersUi.ready || filtersUi.hasDatepicker) {
          appendJobLog(job, 'fetch', 'Tabela ainda nao detectada, mas filtros ja estao prontos. Prosseguindo sem reload inicial.', {
            hasDatepicker: Boolean(filtersUi?.hasDatepicker),
            hasFilterButton: Boolean(filtersUi?.hasFilterButton),
            hasFilterInputs: Boolean(filtersUi?.hasFilterInputs),
          })
        } else {
          for (let retryNav = 1; retryNav <= 2; retryNav += 1) {
            appendJobLog(job, 'fetch', `Tabela nao detectada apos navegacao. Recarregando pagina (tentativa ${retryNav}/2)...`)
            await job.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
            await job.page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null)
            await delay(3000)
            await job.page.waitForSelector('table, [role="grid"], [role="table"], .ag-root-wrapper, [role="row"], soma-datepicker', { timeout: 10000 }).catch(() => null)
            tableReady = await pickTableLocator(job.page)
            if (tableReady) {
              appendJobLog(job, 'fetch', 'Tabela encontrada apos recarregar pagina.')
              break
            }
          }
        }
      }

      await applyFilters(job, job.page, filters)

      // Verificar se o filtro de data foi realmente aplicado
      const hasDateFilter = filters?.dateFrom || filters?.dateTo
      if (hasDateFilter) {
        const dateOk = await verifyExpectedDateRange(job, job.page, filters, 'date_verify_pre_collect')
        if (!dateOk) {
          // Data incorreta — recarregar pagina e tentar filtros novamente
          for (let dateRetry = 1; dateRetry <= 2; dateRetry++) {
            appendJobLog(job, 'fetch', `Data incorreta apos filtros. Recarregando pagina e reaplicando filtros (tentativa ${dateRetry}/2)...`)
            await job.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
            await job.page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null)
            await delay(3000)
            await applyFilters(job, job.page, filters)
            const retryOk = await verifyExpectedDateRange(job, job.page, filters, 'date_verify_retry')
            if (retryOk) {
              appendJobLog(job, 'fetch', 'Data correta apos reload + reaplicacao de filtros.')
              break
            }
          }
        }
      }

      return collectRowsFromTable(job, job.page, { maxPages: payload.maxPages })
    })()

    const result = await Promise.race([collectPromise, timeoutPromise])

    const collectedAt = now()
    // Guardar dados coletados no job para buscar via /results
    job._collectedData = {
      columns: result.headers,
      rows: result.rows,
      totalRows: result.rows.length,
      pagesScanned: result.pagesScanned,
      collectedAt,
    }
    job.lastResult = {
      columns: result.headers,
      totalRows: result.rows.length,
      pagesScanned: result.pagesScanned,
      collectedAt,
    }

    setJobStatus(job, STATUS.SUCCESS, 'done', `Coleta concluida com ${result.rows.length} linhas.`, {
      currentPage: result.pagesScanned,
      totalPages: job.progress.totalPages || result.pagesScanned,
      rowsCollected: result.rows.length,
      finishedAt: collectedAt,
      elapsedMs: Math.max(0, collectedAt - (job.progress.startedAt || collectedAt)),
    })

    appendJobLog(job, 'collecting', 'Coleta concluida', {
      rows: result.rows.length,
      pages: result.pagesScanned,
    })

    return {
      status: STATUS.SUCCESS,
      columns: result.headers,
      rows: result.rows,
      totalRows: result.rows.length,
      pagesScanned: result.pagesScanned,
      collectedAt: job._collectedData.collectedAt,
    }
  } catch (error) {
    await captureDebugScreenshot(job, job.page, 'fetch-failed')
    job.error = serializeError(error)
    setJobStatus(job, STATUS.FAILED, error?.stage || 'collecting', job.error.message)
    appendJobLog(job, error?.stage || 'collecting', 'Falha na coleta', {
      code: job.error.code,
      url: getPageUrl(job.page),
    })
    throw error
  } finally {
    job.running = false
    touchJob(job)
  }
}

// ==========================
// Apuracao Bovespa (Notas)
// ==========================

let pdfjsLoader = null

const stripDiacriticsLower = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()

const parseBrNumber = (value) => {
  if (value == null || value === '') return null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
  if (!cleaned) return null
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    // "27.024,00" -> 27024.00
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
    } else {
      // "27,024.00" -> 27024.00 (fallback)
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

const parseBrCurrency = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (!/[R$]|,\d{2}\b/.test(raw)) return null
  return parseBrNumber(raw)
}

const normalizePositiveMoney = (value) => {
  if (value == null || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Math.abs(num)
}

const normalizeApuracaoSummaryMoney = (summary = {}) => ({
  ...summary,
  valorOperacoes: normalizePositiveMoney(summary.valorOperacoes),
  taxaOperacional: normalizePositiveMoney(summary.taxaOperacional),
})

const normalizeApuracaoRowMoney = (row = {}) => ({
  ...row,
  valorOperacoes: normalizePositiveMoney(row.valorOperacoes),
  taxaOperacional: normalizePositiveMoney(row.taxaOperacional),
})

const applyDebitoCreditoSide = (value, side) => {
  if (value == null) return null
  const dc = String(side || '').trim().toUpperCase()
  if (dc === 'D') return -Math.abs(value)
  return value
}

const sumParsedValues = (hits = []) => {
  if (!Array.isArray(hits) || !hits.length) return null
  const total = hits.reduce((acc, hit) => {
    const v = Number(hit?.value)
    return Number.isFinite(v) ? (acc + v) : acc
  }, 0)
  if (!Number.isFinite(total)) return null
  return Number(total.toFixed(6))
}

const pickFirstSide = (hits = []) => {
  if (!Array.isArray(hits) || !hits.length) return null
  for (const hit of hits) {
    const side = String(hit?.side || '').trim().toUpperCase()
    if (side === 'D' || side === 'C') return side
  }
  return null
}

const parseLabeledValues = (normalizedText = '', labelPatterns = []) => {
  const text = String(normalizedText || '')
  if (!text) return []

  const byRange = new Map()
  const register = (candidate = null) => {
    if (!candidate || candidate.value == null) return
    const key = `${candidate.start}:${candidate.end}`
    const current = byRange.get(key)
    if (!current) {
      byRange.set(key, candidate)
      return
    }
    if ((candidate.priority || 0) > (current.priority || 0)) {
      byRange.set(key, candidate)
      return
    }
    if ((candidate.priority || 0) === (current.priority || 0)) {
      const absCandidate = Math.abs(Number(candidate.value) || 0)
      const absCurrent = Math.abs(Number(current.value) || 0)
      if (absCandidate > absCurrent || (absCandidate === absCurrent && candidate.side && !current.side)) {
        byRange.set(key, candidate)
      }
    }
  }

  for (const label of labelPatterns) {
    const expr = String(label || '').trim()
    if (!expr) continue
    const tests = [
      {
        regex: new RegExp(`${expr}\\s*[:\\-]?\\s*([dc])\\s*([+-]?[0-9][0-9.,]*)\\b`, 'ig'),
        pick: (m) => ({ side: m[1], raw: m[2] }),
        priority: 20,
      },
      {
        regex: new RegExp(`${expr}\\s*[:\\-]?\\s*([+-]?[0-9][0-9.,]*)\\s*([dc])\\b`, 'ig'),
        pick: (m) => ({ side: m[2], raw: m[1] }),
        priority: 30,
      },
      {
        regex: new RegExp(`([+-]?[0-9][0-9.,]*)\\s+${expr}\\s*([dc])\\b`, 'ig'),
        pick: (m) => ({ side: m[2], raw: m[1] }),
        priority: 50,
      },
      {
        regex: new RegExp(`([+-]?[0-9][0-9.,]*)\\s+${expr}\\b`, 'ig'),
        pick: (m) => ({ side: null, raw: m[1] }),
        priority: 40,
      },
      {
        regex: new RegExp(`${expr}\\s*[:\\-]?\\s*([+-]?[0-9][0-9.,]*)\\b`, 'ig'),
        pick: (m) => ({ side: null, raw: m[1] }),
        priority: 10,
      },
    ]

    for (const test of tests) {
      const matches = text.matchAll(test.regex)
      for (const match of matches) {
        const parsedRaw = test.pick(match)
        const parsedValue = parseBrNumber(parsedRaw?.raw)
        if (parsedValue == null) continue
        const start = Number(match.index) || 0
        const matchedText = String(match[0] || '')
        register({
          value: applyDebitoCreditoSide(parsedValue, parsedRaw?.side),
          side: parsedRaw?.side ? String(parsedRaw.side).toUpperCase() : null,
          match: matchedText,
          priority: test.priority,
          start,
          end: start + matchedText.length,
        })
      }
    }
  }

  return [...byRange.values()].sort((a, b) => (a.start || 0) - (b.start || 0))
}

const parseLabeledValue = (normalizedText = '', labelPatterns = []) => {
  const text = String(normalizedText || '')
  if (!text) return { value: null, side: null, match: null }

  let best = null
  for (const label of labelPatterns) {
    const expr = String(label || '').trim()
    if (!expr) continue
    const tests = [
      {
        regex: new RegExp(`${expr}\\s*[:\\-]?\\s*([dc])\\s*([+-]?[0-9][0-9.,]*)\\b`, 'ig'),
        pick: (m) => ({ side: m[1], raw: m[2] }),
        priority: 20,
      },
      {
        regex: new RegExp(`${expr}\\s*[:\\-]?\\s*([+-]?[0-9][0-9.,]*)\\s*([dc])\\b`, 'ig'),
        pick: (m) => ({ side: m[2], raw: m[1] }),
        priority: 30,
      },
      {
        regex: new RegExp(`([+-]?[0-9][0-9.,]*)\\s+${expr}\\s*([dc])\\b`, 'ig'),
        pick: (m) => ({ side: m[2], raw: m[1] }),
        priority: 50,
      },
      {
        regex: new RegExp(`([+-]?[0-9][0-9.,]*)\\s+${expr}\\b`, 'ig'),
        pick: (m) => ({ side: null, raw: m[1] }),
        priority: 40,
      },
      {
        regex: new RegExp(`${expr}\\s*[:\\-]?\\s*([+-]?[0-9][0-9.,]*)\\b`, 'ig'),
        pick: (m) => ({ side: null, raw: m[1] }),
        priority: 10,
      },
    ]

    for (const test of tests) {
      const matches = text.matchAll(test.regex)
      for (const match of matches) {
        const parsedRaw = test.pick(match)
        const parsedValue = parseBrNumber(parsedRaw?.raw)
        if (parsedValue == null) continue
        const value = applyDebitoCreditoSide(parsedValue, parsedRaw?.side)
        const candidate = {
          value,
          side: parsedRaw?.side ? String(parsedRaw.side).toUpperCase() : null,
          match: String(match[0] || ''),
          priority: test.priority,
        }
        if (!best) {
          best = candidate
          continue
        }
        if ((candidate.priority || 0) > (best.priority || 0)) {
          best = candidate
          continue
        }
        if ((candidate.priority || 0) === (best.priority || 0)) {
          const absCandidate = Math.abs(Number(candidate.value) || 0)
          const absBest = Math.abs(Number(best.value) || 0)
          if (absCandidate > absBest) {
            best = candidate
            continue
          }
          if (absCandidate === absBest && candidate.side && !best.side) {
            best = candidate
          }
        }
      }
    }
  }

  if (!best) return { value: null, side: null, match: null }
  return {
    value: best.value,
    side: best.side,
    match: best.match,
  }
}

const buildPdfPageLineEntries = (content = null) => {
  const items = Array.isArray(content?.items) ? content.items : []
  if (!items.length) return []

  const lineMap = new Map()
  for (const item of items) {
    const raw = String(item?.str || '')
    const str = raw.replace(/\s+/g, ' ').trim()
    if (!str) continue
    const transform = Array.isArray(item?.transform) ? item.transform : []
    const x = Number(transform?.[4] || 0)
    const y = Number(transform?.[5] || 0)
    const key = Math.round(y * 2) / 2 // tolera pequenas variacoes de baseline
    if (!lineMap.has(key)) lineMap.set(key, [])
    lineMap.get(key).push({ str, x })
  }

  return [...lineMap.values()]
    .map((lineItems) => {
      const ordered = lineItems.sort((a, b) => a.x - b.x)
      const rawLine = ordered.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim()
      const normalized = stripDiacriticsLower(rawLine).replace(/\s+/g, ' ').trim()
      return {
        raw: rawLine,
        normalized,
      }
    })
    .filter((entry) => entry.normalized)
}

const parseLabeledValueFromPageLines = (pageLines = [], labelPatterns = []) => {
  if (!Array.isArray(pageLines) || !pageLines.length) {
    return { value: null, side: null, match: null }
  }
  const labels = Array.isArray(labelPatterns) ? labelPatterns : []
  if (!labels.length) return { value: null, side: null, match: null }

  let best = null
  const registerCandidate = (candidate = null) => {
    if (!candidate || candidate.value == null) return
    if (!best) {
      best = candidate
      return
    }
    if ((candidate.priority || 0) > (best.priority || 0)) {
      best = candidate
      return
    }
    if ((candidate.priority || 0) === (best.priority || 0)) {
      const absCandidate = Math.abs(Number(candidate.value) || 0)
      const absBest = Math.abs(Number(best.value) || 0)
      if (absCandidate > absBest) {
        best = candidate
        return
      }
      if (absCandidate === absBest && candidate.side && !best.side) {
        best = candidate
      }
    }
  }

  for (const line of pageLines) {
    const normalized = String(line?.normalized || '')
    if (!normalized) continue

    for (const label of labels) {
      const expr = String(label || '').trim()
      if (!expr) continue
      const labelRegex = new RegExp(expr, 'i')
      const match = normalized.match(labelRegex)
      if (!match) continue

      const labelStart = Math.max(0, Number(match.index) || 0)
      const labelEnd = labelStart + String(match[0] || '').length
      const rightText = normalized.slice(labelEnd).trim()
      const leftText = normalized.slice(0, labelStart).trim()

      // Regra principal: valor imediatamente a direita do rotulo na mesma linha.
      const rightTests = [
        { regex: /^[:\-]?\s*([dc])\s*([+-]?[0-9][0-9.,]*)\b/i, pick: (m) => ({ side: m[1], raw: m[2] }), priority: 120 },
        { regex: /^[:\-]?\s*([+-]?[0-9][0-9.,]*)\s*([dc])\b/i, pick: (m) => ({ side: m[2], raw: m[1] }), priority: 130 },
        { regex: /^[:\-]?\s*([+-]?[0-9][0-9.,]*)\b/i, pick: (m) => ({ side: null, raw: m[1] }), priority: 110 },
        { regex: /([dc])\s*([+-]?[0-9][0-9.,]*)\b/i, pick: (m) => ({ side: m[1], raw: m[2] }), priority: 90 },
        { regex: /([+-]?[0-9][0-9.,]*)\s*([dc])\b/i, pick: (m) => ({ side: m[2], raw: m[1] }), priority: 95 },
      ]

      for (const test of rightTests) {
        const rightMatch = rightText.match(test.regex)
        if (!rightMatch) continue
        const parsed = test.pick(rightMatch)
        const parsedValue = parseBrNumber(parsed?.raw)
        if (parsedValue == null) continue
        registerCandidate({
          value: applyDebitoCreditoSide(parsedValue, parsed?.side),
          side: parsed?.side ? String(parsed.side).toUpperCase() : null,
          match: `${match[0]} ${rightMatch[0]}`.trim(),
          priority: test.priority,
        })
      }

      // Fallback: em alguns PDFs o valor aparece a esquerda do rotulo.
      const leftMatch = leftText.match(/([+-]?[0-9][0-9.,]*)\s*([dc])?\s*$/i)
      if (leftMatch?.[1]) {
        const parsedValue = parseBrNumber(leftMatch[1])
        if (parsedValue != null) {
          registerCandidate({
            value: applyDebitoCreditoSide(parsedValue, leftMatch[2]),
            side: leftMatch[2] ? String(leftMatch[2]).toUpperCase() : null,
            match: `${leftMatch[0]} ${match[0]}`.trim(),
            priority: 70,
          })
        }
      }
    }
  }

  if (!best) return { value: null, side: null, match: null }
  return {
    value: best.value,
    side: best.side,
    match: best.match,
  }
}

const parseLabeledValuesFromPageLines = (pageLines = [], labelPatterns = []) => {
  if (!Array.isArray(pageLines) || !pageLines.length) return []
  const out = []
  for (const line of pageLines) {
    const hit = parseLabeledValueFromPageLines([line], labelPatterns)
    if (hit?.value == null) continue
    out.push(hit)
  }
  return out
}

const buildPdfSummaryScanOrder = (totalPages) => {
  const scanOrder = []
  const seen = new Set()
  const addPage = (n) => {
    if (n < 1 || n > totalPages) return
    if (seen.has(n)) return
    seen.add(n)
    scanOrder.push(n)
  }

  // Fonte de verdade: resumo tende a estar no final da nota.
  addPage(totalPages)
  addPage(totalPages - 1)
  addPage(totalPages - 2)
  addPage(1)

  // Fallback final: varrer restante em ordem reversa para manter priorizacao no fim.
  for (let n = totalPages; n >= 1; n -= 1) addPage(n)
  return scanOrder
}

const detectDayTradeEvidence = (normalizedText = '') => {
  const text = String(normalizedText || '')
  if (!text) return {
    isDayTrade: false,
    reason: null,
    value: null,
  }

  const rules = [
    { key: 'IRRF_DAY_TRADE', regex: /irrf\s+day\s*trade\s*[:\-]?\s*([0-9.,]+)/i },
    { key: 'RESULTADO_DAY_TRADE', regex: /resultado\s+day\s*trade\s*[:\-]?\s*([0-9.,]+)/i },
    { key: 'BASE_CALCULO_DAY_TRADE', regex: /base\s+de\s+calculo\s+day\s*trade\s*[:\-]?\s*([0-9.,]+)/i },
  ]

  for (const rule of rules) {
    const match = text.match(rule.regex)
    if (!match?.[1]) continue
    const parsed = parseBrNumber(match[1])
    if (parsed == null) continue
    return {
      isDayTrade: true,
      reason: rule.key,
      value: parsed,
      match: String(match[0] || '').slice(0, 120),
    }
  }

  return {
    isDayTrade: false,
    reason: null,
    value: null,
  }
}

const normalizeAnchorText = (value) => stripDiacriticsLower(String(value || ''))
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const BMF_TEXT_ANCHORS = [
  'Taxa registro BM&F',
  'Taxas BM&F (emol+f.gar)',
  'Custos BM&F',
  'Ajuste de posição',
  'Ajuste day trade',
]

const BOVESPA_TEXT_ANCHORS = [
  'Total CBLC',
  'Total Bovespa',
  'Taxa de liquidação',
  'Emolumentos',
  'Líquido para',
]

const classifyNotaByAnchors = (chunks = []) => {
  const merged = chunks
    .map((chunk) => normalizeAnchorText(chunk))
    .filter(Boolean)
    .join(' ')
    .trim()

  const bmfMatched = BMF_TEXT_ANCHORS.filter((anchor) => merged.includes(normalizeAnchorText(anchor)))
  const bovespaMatched = BOVESPA_TEXT_ANCHORS.filter((anchor) => merged.includes(normalizeAnchorText(anchor)))
  if (bovespaMatched.length) {
    const mixed = bmfMatched.length > 0
    return {
      classification: 'BOVESPA',
      skip: false,
      reason: mixed ? 'BOVESPA+BMF (misto)' : 'BOVESPA/CBLC',
      matchedAnchors: mixed
        ? [...new Set([...bovespaMatched, ...bmfMatched])]
        : bovespaMatched,
    }
  }

  if (bmfMatched.length) {
    return {
      classification: 'BMF',
      skip: true,
      reason: 'BMF/derivativos',
      matchedAnchors: bmfMatched,
    }
  }

  return {
    classification: 'INDETERMINADO',
    skip: true,
    reason: 'INDETERMINADO',
    matchedAnchors: [],
  }
}

const getPdfJs = async () => {
  if (!pdfjsLoader) {
    pdfjsLoader = import('pdfjs-dist/legacy/build/pdf.mjs')
      .catch(() => import('pdfjs-dist/legacy/build/pdf.js'))
      .catch(() => {
        // Fallback CJS require para ambientes empacotados (asar)
        try {
          const mod = require('pdfjs-dist/legacy/build/pdf.js')
          return mod
        } catch {
          // noop
        }
        try {
          const mod = require('pdfjs-dist')
          return mod
        } catch {
          // noop
        }
        return null
      })
      .then((mod) => {
        if (!mod) {
          throw createHttpError(
            503,
            'PDFJS_UNAVAILABLE',
            'Leitor PDF indisponivel. Instale com: npm i pdfjs-dist',
            null,
            'pdf_parse',
          )
        }
        return mod
      })
  }
  const mod = await pdfjsLoader
  return mod?.getDocument ? mod : (mod?.default || mod)
}

const extractApuracaoBovespaFromPdf = async (buffer) => {
  const pdfjs = await getPdfJs()
  // pdf.js requer Uint8Array "puro"; Buffer do Node pode causar erro.
  const data = Buffer.isBuffer(buffer)
    ? Uint8Array.from(buffer)
    : (buffer instanceof Uint8Array ? Uint8Array.from(buffer) : new Uint8Array(buffer))
  const task = pdfjs.getDocument({ data })
  const pdf = await task.promise

  const totalPages = pdf.numPages || 0
  const getNormalizedPageText = async (pageNo) => {
    if (!pageNo || pageNo < 1 || pageNo > totalPages) return ''
    const page = await pdf.getPage(pageNo)
    const content = await page.getTextContent()
    return (content?.items || [])
      .map((it) => it?.str || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  const lastPageText = totalPages > 0 ? await getNormalizedPageText(totalPages) : ''
  const firstPageText = totalPages > 1 ? await getNormalizedPageText(1) : (lastPageText || '')
  const notaClass = classifyNotaByAnchors([lastPageText, firstPageText])

  if (notaClass.skip) {
    return {
      valorOperacoes: null,
      valorFinanceiro: null,
      taxaOperacional: null,
      taxaOperacionalSide: null,
      corretagem: null,
      isDayTrade: false,
      dayTradeReason: null,
      detectedClientCode: null,
      notaClassification: notaClass.classification,
      notaClassificationReason: notaClass.reason,
      notaClassificationAnchors: notaClass.matchedAnchors,
      pagesScanned: totalPages > 1 ? 2 : (totalPages > 0 ? 1 : 0),
      totalPages,
    }
  }

  const scanOrder = buildPdfSummaryScanOrder(totalPages)

  const valorOperacoesHits = []
  const valorLiquidoOperacoesHits = []
  const valorFinanceiroHits = []
  const taxaOperacionalHits = []
  const corretagemHits = []
  let taxaOperacionalSide = null
  let isDayTrade = false
  let dayTradeReason = null
  let detectedClientCode = null
  let pagesScanned = 0

  const valorOperacoesLabels = ['valor\\s+das\\s+operac(?:oes|o?es)?']
  const valorLiquidoOperacoesLabels = ['valor\\s+liquido\\s+das\\s+operac(?:oes|o?es)?']
  const valorFinanceiroLabels = [
    'valor\\s+financeir[oa]',
    'liquido\\s+para(?:\\s+\\d{2}\\/\\d{2}\\/\\d{4})?',
  ]
  const taxaOperacionalLabels = ['taxa\\s+operacional']
  const corretagemLabels = ['corretagem']
  const visitedPages = new Set()
  const processPageForSummary = async (pageNo) => {
    if (!pageNo || pageNo < 1 || pageNo > totalPages) return
    if (visitedPages.has(pageNo)) return
    visitedPages.add(pageNo)
    pagesScanned += 1
    const page = await pdf.getPage(pageNo)
    const content = await page.getTextContent()
    const pageText = (content?.items || []).map((it) => it?.str || '').join(' ')
    const normalized = stripDiacriticsLower(pageText).replace(/\s+/g, ' ')
    const pageLines = buildPdfPageLineEntries(content)

    if (!detectedClientCode) {
      const codeMatch = normalized.match(/codigo\s+cliente\s*(?:\d+\s*-\s*\d+\s*)?(\d{4,})\b/i)
        || normalized.match(/cliente\s+(\d{4,})\b/i)
      if (codeMatch?.[1]) {
        detectedClientCode = String(codeMatch[1]).replace(/\D/g, '')
      }
    }

    // Day Trade: exigir marcador operacional real para evitar falso positivo por legenda.
    if (!isDayTrade) {
      const dayTrade = detectDayTradeEvidence(normalized)
      if (dayTrade.isDayTrade) {
        isDayTrade = true
        dayTradeReason = `${dayTrade.reason}@page_${pageNo}`
      }
    }

    const pageValorOperacoesHits = parseLabeledValuesFromPageLines(pageLines, valorOperacoesLabels)
    if (pageValorOperacoesHits.length) {
      valorOperacoesHits.push(...pageValorOperacoesHits)
    } else {
      const lineFallbackHits = parseLabeledValuesFromPageLines(pageLines, valorLiquidoOperacoesLabels)
      if (lineFallbackHits.length) {
        valorLiquidoOperacoesHits.push(...lineFallbackHits)
      } else {
        const fallbackHits = parseLabeledValues(normalized, valorLiquidoOperacoesLabels)
        if (fallbackHits.length) valorLiquidoOperacoesHits.push(...fallbackHits)
      }
    }

    const pageValorFinanceiroHits = parseLabeledValuesFromPageLines(pageLines, valorFinanceiroLabels)
    if (pageValorFinanceiroHits.length) {
      valorFinanceiroHits.push(...pageValorFinanceiroHits)
    } else {
      const fallbackHits = parseLabeledValues(normalized, valorFinanceiroLabels)
      if (fallbackHits.length) valorFinanceiroHits.push(...fallbackHits)
    }

    const pageTaxaOperacionalHits = parseLabeledValuesFromPageLines(pageLines, taxaOperacionalLabels)
    if (pageTaxaOperacionalHits.length) {
      taxaOperacionalHits.push(...pageTaxaOperacionalHits)
    } else {
      const fallbackHits = parseLabeledValues(normalized, taxaOperacionalLabels)
      if (fallbackHits.length) taxaOperacionalHits.push(...fallbackHits)
    }

    // MODELO XP usa "Corretagem" em vez de "Taxa Operacional"
    const pageCorretagemHits = parseLabeledValuesFromPageLines(pageLines, corretagemLabels)
    if (pageCorretagemHits.length) {
      corretagemHits.push(...pageCorretagemHits)
    } else {
      const fallbackHits = parseLabeledValues(normalized, corretagemLabels)
      if (fallbackHits.length) corretagemHits.push(...fallbackHits)
    }
  }

  const initialScanPageLimit = Number.isFinite(Number(process.env.HUBXP_PDF_INITIAL_SCAN_PAGES))
    ? Math.max(6, Math.min(40, Number(process.env.HUBXP_PDF_INITIAL_SCAN_PAGES)))
    : 14
  const forceFullScan = String(notaClass.reason || '').includes('misto')

  if (forceFullScan || totalPages <= initialScanPageLimit) {
    for (const pageNo of scanOrder) {
      await processPageForSummary(pageNo)
    }
  } else {
    for (const pageNo of scanOrder.slice(0, initialScanPageLimit)) {
      await processPageForSummary(pageNo)
    }
    const hasCoreHits = (valorOperacoesHits.length > 0 || valorLiquidoOperacoesHits.length > 0)
      && (taxaOperacionalHits.length > 0 || corretagemHits.length > 0)
    if (!hasCoreHits) {
      for (const pageNo of scanOrder) {
        await processPageForSummary(pageNo)
      }
    }
  }

  const valorLiquidoOperacoes = sumParsedValues(valorLiquidoOperacoesHits)
  const valorOperacoes = sumParsedValues(valorOperacoesHits) ?? valorLiquidoOperacoes
  const valorFinanceiro = sumParsedValues(valorFinanceiroHits) ?? valorLiquidoOperacoes
  const taxaOperacional = sumParsedValues(taxaOperacionalHits)
  const corretagem = sumParsedValues(corretagemHits)
  taxaOperacionalSide = pickFirstSide(taxaOperacionalHits)

  return normalizeApuracaoSummaryMoney({
    valorOperacoes,
    valorFinanceiro,
    taxaOperacional: taxaOperacional ?? corretagem,
    taxaOperacionalSide,
    corretagem,
    isDayTrade,
    dayTradeReason,
    detectedClientCode,
    notaClassification: notaClass.classification,
    notaClassificationReason: notaClass.reason,
    notaClassificationAnchors: notaClass.matchedAnchors,
    pagesScanned,
    totalPages,
  })
}

const mergeApuracaoResumo = (base = {}, next = {}) => {
  const merged = normalizeApuracaoSummaryMoney({
    valorOperacoes: base.valorOperacoes ?? next.valorOperacoes ?? null,
    valorFinanceiro: base.valorFinanceiro ?? next.valorFinanceiro ?? null,
    taxaOperacional: base.taxaOperacional ?? next.taxaOperacional ?? null,
    taxaOperacionalSide: base.taxaOperacionalSide ?? next.taxaOperacionalSide ?? null,
    corretagem: base.corretagem ?? next.corretagem ?? null,
    isDayTrade: Boolean(base.isDayTrade || next.isDayTrade),
    dayTradeReason: base.dayTradeReason || next.dayTradeReason || null,
  })
  // Preserve classification fields (not monetary, so not normalized)
  merged.notaClassification = base.notaClassification || next.notaClassification || null
  merged.notaClassificationReason = base.notaClassificationReason || next.notaClassificationReason || null
  return merged
}

const parseApuracaoResumoFromText = (text) => {
  const normalized = stripDiacriticsLower(String(text || '')).replace(/\s+/g, ' ')
  if (!normalized) {
    return {
      valorOperacoes: null,
      valorFinanceiro: null,
      taxaOperacional: null,
      taxaOperacionalSide: null,
      corretagem: null,
      isDayTrade: false,
      dayTradeReason: null,
    }
  }

  const valueHits = parseLabeledValues(normalized, ['valor\\s+das\\s+operac(?:oes|o?es)?'])
  const valueFallbackHits = parseLabeledValues(normalized, ['valor\\s+liquido\\s+das\\s+operac(?:oes|o?es)?'])
  const valorFinHits = parseLabeledValues(normalized, [
    'valor\\s+financeir[oa]',
    'liquido\\s+para(?:\\s+\\d{2}\\/\\d{2}\\/\\d{4})?',
  ])
  const taxaHits = parseLabeledValues(normalized, ['taxa\\s+operacional'])
  const corretagemHits = parseLabeledValues(normalized, ['corretagem'])

  const valorLiquidoOperacoes = sumParsedValues(valueFallbackHits)
  const valorOperacoes = sumParsedValues(valueHits) ?? valorLiquidoOperacoes
  const valorFinanceiro = sumParsedValues(valorFinHits) ?? valorLiquidoOperacoes
  const taxaOperacional = sumParsedValues(taxaHits)
  const corretagem = sumParsedValues(corretagemHits)
  const taxaOperacionalSide = pickFirstSide(taxaHits)

  const dayTrade = detectDayTradeEvidence(normalized)

  return normalizeApuracaoSummaryMoney({
    valorOperacoes,
    valorFinanceiro,
    taxaOperacional: taxaOperacional ?? corretagem,
    taxaOperacionalSide,
    corretagem,
    isDayTrade: dayTrade.isDayTrade,
    dayTradeReason: dayTrade.isDayTrade
      ? `${dayTrade.reason}@inline`
      : null,
  })
}

const hasVisibleNotaOverlay = async (page) => {
  return page.evaluate(() => {
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }

    const candidates = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')
      .filter((el) => isVis(el))
    if (!candidates.length) return false

    const hasPdfHint = (el) => {
      if (!el) return false
      const text = String(el.innerText || el.textContent || '')
      const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      if (/\bpdf\b|sinacor|modelo\s+xp|baixar\s+arquivo|arquivo\s+pdf/.test(norm)) return true
      const mediaNodes = deepFind(el, 'iframe, embed, object, canvas, [class*="pdf" i], [data-testid*="pdf" i], [data-test*="pdf" i]')
      for (const node of mediaNodes) {
        if (!isVis(node)) continue
        const attrs = `${node.getAttribute?.('src') || ''} ${node.getAttribute?.('title') || ''} ${node.getAttribute?.('data-src') || ''}`.toLowerCase()
        if (/pdf|nota|sinacor|download|arquivo/.test(attrs)) return true
        const tag = String(node.tagName || '').toLowerCase()
        if (tag === 'canvas' || tag === 'embed' || tag === 'object') return true
      }
      return false
    }

    const hasNotaSignature = (el) => {
      const text = String(el.innerText || el.textContent || '')
      const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      if (/nota\s+de\s+negociacao|nota\s+de\s+corretagem|modelo\s+sinacor|taxa\s+operacional|corretagem/.test(norm)) return true
      if (/baixar\s+arquivo|liquidacao/.test(norm)) return true
      if (hasPdfHint(el)) return true
      return false
    }

    return candidates.some((el) => hasNotaSignature(el))
  }).catch(() => false)
}

const hasBlockingNotasOverlay = async (page) => {
  return page.evaluate(() => {
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }

    const overlays = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i], [class*="backdrop" i]')
      .filter((el) => isVis(el))
    if (!overlays.length) return false
    return overlays.some((el) => {
      const r = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      if (!style) return false
      if (style.visibility === 'hidden' || style.display === 'none') return false
      if (style.pointerEvents === 'none') return false
      const opacity = Number(style.opacity || '1')
      if (Number.isFinite(opacity) && opacity <= 0.05) return false
      const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
      const area = Math.max(1, r.width * r.height)
      const coversCenter = r.left < (window.innerWidth * 0.62)
        && r.right > (window.innerWidth * 0.38)
        && r.top < (window.innerHeight * 0.62)
        && r.bottom > (window.innerHeight * 0.38)
      return coversCenter && area >= (viewportArea * 0.18)
    })
  }).catch(() => false)
}

const waitForNotasUiInteractable = async (page, timeoutMs = 2600) => {
  const maxMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(1000, Number(timeoutMs))
    : 2600
  const startedAt = now()
  while (now() - startedAt < maxMs) {
    const ready = await page.evaluate(() => {
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }

      const maybeOverlays = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i], [class*="backdrop" i]')
        .filter((el) => isVis(el))
      const hasBlockingOverlay = maybeOverlays.some((el) => {
        const r = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        if (!style) return false
        if (style.visibility === 'hidden' || style.display === 'none') return false
        if (style.pointerEvents === 'none') return false
        const opacity = Number(style.opacity || '1')
        if (Number.isFinite(opacity) && opacity <= 0.05) return false
        const area = r.width * r.height
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
        const coversCenter = r.left < (window.innerWidth * 0.6)
          && r.right > (window.innerWidth * 0.4)
          && r.top < (window.innerHeight * 0.6)
          && r.bottom > (window.innerHeight * 0.4)
        if (!coversCenter) return false
        return area >= (viewportArea * 0.2)
      })
      if (hasBlockingOverlay) return false

      const candidates = deepFind(document, 'table, [role="grid"], [role="table"], .ag-root-wrapper, input, button, soma-button')
      const hasInteractive = candidates.some((el) => {
        if (!isVis(el)) return false
        const style = window.getComputedStyle(el)
        if (!style) return false
        if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return false
        if (el.disabled) return false
        const ariaDisabled = el.getAttribute?.('aria-disabled')
        if (ariaDisabled === 'true') return false
        return true
      })
      return hasInteractive
    }).catch(() => false)
    if (ready) return true
    await delay(120)
  }
  return false
}

const closeInlineNotaViewer = async (job, page, options = {}) => {
  const maxAttempts = Number.isFinite(Number(options.maxAttempts))
    ? Math.max(1, Math.min(4, Number(options.maxAttempts)))
    : 3
  const settleTimeoutMs = Number.isFinite(Number(options.settleTimeoutMs))
    ? Math.max(500, Math.min(5000, Number(options.settleTimeoutMs)))
    : 2500
  const strictX = toBoolean(options.strictX, false)
  const allowFallbackEscape = options.allowFallbackEscape == null
    ? !strictX
    : toBoolean(options.allowFallbackEscape, !strictX)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const overlayVisibleBefore = await hasVisibleNotaOverlay(page)
    const blockingOverlayBefore = await hasBlockingNotasOverlay(page)
    if (!overlayVisibleBefore && !blockingOverlayBefore && !strictX) return true

    const clickedInfo = await page.evaluate((evalOptions = {}) => {
      const strictXMode = Boolean(evalOptions?.strictX)
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const hasNotaSignatureText = (value) => {
        const text = normalize(value || '')
        if (!text) return false
        if (/nota de negociacao|nota de corretagem/.test(text)) return true
        if (/modelo sinacor|modelo xp|baixar arquivo/.test(text)) return true
        if (/resumo dos negocios|resumo financeiro|liquido para/.test(text)) return true
        return false
      }
      const resolveClickable = (node) => {
        if (!node) return null
        const tag = (node.tagName || '').toLowerCase()
        if (tag === 'svg' || tag === 'path') {
          return node.closest
            ? node.closest('button, a, [role="button"], soma-icon, [soma-icon], .soma-icon')
            : null
        }
        if (tag === 'button' || tag === 'a') return node
        if (tag === 'soma-icon') return node
        if (node.getAttribute && node.getAttribute('role') === 'button') return node
        return node.closest ? node.closest('button, a, [role="button"], soma-icon, [soma-icon], .soma-icon') : null
      }
      const scoreRoot = (root) => {
        const text = normalize(root?.textContent || '')
        let s = 0
        if (/nota de negociacao|nota de corretagem/.test(text)) s += 90
        if (/modelo sinacor|modelo xp|baixar arquivo/.test(text)) s += 55
        if (/resumo dos negocios|resumo financeiro|liquido para/.test(text)) s += 25
        const r = root?.getBoundingClientRect?.()
        if (r && r.width > (window.innerWidth * 0.35) && r.height > (window.innerHeight * 0.25)) s += 8
        if (r && r.left <= (window.innerWidth * 0.22) && r.top <= (window.innerHeight * 0.2)) s += 4
        return s
      }

      const findRootByHeading = () => {
        const headings = deepFind(document, 'soma-heading, h1, h2, h3, [role="heading"], .soma-heading')
          .filter((el) => isVis(el))
        const notaHeading = headings.find((el) => /nota de negociacao|nota de corretagem/.test(normalize(el.textContent || '')))
        if (!notaHeading) return null
        let cursor = notaHeading
        for (let i = 0; i < 10 && cursor; i += 1) {
          if (isVis(cursor)) {
            const r = cursor.getBoundingClientRect()
            const text = normalize(cursor.textContent || '')
            const likelyModal = r.width > 320 && r.height > 220
              && (/baixar arquivo|modelo sinacor|modelo xp/.test(text) || cursor.querySelector?.('iframe[title*="nota" i]'))
            if (likelyModal) return cursor
          }
          cursor = cursor.parentElement
        }
        return null
      }

      const baseRoots = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')
        .filter((el) => isVis(el))
      const headingRoot = findRootByHeading()
      const rootCandidates = headingRoot ? [headingRoot, ...baseRoots] : baseRoots
      const rootUnique = [...new Set(rootCandidates)]
        .filter((el) => isVis(el))
      if (!rootCandidates.length) {
        return { clicked: false, reason: 'NO_MODAL' }
      }

      const rankedRoots = rootUnique
        .map((root) => {
          const text = normalize(root?.textContent || '')
          const hasNota = hasNotaSignatureText(text)
          const byHeading = headingRoot === root
          let score = scoreRoot(root)
          if (hasNota) score += 40
          if (byHeading) score += 90
          return { root, score, hasNota, byHeading }
        })
        .sort((a, b) => b.score - a.score)
      const chosenMeta = (rankedRoots.find((entry) => entry.hasNota)) || rankedRoots[0] || null
      const chosenRoot = chosenMeta?.root || null
      if (!chosenRoot || !chosenMeta) {
        return { clicked: false, reason: 'NO_MODAL_ROOT' }
      }
      if (strictXMode && !chosenMeta.hasNota) {
        return { clicked: false, reason: 'NO_NOTA_MODAL_ROOT' }
      }
      const rootRect = chosenRoot.getBoundingClientRect()

      const closeSelectors = [
        'soma-icon[icon="close"]',
        'soma-icon[name="close"]',
        'soma-icon[icon*="close" i]',
        'soma-icon[name*="close" i]',
        '[class*="heading-action" i] soma-icon[icon*="close" i]',
        '[class*="heading-action" i] soma-icon[name*="close" i]',
        '[class*="heading-action" i] [aria-label*="close" i]',
        '[class*="heading-action" i] [aria-label*="fechar" i]',
        'button[aria-label*="fechar" i]',
        'button[aria-label*="close" i]',
        '[role="button"][aria-label*="fechar" i]',
        '[role="button"][aria-label*="close" i]',
        'button[title*="fechar" i]',
        'button[title*="close" i]',
        '[role="button"][title*="fechar" i]',
        '[role="button"][title*="close" i]',
        '[data-testid*="close" i]',
        '[data-test*="close" i]',
      ]

      const scoreClose = (node) => {
        const r = node.getBoundingClientRect()
        const tag = normalize(node.tagName || '')
        const text = normalize(node.textContent || '')
        const classValue = typeof node.className === 'string'
          ? node.className
          : (node.className?.baseVal || '')
        const label = normalize(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${classValue || ''} ${node.getAttribute('icon') || ''} ${node.getAttribute('name') || ''}`)
        const combined = `${text} ${label}`
        let s = 0
        if (/\b(fechar|close|encerrar)\b/.test(combined)) s += 46
        if (/soma-icon/.test(combined) && /close/.test(combined)) s += 24
        if ((tag === 'soma-icon' || /soma-icon/.test(combined)) && /close/.test(combined)) s += 20
        if (text === 'x' || text === '×') s += 18
        if (/limpar|clear/.test(combined)) s -= 50
        if (/baixar|download|print|imprimir|zoom|girar|rotate|config|settings/.test(combined)) s -= 40
        if (r.top >= rootRect.top && r.top <= (rootRect.top + (rootRect.height * 0.28))) s += 22
        if (r.right >= (rootRect.left + (rootRect.width * 0.78))) s += 22
        if (!(r.top >= rootRect.top && r.top <= (rootRect.top + (rootRect.height * 0.4)))) s -= 18
        if (!(r.right >= (rootRect.left + (rootRect.width * 0.65)))) s -= 16
        // Penalizar itens muito fora do canto superior direito do modal.
        const dx = Math.abs(r.right - rootRect.right)
        const dy = Math.abs(r.top - rootRect.top)
        s += Math.max(0, 20 - Math.min(20, (dx / 20) + (dy / 20)))
        if (r.width <= 64 && r.height <= 64) s += 6
        if (r.width > (rootRect.width * 0.4) || r.height > (rootRect.height * 0.3)) s -= 12
        return s
      }

      const candidates = []
      for (const sel of closeSelectors) {
        const found = deepFind(chosenRoot, sel)
        for (const item of found) {
          const clickable = resolveClickable(item) || item
          if (!clickable || !isVis(clickable) || clickable.disabled) continue
          candidates.push(clickable)
        }
      }
      if (!candidates.length) {
        return { clicked: false, reason: 'NO_X_CANDIDATE' }
      }
      const unique = [...new Set(candidates)]
      unique.sort((a, b) => scoreClose(b) - scoreClose(a))
      const best = unique[0]
      const bestScore = best ? scoreClose(best) : 0
      const minScore = strictXMode ? 18 : 10
      if (!best || bestScore <= minScore) {
        return { clicked: false, reason: 'LOW_SCORE_X' }
      }
      try {
        best.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, view: window }))
      } catch {}
      try {
        best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window }))
      } catch {}
      try {
        best.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, composed: true, view: window }))
      } catch {}
      try {
        best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: window }))
      } catch {}
      try {
        best.click()
      } catch {
        return {
          clicked: false,
          reason: 'X_CLICK_ERROR',
          score: bestScore,
          rootScore: Number(chosenMeta?.score || 0),
          rootHasNota: Boolean(chosenMeta?.hasNota),
        }
      }
      return {
        clicked: true,
        reason: 'X_CLICKED',
        score: bestScore,
        rootScore: Number(chosenMeta?.score || 0),
        rootHasNota: Boolean(chosenMeta?.hasNota),
      }
    }, { strictX }).catch(() => ({ clicked: false, reason: 'EVAL_ERROR' }))
    const clicked = Boolean(clickedInfo?.clicked)

    if (!clicked) {
      if (allowFallbackEscape) {
        await page.keyboard.press('Escape').catch(() => null)
        await delay(120)
        await page.keyboard.press('Escape').catch(() => null)
      } else {
        appendJobLog(job, 'ui_reset', 'Fechamento no X nao encontrado nesta tentativa.', {
          attempt,
          strictX: true,
          reason: clickedInfo?.reason || 'unknown',
        })
      }
    } else {
      appendJobLog(job, 'ui_reset', 'Clique no X do modal executado.', {
        attempt,
        reason: clickedInfo?.reason || 'X_CLICKED',
        score: Number(clickedInfo?.score || 0),
        rootScore: Number(clickedInfo?.rootScore || 0),
        rootHasNota: Boolean(clickedInfo?.rootHasNota),
      })
    }

    await delay(180)
    const overlayVisible = await hasVisibleNotaOverlay(page)
    const blockingOverlay = await hasBlockingNotasOverlay(page)
    if (!overlayVisible && !blockingOverlay) {
      let interactive = await waitForNotasUiInteractable(page, settleTimeoutMs)
      if (!interactive) {
        // Segunda tentativa de destravar foco/overlay residual antes de seguir.
        if (!strictX) {
          await page.keyboard.press('Escape').catch(() => null)
        }
        await page.evaluate(() => {
          if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur()
          }
          document.body.click()
        }).catch(() => null)
        await delay(220)
        interactive = await waitForNotasUiInteractable(page, settleTimeoutMs)
      }
      if (!interactive) {
        appendJobLog(job, 'ui_reset', 'Overlay sumiu, mas interatividade nao confirmou no prazo; seguindo com cautela.', {
          attempt,
          settleTimeoutMs,
        })
      }
      return true
    }
    if (allowFallbackEscape && attempt < maxAttempts) {
      await page.evaluate(() => {
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur()
        }
        document.body.click()
      }).catch(() => null)
      await delay(220)
    }
  }

  return false
}

const extractApuracaoFromInlineNotaViewer = async (job, page, timeoutMs = 1800) => {
  // Aguardar ate que a nota carregue com valores (adaptive wait).
  // Se "teve leitura" (core values encontrados), retorna imediatamente.
  // Se nao, continua ate o timeout.
  const quickWaitMs = Math.max(12000, Math.min(90000, Number(timeoutMs) || 18000))
  let merged = {
    valorOperacoes: null,
    valorFinanceiro: null,
    taxaOperacional: null,
    taxaOperacionalSide: null,
    corretagem: null,
    isDayTrade: false,
    dayTradeReason: null,
    notaClassification: null,
    notaClassificationReason: null,
  }

  const hasCoreValues = (resumo) => (
    resumo &&
    resumo.valorOperacoes != null &&
    (resumo.taxaOperacional != null || resumo.corretagem != null)
  )

  // Detectar nota BMF pelo texto do viewer inline (MODELO XP BMF tem campos distintos)
  const detectBmfInlineText = (text) => {
    const norm = stripDiacriticsLower(String(text || '')).replace(/\s+/g, ' ')
    const bmfIndicators = [
      'taxa registro bm',
      'taxas bm&f',
      'taxas bmf',
      'custos bmf',
      'custos bm&f',
      'ajuste de posicao',
      'ajuste day trade',
      'taxa registro bmf',
      'taxa bmf',
      'venda disponivel',
      'compra disponivel',
      'vendas opcoes',
      'compras opcoes',
      'exercicio de opcoes',
      'oficio circular bmf',
    ]
    const bovespaIndicators = [
      'total cblc',
      'total bovespa',
      'taxa de liquidacao',
      'emolumentos',
      'liquido para',
    ]
    const bmfHits = bmfIndicators.filter((anchor) => norm.includes(anchor))
    const bovespaHits = bovespaIndicators.filter((anchor) => norm.includes(anchor))
    if (bovespaHits.length > 0) {
      return { isBmf: false, isBovespa: true, mixed: bmfHits.length > 0 }
    }
    if (bmfHits.length >= 2) {
      return { isBmf: true, isBovespa: false, mixed: false }
    }
    return { isBmf: false, isBovespa: false, mixed: false }
  }

  const clickViewerModelTab = async (modelName = 'xp') => {
    return page.evaluate((targetModel) => {
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const resolveClickable = (node) => {
        if (!node) return null
        const tag = (node.tagName || '').toLowerCase()
        if (tag === 'button' || tag === 'a') return node
        if (node.getAttribute && node.getAttribute('role') === 'button') return node
        return node.closest ? node.closest('button, a, [role="button"]') : null
      }

      const overlays = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')
        .filter((el) => isVis(el))
      if (!overlays.length) return false

      const allCandidates = []
      for (const overlay of overlays) {
        const nodes = deepFind(overlay, 'button, a, [role="button"], [role="tab"], span, div')
        for (const node of nodes) {
          const clickable = resolveClickable(node) || node
          if (!clickable || !isVis(clickable) || clickable.disabled) continue
          const text = normalize(clickable.textContent || '')
          const label = normalize(`${clickable.getAttribute?.('aria-label') || ''} ${clickable.getAttribute?.('title') || ''} ${clickable.className || ''}`)
          const combined = `${text} ${label}`
          if (targetModel === 'xp') {
            if (!/modelo\s*xp|\bxp\b/.test(combined)) continue
          } else if (!/sinacor/.test(combined)) {
            continue
          }
          allCandidates.push(clickable)
        }
      }
      if (!allCandidates.length) return false
      const target = allCandidates[0]
      target.click()
      return true
    }, String(modelName || 'xp').toLowerCase()).catch(() => false)
  }

  const clickViewerRefreshButton = async () => {
    const explicitLocators = [
      page.getByRole('button', { name: /atualizar/i }),
      page.locator('button:has-text("Atualizar"), a:has-text("Atualizar"), [role="button"]:has-text("Atualizar"), soma-button:has-text("Atualizar")'),
      page.getByText(/atualizar/i),
    ]
    for (const locator of explicitLocators) {
      const count = await locator.count().catch(() => 0)
      if (!count) continue
      const target = locator.first()
      const visible = await target.isVisible().catch(() => false)
      if (!visible) continue
      await target.click({ timeout: 1500 }).catch(() => null)
      return true
    }
    return false
  }

  const readModalSnapshot = async () => {
    return page.evaluate(() => {
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }

      const containers = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')
        .filter((el) => isVis(el))
      if (!containers.length) {
        return {
          hasModal: false,
          text: '',
          hasLoadError: false,
          hasUpdateButton: false,
          activeModel: null,
        }
      }

      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

      const scoreContainer = (el) => {
        const raw = String(el.innerText || el.textContent || '')
        const norm = normalize(raw)
        let score = 0
        if (/nota\s+de\s+negociacao|nota\s+de\s+corretagem/.test(norm)) score += 10
        if (/modelo\s+sinacor|modelo\s+xp/.test(norm)) score += 8
        if (/valor\s+das\s+operac|taxa\s+operacional|corretagem|custos\s+operacionais/.test(norm)) score += 12
        if (/baixar\s+arquivo|liquidacao/.test(norm)) score += 6
        if (/nao\s+foi\s+possivel\s+carregar\s+as\s+informacoes|atualizar/.test(norm)) score += 5
        return score
      }

      let best = null
      let bestScore = -1
      for (const c of containers) {
        const s = scoreContainer(c)
        if (s > bestScore) {
          best = c
          bestScore = s
        }
      }

      const raw = best ? String(best.innerText || best.textContent || '') : ''
      const normBest = normalize(raw)
      const hasLoadError = /nao\s+foi\s+possivel\s+carregar\s+as\s+informacoes/.test(normBest)

      let hasUpdateButton = false
      let activeModel = null
      const tabNodes = deepFind(best, 'button, a, [role="button"], [role="tab"], span, div')
      for (const node of tabNodes) {
        if (!isVis(node)) continue
        const text = normalize(node.textContent || '')
        const label = normalize(`${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''} ${node.className || ''}`)
        const combined = `${text} ${label}`
        if (/atualizar/.test(combined)) hasUpdateButton = true
        const selected = node.getAttribute?.('aria-selected') === 'true'
          || /active|selected|current|is-active/.test(label)
        if (!selected) continue
        if (/modelo\s*xp|\bxp\b/.test(combined)) {
          activeModel = 'XP'
          break
        }
        if (/sinacor/.test(combined)) {
          activeModel = 'SINACOR'
        }
      }

      return {
        hasModal: true,
        text: raw.replace(/\s+/g, ' ').trim(),
        hasLoadError,
        hasUpdateButton,
        activeModel,
      }
    }).catch(() => ({
      hasModal: false,
      text: '',
      hasLoadError: false,
      hasUpdateButton: false,
      activeModel: null,
    }))
  }

  let sawModal = false
  let switchedToXp = false
  let loadedModel = 'SINACOR'
  let sinacorRefreshCount = 0
  let xpRefreshCount = 0
  const MAX_REFRESH_PER_MODEL = 3
  const REFRESH_WAIT_MS = 3500
  const startedAt = now()

  while (now() - startedAt < quickWaitMs) {
    const snap = await readModalSnapshot()
    if (!snap.hasModal) {
      await delay(110)
      continue
    }
    sawModal = true
    if (snap.activeModel) {
      loadedModel = snap.activeModel
    }
    const text = snap.text || ''
    if (text) {
      merged = mergeApuracaoResumo(merged, parseApuracaoResumoFromText(text))

      // Detect BMF note from inline text (skip immediately if BMF-only)
      const bmfDetect = detectBmfInlineText(text)
      if (bmfDetect.isBmf && !bmfDetect.isBovespa) {
        merged.notaClassification = 'BMF'
        merged.notaClassificationReason = 'BMF detectado no viewer inline'
        appendJobLog(job, 'pdf', 'Nota BMF detectada no viewer inline; sera ignorada.', {
          model: loadedModel,
          elapsedMs: now() - startedAt,
        })
        break
      }
      if (bmfDetect.isBovespa) {
        merged.notaClassification = bmfDetect.mixed ? 'BOVESPA+BMF' : 'BOVESPA'
      }
    }

    // Se ja tem valores core (teve leitura), retorna imediatamente
    if (hasCoreValues(merged) || merged.isDayTrade) {
      appendJobLog(job, 'pdf', 'Valores core encontrados no viewer inline; prosseguindo.', {
        model: loadedModel,
        elapsedMs: now() - startedAt,
        valorOperacoes: merged.valorOperacoes,
        taxaOperacional: merged.taxaOperacional,
        corretagem: merged.corretagem,
      })
      break
    }

    const elapsed = now() - startedAt

    // Logica de retry SINACOR: se erro de conexao, clicar Atualizar ate 3x
    if (snap.hasLoadError && snap.hasUpdateButton && !switchedToXp) {
      if (sinacorRefreshCount < MAX_REFRESH_PER_MODEL) {
        sinacorRefreshCount += 1
        const refreshed = await clickViewerRefreshButton()
        appendJobLog(job, 'pdf', refreshed
          ? `Botao Atualizar acionado no MODELO SINACOR (tentativa ${sinacorRefreshCount}/${MAX_REFRESH_PER_MODEL}).`
          : `Falha ao clicar Atualizar no MODELO SINACOR (tentativa ${sinacorRefreshCount}/${MAX_REFRESH_PER_MODEL}).`, {
          elapsedMs: elapsed,
          model: 'SINACOR',
          attempt: sinacorRefreshCount,
        })
        if (refreshed) {
          // Aguardar carregamento apos refresh
          await delay(REFRESH_WAIT_MS)
          continue
        }
      } else if (sinacorRefreshCount >= MAX_REFRESH_PER_MODEL && !switchedToXp) {
        // SINACOR esgotou retries: trocar para MODELO XP
        const switched = await clickViewerModelTab('xp')
        if (switched) {
          switchedToXp = true
          loadedModel = 'XP'
          appendJobLog(job, 'pdf', `MODELO SINACOR falhou apos ${MAX_REFRESH_PER_MODEL} tentativas de Atualizar; alternando para MODELO XP.`, {
            elapsedMs: elapsed,
          })
          await delay(REFRESH_WAIT_MS)
          continue
        }
      }
    }

    // Logica de retry MODELO XP: se erro de conexao no XP, clicar Atualizar ate 3x
    if (snap.hasLoadError && snap.hasUpdateButton && switchedToXp) {
      if (xpRefreshCount < MAX_REFRESH_PER_MODEL) {
        xpRefreshCount += 1
        const refreshed = await clickViewerRefreshButton()
        appendJobLog(job, 'pdf', refreshed
          ? `Botao Atualizar acionado no MODELO XP (tentativa ${xpRefreshCount}/${MAX_REFRESH_PER_MODEL}).`
          : `Falha ao clicar Atualizar no MODELO XP (tentativa ${xpRefreshCount}/${MAX_REFRESH_PER_MODEL}).`, {
          elapsedMs: elapsed,
          model: 'XP',
          attempt: xpRefreshCount,
        })
        if (refreshed) {
          await delay(REFRESH_WAIT_MS)
          continue
        }
      }
    }

    // Se SINACOR sem erro mas sem valores e ja passou 40% do tempo, trocar para XP
    if (!snap.hasLoadError && !switchedToXp && elapsed > Math.floor(quickWaitMs * 0.40)) {
      const switched = await clickViewerModelTab('xp')
      if (switched) {
        switchedToXp = true
        loadedModel = 'XP'
        appendJobLog(job, 'pdf', 'SINACOR demorou sem retornar valores; alternando para MODELO XP.', {
          elapsedMs: elapsed,
        })
        await delay(1200)
        continue
      }
    }

    await delay(150)
  }

  if (!sawModal) return null
  const hasCore = hasCoreValues(merged) || merged.isDayTrade
  return {
    ...merged,
    loadedInline: true,
    loadedModel,
    hasCoreValues: hasCore,
    pagesScanned: 0,
    totalPages: 0,
  }
}

const prepareExtraPage = async (page) => {
  if (!page) return
  page.setDefaultTimeout(8000)
  // NAO bloquear SVGs — SOMA Design System carrega icones via SVG requests
  await page.route(/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|otf|mp4|webm|ogg)$/i, (route) => route.abort()).catch(() => null)
  await page.route(/\.(css)$/i, (route) => {
    const url = route.request().url()
    if (/fonts\.googleapis|fonts\.gstatic|typekit|fontawesome/i.test(url)) {
      return route.abort()
    }
    return route.continue()
  }).catch(() => null)
  await page.route(/google-analytics|googletagmanager|hotjar|segment|amplitude|mixpanel|facebook.*pixel|doubleclick|datadog|datadoghq|ddsource=browser|ddtags=|\/pub[a-f0-9]{20,}/i, (route) => route.abort()).catch(() => null)
}

const DEFAULT_NOTAS_URL = 'https://hub.xpi.com.br/new/renda-variavel/#/notas-de-negociacao'

const ensureNotasNegociacaoView = async (job, page, notesUrl, options = {}) => {
  const targetUrl = scrubText(notesUrl || process.env.HUBXP_NOTAS_NEGOCIACAO_URL || DEFAULT_NOTAS_URL)
  const entryUrl = scrubText(process.env.HUBXP_ENTRY_URL || DEFAULT_ENTRY_URL)
  const notesOnly = toBoolean(options.notesOnly, false)
  const menuFallbackInNotesOnly = toBoolean(options.menuFallbackInNotesOnly, false)

  appendJobLog(job, 'notas_nav', 'Abrindo Notas de Negociacao', {
    targetUrl: targetUrl || '(via menu)',
    entryUrl,
    notesOnly,
  })

  const navigateByMenu = async () => {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null),
      delay(1500),
    ])

    const steps = [
      ['Investimento', 'Investimentos'],
      ['Renda Variável', 'Renda Variavel', 'Renda variavel'],
      ['Operacional', 'Opera\u00e7\u00f5es', 'Operacoes'],
      ['Notas de negocia\u00e7\u00e3o', 'Notas de Negociacao', 'Notas negocia\u00e7\u00e3o', 'Notas negociacao'],
    ]

    for (const labels of steps) {
      const clicked = await clickSidebarItem(page, labels, { timeout: 5000 })
      if (!clicked) {
        // Fallback generico
        await clickByTexts(page, labels, { timeout: 5000 }).catch(() => null)
      }
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null),
        delay(900),
      ])
    }
  }

  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null)
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null),
      delay(1200),
    ])
    const directUrl = String(page.url() || '').toLowerCase()
    const looksLikeNotas = /notas-de-negociacao|notas\s*de\s*negociacao|notas\s*de\s*corretagem/.test(directUrl)
    if (!looksLikeNotas) {
      if (notesOnly) {
        appendJobLog(job, 'notas_nav', 'URL direta nao abriu Notas. Repetindo acesso direto sem fallback para Home.', {
          currentUrl: directUrl || null,
        })
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null)
        await Promise.race([
          page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null),
          delay(1200),
        ])
        const retryDirectUrl = String(page.url() || '').toLowerCase()
        const retryLooksLikeNotas = /notas-de-negociacao|notas\s*de\s*negociacao|notas\s*de\s*corretagem/.test(retryDirectUrl)
        if (!retryLooksLikeNotas) {
          if (menuFallbackInNotesOnly) {
            appendJobLog(job, 'notas_nav', 'Acesso direto falhou no modo notes-only. Tentando contingencia via menu.', {
              currentUrl: retryDirectUrl || null,
            })
            await navigateByMenu()
          } else {
            throw createHttpError(
              502,
              'NOTAS_DIRECT_URL_FAILED',
              'Nao foi possivel abrir diretamente a tela de Notas de Negociacao.',
              { url: retryDirectUrl || null, targetUrl },
              'notas_nav',
            )
          }
        }
      } else {
        appendJobLog(job, 'notas_nav', 'URL direta nao abriu Notas. Tentando fallback via menu...')
        await navigateByMenu()
      }
    }
  } else {
    if (notesOnly) {
      throw createHttpError(
        400,
        'NOTAS_URL_REQUIRED',
        'URL de Notas obrigatoria para modo notes-only.',
        null,
        'notas_nav',
      )
    }
    await navigateByMenu()
  }

  // Esperar pagina estabilizar (SPA pode demorar para renderizar conteudo)
  // Esperar pelo soma-datepicker que e essencial para o filtro de data
  await Promise.race([
    page.waitForSelector('soma-datepicker, input[type="date"], [class*="datepicker" i]', { timeout: 8000 }).catch(() => null),
    page.waitForSelector('input, button, table, [role="grid"]', { timeout: 6000 }).catch(() => null),
  ])
  // Dar tempo extra para web components SOMA renderizarem (Shadow DOM pode demorar em browsers novos)
  await delay(1200)

  // Verificar se chegou na pagina certa — aceitar qualquer variante do titulo
  try {
    const body = stripDiacriticsLower(await page.locator('body').innerText())
    if (
      body.includes('notas de negociacao') ||
      body.includes('nota de negociacao') ||
      body.includes('notas de corretagem') ||
      body.includes('nota de corretagem')
    ) return true
  } catch {
    // noop
  }

  // Fallback: verificar se existem elementos de filtro da pagina (input de conta, botao filtrar)
  const hasFilterForm = await page.evaluate(() => {
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }
    // Buscar input de conta/cliente
    const inputs = deepFind(document, 'input')
    for (const inp of inputs) {
      const ph = (inp.placeholder || '').toLowerCase()
      const label = (inp.getAttribute('aria-label') || '').toLowerCase()
      const combined = ph + ' ' + label
      if (/c[oó]d|cliente|conta/i.test(combined)) return true
    }
    // Buscar botao "Filtrar"
    const buttons = deepFind(document, 'button')
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase()
      if (text === 'filtrar' || text === 'buscar') return true
    }
    return false
  }).catch(() => false)

  if (hasFilterForm) {
    appendJobLog(job, 'notas_nav', 'Pagina identificada via formulario de filtros')
    return true
  }

  // Fallback: se existe uma tabela visivel, seguir (a pagina pode nao ter titulo facil)
  if (await pickTableLocator(page)) return true

  throw createHttpError(
    502,
    'NOTAS_PAGE_NOT_FOUND',
    'Nao foi possivel chegar na tela de Notas de Negociacao no HubXP.',
    { url: getPageUrl(page) },
    'notas_nav',
  )
}

const NOTAS_CLIENT_INPUT_SELECTORS = [
  'input[placeholder*="c\u00f3d" i]',
  'input[aria-label*="c\u00f3d" i]',
  'input[placeholder*="cod" i]',
  'input[aria-label*="cod" i]',
  'input[name*="cod" i]',
  'input[placeholder*="conta" i]',
  'input[aria-label*="conta" i]',
  'input[name*="conta" i]',
  'input[placeholder*="cliente" i]',
  'input[aria-label*="cliente" i]',
  'input[type="search"]',
]

const clearClientCodeInputViaX = async (job, page, inputRef = null) => {
  const locateInput = async () => {
    if (inputRef?.locator) return inputRef
    let found = await pickVisibleLocator(page, NOTAS_CLIENT_INPUT_SELECTORS)
    if (found?.locator) return found
    for (const sel of NOTAS_CLIENT_INPUT_SELECTORS) {
      try {
        const loc = page.locator(sel).first()
        if (await loc.count() === 0) continue
        if (!(await loc.isVisible({ timeout: 160 }).catch(() => false))) continue
        found = { locator: loc, selector: sel }
        break
      } catch {
        // tentar proximo
      }
    }
    return found || null
  }

  const target = await locateInput()
  if (!target?.locator) {
    appendJobLog(job, 'ui_reset', 'Nao foi possivel localizar input de cliente para limpar.')
    return {
      ok: false,
      clickedX: false,
      beforeValue: '',
      afterValue: '',
      selectionCleared: false,
    }
  }

  const beforeValue = scrubText(await readLocatorValue(target.locator))
  appendJobLog(job, 'ui_reset', 'Limpando campo Cód. do cliente', {
    selector: target.selector || null,
    beforeValue,
  })

  const clearResult = await page.evaluate((selector) => {
    const deepFind = (root, query) => {
      const out = []
      try { out.push(...root.querySelectorAll(query)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, query)) } catch {}
        }
      }
      return out
    }
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()

    const pickInput = () => {
      if (selector) {
        try {
          const bySelector = document.querySelector(selector)
          if (bySelector && bySelector.tagName && bySelector.tagName.toLowerCase() === 'input' && isVis(bySelector)) {
            return bySelector
          }
        } catch {
          // fallback abaixo
        }
      }
      const inputs = deepFind(document, 'input')
      for (const inp of inputs) {
        if (!isVis(inp)) continue
        const combined = normalize(`${inp.placeholder || ''} ${inp.getAttribute('aria-label') || ''} ${inp.name || ''} ${inp.id || ''}`)
        if (/c[oó]d|cod|conta|cliente/.test(combined)) return inp
      }
      return null
    }

    const input = pickInput()
    if (!input) {
      return {
        clickedX: false,
        valueBefore: '',
        valueAfter: '',
        selectionCleared: false,
      }
    }

    const valueBefore = String(input.value || '')
    const oldDigits = valueBefore.replace(/\D/g, '')
    const roots = []
    let cursor = input
    for (let i = 0; i < 7 && cursor; i += 1) {
      roots.push(cursor)
      cursor = cursor.parentElement
    }
    if (document.body) roots.push(document.body)

    const resolveClickable = (node) => {
      if (!node) return null
      const tag = (node.tagName || '').toLowerCase()
      if (tag === 'button' || tag === 'a') return node
      if (node.getAttribute && node.getAttribute('role') === 'button') return node
      return node.closest ? node.closest('button, a, [role="button"]') : null
    }

    const scoreClearCandidate = (node) => {
      if (!node || !isVis(node)) return 0
      const target = resolveClickable(node) || node
      if (!target || !isVis(target) || target.disabled) return 0

      const label = normalize(`${target.getAttribute('aria-label') || ''} ${target.getAttribute('title') || ''} ${target.className || ''}`)
      const text = normalize(target.textContent || '')
      const combo = `${label} ${text}`
      const r = target.getBoundingClientRect()
      const ir = input.getBoundingClientRect()

      let score = 0
      if (/limpar|clear/.test(combo)) score += 30
      if (/fechar|close/.test(combo)) score += 16
      if (text === 'x') score += 12
      if (/icon-close|btn-close|clear|close/.test(label)) score += 10
      if (r.left >= (ir.left + (ir.width * 0.55))) score += 8
      if (r.width <= 48 && r.height <= 48) score += 4
      return score
    }

    const candidates = []
    for (const root of roots) {
      if (!root) continue
      const found = deepFind(root, 'button, a, [role="button"], [class*="clear" i], [class*="close" i], soma-icon, svg, span')
      for (const node of found) {
        const clickable = resolveClickable(node) || node
        if (!clickable || !isVis(clickable) || clickable.disabled) continue
        candidates.push(clickable)
      }
    }
    const unique = [...new Set(candidates)]
    unique.sort((a, b) => scoreClearCandidate(b) - scoreClearCandidate(a))
    const best = unique[0] || null
    const bestScore = best ? scoreClearCandidate(best) : 0

    let clickedX = false
    if (best && bestScore > 0) {
      best.click()
      clickedX = true
    }

    if (!clickedX) {
      input.focus()
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    }

    const valueAfter = String(input.value || '')
    const rootTexts = roots
      .map((root) => normalize(root?.textContent || ''))
      .join(' ')
      .slice(0, 1600)
    const selectionCleared = !oldDigits || !rootTexts.includes(oldDigits)

    return {
      clickedX,
      valueBefore,
      valueAfter,
      selectionCleared,
    }
  }, target.selector || null).catch(() => ({
    clickedX: false,
    valueBefore: beforeValue,
    valueAfter: '',
    selectionCleared: false,
  }))

  const afterValue = scrubText(await readLocatorValue(target.locator))
  const cleared = afterValue === ''
  appendJobLog(job, 'ui_reset', clearResult.clickedX
    ? 'Campo de cliente limpo via botao X interno.'
    : 'Botao X interno indisponivel; limpeza aplicada via fallback.', {
    clickedX: Boolean(clearResult.clickedX),
    beforeValue: scrubText(clearResult.valueBefore || beforeValue),
    afterValue,
    inputCleared: cleared,
    selectionCleared: Boolean(clearResult.selectionCleared),
  })

  return {
    ok: cleared,
    clickedX: Boolean(clearResult.clickedX),
    beforeValue: scrubText(clearResult.valueBefore || beforeValue),
    afterValue,
    selectionCleared: Boolean(clearResult.selectionCleared),
  }
}

const selectContaOnNotas = async (job, page, contaRaw, options = {}) => {
  const digits = String(contaRaw || '').replace(/\D/g, '')
  if (!digits) return false
  const retryingSelection = Boolean(options.retryingSelection)

  appendJobLog(job, 'notas_filter', 'Selecionando conta', { conta: digits })

  // Pre-aguardar web components renderizarem (Shadow DOM pode demorar em browsers novos)
  if (!retryingSelection) {
    await Promise.race([
      page.waitForSelector('soma-datepicker, input[placeholder*="cód" i], input[placeholder*="cod" i], input[placeholder*="conta" i]', { timeout: 6000 }).catch(() => null),
      delay(2000),
    ])
  }

  const locateClientInput = async (maxAttempts = 16) => {
    let located = null
    for (let attempt = 0; attempt < maxAttempts && !located; attempt += 1) {
      located = await pickVisibleLocator(page, NOTAS_CLIENT_INPUT_SELECTORS)
      if (!located) {
        if (attempt === 0) {
          appendJobLog(job, 'notas_filter', 'pickVisibleLocator falhou, tentando Playwright locators (Shadow DOM)...')
        }
        for (const sel of NOTAS_CLIENT_INPUT_SELECTORS) {
          try {
            const loc = page.locator(sel).first()
            if (await loc.count() > 0 && await loc.isVisible({ timeout: 150 }).catch(() => false)) {
              located = { locator: loc, selector: sel }
              appendJobLog(job, 'notas_filter', 'Input encontrado via Playwright locator', { selector: sel })
              break
            }
          } catch { /* continue */ }
        }
      }
      if (!located) await delay(220)
    }
    return located
  }

  const deepFillConta = async () => {
    const filled = await page.evaluate((value) => {
      function deepFind(root, selector) {
        const results = []
        try { results.push(...root.querySelectorAll(selector)) } catch {}
        const allEls = root.querySelectorAll('*')
        for (const el of allEls) {
          if (el.shadowRoot) {
            try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return results
      }
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const inputs = deepFind(document, 'input')
      for (const inp of inputs) {
        if (!isVis(inp)) continue
        const ph = String(inp.placeholder || '').toLowerCase()
        const aria = String(inp.getAttribute('aria-label') || '').toLowerCase()
        const name = String(inp.getAttribute('name') || '').toLowerCase()
        const id = String(inp.getAttribute('id') || '').toLowerCase()
        const combined = `${ph} ${aria} ${name} ${id}`
        if (!/c[oó]d|cod|conta|cliente/.test(combined)) continue
        inp.focus()
        inp.value = ''
        inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        inp.value = String(value || '')
        inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
        return true
      }
      return false
    }, digits).catch(() => false)
    if (filled) {
      appendJobLog(job, 'notas_filter', 'Campo de conta preenchido via busca profunda no DOM.')
    }
    return Boolean(filled)
  }

  // pickVisibleLocator usa document.querySelector — NAO penetra Shadow DOM.
  // Playwright locators penetram Shadow DOM automaticamente, entao usamos como fallback.
  let input = await locateClientInput(16)
  let deepFilled = false
  if (!input) {
    deepFilled = await deepFillConta()
  }

  // Recuperacao: se ainda nao encontrou campo, reabrir Notas e tentar novamente.
  if (!input && !deepFilled) {
    appendJobLog(job, 'notas_filter', 'Campo de conta/cliente nao encontrado; tentando recuperar tela de Notas e repetir.', {
      conta: digits,
    })
    await ensureNotasNegociacaoView(job, page, null, { notesOnly: true }).catch(() => null)
    await delay(350)
    input = await locateClientInput(24)
    if (!input) {
      deepFilled = await deepFillConta()
    }
  }

  if (input) {
    try {
      await clearClientCodeInputViaX(job, page, input)
      await input.locator.click({ timeout: 1500 }).catch(() => null)
      await input.locator.fill(digits).catch(async () => {
        await input.locator.fill('').catch(() => null)
        await input.locator.type(digits, { delay: 30 }).catch(() => null)
      })
    } catch {
      // noop
    }
  } else if (!deepFilled) {
    appendJobLog(job, 'notas_filter', 'Campo de conta/cliente nao encontrado')
    return false
  }

  // Estrategia 1: Playwright locators (penetram Shadow DOM automaticamente)
  // Esperar ate 4s pela sugestao do autocomplete usando locators nativos
  const pollStart = now()
  let picked = null

  // Locators Playwright que penetram Shadow DOM:
  const autocompleteSelectors = [
    `[role="option"]:has-text("${digits}")`,
    `[role="listbox"] >> text=${digits}`,
    `soma-option:has-text("${digits}")`,
    `.autocomplete-item:has-text("${digits}")`,
    `li:has-text("${digits}")`,
  ]

  // Tentar encontrar via Playwright locators (metodo mais robusto)
  for (let attempt = 0; attempt < 15 && !picked; attempt += 1) {
    for (const sel of autocompleteSelectors) {
      try {
        const loc = page.locator(sel).first()
        if (await loc.isVisible({ timeout: 80 }).catch(() => false)) {
          const text = await loc.textContent().catch(() => '') || ''
          await loc.click({ timeout: 1000, force: true })
          picked = text.replace(/\s+/g, ' ').trim().slice(0, 120)
          appendJobLog(job, 'notas_filter', 'Conta selecionada via Playwright locator', { picked, selector: sel })
          break
        }
      } catch { /* continue */ }
    }
    if (!picked) {
      // Fallback: tentar getByText com regex para "Conta XP" + digitos
      try {
        const loc = page.getByText(new RegExp(`Conta\\s*XP[:\\s]*${digits}`, 'i')).first()
        if (await loc.isVisible({ timeout: 80 }).catch(() => false)) {
          const text = await loc.textContent().catch(() => '') || ''
          await loc.click({ timeout: 1000, force: true })
          picked = text.replace(/\s+/g, ' ').trim().slice(0, 120)
          appendJobLog(job, 'notas_filter', 'Conta selecionada via getByText (Conta XP)', { picked })
          break
        }
      } catch { /* continue */ }
    }
    if (!picked) await delay(150)
  }

  // Estrategia 2: page.evaluate deepFind como ultimo fallback
  if (!picked) {
    for (let attempt = 0; attempt < 8 && !picked; attempt += 1) {
      picked = await page.evaluate((needle) => {
        function deepFind(root, selector) {
          const results = []
          try { results.push(...root.querySelectorAll(selector)) } catch {}
          const allEls = root.querySelectorAll('*')
          for (const el of allEls) {
            if (el.shadowRoot) {
              try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
            }
          }
          return results
        }
        const isVis = (el) => {
          if (!el) return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const optionSelectors = '[role="option"], [role="listbox"] > *, soma-option, .autocomplete-item, li'
        const options = deepFind(document, optionSelectors)
        for (const el of options) {
          if (!isVis(el)) continue
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (text.includes(needle)) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' })
            el.click()
            return text.slice(0, 120)
          }
        }
        const fallbackEls = deepFind(document, 'button, a, div, span')
        for (const el of fallbackEls) {
          if (!isVis(el)) continue
          const r = el.getBoundingClientRect()
          if (r.width > 600 && r.height > 200) continue
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (!text || text.length > 200) continue
          if (text.includes(needle) && /conta\s*xp|xp\s*:/i.test(text)) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' })
            el.click()
            return text.slice(0, 120)
          }
        }
        return null
      }, digits).catch(() => null)
      if (!picked) await delay(150)
    }
  }

  if (picked) {
    appendJobLog(job, 'notas_filter', 'Conta selecionada via sugestao', { picked, waitMs: now() - pollStart })
  } else {
    appendJobLog(job, 'notas_filter', 'Nenhuma sugestao encontrada apos tentativas, tentando Enter...')
    if (input?.locator) {
      await input.locator.press('Enter').catch(() => null)
    } else {
      await page.keyboard.press('Enter').catch(() => null)
    }
  }

  const confirmed = picked ? true : await page.evaluate((needle) => {
    function deepFind(root, selector) {
      const results = []
      try { results.push(...root.querySelectorAll(selector)) } catch {}
      const allEls = root.querySelectorAll('*')
      for (const el of allEls) {
        if (el.shadowRoot) {
          try { results.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return results
    }
    const isVis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const digits = String(needle || '').replace(/\D/g, '')
    if (!digits) return false

    // 1) Campo de conta contendo o codigo digitado.
    const inputs = deepFind(document, 'input')
    for (const inp of inputs) {
      if (!isVis(inp)) continue
      const v = String(inp.value || '').replace(/\D/g, '')
      if (v && v.includes(digits)) return true
    }

    // 2) Texto visivel indicando conta selecionada.
    const candidates = deepFind(document, '[role="option"], [role="combobox"], [class*="selected" i], [class*="chip" i], span, div')
    for (const el of candidates) {
      if (!isVis(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width > 800 || r.height > 120) continue
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (!text || text.length > 220) continue
      if (!text.includes(digits)) continue
      if (/conta\s*xp|xp\s*:|conta|cliente/i.test(text)) return true
    }

    return false
  }, digits).catch(() => false)

  if (!confirmed) {
    if (!retryingSelection) {
      appendJobLog(job, 'notas_filter', 'Conta nao confirmada apos digitacao. Reabrindo Notas e tentando novamente uma unica vez.', {
        conta: digits,
      })
      await ensureNotasNegociacaoView(job, page, null, { notesOnly: true }).catch(() => null)
      await delay(350)
      return selectContaOnNotas(job, page, digits, { retryingSelection: true })
    }
    appendJobLog(job, 'notas_filter', 'Conta nao confirmada apos segunda tentativa. Conta sera pulada para evitar filtro incorreto.', {
      conta: digits,
    })
    return false
  }

  appendJobLog(job, 'notas_filter', 'Conta confirmada no filtro.', {
    conta: digits,
    confirmed: true,
  })

  // Alguns componentes so consolidam o autocomplete apos "commit" (Enter/blur).
  await page.keyboard.press('Enter').catch(() => null)
  await delay(80)
  await delay(100)
  return true
}

const getNotasTable = async (job, page) => {
  let table = await pickTableLocator(page)
  if (!table) {
    await page.waitForSelector('table, [role="grid"], [role="table"], .ag-root-wrapper, [role="row"]', { timeout: 4000 }).catch(() => null)
    table = await pickTableLocator(page)
  }
  if (!table) {
    throw createHttpError(502, 'NOTAS_TABLE_NOT_FOUND', 'Tabela de Notas de Negociacao nao encontrada.', null, 'notas_table')
  }
  return table
}

const buildRowSignature = (row = {}) => {
  if (!row || typeof row !== 'object') return ''
  const keys = Object.keys(row).sort()
  return keys.map((key) => `${key}:${scrubText(row[key])}`).join('|')
}

const collectNotasRowsFromAllPages = async (job, page, options = {}) => {
  const maxPages = Number.isFinite(Number(options.maxPages))
    ? Math.max(1, Math.min(200, Number(options.maxPages)))
    : 120
  const onPage = typeof options.onPage === 'function' ? options.onPage : null

  const allRows = []
  const dedupe = new Set()
  const visitedPageSignatures = new Set()
  let headers = []
  let pagesScanned = 0
  let pageNumber = 1
  let totalPages = null
  let repeatedSignatureHits = 0

  const movedToFirst = await clickFirstPage(page)
  if (movedToFirst) {
    await Promise.race([
      waitForOrdersResponse(page, 3500),
      delay(1400),
    ])
    await delay(240)
  }

  while (pageNumber <= maxPages) {
    const table = await getNotasTable(job, page)
    const extracted = await extractTableRows(table)
    pagesScanned += 1

    if (!headers.length && extracted.headers.length) {
      headers = extracted.headers
    }

    for (const row of extracted.rows || []) {
      const key = buildRowSignature(row)
      if (key && dedupe.has(key)) continue
      if (key) dedupe.add(key)
      allRows.push(row)
    }

    const indicator = await findPageIndicator(page)
    if (indicator) {
      const current = Number(indicator.current)
      const total = Number(indicator.total)
      if (Number.isFinite(current) && current > 0) pageNumber = current
      if (Number.isFinite(total) && total > 0) totalPages = total
    }

    const tableSignature = await getNotasTableSignature(page)
    if (tableSignature) {
      if (visitedPageSignatures.has(tableSignature)) {
        repeatedSignatureHits += 1
      } else {
        visitedPageSignatures.add(tableSignature)
        repeatedSignatureHits = 0
      }
    }

    appendJobLog(job, 'notas_pagination', 'Pagina de notas coletada', {
      page: pageNumber,
      totalPages: totalPages || null,
      rowsInPage: Array.isArray(extracted.rows) ? extracted.rows.length : 0,
      rowsTotal: allRows.length,
    })

    if (onPage) {
      await onPage({
        table,
        headers: extracted.headers || headers,
        rows: Array.isArray(extracted.rows) ? extracted.rows : [],
        page: pageNumber,
        totalPages: totalPages || null,
        pagesScanned,
      })
    }

    if (totalPages && pageNumber >= totalPages) {
      break
    }
    if (repeatedSignatureHits >= 2) {
      appendJobLog(job, 'notas_pagination', 'Tabela repetiu assinatura apos paginacao; encerrando varredura para evitar loop.', {
        page: pageNumber,
      })
      break
    }

    const clicked = await clickNextPage(page)
    if (!clicked) {
      break
    }
    await Promise.race([
      waitForOrdersResponse(page, 3500),
      delay(1300),
    ])
    await delay(260)
    if (!totalPages) {
      pageNumber += 1
    }
  }

  return {
    headers,
    rows: allRows,
    pagesScanned: Math.max(1, pagesScanned),
    totalPages: totalPages || null,
  }
}

const clickPdfIconForRow = async (job, page, table, rowIndex, timeoutMs = 15000, options = {}) => {
  const noteLoadTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(6000, Math.min(35000, Number(timeoutMs)))
    : 14000
  const urlSkip = Number.isFinite(Number(options.urlSkip))
    ? Math.max(0, Number(options.urlSkip))
    : 0
  const preferPdfBytes = toBoolean(options.preferPdfBytes, true)
  const hasInlineCosts = (summary) => {
    if (!summary) return false
    if (summary.isDayTrade) return true
    return summary.taxaOperacional != null || summary.corretagem != null
  }

  appendJobLog(job, 'pdf', 'Abrindo nota para extracao', {
    rowIndex,
    noteLoadTimeoutMs,
  })

  const isPdfResponse = (response) => {
    try {
      const url = String(response?.url?.() || '')
      if (!url) return false
      const ct = String(response.headers()?.['content-type'] || response.headers()?.['Content-Type'] || '')
      if (ct.toLowerCase().includes('application/pdf')) return true
      return url.toLowerCase().includes('.pdf') || /pdf/i.test(ct)
    } catch {
      return false
    }
  }

  const downloadPromise = page.waitForEvent('download', { timeout: noteLoadTimeoutMs })
    .then((download) => ({ type: 'download', download }))
  const responsePromise = page.waitForResponse(isPdfResponse, { timeout: noteLoadTimeoutMs })
    .then((response) => ({ type: 'response', response }))
  const popupPromise = page.waitForEvent('popup', { timeout: noteLoadTimeoutMs })
    .then((popup) => ({ type: 'popup', popup }))

  // Evitar unhandled rejections em timeouts
  downloadPromise.catch(() => null)
  responsePromise.catch(() => null)
  popupPromise.catch(() => null)

  const clicked = await table.evaluate((el, index) => {
    const isVis = (node) => {
      if (!node) return false
      const r = node.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    const pickRows = () => {
      const tbody = el.querySelector('tbody')
      if (tbody) {
        const trs = Array.from(tbody.querySelectorAll('tr'))
        if (trs.length) return trs
      }
      const roleRows = Array.from(el.querySelectorAll('[role="row"]'))
      if (roleRows.length > 1) return roleRows.slice(1)
      const trs = Array.from(el.querySelectorAll('tr'))
      if (trs.length > 1) return trs.slice(1)
      return []
    }

    const rows = pickRows()
    const row = rows[index]
    if (!row) return false
    row.scrollIntoView({ behavior: 'instant', block: 'center' })

    // Priorizar botoes com aria-label/title relacionado a PDF/download
    // Tambem detectar botoes com apenas icone SVG (sem texto visivel)
    const candidates = Array.from(row.querySelectorAll('button, a, [role="button"], soma-icon, [class*="action"], [class*="icon"]'))
      .filter((node) => {
        if (node.disabled) return false
        // Para botoes, verificar visibilidade normalmente
        if (isVis(node)) return true
        // Verificar se o parent button/link e visivel (icone pode ter tamanho 0 mas parent e clicavel)
        const parent = node.closest('button, a, [role="button"]')
        if (parent && isVis(parent) && !parent.disabled) return true
        return false
      })
    const score = (node) => {
      const label = ((node.getAttribute && node.getAttribute('aria-label')) || '')
        + ' ' + ((node.getAttribute && node.getAttribute('title')) || '')
        + ' ' + (node.className || '')
        + ' ' + ((node.getAttribute && node.getAttribute('icon')) || '')
      const text = (node.textContent || '')
      const combined = (label + ' ' + text).toLowerCase()
      let s = 0
      if (/pdf|nota|download|baixar|visualizar|imprimir|file|document|arquivo/.test(combined)) s += 10
      // Botoes em celulas de "acoes" (ultima coluna)
      const cell = node.closest('td, [role="cell"], [role="gridcell"]')
      if (cell) {
        const cellIndex = Array.from(cell.parentElement?.children || []).indexOf(cell)
        const totalCells = cell.parentElement?.children?.length || 0
        if (cellIndex === totalCells - 1) s += 5 // ultima coluna = provavelmente Acoes
      }
      // Botoes com icone SVG dentro
      if (node.querySelector('svg, soma-icon, [class*="icon"]')) s += 3
      // Botoes sem texto (icon-only buttons)
      if (!(text || '').trim()) s += 2
      return s || 1
    }
    // Resolver para o parent clicavel se necessario
    const resolveClickable = (node) => {
      const tag = (node.tagName || '').toLowerCase()
      if (tag === 'button' || tag === 'a' || (node.getAttribute('role') === 'button')) return node
      const parent = node.closest('button, a, [role="button"]')
      return parent || node
    }
    const uniqueCandidates = [...new Set(candidates.map(resolveClickable))].filter(Boolean)
    uniqueCandidates.sort((a, b) => score(b) - score(a))
    const best = uniqueCandidates[0] || null
    if (best) {
      best.scrollIntoView({ behavior: 'instant', block: 'center' })
      best.click()
      return true
    }

    // Fallback 1: clicar na ultima celula (coluna de acoes).
    const rowCells = Array.from(row.querySelectorAll('td, [role="gridcell"], [role="cell"]'))
    const lastCell = rowCells.length ? rowCells[rowCells.length - 1] : null
    if (lastCell && isVis(lastCell)) {
      lastCell.scrollIntoView({ behavior: 'instant', block: 'center' })
      lastCell.click()
      return true
    }

    // Fallback 2: alguns grids abrem detalhes por double-click na linha.
    if (isVis(row)) {
      row.scrollIntoView({ behavior: 'instant', block: 'center' })
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      row.click()
      return true
    }
    return false
  }, rowIndex).catch(() => false)

  if (!clicked) {
    throw createHttpError(502, 'PDF_ICON_NOT_FOUND', 'Nao foi possivel clicar no icone do PDF.', { rowIndex }, 'pdf_click')
  }

  if (!preferPdfBytes) {
    appendJobLog(job, 'pdf', 'Leitura inline iniciada; se corretagem/taxa nao carregar, sera tentado download do PDF.', {
      rowIndex,
      noteLoadTimeoutMs,
    })
  }

  const clickViewerModelTabIfPresent = async (modelName = 'sinacor') => {
    return page.evaluate((targetModel) => {
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const resolveClickable = (node) => {
        if (!node) return null
        const tag = (node.tagName || '').toLowerCase()
        if (tag === 'button' || tag === 'a') return node
        if (node.getAttribute && node.getAttribute('role') === 'button') return node
        return node.closest ? node.closest('button, a, [role="button"]') : null
      }

      const overlays = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')
        .filter((el) => isVis(el))
      if (!overlays.length) return { clicked: false, reason: 'NO_OVERLAY' }

      const items = []
      for (const overlay of overlays) {
        const nodes = deepFind(overlay, 'button, a, [role="button"], [role="tab"], span, div')
        for (const node of nodes) {
          const clickable = resolveClickable(node) || node
          if (!clickable || !isVis(clickable) || clickable.disabled) continue
          const text = normalize(clickable.textContent || '')
          const label = normalize(`${clickable.getAttribute?.('aria-label') || ''} ${clickable.getAttribute?.('title') || ''} ${clickable.className || ''}`)
          const combined = `${text} ${label}`
          if (targetModel === 'xp') {
            if (!/modelo\s*xp|\bxp\b/.test(combined)) continue
          } else if (!/sinacor/.test(combined)) {
            continue
          }
          items.push(clickable)
        }
      }
      if (!items.length) return { clicked: false, reason: 'TAB_NOT_FOUND' }
      const target = items[0]
      const className = normalize(String(target.className || ''))
      const ariaSelected = normalize(target.getAttribute?.('aria-selected') || '')
      if (ariaSelected === 'true' || /active|selected|current|is-active/.test(className)) {
        return { clicked: false, reason: 'ALREADY_ACTIVE' }
      }
      target.click()
      return { clicked: true, reason: 'CLICKED' }
    }, String(modelName || 'sinacor').toLowerCase()).catch(() => ({ clicked: false, reason: 'EVAL_ERROR' }))
  }

  const clickSinacorTabIfPresent = async () => {
    const result = await clickViewerModelTabIfPresent('sinacor')
    return Boolean(result?.clicked)
  }

  const clickXpTabIfPresent = async () => {
    const result = await clickViewerModelTabIfPresent('xp')
    return Boolean(result?.clicked)
  }

  const getViewerLoadState = async () => {
    return page.evaluate(() => {
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

      const overlays = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')
        .filter((el) => isVis(el))
      if (!overlays.length) {
        return {
          hasOverlay: false,
          hasLoadError: false,
          hasUpdateButton: false,
          activeModel: null,
        }
      }

      const scoreOverlay = (el) => {
        const text = normalize(el.innerText || el.textContent || '')
        let score = 0
        if (/nota de negociacao|nota de corretagem/.test(text)) score += 12
        if (/modelo sinacor|modelo xp/.test(text)) score += 8
        if (/valor das operac|taxa operacional|corretagem|liquido para|total cblc/.test(text)) score += 10
        if (/nao foi possivel carregar as informacoes|atualizar/.test(text)) score += 6
        return score
      }

      let best = overlays[0]
      let bestScore = scoreOverlay(best)
      for (const overlay of overlays.slice(1)) {
        const s = scoreOverlay(overlay)
        if (s > bestScore) {
          best = overlay
          bestScore = s
        }
      }

      const bestText = normalize(best.innerText || best.textContent || '')
      const hasLoadError = /nao foi possivel carregar as informacoes/.test(bestText)

      const buttonNodes = deepFind(best, 'button, a, [role="button"], soma-button, span, div')
      const hasUpdateButton = buttonNodes.some((node) => {
        if (!isVis(node)) return false
        const text = normalize(node.textContent || '')
        const label = normalize(`${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`)
        return /atualizar/.test(`${text} ${label}`)
      })

      let activeModel = null
      const tabNodes = deepFind(best, 'button, a, [role="button"], [role="tab"], span, div')
      for (const node of tabNodes) {
        if (!isVis(node)) continue
        const text = normalize(node.textContent || '')
        const label = normalize(`${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''} ${node.className || ''}`)
        const combined = `${text} ${label}`
        const selected = node.getAttribute?.('aria-selected') === 'true'
          || /active|selected|current|is-active/.test(label)
        if (!selected) continue
        if (/modelo\s*xp|\bxp\b/.test(combined)) {
          activeModel = 'XP'
          break
        }
        if (/sinacor/.test(combined)) {
          activeModel = 'SINACOR'
        }
      }

      return {
        hasOverlay: true,
        hasLoadError,
        hasUpdateButton,
        activeModel,
      }
    }).catch(() => ({
      hasOverlay: false,
      hasLoadError: false,
      hasUpdateButton: false,
      activeModel: null,
    }))
  }

  const clickViewerRefreshButton = async () => {
    const explicitLocators = [
      page.getByRole('button', { name: /atualizar/i }),
      page.locator('button:has-text("Atualizar"), a:has-text("Atualizar"), [role="button"]:has-text("Atualizar"), soma-button:has-text("Atualizar")'),
      page.getByText(/atualizar/i),
    ]
    for (const locator of explicitLocators) {
      const count = await locator.count().catch(() => 0)
      if (!count) continue
      const target = locator.first()
      const visible = await target.isVisible().catch(() => false)
      if (!visible) continue
      await target.click({ timeout: 1800 }).catch(() => null)
      return true
    }
    return false
  }

  const clickViewerDownloadButton = async () => {
    const explicitLocators = [
      page.getByRole('button', { name: /baixar arquivo/i }),
      page.locator('button:has-text("Baixar Arquivo"), a:has-text("Baixar Arquivo"), [role="button"]:has-text("Baixar Arquivo"), soma-button:has-text("Baixar Arquivo")'),
      page.getByText(/baixar arquivo/i),
    ]
    for (const locator of explicitLocators) {
      const count = await locator.count().catch(() => 0)
      if (!count) continue
      const target = locator.first()
      const visible = await target.isVisible().catch(() => false)
      if (!visible) continue
      await target.click({ timeout: 1800 }).catch(() => null)
      return true
    }

    return page.evaluate(() => {
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const resolveClickable = (node) => {
        if (!node) return null
        const tag = (node.tagName || '').toLowerCase()
        if (tag === 'button' || tag === 'a') return node
        if (node.getAttribute && node.getAttribute('role') === 'button') return node
        return node.closest ? node.closest('button, a, [role="button"]') : null
      }
      const score = (el) => {
        const text = normalize(el.textContent || '')
        const label = normalize(`${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.className || ''} ${el.getAttribute?.('icon') || ''}`)
        const combined = `${text} ${label}`
        if (/fechar|close/.test(combined)) return -20
        let s = 0
        if (/baixar arquivo/.test(combined)) s += 40
        if (/\bbaixar\b/.test(combined)) s += 26
        if (/\bdownload\b/.test(combined)) s += 22
        if (/\barquivo\b/.test(combined)) s += 14
        if (/\bpdf\b/.test(combined)) s += 12
        if (/soma-icon-download|icon-download|download|arrow-down|file-download/.test(combined)) s += 12
        return s
      }

      const overlays = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')
        .filter((el) => isVis(el))
      if (!overlays.length) return false

      const candidates = []
      for (const overlay of overlays) {
        const nodes = deepFind(overlay, 'button, a, [role="button"], soma-button, span, div')
        for (const node of nodes) {
          const clickable = resolveClickable(node) || node
          if (!clickable || !isVis(clickable) || clickable.disabled) continue
          const sc = score(clickable)
          if (sc <= 0) continue
          candidates.push({ clickable, sc })
        }
      }
      if (!candidates.length) return false
      candidates.sort((a, b) => b.sc - a.sc)
      const best = candidates[0]?.clickable
      if (!best) return false
      best.click()
      return true
    }).catch(() => false)
  }

  const extractPdfUrlsFromViewer = async () => {
    return page.evaluate(() => {
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }
      const isVis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

      const collectUrls = (root, baseScore) => {
        const collected = []
        const nodes = deepFind(root, 'a[href], iframe[src], embed[src], object[data], source[src], [data-src], [data-url]')
        for (const el of nodes) {
          const raw = String(
            el.getAttribute?.('href')
            || el.getAttribute?.('src')
            || el.getAttribute?.('data')
            || el.getAttribute?.('data-src')
            || el.getAttribute?.('data-url')
            || '',
          ).trim()
          if (!raw) continue
          const low = raw.toLowerCase()
          if (/^about:blank$/.test(low) || /^javascript:/.test(low)) continue
          const isDataPdf = /^data:application\/pdf;base64,/i.test(raw)
          const isBlob = /^blob:/i.test(raw)
          const isHttp = /^https?:\/\//i.test(raw)
          const hasPdfHint = /(^|[/?#._-])pdf([/?#._-]|$)|download|nota|sinacor|arquivo/.test(low) || /\.pdf(\?|$)/.test(low)
          if (!(isDataPdf || isBlob || (isHttp && hasPdfHint))) continue
          const tag = String(el.tagName || '').toLowerCase()
          const attrText = normalize(`${el.className || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''}`)
          let score = baseScore
          if (tag === 'iframe' || tag === 'embed' || tag === 'object') score += 14
          if (/sinacor|nota|pdf|download|arquivo/.test(attrText)) score += 8
          if (isDataPdf) score += 50
          else if (isBlob) score += 42
          else if (isHttp) {
            if (/\.pdf(\?|$)/.test(low)) score += 36
            if (hasPdfHint) score += 22
          }
          collected.push({ href: raw, score })
        }
        return collected
      }

      const overlays = deepFind(document, 'soma-modal, [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="overlay" i]')
        .filter((el) => isVis(el))

      const candidates = []
      for (const overlay of overlays) {
        candidates.push(...collectUrls(overlay, 40))
      }
      // Fallback: alguns viewers guardam URL em nodes fora do container do modal.
      if (!candidates.length) {
        candidates.push(...collectUrls(document, 10))
      }
      if (!candidates.length) return []
      candidates.sort((a, b) => b.score - a.score)
      const seen = new Set()
      const ordered = []
      for (const item of candidates) {
        const href = String(item?.href || '').trim()
        if (!href || seen.has(href)) continue
        seen.add(href)
        ordered.push(href)
      }
      return ordered
    }).catch(() => [])
  }

  const isLikelyPdfBytes = (bytes) => {
    if (!bytes) return false
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    if (!buf || buf.length < 5) return false
    const head = buf.subarray(0, 16).toString('utf8')
    return head.includes('%PDF')
  }

  const readPdfBytesFromViewerUrl = async (pdfUrl, timeout = noteLoadTimeoutMs) => {
    const rawUrl = String(pdfUrl || '').trim()
    if (!rawUrl) return null

    if (/^data:application\/pdf;base64,/i.test(rawUrl)) {
      const base64 = rawUrl.replace(/^data:application\/pdf;base64,/i, '')
      if (!base64) return null
      try {
        const bytes = Buffer.from(base64, 'base64')
        return isLikelyPdfBytes(bytes) ? bytes : null
      } catch {
        return null
      }
    }

    if (/^blob:/i.test(rawUrl)) {
      const blobBase64 = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url)
          if (!resp || !resp.ok) return null
          const buf = await resp.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let binary = ''
          const chunk = 0x8000
          for (let i = 0; i < bytes.length; i += chunk) {
            const slice = bytes.subarray(i, i + chunk)
            binary += String.fromCharCode(...slice)
          }
          return btoa(binary)
        } catch {
          return null
        }
      }, rawUrl).catch(() => null)
      if (!blobBase64) return null
      try {
        const bytes = Buffer.from(blobBase64, 'base64')
        return isLikelyPdfBytes(bytes) ? bytes : null
      } catch {
        return null
      }
    }

    if (/^https?:\/\//i.test(rawUrl) && job?.context?.request) {
      const resp = await job.context.request.get(rawUrl, { timeout }).catch(() => null)
      if (resp && resp.ok()) {
        const bytes = await resp.body().catch(() => null)
        return isLikelyPdfBytes(bytes) ? bytes : null
      }
    }

    return null
  }

  const inlinePromise = extractApuracaoFromInlineNotaViewer(job, page, noteLoadTimeoutMs)
    .then((summary) => {
      if (!summary) throw new Error('INLINE_NOT_FOUND')
      return { type: 'inline', summary }
    })
  inlinePromise.catch(() => null)

  let event = null
  try {
    event = await Promise.any([downloadPromise, responsePromise, popupPromise, inlinePromise])
  } catch {
    event = null
  }

  appendJobLog(job, 'pdf', event
    ? 'Evento da nota capturado.'
    : 'Sem evento inicial de nota (download/response/popup/inline).', {
    rowIndex,
    eventType: event?.type || null,
  })

  const tryGetData = async (evt) => {
    if (!evt) return { pdfBytes: null, inlineSummary: null }
    if (evt.type === 'inline' && evt.summary) {
      return { pdfBytes: null, inlineSummary: evt.summary }
    }

    if (evt.type === 'download' && evt.download) {
      const filePath = await evt.download.path().catch(() => null)
      if (filePath) {
        const data = await fs.readFile(filePath).catch(() => null)
        if (data) return { pdfBytes: data, inlineSummary: null }
      }
      // fallback: salvar em memoria
      const tmpPath = path.join(DEBUG_HUBXP_DIR, `nota-${debugTimestamp()}-${shortId().slice(0, 6)}.pdf`)
      await fs.mkdir(path.dirname(tmpPath), { recursive: true }).catch(() => null)
      await evt.download.saveAs(tmpPath).catch(() => null)
      const data = await fs.readFile(tmpPath).catch(() => null)
      return { pdfBytes: data || null, inlineSummary: null }
    }

    if (evt.type === 'response' && evt.response) {
      const data = await evt.response.body().catch(() => null)
      return { pdfBytes: data || null, inlineSummary: null }
    }

    if (evt.type === 'popup' && evt.popup) {
      const popup = evt.popup
      await popup.waitForLoadState('domcontentloaded', { timeout: noteLoadTimeoutMs }).catch(() => null)
      const url = String(popup.url() || '').trim()
      let data = null

      // Tentar capturar PDF via resposta de rede dentro do popup (viewer HubXP)
      const tryInterceptPdfFromPopup = async (popupPage, waitMs = noteLoadTimeoutMs) => {
        try {
          const pdfResp = await popupPage.waitForResponse(
            (resp) => {
              const ct = String(resp.headers()?.['content-type'] || '').toLowerCase()
              return ct.includes('application/pdf') || String(resp.url() || '').includes('.pdf')
            },
            { timeout: waitMs },
          )
          return await pdfResp.body().catch(() => null)
        } catch {
          return null
        }
      }

      // Se a URL do popup nao e um PDF direto, e um viewer com abas SINACOR/XP
      const isDirectPdf = /\.pdf(\?|$)/i.test(url)

      if (isDirectPdf && job?.context?.request) {
        // PDF direto — baixar
        const resp = await job.context.request.get(url, { timeout: noteLoadTimeoutMs }).catch(() => null)
        if (resp && resp.ok()) {
          data = await resp.body().catch(() => null)
        }
      } else if (!isDirectPdf) {
        // Viewer de nota em popup — tentativa rapida para nao travar o fluxo.
        data = await tryInterceptPdfFromPopup(popup, noteLoadTimeoutMs)
      }

      // Fallback: tentar baixar URL com contexto request
      if (!data && url && /^https?:\/\//i.test(url) && job?.context?.request) {
        const resp = await job.context.request.get(url, { timeout: noteLoadTimeoutMs }).catch(() => null)
        if (resp && resp.ok()) {
          data = await resp.body().catch(() => null)
        }
      }

      await popup.close().catch(() => null)
      return { pdfBytes: data || null, inlineSummary: null }
    }

    return { pdfBytes: null, inlineSummary: null }
  }

  const tryDownloadFromOpenViewer = async () => {
    const downloadAttempts = 3
    let lastForceTimeoutMs = Math.max(5000, Math.min(20000, noteLoadTimeoutMs))
    let switchedToXpForDownload = false
    let sinacorRefreshesForDownload = 0
    let xpRefreshesForDownload = 0
    const MAX_REFRESH_DOWNLOAD = 3

    for (let downloadAttempt = 1; downloadAttempt <= downloadAttempts; downloadAttempt += 1) {
      const forceTimeoutMs = Math.max(5000, Math.min(20000, noteLoadTimeoutMs + ((downloadAttempt - 1) * 4000)))
      lastForceTimeoutMs = forceTimeoutMs

      const viewerState = await getViewerLoadState()

      // Se SINACOR tem erro de conexao, tentar Atualizar ate 3x antes de trocar para XP
      if (viewerState.hasLoadError && !switchedToXpForDownload) {
        if (sinacorRefreshesForDownload < MAX_REFRESH_DOWNLOAD && viewerState.hasUpdateButton) {
          sinacorRefreshesForDownload += 1
          const refreshed = await clickViewerRefreshButton().catch(() => false)
          if (refreshed) {
            appendJobLog(job, 'pdf', `Atualizar no SINACOR antes do download (tentativa ${sinacorRefreshesForDownload}/${MAX_REFRESH_DOWNLOAD}).`, {
              rowIndex,
              downloadAttempt,
            })
            await delay(3500)
            continue
          }
        }
        // Esgotou retries SINACOR: trocar para XP
        if (sinacorRefreshesForDownload >= MAX_REFRESH_DOWNLOAD) {
          const switchedToXp = await clickXpTabIfPresent().catch(() => false)
          if (switchedToXp) {
            switchedToXpForDownload = true
            appendJobLog(job, 'pdf', `Viewer SINACOR falhou apos ${MAX_REFRESH_DOWNLOAD} tentativas de Atualizar; alternando para MODELO XP.`, {
              rowIndex,
              downloadAttempt,
            })
            await delay(3500)
            continue
          }
        }
      }

      // Se XP tem erro de conexao, tentar Atualizar
      if (viewerState.hasLoadError && switchedToXpForDownload && viewerState.hasUpdateButton) {
        if (xpRefreshesForDownload < MAX_REFRESH_DOWNLOAD) {
          xpRefreshesForDownload += 1
          const refreshed = await clickViewerRefreshButton().catch(() => false)
          if (refreshed) {
            appendJobLog(job, 'pdf', `Atualizar no MODELO XP antes do download (tentativa ${xpRefreshesForDownload}/${MAX_REFRESH_DOWNLOAD}).`, {
              rowIndex,
              downloadAttempt,
            })
            await delay(3500)
            continue
          }
        }
      }

      await delay(150)

      const forceDownloadPromise = page.waitForEvent('download', { timeout: forceTimeoutMs })
        .then((download) => ({ type: 'download', download }))
      const forceResponsePromise = page.waitForResponse(isPdfResponse, { timeout: forceTimeoutMs })
        .then((response) => ({ type: 'response', response }))
      const forcePopupPromise = page.waitForEvent('popup', { timeout: forceTimeoutMs })
        .then((popup) => ({ type: 'popup', popup }))

      forceDownloadPromise.catch(() => null)
      forceResponsePromise.catch(() => null)
      forcePopupPromise.catch(() => null)

      const clickedDownload = await clickViewerDownloadButton()
      appendJobLog(job, 'pdf', clickedDownload
        ? 'Tentando baixar PDF pelo botao do viewer.'
        : 'Botao de download/baixar arquivo nao encontrado no viewer.', {
        rowIndex,
        forceTimeoutMs,
        downloadAttempt,
        downloadAttempts,
        viewerModel: switchedToXpForDownload ? 'XP' : (viewerState.activeModel || 'SINACOR'),
      })

      if (!clickedDownload) {
        if (downloadAttempt < downloadAttempts) {
          await delay(500)
          continue
        }
        return { pdfBytes: null, inlineSummary: null }
      }

      let evt = null
      try {
        evt = await Promise.any([forceDownloadPromise, forceResponsePromise, forcePopupPromise])
      } catch {
        evt = null
      }

      let forceResult = await tryGetData(evt)
      if (!forceResult.pdfBytes) {
        const settled = await Promise.allSettled([forceDownloadPromise, forceResponsePromise, forcePopupPromise])
        for (const item of settled) {
          if (item.status !== 'fulfilled') continue
          forceResult = await tryGetData(item.value)
          if (forceResult.pdfBytes) break
        }
      }

      if (forceResult.pdfBytes) {
        appendJobLog(job, 'pdf', 'PDF capturado via botao de download do viewer.', {
          rowIndex,
          bytesLength: forceResult.pdfBytes.length || 0,
          downloadAttempt,
        })
        return forceResult
      }

      appendJobLog(job, 'pdf', 'Tentativa de download no viewer nao retornou bytes de PDF.', {
        rowIndex,
        downloadAttempt,
        downloadAttempts,
      })
      await delay(500)
    }

    // Fallback final: algumas implementacoes deixam o PDF apenas em blob/data URL do viewer.
    const directPdfUrls = await extractPdfUrlsFromViewer()
    if (directPdfUrls.length) {
      const rotateBy = directPdfUrls.length > 0 ? (urlSkip % directPdfUrls.length) : 0
      const orderedUrls = directPdfUrls.slice(rotateBy).concat(directPdfUrls.slice(0, rotateBy))
      for (const directPdfUrl of orderedUrls.slice(0, 5)) {
        appendJobLog(job, 'pdf', 'Tentando baixar PDF via URL detectada no viewer (fallback).', {
          rowIndex,
          urlKind: /^blob:/i.test(directPdfUrl) ? 'blob'
            : /^data:/i.test(directPdfUrl) ? 'data'
              : /^https?:\/\//i.test(directPdfUrl) ? 'http'
                : 'unknown',
        })
        const directBytes = await readPdfBytesFromViewerUrl(directPdfUrl, lastForceTimeoutMs)
        if (directBytes) {
          appendJobLog(job, 'pdf', 'PDF capturado por URL do viewer (fallback).', {
            rowIndex,
            bytesLength: directBytes.length || 0,
          })
          return { pdfBytes: directBytes, inlineSummary: null }
        }
      }
      appendJobLog(job, 'pdf', 'Fallback de URLs do viewer nao retornou bytes validos de PDF.', {
        rowIndex,
        candidates: directPdfUrls.length,
      })
    }
    return { pdfBytes: null, inlineSummary: null }
  }

  let result = await tryGetData(event)
  // Mesmo com inline detectado primeiro, aguardar canais de bytes (download/response/popup).
  // Isso evita cair em resumo inline "stale" quando o PDF chega logo depois.
  if (!result.pdfBytes) {
    const settled = await Promise.allSettled([downloadPromise, responsePromise, popupPromise])
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue
      const candidate = await tryGetData(item.value)
      if (candidate?.pdfBytes) {
        result = {
          pdfBytes: candidate.pdfBytes,
          inlineSummary: result.inlineSummary || candidate.inlineSummary || null,
        }
        break
      }
    }
  }

  // Quando abre apenas viewer, tentar forcar download do PDF para parse por bytes.
  // Em modo multi-browser, so forcamos download quando o inline nao trouxe custos.
  const inlineIncomplete = Boolean(result.inlineSummary) && !hasInlineCosts(result.inlineSummary)
  if (!result.pdfBytes && (preferPdfBytes || !result.inlineSummary || inlineIncomplete)) {
    const forced = await tryDownloadFromOpenViewer()
    if (forced?.pdfBytes) {
      result = {
        pdfBytes: forced.pdfBytes,
        inlineSummary: result.inlineSummary || forced.inlineSummary || null,
      }
    }
  } else if (!result.pdfBytes && result.inlineSummary && !preferPdfBytes) {
    appendJobLog(job, 'pdf', 'Resumo inline completo detectado; download forcado ignorado para estabilidade.', {
      rowIndex,
    })
  }

  // Regra de negocio: antes de fechar a nota, garantir que taxa/corretagem carregou.
  // Se ainda nao carregou, aguardamos mais tempo dentro da nota.
  // O tempo extra permite retries de Atualizar e troca SINACOR->XP.
  if (!result.pdfBytes && result.inlineSummary && !hasInlineCosts(result.inlineSummary)) {
    // Se a nota foi classificada como BMF no viewer inline, nao esperar mais
    const isBmfInline = result.inlineSummary?.notaClassification === 'BMF'
    if (!isBmfInline) {
      const inlineSettleTimeoutMs = Number.isFinite(Number(options.inlineSettleTimeoutMs))
        ? Math.max(15000, Math.min(90000, Number(options.inlineSettleTimeoutMs)))
        : Math.max(35000, Math.min(90000, noteLoadTimeoutMs + 25000))
      appendJobLog(job, 'pdf', 'Nota aberta sem corretagem/taxa; aguardando carregamento com retry de Atualizar e fallback XP.', {
        rowIndex,
        inlineSettleTimeoutMs,
      })
      const settledInline = await extractApuracaoFromInlineNotaViewer(job, page, inlineSettleTimeoutMs).catch(() => null)
      if (settledInline) {
        result = {
          ...result,
          inlineSummary: mergeApuracaoResumo(result.inlineSummary, settledInline),
        }
      }
    }
  }

  if (!result.pdfBytes && result.inlineSummary && !hasInlineCosts(result.inlineSummary)) {
    const closedAfterIncomplete = await closeInlineNotaViewer(job, page, {
      strictX: false,
      allowFallbackEscape: true,
      maxAttempts: 6,
      settleTimeoutMs: 3200,
    }).catch(() => false)
    appendJobLog(job, 'ui_reset', closedAfterIncomplete
      ? 'Nota incompleta fechada por contingencia (X/Escape).'
      : 'Nota incompleta e fechamento de contingencia falhou.', {
      rowIndex,
    })
    throw createHttpError(
      425,
      'INLINE_COST_NOT_READY',
      'Nota aberta, mas corretagem/taxa nao carregou no viewer dentro do tempo limite.',
      { rowIndex },
      'pdf_download',
    )
  }

  if (!result.pdfBytes && !result.inlineSummary) {
    await debugShot(job, page, `pdf_timeout_row_${String(rowIndex + 1).padStart(3, '0')}`)
    await captureDebugHtml(job, page, `pdf_timeout_row_${String(rowIndex + 1).padStart(3, '0')}`)
    const closedOnError = await closeInlineNotaViewer(job, page)
    appendJobLog(job, 'ui_reset', closedOnError
      ? 'Modal/overlay da nota fechado apos timeout.'
      : 'Falha ao fechar modal/overlay da nota apos timeout.', {
      rowIndex,
    })
    throw createHttpError(
      504,
      'PDF_NOTE_LOAD_TIMEOUT',
      'Nao foi possivel extrair a nota no tempo rapido. Seguindo com fallback da tabela.',
      null,
      'pdf_download',
    )
  }

  const closed = await closeInlineNotaViewer(job, page, {
    strictX: true,
    maxAttempts: 4,
    settleTimeoutMs: 2600,
  })
  const closedFallback = closed
    ? true
    : await closeInlineNotaViewer(job, page, {
      strictX: false,
      allowFallbackEscape: true,
      maxAttempts: 6,
      settleTimeoutMs: 3200,
    }).catch(() => false)
  appendJobLog(job, 'ui_reset', closed
    ? 'Nota lida e fechada no X do modal.'
    : (closedFallback
      ? 'X do modal falhou, mas fechamento por contingencia concluiu.'
      : 'Nota lida, mas nao foi possivel fechar no X do modal.'), {
    rowIndex,
  })
  if (!closed && !closedFallback) {
    throw createHttpError(
      504,
      'PDF_MODAL_CLOSE_FAILED',
      'A nota foi lida, mas nao fechou no X do modal.',
      { rowIndex },
      'ui_reset',
    )
  }

  if (DEBUG_HUBXP && result.pdfBytes) {
    await fs.mkdir(DEBUG_HUBXP_DIR, { recursive: true }).catch(() => null)
    const outPath = path.join(DEBUG_HUBXP_DIR, `nota-${debugTimestamp()}-${String(rowIndex + 1).padStart(3, '0')}.pdf`)
    await fs.writeFile(outPath, result.pdfBytes).catch(() => null)
    appendJobLog(job, 'pdf', 'PDF salvo em debug', { outPath })
  }

  return result
}

const extractNotaResumoWithRetry = async (job, page, table, rowIndex, options = {}) => {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(5000, Math.min(30000, Number(options.timeoutMs)))
    : 10000
  const noteReadTimeoutMs = Math.max(60000, Math.min(180000, timeoutMs + 60000))
  const inlineSettleTimeoutMs = Number.isFinite(Number(options.inlineSettleTimeoutMs))
    ? Math.max(15000, Math.min(90000, Number(options.inlineSettleTimeoutMs)))
    : Math.max(35000, Math.min(90000, Math.floor(noteReadTimeoutMs * 0.55)))
  const preferPdfBytes = options.preferPdfBytes !== false
  const retries = Number.isFinite(Number(options.retries))
    ? Math.max(0, Math.min(4, Number(options.retries)))
    : 2
  const expectedContaDigits = String(options.expectedConta || '').replace(/\D/g, '')
  const attempts = retries + 1
  const hasInlineCoreValues = (summary) => {
    if (!summary) return false
    if (summary.isDayTrade) return true
    const hasCosts = summary.taxaOperacional != null || summary.corretagem != null
    return hasCosts
  }

  let lastError = null
  let activeTable = table
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      try {
        activeTable = await getNotasTable(job, page)
      } catch {
        activeTable = table
      }
      const noteResult = await runWithTimeout(
        () => clickPdfIconForRow(job, page, activeTable, rowIndex, timeoutMs, {
          urlSkip: attempt - 1,
          preferPdfBytes,
          inlineSettleTimeoutMs,
        }),
        noteReadTimeoutMs,
        (maxMs) => createHttpError(
          504,
          'PDF_NOTE_TIMEOUT',
          `Abertura/leitura da nota excedeu ${maxMs}ms.`,
          { rowIndex, attempt, timeoutMs: maxMs, pdfTimeoutMs: timeoutMs },
          'pdf_timeout',
        ),
      )

      if (noteResult?.pdfBytes) {
        const bytesLength = noteResult.pdfBytes.length || 0
        appendJobLog(job, 'pdf', 'PDF obtido em bytes para extracao.', {
          rowIndex,
          attempt,
          bytesLength,
        })
        const parsed = await runWithTimeout(
          () => extractApuracaoBovespaFromPdf(noteResult.pdfBytes),
          timeoutMs,
          (maxMs) => createHttpError(
            504,
            'PDF_PARSE_TIMEOUT',
            `Parser da nota excedeu ${maxMs}ms.`,
            { rowIndex, attempt, timeoutMs: maxMs },
            'pdf_parse',
          ),
        )
        appendJobLog(job, 'pdf', 'Extracao PDF concluida.', {
          rowIndex,
          attempt,
          pagesScanned: parsed?.pagesScanned ?? null,
          totalPages: parsed?.totalPages ?? null,
          dayTrade: Boolean(parsed?.isDayTrade),
          dayTradeReason: parsed?.dayTradeReason || null,
          classification: parsed?.notaClassification || null,
          classificationReason: parsed?.notaClassificationReason || null,
        })

        const detectedContaDigits = String(parsed?.detectedClientCode || '').replace(/\D/g, '')
        if (expectedContaDigits && detectedContaDigits && detectedContaDigits !== expectedContaDigits) {
          throw createHttpError(
            409,
            'PDF_CLIENT_MISMATCH',
            `PDF da nota nao corresponde a conta esperada (${expectedContaDigits}).`,
            {
              rowIndex,
              attempt,
              expectedConta: expectedContaDigits,
              detectedConta: detectedContaDigits,
            },
            'pdf_download',
          )
        }

        return {
          ...parsed,
          source: 'pdf_bytes',
          bytesLength,
        }
      }

      if (noteResult?.inlineSummary) {
        const inlineComplete = hasInlineCoreValues(noteResult.inlineSummary)
        const isBmfInline = noteResult.inlineSummary?.notaClassification === 'BMF'
        appendJobLog(job, 'pdf', 'Resumo obtido no viewer inline (fallback).', {
          rowIndex,
          attempt,
          inlineComplete,
          isBmfInline,
          valorOperacoes: noteResult.inlineSummary?.valorOperacoes ?? null,
          taxaOperacional: noteResult.inlineSummary?.taxaOperacional ?? null,
          corretagem: noteResult.inlineSummary?.corretagem ?? null,
          dayTrade: Boolean(noteResult.inlineSummary?.isDayTrade),
          dayTradeReason: noteResult.inlineSummary?.dayTradeReason || null,
          notaClassification: noteResult.inlineSummary?.notaClassification || null,
        })
        // Nota BMF detectada no inline: retornar imediatamente para que o caller pule
        if (isBmfInline) {
          return {
            ...noteResult.inlineSummary,
            source: 'inline_viewer_bmf',
          }
        }
        if (!inlineComplete && attempt < attempts) {
          throw createHttpError(
            425,
            'INLINE_SUMMARY_INCOMPLETE_RETRY',
            'Resumo inline incompleto (sem corretagem/taxa); repetindo leitura da nota.',
            { rowIndex, attempt, attempts },
            'pdf_download',
          )
        }
        if (!inlineComplete) {
          throw createHttpError(
            504,
            'INLINE_SUMMARY_INCOMPLETE',
            'Resumo inline incompleto apos retries.',
            { rowIndex, attempt, attempts },
            'pdf_download',
          )
        }
        if (preferPdfBytes && attempt < attempts) {
          throw createHttpError(
            425,
            'PDF_BYTES_PREFERRED_RETRY',
            'Resumo inline sem bytes; repetindo para priorizar PDF real.',
            { rowIndex, attempt, attempts },
            'pdf_download',
          )
        }
        if (preferPdfBytes) {
          throw createHttpError(
            504,
            'PDF_BYTES_REQUIRED',
            'Nao foi possivel obter bytes reais do PDF apos retries.',
            { rowIndex, attempt, attempts },
            'pdf_download',
          )
        }
        return {
          ...noteResult.inlineSummary,
          source: 'inline_viewer',
        }
      }

      return {
        valorOperacoes: null,
        valorFinanceiro: null,
        taxaOperacional: null,
        corretagem: null,
        isDayTrade: false,
        dayTradeReason: null,
        totalPages: 0,
        pagesScanned: 0,
        source: 'empty',
      }
    } catch (error) {
      lastError = error
      appendJobLog(job, 'pdf', 'Falha ao abrir/processar nota.', {
        rowIndex,
        attempt,
        retries,
        error: error?.message || 'unknown',
        code: error?.code || null,
      })
      await debugShot(job, page, `pdf_attempt_${attempt}_row_${String(rowIndex + 1).padStart(3, '0')}`)
      await captureDebugHtml(job, page, `pdf_attempt_${attempt}_row_${String(rowIndex + 1).padStart(3, '0')}`)
      const closed = await closeInlineNotaViewer(job, page)
      const interactive = await waitForNotasUiInteractable(page, 2600)
      appendJobLog(job, 'ui_reset', 'Estado da UI apos falha de nota.', {
        rowIndex,
        attempt,
        closedModal: closed,
        interactive,
      })

      // Erros permanentes que nao se recuperam com retry — interromper imediatamente
      const fatalNonRetryableCodes = new Set([
        'PDFJS_UNAVAILABLE',
      ])
      if (fatalNonRetryableCodes.has(String(error?.code || ''))) {
        appendJobLog(job, 'pdf', 'Erro fatal permanente; interrompendo retries da nota.', {
          rowIndex,
          attempt,
          code: error?.code || null,
        })
        break
      }

      const recoverableRefilterCodes = new Set([
        'PDF_CLIENT_MISMATCH',
        'INLINE_COST_NOT_READY',
        'PDF_ICON_NOT_FOUND',
        'PDF_NOTE_LOAD_TIMEOUT',
        'PDF_NOTE_TIMEOUT',
        'INLINE_SUMMARY_INCOMPLETE_RETRY',
        'INLINE_SUMMARY_INCOMPLETE',
        'PDF_BYTES_PREFERRED_RETRY',
        'PDF_BYTES_REQUIRED',
      ])
      const shouldRefilterBeforeRetry = attempt < attempts
        && Boolean(expectedContaDigits)
        && recoverableRefilterCodes.has(String(error?.code || ''))
      if (shouldRefilterBeforeRetry) {
        appendJobLog(job, 'pdf', 'Refiltrando conta antes do proximo retry da nota.', {
          rowIndex,
          attempt,
          code: error?.code || null,
          conta: expectedContaDigits,
        })
        const reselected = await selectContaOnNotas(job, page, expectedContaDigits).catch(() => false)
        appendJobLog(job, 'notas_filter', reselected
          ? 'Conta re-selecionada antes do retry da nota.'
          : 'Falha ao re-selecionar conta antes do retry da nota.', {
          conta: expectedContaDigits,
          attempt,
        })
        if (reselected) {
          const refiltered = await withNotasFilterLock(() => runNotasFilterSearch(job, page, {
            maxAttempts: 2,
            expectedAccount: expectedContaDigits,
          }), {
            cooldownMs: 380,
          }).catch(() => false)
          appendJobLog(job, 'notas_filter', refiltered
            ? 'Filtro de notas reexecutado antes do retry da nota.'
            : 'Falha ao reexecutar filtro antes do retry da nota.', {
            conta: expectedContaDigits,
            attempt,
          })
          if (refiltered) {
            try {
              activeTable = await getNotasTable(job, page)
            } catch {
              // segue com tabela anterior
            }
          }
        }
        await delay(260)
      }
      if (attempt < attempts) {
        await delay(220 * attempt)
      }
    }
  }

  throw lastError || createHttpError(
    504,
    'PDF_NOTE_FAILED',
    'Nao foi possivel extrair a nota apos retries.',
    { rowIndex, attempts, timeoutMs },
    'pdf_download',
  )
}

const fetchApuracaoBovespa = async (job, payload = {}) => {
  if (!job.context || !job.page) {
    throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para coleta.', null, 'apuracao_bovespa')
  }

  if (job.running) {
    throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, 'apuracao_bovespa')
  }

  // Permitir re-coleta apos FAILED (o browser ainda esta aberto, so a coleta falhou)
  const allowedStatuses = new Set([STATUS.AUTHENTICATED, STATUS.SUCCESS, STATUS.FAILED])
  if (!allowedStatuses.has(job.status)) {
    throw createHttpError(409, 'JOB_NOT_AUTHENTICATED', 'Sessao nao autenticada. Inicie login antes de coletar.', null, 'apuracao_bovespa')
  }

  // Resetar estado de interrupcao e resultado anterior para uma nova execucao limpa.
  job._abortApuracao = false
  job._apuracaoBovespaData = null
  job.running = true
  job.error = null
  job.progress.startedAt = now()
  job.progress.finishedAt = null

  const timeoutMs = Number.isFinite(Number(payload.timeoutMs))
    ? Math.max(30000, Math.min(30 * 60 * 1000, Number(payload.timeoutMs)))
    : 12 * 60 * 1000
  const pdfTimeoutMs = Number.isFinite(Number(payload.pdfTimeoutMs))
    ? Math.max(7000, Math.min(45000, Number(payload.pdfTimeoutMs)))
    : 18000

  const filters = payload.filters && typeof payload.filters === 'object' ? payload.filters : {}
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : []
  const accountMeta = payload.accountMeta && typeof payload.accountMeta === 'object' ? payload.accountMeta : {}
  const useRecordedFlow = toBoolean(payload.useRecordedFlow, false)
  const tableFastPath = toBoolean(payload.tableFastPath, false)
  const tableFallbackOnPdfError = toBoolean(payload.tableFallbackOnPdfError, true)
  const strictCompletion = toBoolean(payload.strictCompletion, true)
  const adaptiveRateLimit = toBoolean(payload.adaptiveRateLimit, true)
  const strictWorkerDistribution = toBoolean(payload.strictWorkerDistribution, false)
  const maxNotesPages = Number.isFinite(Number(payload.maxNotesPages))
    ? Math.max(1, Math.min(200, Number(payload.maxNotesPages)))
    : 120
  const dateFrom = normalizeDateInput(filters.dateFrom || resolveToday())
  const dateTo = normalizeDateInput(filters.dateTo || dateFrom)

  setJobStatus(job, STATUS.COLLECTING, 'apuracao_bovespa', 'Iniciando apuracao Bovespa...', {
    currentPage: 0,
    totalPages: accounts.length || null,
    rowsCollected: 0,
    accountsProcessed: 0,
    accountsFailed: 0,
    accountsTotal: accounts.length,
  })

  appendJobLog(job, 'apuracao_bovespa', 'Apuracao Bovespa iniciada', {
    accounts: accounts.length,
    dateFrom,
    dateTo,
    useRecordedFlow,
    tableFastPath,
    tableFallbackOnPdfError,
    pdfTimeoutMs,
    strictCompletion,
    adaptiveRateLimit,
    strictWorkerDistribution,
    maxNotesPages,
  })

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(createHttpError(504, 'APURACAO_TIMEOUT', 'Tempo limite excedido durante apuracao Bovespa.'))
    }, timeoutMs)
  })

  const DEFAULT_MAX_BROWSERS = 2
  const HARD_MAX_BROWSERS = 5
  const requestedConcurrency = Number(payload.concurrency)
  const envMaxBrowsers = Number(process.env.HUBXP_APURACAO_BOVESPA_MAX_BROWSERS)
  const requestedMaxBrowsers = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : DEFAULT_MAX_BROWSERS
  const configuredMaxBrowsers = Number.isFinite(envMaxBrowsers)
    ? Math.max(1, Math.floor(envMaxBrowsers))
    : requestedMaxBrowsers
  const maxBrowsers = Math.max(1, Math.min(HARD_MAX_BROWSERS, configuredMaxBrowsers))
  const baseConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : maxBrowsers
  const CONCURRENCY = Math.min(maxBrowsers, accounts.length || 1, baseConcurrency)
  const reuseSinglePage = toBoolean(payload.reuseSinglePage, false)

  const collectPromise = (async () => {
    // Se o browser esta visivel (keepVisible ou headless=false), NAO trocar para headless
    if (job._keepVisible || job.browserHeadless === false) {
      appendJobLog(job, 'apuracao_bovespa', 'Mantendo browser visivel para apuracao (keepVisible ou sessao visivel).')
      const authOk = await isAuthenticated(job.page).catch(() => false)
      if (!authOk) {
        appendJobLog(job, 'apuracao_bovespa', 'Sessao visivel perdeu autenticacao.')
        throw createHttpError(409, 'SESSION_EXPIRED', 'Sessao HubXP expirou. Faca login novamente.', null, 'apuracao_bovespa')
      }
    } else {
      await ensureHeadlessExecution(job, 'apuracao_bovespa')
    }

    const effectiveConcurrency = reuseSinglePage
      ? 1
      : CONCURRENCY

    // ===== PRE-DIVIDIR contas entre browsers (sem fila compartilhada) =====
    // Ex: 30 contas / 10 browsers = 3 contas por browser, sem repetição
    const accountBatches = Array.from({ length: effectiveConcurrency }, () => [])
    for (let i = 0; i < accounts.length; i += 1) {
      accountBatches[i % effectiveConcurrency].push({ index: i, conta: accounts[i] })
    }

    appendJobLog(job, 'apuracao_bovespa', `Dividindo ${accounts.length} contas entre ${effectiveConcurrency} browsers`, {
      distribution: accountBatches.map((b, i) => `Browser ${i + 1}: ${b.length} contas`),
    })

    const activeWorkers = [] // { browser, context, page, batch, keepOpen }
    const orphanedBatches = []
    let sharedStorageState = null
    let sharedChromium = null
    const browserChannel = process.env.HUBXP_BROWSER_CHANNEL || undefined
    // Browsers auxiliares DEVEM ser visiveis (headless: false) para que os
    // web-components Shadow DOM do HubXP renderizem corretamente.  Em modo
    // headless o <soma-datepicker>, input de conta e outros custom-elements
    // simplesmente nao aparecem, causando CONTA_NOT_SELECTED em todas as contas.
    const auxHeadless = toBoolean(process.env.HUBXP_AUX_HEADLESS, false)
    const openAuxWorker = async (batch = []) => {
      if (!sharedChromium || !sharedStorageState) return null
      const browser = await sharedChromium.launch({
        headless: auxHeadless,
        channel: browserChannel,
        args: [
          '--disable-dev-shm-usage',
        ],
      })
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        ignoreHTTPSErrors: true,
        storageState: sharedStorageState,
      })
      const pg = await context.newPage()
      await prepareExtraPage(pg)
      return { browser, context, page: pg, batch, keepOpen: false }
    }
    if (reuseSinglePage) {
      const primaryBatch = accountBatches[0] || []
      activeWorkers.push({
        browser: null,
        context: null,
        page: job.page,
        batch: primaryBatch,
        keepOpen: true,
      })
      appendJobLog(job, 'apuracao_bovespa', 'Modo pagina unica ativo: mantendo browser atual para todo o lote.', {
        accounts: primaryBatch.length,
      })
    } else {
      // ===== Abrir browsers em lotes de 3 (semi-paralelo para estabilidade) =====
      // Obter sessao autenticada para compartilhar entre browsers
      sharedStorageState = await job.context.storageState()
      sharedChromium = await getPlaywright()
      const batchesToLaunch = accountBatches.map((batch, i) => ({ batch, index: i })).filter((b) => b.batch.length > 0)
      const LAUNCH_BATCH_SIZE = 3
      for (let start = 0; start < batchesToLaunch.length; start += LAUNCH_BATCH_SIZE) {
        const chunk = batchesToLaunch.slice(start, start + LAUNCH_BATCH_SIZE)
        appendJobLog(job, 'apuracao_bovespa', `Abrindo browsers ${start + 1}-${start + chunk.length}/${batchesToLaunch.length}...`)
        const results = await Promise.allSettled(chunk.map(async ({ batch }) => openAuxWorker(batch)))
        for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
          const r = results[resultIndex]
          const failedBatch = chunk[resultIndex]?.batch || []
          if (r.status === 'fulfilled') {
            activeWorkers.push(r.value)
            continue
          }
          if (failedBatch.length) {
            orphanedBatches.push(failedBatch)
          }
          appendJobLog(job, 'apuracao_bovespa', 'Browser falhou ao abrir', {
            error: r.reason?.message || 'unknown',
            slot: start + resultIndex + 1,
            batchAccounts: failedBatch.length,
          })
        }
      }
    }

    const pages = activeWorkers.map((w) => w.page)
    if (pages.length === 0) {
      throw createHttpError(502, 'BROWSERS_FAILED', 'Nenhum browser abriu com sucesso.')
    }

    appendJobLog(job, 'apuracao_bovespa', `${pages.length} browsers abertos, navegando para Notas de Negociacao...`)

    // ===== Navegar TODOS e usar apenas workers realmente prontos =====
    const closeWorkerResources = async (worker) => {
      if (!worker || worker.keepOpen) return
      try { await worker.page?.close() } catch {}
      try { await worker.context?.close() } catch {}
      try { await worker.browser?.close() } catch {}
    }

    const closeWorkerExtraPages = async (worker) => {
      if (!worker?.context || !worker?.page) return
      const pagesInContext = worker.context.pages?.() || []
      const extras = pagesInContext.filter((ctxPage) => ctxPage && ctxPage !== worker.page)
      await Promise.allSettled(extras.map(async (ctxPage) => {
        try { await ctxPage.close() } catch {}
      }))
    }

    const ensureWorkerNotasReady = async (worker, workerIndex) => {
      const maxNavAttempts = 3
      let lastError = null
      for (let attempt = 1; attempt <= maxNavAttempts; attempt += 1) {
        try {
          await ensureNotasNegociacaoView(job, worker.page, payload.notasUrl, {
            notesOnly: true,
            menuFallbackInNotesOnly: true,
          })
          if (attempt > 1) {
            appendJobLog(job, 'notas_nav', 'Worker recuperado e pronto na pagina de Notas apos retry.', {
              worker: workerIndex + 1,
              attempt,
            })
          }
          return true
        } catch (error) {
          lastError = error
          appendJobLog(job, 'notas_nav', 'Falha ao preparar worker na pagina de Notas.', {
            worker: workerIndex + 1,
            attempt,
            maxAttempts: maxNavAttempts,
            error: error?.message || 'unknown',
            code: error?.code || null,
            currentUrl: getPageUrl(worker.page) || null,
          })
          if (attempt < maxNavAttempts) {
            await delay(500 * attempt)
          }
        }
      }
      throw lastError || createHttpError(
        502,
        'NOTAS_PAGE_NOT_READY',
        'Worker nao conseguiu abrir a tela de Notas apos retries.',
        { worker: workerIndex + 1 },
        'notas_nav',
      )
    }

    const navResults = await Promise.allSettled(activeWorkers.map((w, idx) =>
      ensureWorkerNotasReady(w, idx)
    ))
    const readyWorkers = []
    const pendingBatches = [...orphanedBatches]
    for (let i = 0; i < navResults.length; i += 1) {
      const result = navResults[i]
      if (result.status === 'fulfilled') {
        await closeWorkerExtraPages(activeWorkers[i])
        readyWorkers.push(activeWorkers[i])
      } else {
        const failedWorker = activeWorkers[i]
        const failedBatch = activeWorkers[i]?.batch || []
        await closeWorkerResources(failedWorker)

        let recovered = false
        if (!reuseSinglePage && failedBatch.length && sharedChromium && sharedStorageState) {
          appendJobLog(job, 'notas_nav', 'Tentando relancar worker que falhou ao abrir Notas.', {
            worker: i + 1,
            batchAccounts: failedBatch.length,
          })
          let replacementWorker = null
          try {
            replacementWorker = await openAuxWorker(failedBatch)
            if (replacementWorker) {
              await ensureWorkerNotasReady(replacementWorker, i)
              await closeWorkerExtraPages(replacementWorker)
              activeWorkers.push(replacementWorker)
              readyWorkers.push(replacementWorker)
              recovered = true
              appendJobLog(job, 'notas_nav', 'Worker relancado com sucesso para Notas.', {
                worker: i + 1,
                batchAccounts: failedBatch.length,
              })
            }
          } catch (recoveryError) {
            await closeWorkerResources(replacementWorker)
            appendJobLog(job, 'notas_nav', 'Falha ao relancar worker para Notas.', {
              worker: i + 1,
              batchAccounts: failedBatch.length,
              error: recoveryError?.message || 'unknown',
              code: recoveryError?.code || null,
            })
          }
        }

        if (!recovered) {
          if (failedBatch.length) {
            pendingBatches.push(failedBatch)
          }
          appendJobLog(job, 'notas_nav', 'Worker nao chegou na pagina de Notas; sera ignorado nesta execucao.', {
            worker: i + 1,
            error: result.reason?.message || 'unknown',
            batchAccounts: failedBatch.length,
            closedWorker: true,
          })
        }
      }
    }
    appendJobLog(job, 'apuracao_bovespa', `${readyWorkers.length}/${pages.length} browsers prontos na pagina de Notas. Iniciando apuracao...`)
    if (readyWorkers.length === 0) {
      throw createHttpError(502, 'NOTAS_PAGE_NOT_READY', 'Nenhum browser chegou na tela de Notas de Negociacao.')
    }
    if (strictWorkerDistribution && !reuseSinglePage && readyWorkers.length < effectiveConcurrency) {
      throw createHttpError(
        502,
        'WORKER_DISTRIBUTION_UNBALANCED',
        `Modo estrito de distribuicao ativo: ${readyWorkers.length}/${effectiveConcurrency} browsers ficaram prontos.`,
        {
          readyWorkers: readyWorkers.length,
          expectedWorkers: effectiveConcurrency,
          pendingBatches: pendingBatches.length,
        },
        'notas_nav',
      )
    }

    if (pendingBatches.length) {
      const reassignedAccounts = pendingBatches
        .flat()
        .sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0))

      if (reassignedAccounts.length) {
        if (strictWorkerDistribution && !reuseSinglePage) {
          throw createHttpError(
            502,
            'WORKER_DISTRIBUTION_UNBALANCED',
            `Modo estrito de distribuicao ativo: ${reassignedAccounts.length} contas ficariam concentradas por indisponibilidade de worker.`,
            {
              redistributedAccounts: reassignedAccounts.length,
              workersReady: readyWorkers.length,
              expectedWorkers: effectiveConcurrency,
            },
            'notas_nav',
          )
        }
        reassignedAccounts.forEach((accountItem, accountIndex) => {
          const targetWorker = readyWorkers[accountIndex % readyWorkers.length]
          targetWorker.batch.push(accountItem)
        })
        readyWorkers.forEach((worker) => {
          worker.batch.sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0))
        })
        appendJobLog(job, 'apuracao_bovespa', 'Contas de workers indisponiveis foram redistribuidas.', {
          redistributedAccounts: reassignedAccounts.length,
          workers: readyWorkers.length,
          distribution: readyWorkers.map((worker, idx) => `Browser ${idx + 1}: ${worker.batch.length} contas`),
        })
      }
    }

    const activeWorkerCount = readyWorkers.length
    const multiBrowserMode = activeWorkerCount > 1
    // Fluxo prioriza estabilidade: inline + bytes, com retry curto por nota.
    const preferPdfBytes = toBoolean(payload.preferPdfBytes, false)
    const perNoteRetries = Number.isFinite(Number(payload.perNoteRetries))
      ? Math.max(0, Math.min(4, Number(payload.perNoteRetries)))
      : (multiBrowserMode ? 2 : 1)

    appendJobLog(job, 'pdf', multiBrowserMode
      ? 'Modo multi-browser: leitura de nota com retry curto e recuperacao de filtro.'
      : 'Modo single-browser: leitura de nota com retry curto e recuperacao de filtro.', {
      workers: activeWorkerCount,
      retries: perNoteRetries,
      preferPdfBytes,
    })

    const outRows = []
    let processedNotes = 0
    const accountRuns = []
    const accountRunsMap = new Map()

    // ===== Sync incremental: atualizar _apuracaoBovespaData durante a coleta =====
    const apuracaoColumns = [
      'conta', 'tag', 'broker', 'cliente', 'data',
      'valorOperacoes', 'valorFinanceiro', 'taxaOperacional', 'corretagem',
      'outrasTaxas', 'totalTaxas', 'bolsa', 'pdfPages', 'pdfScanned',
    ]
    const syncApuracaoDataToJob = () => {
      const accountRunsPayload = accountRuns.map((run) => ({
        account: run.account,
        worker: run.worker,
        status: run.status,
        notesListed: Number(run.notesListed || 0),
        notesProcessed: Number(run.notesProcessed || 0),
        pagesScanned: Number(run.pagesScanned || 0),
        errorCode: run.errorCode || null,
        errorMessage: run.errorMessage || null,
        rateLimitHits: Number(run.rateLimitHits || 0),
        startedAt: run.startedAt || null,
        finishedAt: run.finishedAt || null,
      }))
      const summary = getAccountSummary()
      const failedAccountsList = accountRunsPayload.filter((run) => isFailedAccountStatus(run.status))
      const normalizedOutRows = outRows.map((row) => normalizeApuracaoRowMoney(row))
      job._apuracaoBovespaData = {
        columns: apuracaoColumns,
        rows: normalizedOutRows,
        totalRows: normalizedOutRows.length,
        collectedAt: now(),
        accountRuns: accountRunsPayload,
        failedAccounts: failedAccountsList,
        summary,
      }
    }

    const toAccountDigits = (value) => String(value || '').replace(/\D/g, '')
    const isFailedAccountStatus = (value) => String(value || '').startsWith('failed')
    const getAccountSummary = () => {
      const summary = {
        success: 0,
        no_notes: 0,
        failed: 0,
        accountsProcessed: 0,
        accountsTotal: accounts.length,
        notesListed: 0,
        notesProcessed: 0,
        pagesScanned: 0,
      }
      for (const run of accountRuns) {
        summary.notesListed += Number(run.notesListed || 0)
        summary.notesProcessed += Number(run.notesProcessed || 0)
        summary.pagesScanned += Number(run.pagesScanned || 0)
        if (run.finishedAt) summary.accountsProcessed += 1
        if (run.status === 'success') summary.success += 1
        else if (run.status === 'no_notes') summary.no_notes += 1
        else if (isFailedAccountStatus(run.status)) summary.failed += 1
      }
      return summary
    }
    const syncAccountProgress = () => {
      const summary = getAccountSummary()
      job.progress.accountsProcessed = summary.accountsProcessed
      job.progress.accountsFailed = summary.failed
      job.progress.accountsTotal = accounts.length
      return summary
    }
    const getOrCreateAccountRun = (accountDigits, workerId, phase = 'base') => {
      const key = toAccountDigits(accountDigits)
      if (!key) return null
      let run = accountRunsMap.get(key)
      if (!run) {
        run = {
          account: key,
          worker: workerId,
          status: 'running',
          notesListed: 0,
          notesProcessed: 0,
          pagesScanned: 0,
          errorCode: null,
          errorMessage: null,
          rateLimitHits: 0,
          startedAt: now(),
          finishedAt: null,
        }
        accountRunsMap.set(key, run)
        accountRuns.push(run)
        return run
      }
      if (phase === 'adaptive') {
        run.worker = workerId
        run.status = 'running'
        run.notesListed = 0
        run.notesProcessed = 0
        run.pagesScanned = 0
        run.errorCode = null
        run.errorMessage = null
        run.rateLimitHits = 0
        run.startedAt = now()
        run.finishedAt = null
      }
      return run
    }
    const finishAccountRun = (run, status, extra = {}) => {
      if (!run) return
      run.status = status
      Object.assign(run, extra || {})
      run.finishedAt = now()
      syncAccountProgress()
      syncApuracaoDataToJob()
    }

    // ===== Worker: cada browser processa APENAS suas contas pre-atribuidas =====
    const processWorker = async (worker, workerId, options = {}) => {
      const phase = String(options.phase || 'base')
      const filterMaxAttempts = Number.isFinite(Number(options.filterMaxAttempts))
        ? Math.max(1, Math.min(12, Number(options.filterMaxAttempts)))
        : 6
      const retryFilterMaxAttempts = Number.isFinite(Number(options.retryFilterMaxAttempts))
        ? Math.max(1, Math.min(10, Number(options.retryFilterMaxAttempts)))
        : 4
      const filterCooldownMs = Number.isFinite(Number(options.filterCooldownMs))
        ? Math.max(120, Math.min(1800, Number(options.filterCooldownMs)))
        : 420
      const forceDateEachAccount = Boolean(options.forceDateEachAccount)
      const pg = worker.page
      const batch = Array.isArray(options.batchOverride) ? options.batchOverride : worker.batch
      let datePrimed = false
      for (let bi = 0; bi < batch.length; bi += 1) {
        // Verificar se foi solicitado abort
        if (job._abortApuracao) {
          appendJobLog(job, 'apuracao_bovespa', `Browser ${workerId}: processo interrompido pelo usuario`)
          break
        }
        const { index: ai, conta } = batch[bi]
        const contaDigits = toAccountDigits(conta)
        const run = getOrCreateAccountRun(contaDigits, workerId, phase)
        if (!run) continue
        const accountSummary = syncAccountProgress()

        setJobStatus(job, STATUS.COLLECTING, 'apuracao_bovespa', `Browser ${workerId}: conta ${bi + 1}/${batch.length} (total ${processedNotes}/${accounts.length})`, {
          currentPage: Number.isFinite(Number(ai)) ? Math.max(1, Number(ai) + 1) : (processedNotes + 1),
          totalPages: accounts.length,
          rowsCollected: processedNotes,
          accountsProcessed: accountSummary.accountsProcessed,
          accountsFailed: accountSummary.failed,
          accountsTotal: accounts.length,
        })

        // Garantir que nenhum modal de nota ficou aberto da conta anterior.
        const closedBeforeAccount = await closeInlineNotaViewer(job, pg, {
          strictX: false,
          allowFallbackEscape: true,
          maxAttempts: 3,
          settleTimeoutMs: 2400,
        })
        if (closedBeforeAccount) {
          appendJobLog(job, 'ui_reset', 'Modal de nota fechado no X antes de trocar conta.', {
            conta: String(conta || ''),
            worker: workerId,
          })
        }

        try {
          let filteredByReplay = false
          if (useRecordedFlow && Array.isArray(job?._manualFlow?.events) && job._manualFlow.events.length) {
            const replay = await replayManualFlow(
              job,
              pg,
              {
                account: String(conta || ''),
                date_from: dateFrom,
                date_to: dateTo,
              },
              {
                mode: 'prepare_filters',
                maxEvents: 160,
                // O periodo deve ser ajustado no primeiro cliente; nos demais, manter.
                applyDateFallback: forceDateEachAccount || !datePrimed,
              },
            )
            const replayReachedFilter = replay.ok && replay.stoppedAt === 'filter_action'
            if (replayReachedFilter) {
              filteredByReplay = true
              appendJobLog(job, 'flow_replay', `Fluxo gravado executado para conta ${String(conta || '')}.`, {
                executed: replay.executed,
                worker: workerId,
              })
            } else {
              appendJobLog(job, 'flow_replay', 'Fluxo gravado indisponivel/falhou; usando fluxo padrao.', {
                reason: replay.reason || (replay.ok ? 'FILTER_ACTION_NOT_REACHED' : 'unknown'),
                stoppedAt: replay.stoppedAt || null,
                worker: workerId,
              })
            }
          }

          if (!filteredByReplay) {
            // Fluxo padrao: selecionar conta/cliente, manter periodo, filtrar.
            const contaSelected = await selectContaOnNotas(job, pg, conta)
            if (!contaSelected) {
              appendJobLog(job, 'apuracao_bovespa', 'Conta nao selecionada no filtro, pulando.', {
                conta: String(conta || ''),
                worker: workerId,
              })
              finishAccountRun(run, 'failed_filter', {
                errorCode: 'CONTA_NOT_SELECTED',
                errorMessage: 'Conta nao selecionada no filtro.',
              })
              continue
            }
            await pg.waitForSelector('soma-datepicker, input[type="date"], [class*="datepicker" i]', { timeout: 3000 }).catch(() => null)

            // Fluxo exigido: ajustar periodo no primeiro cliente (ou em toda conta na fase adaptativa).
            if (forceDateEachAccount || !datePrimed) {
              appendJobLog(job, 'date_filter', 'Primeiro cliente: aplicando periodo no calendario (data inicial + data final).', {
                dateFrom,
                dateTo,
                worker: workerId,
              })
              let appliedDate = await tryApplyDateFilters(job, pg, { dateFrom, dateTo })
              if (!appliedDate) {
                appendJobLog(job, 'date_filter', 'Primeira tentativa de data falhou. Repetindo...')
                await delay(250)
                appliedDate = await tryApplyDateFilters(job, pg, { dateFrom, dateTo })
              }
              if (!forceDateEachAccount) {
                // Nunca reabrir periodo apos a primeira conta (mesmo em falha).
                datePrimed = true
              }
              if (!appliedDate) {
                appendJobLog(job, 'date_filter', 'Data da primeira conta falhou; periodo bloqueado para proximas contas.', {
                  datePrimed,
                  conta: String(conta || ''),
                  worker: workerId,
                })
                appendJobLog(job, 'apuracao_bovespa', 'Nao foi possivel aplicar data no primeiro cliente. Pulando conta.', {
                  conta: String(conta || ''),
                  worker: workerId,
                })
                finishAccountRun(run, 'failed_filter', {
                  errorCode: 'DATE_FILTER_FAILED',
                  errorMessage: 'Nao foi possivel aplicar o periodo para a conta.',
                })
                continue
              }
              const dateVerified = await verifyExpectedDateRange(job, pg, { dateFrom, dateTo }, 'notas_data_inicial')
              if (!dateVerified) {
                appendJobLog(job, 'date_verify', 'Periodo nao confirmado visualmente; seguindo fluxo sem clicar em limpar.')
              }
            } else {
              appendJobLog(job, 'date_filter', 'Periodo mantido. Trocando somente conta e clicando Filtrar.', {
                conta: String(conta || ''),
                worker: workerId,
              })
            }

            // Filtrar (com retry/backoff se HubXP responder 429/403).
            const filterStats = { rateLimitHits: 0, attempts: 0, lastRateLimitStatus: null, lastRateLimitUrl: null }
            const filtered = await withNotasFilterLock(() => runNotasFilterSearch(job, pg, {
              maxAttempts: filterMaxAttempts,
              expectedAccount: String(conta || ''),
              stats: filterStats,
            }), {
              cooldownMs: filterCooldownMs,
            })
            run.rateLimitHits = Number(run.rateLimitHits || 0) + Number(filterStats.rateLimitHits || 0)
            if (!filtered) {
              appendJobLog(job, 'apuracao_bovespa', 'Falha ao acionar filtro de Notas. Pulando conta.', {
                conta: String(conta || ''),
                worker: workerId,
                rateLimitHits: run.rateLimitHits,
              })
              finishAccountRun(run, 'failed_filter', {
                errorCode: run.rateLimitHits > 0 ? 'NOTAS_FILTER_RATE_LIMIT' : 'NOTAS_FILTER_FAILED',
                errorMessage: run.rateLimitHits > 0
                  ? 'Falha ao filtrar notas apos retries com rate-limit.'
                  : 'Falha ao acionar filtro de notas.',
              })
              continue
            }

          } else {
            // Fluxo gravado aplicou conta/filtro; apos primeiro cliente, manter periodo.
            datePrimed = true
          }

          let table = null
          try {
            table = await getNotasTable(job, pg)
          } catch {
            appendJobLog(job, 'apuracao_bovespa', 'Tabela nao encontrada para conta', { conta: String(conta), worker: workerId })
          }

          if (!table) {
            finishAccountRun(run, 'failed_processing', {
              errorCode: 'NOTAS_TABLE_NOT_FOUND',
              errorMessage: 'Tabela de notas nao encontrada.',
            })
            continue
          }

          const runFilterRetry = async (attempts = retryFilterMaxAttempts) => {
            const retryStats = { rateLimitHits: 0, attempts: 0, lastRateLimitStatus: null, lastRateLimitUrl: null }
            const ok = await withNotasFilterLock(() => runNotasFilterSearch(job, pg, {
              maxAttempts: attempts,
              expectedAccount: String(conta || ''),
              stats: retryStats,
            }), {
              cooldownMs: filterCooldownMs,
            }).catch(() => false)
            run.rateLimitHits = Number(run.rateLimitHits || 0) + Number(retryStats.rateLimitHits || 0)
            return ok
          }

          const collectRowsForAccount = async () => {
            const state = {
              technicalErrors: 0,
              firstTechnicalError: null,
            }
            const collected = await collectNotasRowsFromAllPages(job, pg, {
              maxPages: maxNotesPages,
              onPage: async ({ table: pageTable, headers: pageHeaders, rows: pageRows }) => {
                const headers = Array.isArray(pageHeaders) ? pageHeaders : []
                const normalizeHeaderKey = (value) => stripDiacriticsLower(String(value || '')).replace(/\s+/g, ' ').trim()
                const findHeaderIndex = (aliases = []) => {
                  const norms = aliases.map((v) => normalizeHeaderKey(v)).filter(Boolean)
                  if (!norms.length) return -1
                  return headers.findIndex((header) => {
                    const h = normalizeHeaderKey(header)
                    return norms.some((token) => h.includes(token))
                  })
                }
                const likelyDate = (value) => /^\d{2}\/\d{2}\/\d{4}$/.test(String(value || '').trim())
                const likelyMoney = (value) => parseBrNumber(value) != null
                const firstRowForShift = pageRows[0] || null
                const idxClienteHdr = findHeaderIndex(['cliente'])
                const idxDataHdr = findHeaderIndex(['data'])
                const headerShiftLeft = (() => {
                  if (!firstRowForShift) return 0
                  if (idxClienteHdr <= 0 || idxDataHdr <= 0) return 0
                  const clienteRaw = firstRowForShift[headers[idxClienteHdr]]
                  const dataRaw = firstRowForShift[headers[idxDataHdr]]
                  if (likelyDate(clienteRaw) && likelyMoney(dataRaw)) return 1
                  return 0
                })()
                const readRowByAliases = (rowObj, aliases = []) => {
                  for (const alias of aliases) {
                    const idx = findHeaderIndex([alias])
                    if (idx < 0) continue
                    const adjustedIdx = Math.max(0, idx - headerShiftLeft)
                    const key = headers[adjustedIdx] || `coluna_${adjustedIdx + 1}`
                    const raw = rowObj?.[key]
                    if (raw != null && String(raw).trim() !== '') return raw
                  }
                  return null
                }

                let activePageTable = pageTable
                for (let ri = 0; ri < pageRows.length; ri += 1) {
                  if (job._abortApuracao) break
                  const row = pageRows[ri] || {}
                  const bolsa = scrubText(readRowByAliases(row, ['bolsa']) || row.Bolsa || row.bolsa || '')
                  const bolsaNorm = stripDiacriticsLower(bolsa).replace(/\s+/g, '')
                  const hasBovespa = !bolsaNorm || bolsaNorm.includes('bovespa')
                  const hasBmf = bolsaNorm.includes('bmf') || bolsaNorm.includes('futu')
                  const mixedBolsa = hasBovespa && hasBmf
                  if (!hasBovespa) continue

                  const findRowVal = (keys) => {
                    const raw = readRowByAliases(row, keys)
                    const parsed = parseBrNumber(raw)
                    if (parsed != null) return parsed
                    return null
                  }

                  const rowValorOps = findRowVal(['valor operações', 'valor operacoes', 'valor das operações', 'valor das operacoes'])
                    ?? parseBrNumber(row?.Data)
                    ?? parseBrNumber(row?.['Valor Operações'])
                  const rowOutrasTaxas = findRowVal(['outras taxas'])
                  const rowTotalTaxas = findRowVal(['total + taxas', 'total taxas'])
                  const rowTaxaOps = findRowVal(['taxas operacionais', 'taxa operacional'])
                    ?? parseBrNumber(row?.['Valor Operações'])
                    ?? parseBrNumber(row?.['Taxas Operacionais'])
                    ?? rowTotalTaxas
                  const canUseTableFastPath = tableFastPath && !mixedBolsa && rowValorOps != null && rowTaxaOps != null
                  const clienteFromRowRaw = scrubText(readRowByAliases(row, ['cliente']) || row.Cliente || row.cliente || row.coluna_1 || '')
                  const dataFromRowRaw = scrubText(readRowByAliases(row, ['data']) || row.Data || row.data || '')
                  const clienteFromRow = likelyDate(clienteFromRowRaw)
                    ? scrubText(row.coluna_1 || '')
                    : clienteFromRowRaw
                  const dataFromRow = likelyDate(dataFromRowRaw)
                    ? dataFromRowRaw
                    : (likelyDate(clienteFromRowRaw) ? clienteFromRowRaw : dataFromRowRaw)

                  if (canUseTableFastPath) {
                    const meta = accountMeta[contaDigits] || {}
                    outRows.push({
                      conta: contaDigits,
                      tag: scrubText(meta.tag || ''),
                      broker: scrubText(meta.broker || ''),
                      cliente: clienteFromRow,
                      data: dataFromRow,
                      valorOperacoes: Math.abs(rowValorOps),
                      valorFinanceiro: Math.abs(rowValorOps),
                      taxaOperacional: normalizePositiveMoney(rowTaxaOps),
                      corretagem: rowTaxaOps,
                      outrasTaxas: rowOutrasTaxas,
                      totalTaxas: rowTotalTaxas,
                      bolsa: bolsa || 'BOVESPA',
                      pdfPages: 0,
                      pdfScanned: 0,
                      source: 'table_fast_path',
                    })
                    processedNotes += 1
                    run.notesProcessed = Number(run.notesProcessed || 0) + 1
                    syncApuracaoDataToJob()
                    continue
                  }

                  let resumo = {
                    valorOperacoes: null,
                    valorFinanceiro: null,
                    taxaOperacional: null,
                    corretagem: null,
                    isDayTrade: false,
                    dayTradeReason: null,
                    notaClassification: null,
                    notaClassificationReason: null,
                    notaClassificationAnchors: [],
                    totalPages: 0,
                    pagesScanned: 0,
                  }
                  let resumoError = null
                  try {
                    await closeInlineNotaViewer(job, pg, {
                      strictX: false,
                      allowFallbackEscape: true,
                      maxAttempts: 3,
                      settleTimeoutMs: 2200,
                    }).catch(() => false)
                    resumo = {
                      ...resumo,
                      ...await extractNotaResumoWithRetry(job, pg, activePageTable, ri, {
                        timeoutMs: pdfTimeoutMs,
                        retries: perNoteRetries,
                        preferPdfBytes,
                        expectedConta: String(conta || ''),
                      }),
                    }
                    await pg.evaluate(() => {
                      if (document.activeElement && document.activeElement !== document.body) {
                        document.activeElement.blur()
                      }
                      document.body.click()
                    }).catch(() => null)
                    await delay(300)
                    try {
                      activePageTable = await getNotasTable(job, pg)
                    } catch {
                      // manter referencia
                    }
                  } catch (pdfErr) {
                    resumoError = pdfErr
                  }

                  if (resumoError) {
                    if (tableFallbackOnPdfError && !mixedBolsa && rowValorOps != null && rowTaxaOps != null) {
                      resumo = {
                        ...resumo,
                        valorOperacoes: Math.abs(rowValorOps),
                        valorFinanceiro: Math.abs(rowValorOps),
                        taxaOperacional: normalizePositiveMoney(rowTaxaOps),
                        corretagem: rowTaxaOps,
                        source: 'table_fallback_after_pdf_error',
                      }
                    } else {
                      state.technicalErrors += 1
                      if (!state.firstTechnicalError) {
                        state.firstTechnicalError = {
                          code: resumoError?.code || 'PDF_NOTE_FAILED',
                          message: resumoError?.message || 'Falha de leitura do PDF.',
                        }
                      }
                      continue
                    }
                  }

                  if (resumo.notaClassification && resumo.notaClassification !== 'BOVESPA' && !String(resumo.notaClassification).includes('BOVESPA')) continue
                  if (resumo.isDayTrade) continue

                  const valorOps = resumo.valorOperacoes ?? rowValorOps
                  const valorFin = resumo.valorFinanceiro ?? valorOps
                  const mixedBovespaNota = String(resumo.notaClassificationReason || '').includes('misto')
                  const taxaOps = resumo.taxaOperacional ?? resumo.corretagem ?? rowTaxaOps
                  const corretagem = mixedBovespaNota
                    ? (resumo.taxaOperacional ?? resumo.corretagem)
                    : (resumo.corretagem ?? resumo.taxaOperacional ?? rowTaxaOps)
                  const meta = accountMeta[contaDigits] || {}

                  outRows.push({
                    conta: contaDigits,
                    tag: scrubText(meta.tag || ''),
                    broker: scrubText(meta.broker || ''),
                    cliente: clienteFromRow,
                    data: dataFromRow,
                    valorOperacoes: normalizePositiveMoney(valorOps),
                    valorFinanceiro: valorFin,
                    taxaOperacional: normalizePositiveMoney(taxaOps),
                    corretagem,
                    outrasTaxas: rowOutrasTaxas,
                    totalTaxas: rowTotalTaxas,
                    bolsa: bolsa || 'BOVESPA',
                    pdfPages: resumo.totalPages,
                    pdfScanned: resumo.pagesScanned,
                    source: resumo.source || 'pdf_bytes',
                  })
                  processedNotes += 1
                  run.notesProcessed = Number(run.notesProcessed || 0) + 1
                  syncApuracaoDataToJob()
                }
              },
            })
            return { collected, state }
          }

          let result = await collectRowsForAccount()
          let dataRows = result.collected.rows || []
          let headers = result.collected.headers || []
          let pagesScanned = Number(result.collected.pagesScanned || 0)
          let technicalErrors = Number(result.state.technicalErrors || 0)
          let firstTechnicalError = result.state.firstTechnicalError || null

          if (dataRows.length === 0) {
            appendJobLog(job, 'apuracao_bovespa', 'Nenhuma nota retornada apos filtro; revalidando conta/filtro uma vez.', {
              conta: String(conta || ''),
              worker: workerId,
            })
            const reselected = await selectContaOnNotas(job, pg, conta).catch(() => false)
            let refiltered = false
            if (reselected) {
              refiltered = await runFilterRetry(retryFilterMaxAttempts)
            }
            if (refiltered) {
              await delay(320)
              result = await collectRowsForAccount()
              dataRows = result.collected.rows || []
              headers = result.collected.headers || headers
              pagesScanned = Number(result.collected.pagesScanned || pagesScanned)
              technicalErrors = Number(result.state.technicalErrors || 0)
              firstTechnicalError = result.state.firstTechnicalError || firstTechnicalError
            }

            if (dataRows.length === 0) {
              appendJobLog(job, 'apuracao_bovespa', 'Conta ainda sem linhas; aplicando recuperacao completa da tela de Notas.', {
                conta: String(conta || ''),
                worker: workerId,
              })
              try {
                await ensureNotasNegociacaoView(job, pg, payload.notasUrl, {
                  notesOnly: true,
                  menuFallbackInNotesOnly: true,
                })
                const reselectedAfterNav = await selectContaOnNotas(job, pg, conta).catch(() => false)
                if (reselectedAfterNav) {
                  await tryApplyDateFilters(job, pg, { dateFrom, dateTo }).catch(() => false)
                  const filteredAfterNav = await runFilterRetry(retryFilterMaxAttempts)
                  if (filteredAfterNav) {
                    await delay(360)
                    result = await collectRowsForAccount()
                    dataRows = result.collected.rows || []
                    headers = result.collected.headers || headers
                    pagesScanned = Number(result.collected.pagesScanned || pagesScanned)
                    technicalErrors = Number(result.state.technicalErrors || 0)
                    firstTechnicalError = result.state.firstTechnicalError || firstTechnicalError
                  }
                }
              } catch (rowsRecoverError) {
                appendJobLog(job, 'apuracao_bovespa', 'Recuperacao completa da tela de Notas falhou.', {
                  conta: String(conta || ''),
                  worker: workerId,
                  error: rowsRecoverError?.message || 'unknown',
                  code: rowsRecoverError?.code || null,
                })
              }
            }
          }

          run.notesListed = dataRows.length
          run.pagesScanned = pagesScanned

          appendJobLog(job, 'apuracao_bovespa', 'Notas listadas', {
            conta: String(conta || ''),
            rows: dataRows.length,
            pagesScanned,
            headers: headers.slice(0, 12),
            worker: workerId,
          })

          if (technicalErrors > 0) {
            finishAccountRun(run, 'failed_processing', {
              errorCode: firstTechnicalError?.code || 'PDF_NOTE_FAILED',
              errorMessage: firstTechnicalError?.message || 'Falha tecnica ao ler notas.',
            })
          } else if (Number(run.notesProcessed || 0) > 0) {
            finishAccountRun(run, 'success')
          } else {
            finishAccountRun(run, 'no_notes')
          }
        } catch (accountErr) {
          finishAccountRun(run, 'failed_processing', {
            errorCode: accountErr?.code || 'ACCOUNT_PROCESSING_FAILED',
            errorMessage: accountErr?.message || 'Falha ao processar conta.',
          })
          appendJobLog(job, 'apuracao_bovespa', 'Falha ao processar conta', {
            conta: String(conta),
            error: accountErr?.message || 'unknown',
            code: accountErr?.code || null,
            worker: workerId,
          })
          const closed = await closeInlineNotaViewer(job, pg)
          const interactive = await waitForNotasUiInteractable(pg, 2600)
          await pg.evaluate(() => {
            if (document.activeElement && document.activeElement !== document.body) {
              document.activeElement.blur()
            }
            document.body.click()
          }).catch(() => null)
          appendJobLog(job, 'ui_reset', 'Recuperacao apos falha de conta.', {
            conta: String(conta || ''),
            worker: workerId,
            closedModal: closed,
            interactive,
          })
        }

        // Reforco: ao terminar a conta, fechar qualquer modal pendente no X.
        const closedAfterAccount = await closeInlineNotaViewer(job, pg, { maxAttempts: 2, settleTimeoutMs: 1800 })
        if (closedAfterAccount) {
          appendJobLog(job, 'ui_reset', 'Modal de nota fechado no X ao finalizar conta.', {
            conta: String(conta || ''),
            worker: workerId,
          })
        }

        // Nao recarregar entre clientes: manter mesmo periodo e apenas trocar conta + filtrar.
        if (bi < batch.length - 1 && !job._abortApuracao) {
          await delay(250)
        }
      }
    }

    try {
      // Iniciar workers em paralelo (1 por browser, cada um com suas contas pre-atribuidas)
      await Promise.allSettled(readyWorkers.map((w, idx) => processWorker(w, idx + 1)))

      if (job._abortApuracao) {
        throw createHttpError(409, 'APURACAO_ABORTED', 'Processo interrompido pelo usuario.', {
          processedNotes,
          totalAccounts: accounts.length,
        }, 'apuracao_bovespa')
      }

      if (adaptiveRateLimit) {
        const retryAccounts = accountRuns
          .filter((run) => run.status === 'failed_filter' && Number(run.rateLimitHits || 0) > 0)
          .map((run) => run.account)
        if (retryAccounts.length) {
          const retryBatch = retryAccounts
            .map((account) => ({ account, index: accounts.findIndex((item) => toAccountDigits(item) === account) }))
            .filter((item) => item.index >= 0)
            .sort((a, b) => a.index - b.index)
            .map((item) => ({ index: item.index, conta: item.account }))
          if (retryBatch.length) {
            const recoveryWorker = readyWorkers[0]
            appendJobLog(job, 'notas_rate_limit', 'Iniciando fase adaptativa (single-browser) para contas com rate-limit.', {
              accounts: retryBatch.map((item) => String(item.conta || '')),
            })
            await ensureNotasNegociacaoView(job, recoveryWorker.page, payload.notasUrl, {
              notesOnly: true,
              menuFallbackInNotesOnly: true,
            }).catch(() => null)
            await processWorker(recoveryWorker, 'A1', {
              phase: 'adaptive',
              batchOverride: retryBatch,
              filterMaxAttempts: 10,
              retryFilterMaxAttempts: 8,
              filterCooldownMs: 900,
              forceDateEachAccount: true,
            })
          }
        }
      }

      const collectedAt = now()
      const columns = [
        'conta',
        'tag',
        'broker',
        'cliente',
        'data',
        'valorOperacoes',
        'valorFinanceiro',
        'taxaOperacional',
        'corretagem',
        'outrasTaxas',
        'totalTaxas',
        'bolsa',
        'pdfPages',
        'pdfScanned',
      ]
      const accountRunsPayload = accountRuns.map((run) => ({
        account: run.account,
        worker: run.worker,
        status: run.status,
        notesListed: Number(run.notesListed || 0),
        notesProcessed: Number(run.notesProcessed || 0),
        pagesScanned: Number(run.pagesScanned || 0),
        errorCode: run.errorCode || null,
        errorMessage: run.errorMessage || null,
        rateLimitHits: Number(run.rateLimitHits || 0),
        startedAt: run.startedAt || null,
        finishedAt: run.finishedAt || null,
      }))
      const summary = getAccountSummary()
      const failedAccounts = accountRunsPayload.filter((run) => isFailedAccountStatus(run.status))
      const normalizedOutRows = outRows.map((row) => normalizeApuracaoRowMoney(row))

      job._apuracaoBovespaData = {
        columns,
        rows: normalizedOutRows,
        totalRows: normalizedOutRows.length,
        collectedAt,
        accountRuns: accountRunsPayload,
        failedAccounts,
        summary,
      }

      if (strictCompletion && failedAccounts.length > 0) {
        throw createHttpError(
          409,
          'APURACAO_INCOMPLETE',
          `Apuracao concluida com falhas em ${failedAccounts.length} conta(s).`,
          {
            failedAccounts: failedAccounts.map((run) => ({
              account: run.account,
              errorCode: run.errorCode,
              errorMessage: run.errorMessage,
            })),
            summary,
          },
          'apuracao_bovespa_incomplete',
        )
      }

      setJobStatus(job, STATUS.SUCCESS, 'apuracao_bovespa_done', `Apuracao concluida com ${normalizedOutRows.length} notas (${activeWorkerCount} browsers).`, {
        currentPage: accounts.length,
        totalPages: accounts.length,
        rowsCollected: normalizedOutRows.length,
        accountsProcessed: summary.accountsProcessed,
        accountsFailed: summary.failed,
        accountsTotal: accounts.length,
        finishedAt: collectedAt,
        elapsedMs: Math.max(0, collectedAt - (job.progress.startedAt || collectedAt)),
      })

      appendJobLog(job, 'apuracao_bovespa', 'Apuracao Bovespa concluida', {
        notes: normalizedOutRows.length,
        concurrency: activeWorkerCount,
        failedAccounts: failedAccounts.length,
      })

      return {
        status: STATUS.SUCCESS,
        columns,
        rows: normalizedOutRows,
        totalRows: normalizedOutRows.length,
        collectedAt,
        accountRuns: accountRunsPayload,
        failedAccounts,
        summary,
      }
    } finally {
      // Fechar apenas browsers auxiliares. Em modo pagina unica, manter browser principal aberto.
      const closableWorkers = activeWorkers.filter((w) => !w.keepOpen)
      appendJobLog(job, 'apuracao_bovespa', `Fechando ${closableWorkers.length} browsers...`)
      await Promise.allSettled(closableWorkers.map(async (w) => {
        try { await w.page?.close() } catch {}
        try { await w.context?.close() } catch {}
        try { await w.browser?.close() } catch {}
      }))
    }
  })()

  try {
    const result = await Promise.race([collectPromise, timeoutPromise])
    return result
  } catch (error) {
    const isAbortError = error?.code === 'APURACAO_ABORTED'
    if (!isAbortError) {
      await captureDebugScreenshot(job, job.page, 'apuracao-bovespa-failed')
    }
    job.error = serializeError(error)
    setJobStatus(job, STATUS.FAILED, error?.stage || 'apuracao_bovespa', job.error.message)
    if (isAbortError) {
      appendJobLog(job, 'apuracao_bovespa', 'Apuracao interrompida pelo usuario')
    } else {
      appendJobLog(job, error?.stage || 'apuracao_bovespa', 'Falha na apuracao Bovespa', {
        code: job.error.code,
        url: getPageUrl(job.page),
      })
    }
    throw error
  } finally {
    job.running = false
    // Evita que o flag de abort "vaze" para a proxima execucao.
    job._abortApuracao = false
    touchJob(job)
  }
}

const respondError = (res, error, job = null) => {
  const serialized = serializeError(error)
  const status = serialized.status || 500
  res.status(status).json({
    ok: false,
    error: serialized,
    job: job ? buildJobSnapshot(job) : null,
  })
}

const HUBXP_LOOKUP_SEARCH_SELECTORS = [
  'search-customers input[type="text"]',
  'search-customers input',
  'input[type="search"]',
  'input[type="text"][placeholder*="pesquisar" i]',
  'input[placeholder*="buscar" i]',
  'input[placeholder*="pesquisar" i]',
  'input[placeholder*="conta" i]',
  'input[placeholder*="cliente" i]',
  'input[aria-label*="buscar" i]',
  'input[aria-label*="pesquisar" i]',
  'input[aria-label*="conta" i]',
  'input[aria-label*="cliente" i]',
  'input[name*="search" i]',
  'input[name*="conta" i]',
  'input[name*="cliente" i]',
]
const HUBXP_LOOKUP_STRICT_SEARCH_SELECTORS = [
  'hbumenu-wrapper search-customers input[placeholder="Pesquisar"]',
  'hbumenu-wrapper search-customers input[type="text"][placeholder*="Pesquisar" i]',
  'search-customers input[placeholder="Pesquisar"]',
  'search-customers input[type="text"][placeholder*="Pesquisar" i]',
  'search-customers input[type="search"]',
]
const HUBXP_LOOKUP_MIN_POST_SEARCH_WAIT_MS = 2000

const resolveRequestUserKey = (req, body = null) => {
  const payload = body && typeof body === 'object' ? body : {}
  const query = req?.query && typeof req.query === 'object' ? req.query : {}
  const headerUserKey = scrubText(req?.headers?.['x-user-key'] || req?.headers?.['x-userkey'] || '')
  const candidate = payload.userKey || query.userKey || headerUserKey || ''
  const normalized = normalizeUserKey(candidate)
  if (normalized === 'guest' && !ALLOW_LEGACY_GUEST) {
    throw createHttpError(
      400,
      'USER_KEY_REQUIRED',
      'userKey obrigatorio. Informe um identificador individual por usuario.',
    )
  }
  return normalized
}

const normalizeAccountDigits = (value) => String(value || '').replace(/\D/g, '')

const sanitizeAccountInputRows = (accounts) => {
  const list = Array.isArray(accounts) ? accounts : []
  const out = []
  for (const item of list) {
    const digits = normalizeAccountDigits(item)
    if (!digits) continue
    out.push(digits)
  }
  return out
}

const parseHubxpLookupConfig = (payload = {}) => {
  const minWaitMs = Number.isFinite(Number(payload.minWaitMs))
    ? Math.max(2000, Math.min(10000, Number(payload.minWaitMs)))
    : 2000
  const timeoutMs = Number.isFinite(Number(payload.timeoutMs))
    ? Math.max(4000, Math.min(60000, Number(payload.timeoutMs)))
    : 10000
  const retryPerAccount = Number.isFinite(Number(payload.retryPerAccount))
    ? Math.max(0, Math.min(2, Number(payload.retryPerAccount)))
    : 1
  return { minWaitMs, timeoutMs, retryPerAccount }
}

const gotoHubxpHomeForLookup = async (job, page) => {
  const homeUrl = scrubText(
    process.env.HUBXP_HOME_URL
    || process.env.HUBXP_ENTRY_URL
    || DEFAULT_ENTRY_URL,
  )
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null)
  // Aguardar componentes Shadow DOM renderizarem (search-customers pode demorar)
  await page.waitForSelector('search-customers, input[placeholder*="Pesquisar" i], input[placeholder*="Buscar" i], input[type="search"]', { timeout: 4000 }).catch(() => null)
  await delay(300)
  appendJobLog(job, 'hubxp_lookup', 'Navegou para Home', { url: getPageUrl(page) })
}

const createSharedLookupPage = async (job) => {
  if (!job?.context) {
    return { page: job?.page || null, isolated: false }
  }

  let lookupPage = null
  try {
    lookupPage = await job.context.newPage()
    await prepareExtraPage(lookupPage)
    // Sempre navegar para Home para lookup — nunca depender da URL de job.page
    // que pode estar em Central de Ordens ou outro local
    const homeUrl = scrubText(
      process.env.HUBXP_HOME_URL
      || process.env.HUBXP_ENTRY_URL
      || DEFAULT_ENTRY_URL,
    )
    await lookupPage.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
    await lookupPage.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null)

    // Verificar se a aba isolada esta autenticada
    const lookupAuthenticated = await isAuthenticated(lookupPage).catch(() => false)
    if (!lookupAuthenticated) {
      appendJobLog(job, 'hubxp_lookup', 'Aba isolada nao autenticada; tentando recarregar com credenciais...', {
        url: getPageUrl(lookupPage),
      })
      // Tentar mais uma vez — algumas vezes o primeiro load nao herda cookies corretamente
      await lookupPage.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null)
      await lookupPage.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null)
      const retryAuth = await isAuthenticated(lookupPage).catch(() => false)
      if (!retryAuth) {
        appendJobLog(job, 'hubxp_lookup', 'Aba isolada nao autenticou; usando job.page como fallback.', {
          url: getPageUrl(lookupPage),
        })
        await lookupPage.close().catch(() => null)
        // Fallback: usar job.page (a protecao contra concorrencia ja e feita pelo caller)
        return { page: job.page, isolated: false }
      }
    }

    // Aguardar componentes Shadow DOM da busca renderizarem
    await lookupPage.waitForSelector('search-customers, input[placeholder*=\"Pesquisar\" i], input[placeholder*=\"Buscar\" i], input[type=\"search\"]', { timeout: 4000 }).catch(() => null)
    await delay(300)

    appendJobLog(job, 'hubxp_lookup', 'Lookup compartilhado em aba isolada.', {
      url: getPageUrl(lookupPage),
      sourceUrl: getPageUrl(job.page),
    })
    return { page: lookupPage, isolated: true }
  } catch (error) {
    await lookupPage?.close().catch(() => null)
    appendJobLog(job, 'hubxp_lookup', 'Falha ao abrir aba isolada para lookup; usando aba principal.', {
      message: scrubText(error?.message || 'Erro desconhecido'),
    })
    return { page: job.page, isolated: false }
  }
}

const resolveHubxpHomeSearchFieldStrict = async (page) => {
  for (const selector of HUBXP_LOOKUP_STRICT_SEARCH_SELECTORS) {
    try {
      const locator = page.locator(selector).first()
      if (await locator.count() === 0) continue
      if (!(await locator.isVisible({ timeout: 160 }).catch(() => false))) continue
      return {
        locator,
        selector,
        strategy: 'strict_locator',
      }
    } catch {
      // tentar proximo selector estrito
    }
  }

  const marker = await page.evaluate(() => {
    const normalize = (value) => String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const isVisible = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const hostChainTags = (el) => {
      const tags = []
      let root = el?.getRootNode?.()
      let guard = 0
      while (root?.host && guard < 10) {
        tags.push(normalize(root.host.tagName || ''))
        root = root.host?.getRootNode?.()
        guard += 1
      }
      return tags
    }
    const scoreInput = (input) => {
      if (!input || !isVisible(input)) return -1
      const r = input.getBoundingClientRect()
      const placeholder = normalize(input.getAttribute('placeholder') || '')
      const aria = normalize(input.getAttribute('aria-label') || '')
      const type = normalize(input.getAttribute('type') || '')
      const name = normalize(input.getAttribute('name') || '')
      const id = normalize(input.getAttribute('id') || '')
      const cls = normalize(input.getAttribute('class') || '')
      const hint = `${placeholder} ${aria} ${name} ${id} ${cls}`.trim()
      const hostTags = hostChainTags(input).join(' ')
      const insideSearchCustomers = hostTags.includes('search-customers')
        || Boolean(input.closest('search-customers'))
      const insideWrapper = hostTags.includes('hbumenu-wrapper')
        || /wrapper-customer-search/.test(cls)
        || Boolean(input.closest('.wrapper-customer-search'))

      let score = 0
      if (placeholder === 'pesquisar') score += 220
      if (/pesquisar/.test(placeholder)) score += 160
      if (/pesquisar|buscar|search/.test(hint)) score += 80
      if (insideSearchCustomers) score += 180
      if (insideWrapper) score += 120
      if (type === 'search') score += 40
      if (r.top >= 0 && r.top <= 220) score += 28
      if (r.width >= 170) score += 12
      if (r.width >= 240) score += 12
      if (input.disabled || input.readOnly) score -= 120
      if (!/pesquisar|buscar|search|conta|cliente/.test(hint) && !insideSearchCustomers) score -= 80
      return score
    }

    const inputs = deepFind(document, 'input')
      .map((input) => ({ input, score: scoreInput(input) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)

    if (!inputs.length) return null
    for (const el of deepFind(document, 'input[data-hubxp-home-search-strict="1"]')) {
      el.removeAttribute('data-hubxp-home-search-strict')
    }
    inputs[0].input.setAttribute('data-hubxp-home-search-strict', '1')
    return 'input[data-hubxp-home-search-strict="1"]'
  }).catch(() => null)

  if (!marker) return null
  return {
    locator: page.locator(marker).first(),
    selector: marker,
    strategy: 'strict_shadow',
  }
}

const resolveHubxpHomeSearchField = async (page, options = {}) => {
  const strictOnly = toBoolean(options.strictOnly, false)

  const strictField = await resolveHubxpHomeSearchFieldStrict(page)
  if (strictField?.locator) return strictField
  if (strictOnly) return null

  let field = await pickVisibleLocator(page, HUBXP_LOOKUP_SEARCH_SELECTORS)
  if (!field?.locator) {
    const marker = await page.evaluate(() => {
      const normalize = (value) => String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
      const hintScore = (hint) => {
        let score = 0
        if (/pesquisar/.test(hint)) score += 40
        if (/buscar/.test(hint)) score += 30
        if (/search/.test(hint)) score += 24
        if (/conta|cliente/.test(hint)) score += 16
        return score
      }
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }
      const isVisible = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const scoreInput = (input) => {
        if (!input || !isVisible(input)) return -1
        const r = input.getBoundingClientRect()
        const placeholder = normalize(input.getAttribute('placeholder') || '')
        const aria = normalize(input.getAttribute('aria-label') || '')
        const name = normalize(input.getAttribute('name') || '')
        const id = normalize(input.getAttribute('id') || '')
        const cls = normalize(input.getAttribute('class') || '')
        const type = normalize(input.getAttribute('type') || '')
        const hint = `${placeholder} ${aria} ${name} ${id} ${cls}`.trim()
        if (!/pesquisar|buscar|search|conta|cliente/.test(hint)) return -1

        let score = hintScore(hint)
        if (type === 'search') score += 20
        if (placeholder === 'pesquisar') score += 25
        if (r.top >= 0 && r.top <= 220) score += 32
        if (r.width >= 180) score += 14
        if (r.width >= 260) score += 10
        if (r.height >= 26) score += 6
        if (input.closest('header, nav, [class*="header" i], [class*="top" i], [class*="toolbar" i]')) score += 22
        if (input.closest('table, [role="table"], [class*="filter" i], [class*="filtro" i]')) score -= 20
        if (input.disabled || input.readOnly) score -= 50
        return score
      }

      const inputs = deepFind(document, 'input')
      const scored = inputs
        .map((input) => ({ input, score: scoreInput(input) }))
        .filter((item) => item.score > -1)
        .sort((a, b) => b.score - a.score)
      if (scored.length) {
        for (const el of deepFind(document, 'input[data-hubxp-home-search="1"]')) {
          el.removeAttribute('data-hubxp-home-search')
        }
        scored[0].input.setAttribute('data-hubxp-home-search', '1')
        return 'input[data-hubxp-home-search="1"]'
      }
      return null
    }).catch(() => null)
    if (marker) {
      field = { locator: page.locator(marker).first(), selector: marker }
    }
  }
  if (!field?.locator) return null
  return {
    locator: field.locator,
    selector: field.selector,
    strategy: 'fallback_heuristic',
  }
}

const lookupDigitsMatch = (currentValue, accountDigits) => {
  const currentDigits = normalizeAccountDigits(currentValue)
  const targetDigits = normalizeAccountDigits(accountDigits)
  if (!targetDigits) return false
  if (!currentDigits) return false
  return currentDigits.includes(targetDigits) || targetDigits.includes(currentDigits)
}

const searchAccountFromHomeDeepStrict = async (job, page, accountDigits) => {
  const digits = normalizeAccountDigits(accountDigits)
  if (!digits) return { ok: false, fieldLocator: null, fieldSelector: null, fieldStrategy: null, elapsedMs: 0 }

  const startedAt = now()
  const deepResult = await page.evaluate((payload) => {
    const targetDigits = String(payload?.digits || '').replace(/\D/g, '')
    if (!targetDigits) return { ok: false, reason: 'NO_DIGITS' }

    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const normalize = (value) => String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const isVisible = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const hostChain = (el) => {
      const tags = []
      let root = el?.getRootNode?.()
      let guard = 0
      while (root?.host && guard < 10) {
        tags.push(normalize(root.host.tagName || ''))
        root = root.host?.getRootNode?.()
        guard += 1
      }
      return tags.join(' ')
    }
    const scoreInput = (input) => {
      if (!input || !isVisible(input)) return -1
      const ph = normalize(input.getAttribute('placeholder') || '')
      const aria = normalize(input.getAttribute('aria-label') || '')
      const name = normalize(input.getAttribute('name') || '')
      const id = normalize(input.getAttribute('id') || '')
      const cls = normalize(input.getAttribute('class') || '')
      const type = normalize(input.getAttribute('type') || '')
      const hint = `${ph} ${aria} ${name} ${id} ${cls}`.trim()
      const hosts = hostChain(input)
      const insideSearchCustomers = hosts.includes('search-customers') || Boolean(input.closest('search-customers'))
        || hosts.includes('customer-search') || Boolean(input.closest('customer-search'))
      const insideWrapper = hosts.includes('hbumenu-wrapper')
        || /wrapper-customer-search|search-wrapper|header-search/.test(cls)
        || Boolean(input.closest('.wrapper-customer-search'))
        || Boolean(input.closest('[class*="search-wrapper" i]'))
        || Boolean(input.closest('header'))
        || Boolean(input.closest('nav'))
      let score = 0
      if (ph === 'pesquisar') score += 220
      if (/pesquisar/.test(hint)) score += 120
      if (/buscar|search|procurar|pesquise/.test(hint)) score += 60
      if (insideSearchCustomers) score += 180
      if (insideWrapper) score += 120
      if (type === 'search') score += 40
      // Inputs no topo da pagina sao mais provaveis de ser busca global
      const inputRect = input.getBoundingClientRect()
      if (inputRect.top >= 0 && inputRect.top <= 120) score += 50
      if (inputRect.width >= 200) score += 20
      if (!/pesquisar|buscar|search|conta|cliente|procurar|pesquise/.test(hint) && !insideSearchCustomers) score -= 80
      if (input.disabled || input.readOnly) score -= 200
      return score
    }

    const candidates = deepFind(document, 'input')
      .map((input) => ({ input, score: scoreInput(input) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
    if (!candidates.length) return { ok: false, reason: 'INPUT_NOT_FOUND' }

    const input = candidates[0].input
    input.focus()

    const setValue = (value) => {
      const next = String(value || '')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(input, next)
      else input.value = next
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    }

    setValue('')
    setValue(targetDigits)

    const enterEventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      composed: true,
      cancelable: true,
    }
    input.dispatchEvent(new KeyboardEvent('keydown', enterEventInit))
    input.dispatchEvent(new KeyboardEvent('keypress', enterEventInit))
    input.dispatchEvent(new KeyboardEvent('keyup', enterEventInit))
    input.dispatchEvent(new Event('blur', { bubbles: true, composed: true }))

    const readBack = String(input.value || '')
    const readDigits = readBack.replace(/\D/g, '')
    const ok = readDigits.includes(targetDigits) || targetDigits.includes(readDigits)

    return {
      ok,
      reason: ok ? 'FILLED_AND_ENTER' : 'VALUE_MISMATCH',
      score: candidates[0].score,
      readBack,
      host: hostChain(input),
      placeholder: String(input.getAttribute('placeholder') || ''),
    }
  }, { digits }).catch(() => ({ ok: false, reason: 'EVAL_ERROR' }))

  const elapsedMs = now() - startedAt
  if (!deepResult?.ok) {
    appendJobLog(job, 'hubxp_lookup', 'Fallback deep strict falhou ao preencher busca da conta.', {
      account: accountDigits,
      reason: deepResult?.reason || 'unknown',
      elapsedMs,
      url: getPageUrl(page),
    })
    return {
      ok: false,
      fieldLocator: null,
      fieldSelector: null,
      fieldStrategy: null,
      elapsedMs,
    }
  }

  appendJobLog(job, 'hubxp_lookup', 'Busca da conta disparada via fallback deep strict.', {
    account: accountDigits,
    score: deepResult?.score ?? null,
    placeholder: deepResult?.placeholder || '',
    waitedAfterSearchMs: HUBXP_LOOKUP_MIN_POST_SEARCH_WAIT_MS,
    elapsedMs,
    url: getPageUrl(page),
  })
  await delay(HUBXP_LOOKUP_MIN_POST_SEARCH_WAIT_MS)
  return {
    ok: true,
    fieldLocator: null,
    fieldSelector: 'deep-shadow-search-customers-input',
    fieldStrategy: 'strict_deep_fallback',
    elapsedMs: now() - startedAt,
  }
}

const dispatchLookupSearchEvents = async (locator, accountDigits) => {
  const digits = normalizeAccountDigits(accountDigits)
  if (!digits || !locator) return false
  try {
    await locator.evaluate((el, value) => {
      const nextValue = String(value || '')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(el, nextValue)
      else el.value = nextValue
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
      el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }))
    }, digits)
    return true
  } catch {
    return false
  }
}

const fillLookupSearchField = async (locator, accountDigits) => {
  const digits = normalizeAccountDigits(accountDigits)
  if (!digits || !locator) return false

  try { await locator.click({ timeout: 1200 }) } catch {}
  try { await locator.press('Control+A') } catch {}
  try { await locator.press('Backspace') } catch {}
  try { await locator.type(digits, { delay: 34 }) } catch {}

  let currentValue = await readLocatorValue(locator)
  if (!lookupDigitsMatch(currentValue, digits)) {
    const filled = await fillInputRobust(locator, digits)
    if (!filled) return false
    currentValue = await readLocatorValue(locator)
  }
  await dispatchLookupSearchEvents(locator, digits)
  return lookupDigitsMatch(currentValue, digits)
}

const searchAccountFromHome = async (job, page, accountDigits, options = {}) => {
  const fieldWaitMs = Number.isFinite(Number(options.fieldWaitMs))
    ? Math.max(1500, Math.min(12000, Number(options.fieldWaitMs)))
    : 5000
  const strictOnly = toBoolean(options.strictOnly, false)

  const startedAt = now()
  let field = null
  while (now() - startedAt <= fieldWaitMs) {
    field = await resolveHubxpHomeSearchField(page, { strictOnly })
    if (field?.locator) break
    await delay(120)
  }

  if (!field?.locator) {
    appendJobLog(job, 'hubxp_lookup', 'Campo de busca da Home nao encontrado. Tentando fallback deep strict...', {
      strictOnly,
      elapsedMs: now() - startedAt,
      url: getPageUrl(page),
    })
    const deepSearch = await searchAccountFromHomeDeepStrict(job, page, accountDigits).catch(() => null)
    if (deepSearch?.ok) {
      return deepSearch
    }
    return {
      ok: false,
      fieldLocator: null,
      fieldSelector: null,
      fieldStrategy: null,
      elapsedMs: now() - startedAt,
    }
  }

  const filled = await fillLookupSearchField(field.locator, accountDigits)
  if (!filled) {
    appendJobLog(job, 'hubxp_lookup', 'Falha ao preencher campo de busca da Home. Tentando fallback deep strict...', {
      selector: field.selector || 'unknown',
      strategy: field.strategy || 'unknown',
      strictOnly,
      elapsedMs: now() - startedAt,
    })
    const deepSearch = await searchAccountFromHomeDeepStrict(job, page, accountDigits).catch(() => null)
    if (deepSearch?.ok) {
      return deepSearch
    }
    return {
      ok: false,
      fieldLocator: field.locator,
      fieldSelector: field.selector || null,
      fieldStrategy: field.strategy || null,
      elapsedMs: now() - startedAt,
    }
  }

  await field.locator.click({ timeout: 800 }).catch(() => null)
  // Aguardar resultados de autocomplete/dropdown antes de pressionar Enter
  // HubXP pode mostrar resultados "live" enquanto o usuario digita
  await delay(1200)
  // Verificar se ja apareceram resultados antes de pressionar Enter
  const hasLiveResults = await page.evaluate((digits) => {
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const resultNodes = deepFind(document, 'search-customers-results, search-customers li, search-customers a, [role="listbox"], [role="option"], [class*="dropdown" i] li, [class*="result" i] li, [class*="suggestion" i] li')
    for (const node of resultNodes) {
      const r = node.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return true
    }
    return false
  }, normalizeAccountDigits(accountDigits)).catch(() => false)
  if (!hasLiveResults) {
    // Sem resultados live — pressionar Enter para disparar busca
    await field.locator.press('Enter').catch(() => null)
    await clickByTexts(page, ['Buscar', 'Pesquisar', 'Aplicar', 'Filtrar'], { timeout: 700 }).catch(() => null)
  } else {
    appendJobLog(job, 'hubxp_lookup', 'Resultados live detectados apos digitacao; nao pressionando Enter.', {
      account: accountDigits,
    })
  }
  await delay(HUBXP_LOOKUP_MIN_POST_SEARCH_WAIT_MS)
  const elapsedMs = now() - startedAt
  appendJobLog(job, 'hubxp_lookup', 'Busca da conta disparada na Home', {
    account: accountDigits,
    selector: field.selector || 'unknown',
    strategy: field.strategy || 'unknown',
    strictOnly,
    waitedAfterSearchMs: HUBXP_LOOKUP_MIN_POST_SEARCH_WAIT_MS,
    elapsedMs,
    url: getPageUrl(page),
  })
  return {
    ok: true,
    fieldLocator: field.locator,
    fieldSelector: field.selector || null,
    fieldStrategy: field.strategy || null,
    elapsedMs,
  }
}

const waitForStrictAccountResultFromHome = async (page, accountDigits, timeoutMs = 2800) => {
  const digits = String(accountDigits || '').replace(/\D/g, '')
  if (!digits) return false
  const startedAt = now()
  while (now() - startedAt <= timeoutMs) {
    const found = await page.evaluate((payload) => {
      const targetDigits = String(payload?.digits || '')
      if (!targetDigits) return false
      if (/posicao-consolidada|visao-atual-cliente|oda/i.test(String(window.location?.href || ''))) return true

      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }

      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const hosts = deepFind(document, 'search-customers-results')
      for (const host of hosts) {
        const roots = [host]
        if (host.shadowRoot) roots.unshift(host.shadowRoot)
        for (const root of roots) {
          let nodes = []
          try {
            nodes = Array.from(root.querySelectorAll('li, a, [role="option"], [role="listitem"], div, p, h3, span'))
          } catch {
            nodes = []
          }
          for (const node of nodes) {
            const text = normalize(node?.textContent || node?.innerText || '')
            if (!text) continue
            const digitsInText = text.replace(/\D/g, '')
            if (digitsInText.includes(targetDigits) && /conta xp|cliente|conta|codigo|c[oó]digo/.test(text)) return true
            if (digitsInText.includes(targetDigits)) return true
            if (/conta|cliente/.test(text) && text.length <= 220) return true
          }
          if (nodes.length > 0) return true
        }
      }
      return false
    }, { digits }).catch(() => false)
    if (found) return true
    await delay(120)
  }
  return false
}

const waitForAccountResultFromHome = async (page, accountDigits, timeoutMs = 7000) => {
  const digits = String(accountDigits || '').replace(/\D/g, '')
  if (!digits) return false
  const startedAt = now()
  while (now() - startedAt <= timeoutMs) {
    const found = await page.evaluate((payload) => {
      const targetDigits = String(payload?.digits || '')
      if (!targetDigits) return false
      if (/posicao-consolidada|visao-atual-cliente|oda/i.test(String(window.location?.href || ''))) return true
      const deepFind = (root, selector) => {
        const out = []
        try { out.push(...root.querySelectorAll(selector)) } catch {}
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) {
            try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
          }
        }
        return out
      }

      // Fast path: resultado no componente de busca do Hub.
      const nodes = deepFind(
        document,
        'search-customers-results li, search-customers-results a, search-customers-results h3, search-customers-results p, search-customers-results div',
      )
      for (const node of nodes) {
        const text = String(node?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
        if (!text) continue
        const hasDigits = text.replace(/\D/g, '').includes(targetDigits)
        if (!hasDigits) continue
        if (/conta xp|resultado|cliente|conta/.test(text)) return true
      }

      // Fallback leve para páginas com layout diferente.
      const fallback = deepFind(document, '[class*="result" i], [class*="customer" i], [role="option"]')
      for (const node of fallback) {
        const text = String(node?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
        if (!text) continue
        if (text.replace(/\D/g, '').includes(targetDigits)) return true
      }

      const broadNodes = deepFind(
        document,
        '[role="option"], [role="listitem"], [role="menuitem"], [role="row"], li, tr, a, button',
      )
      for (const node of broadNodes) {
        const text = String(node?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
        if (!text) continue
        if (text.replace(/\D/g, '').includes(targetDigits)) return true
      }
      return false
    }, { digits }).catch(() => false)
    if (found) return true
    await delay(140)
  }
  return false
}

const clickFirstAccountResultStrict = async (job, page, accountDigits) => {
  // Fase 1: Tentar encontrar <a> diretamente dentro de search-customers-results shadow DOM
  // Estrutura observada: search-customers-results > #shadow-root > div.wrapper-result > ul > li > a[title]
  const directAnchor = await page.evaluate((payload) => {
    const digits = String(payload?.accountDigits || '').replace(/\D/g, '')
    if (!digits) return null

    // Buscar search-customers-results em qualquer nivel de shadow DOM
    const findHosts = (root) => {
      const out = []
      try {
        const found = root.querySelectorAll('search-customers-results')
        for (const el of found) out.push(el)
      } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try {
            const inner = el.shadowRoot.querySelectorAll('search-customers-results')
            for (const el2 of inner) out.push(el2)
          } catch {}
          out.push(...findHosts(el.shadowRoot))
        }
      }
      return out
    }

    const hosts = findHosts(document)
    const debugAnchors = []
    for (const host of hosts) {
      const sr = host.shadowRoot
      if (!sr) continue
      // Buscar todos os <a> dentro do shadow root (recursivamente em caso de mais shadow)
      const anchors = sr.querySelectorAll('a')
      for (const a of anchors) {
        const title = String(a.getAttribute('title') || '').trim()
        const text = String(a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim()
        const textDigits = (text + title).replace(/\D/g, '')
        const r = a.getBoundingClientRect()
        debugAnchors.push({
          title: title.slice(0, 80),
          text: text.slice(0, 80),
          w: Math.round(r.width),
          h: Math.round(r.height),
          cx: Math.round(r.left + r.width / 2),
          cy: Math.round(r.top + r.height / 2),
        })
        // Match: ancora cujo text/title contem os digitos da conta
        if (textDigits.includes(digits) && r.width > 5 && r.height > 5) {
          return {
            found: true,
            strategy: 'direct_shadow_anchor',
            cx: Math.round(r.left + r.width / 2),
            cy: Math.round(r.top + r.height / 2),
            width: Math.round(r.width),
            height: Math.round(r.height),
            tagName: 'A',
            title,
            text: text.slice(0, 160),
            debugAnchors,
            hostsCount: hosts.length,
          }
        }
      }
      // Fallback: buscar <li> que contenha os digitos
      const lis = sr.querySelectorAll('li')
      for (const li of lis) {
        const text = String(li.innerText || li.textContent || '').replace(/\s+/g, ' ').trim()
        const textDigits = text.replace(/\D/g, '')
        const r = li.getBoundingClientRect()
        if (textDigits.includes(digits) && r.width > 5 && r.height > 5) {
          return {
            found: true,
            strategy: 'direct_shadow_li',
            cx: Math.round(r.left + r.width / 2),
            cy: Math.round(r.top + r.height / 2),
            width: Math.round(r.width),
            height: Math.round(r.height),
            tagName: 'LI',
            text: text.slice(0, 160),
            debugAnchors,
            hostsCount: hosts.length,
          }
        }
      }
    }
    return { found: false, hostsCount: hosts.length, debugAnchors }
  }, { accountDigits }).catch((err) => ({ found: false, error: String(err?.message || err).slice(0, 200) }))

  if (directAnchor?.found) {
    appendJobLog(job, 'hubxp_lookup', 'Encontrou resultado direto no Shadow DOM (search-customers-results)', {
      account: accountDigits,
      strategy: directAnchor.strategy,
      cx: directAnchor.cx,
      cy: directAnchor.cy,
      tagName: directAnchor.tagName,
      text: directAnchor.text,
      title: directAnchor.title || '',
      width: directAnchor.width,
      height: directAnchor.height,
    })
    try {
      await page.mouse.click(directAnchor.cx, directAnchor.cy)
      await delay(500)
      const urlAfter = await page.evaluate(() => window.location?.href || '').catch(() => '')
      const navigated = /posicao-consolidada|visao-atual-cliente|oda|perfil|cliente/i.test(urlAfter)
      if (!navigated) {
        appendJobLog(job, 'hubxp_lookup', 'Click direto nao navegou, tentando click duplo e offsets', {
          account: accountDigits,
          urlAfter,
        })
        // Tentar clicar um pouco mais acima (no nome do cliente)
        await page.mouse.click(directAnchor.cx, directAnchor.cy - Math.round(directAnchor.height / 4))
        await delay(400)
        const urlAfter2 = await page.evaluate(() => window.location?.href || '').catch(() => '')
        if (!/posicao-consolidada|visao-atual-cliente|oda|perfil|cliente/i.test(urlAfter2)) {
          // Ultimo recurso: navegar diretamente via href do <a>
          const href = await page.evaluate((payload) => {
            const digits = String(payload?.accountDigits || '').replace(/\D/g, '')
            const findHosts = (root) => {
              const out = []
              try { for (const el of root.querySelectorAll('search-customers-results')) out.push(el) } catch {}
              for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                  try { for (const el2 of el.shadowRoot.querySelectorAll('search-customers-results')) out.push(el2) } catch {}
                  out.push(...findHosts(el.shadowRoot))
                }
              }
              return out
            }
            for (const host of findHosts(document)) {
              if (!host.shadowRoot) continue
              for (const a of host.shadowRoot.querySelectorAll('a')) {
                const t = String(a.innerText || a.textContent || '' + a.getAttribute('title') || '').replace(/\D/g, '')
                if (t.includes(digits)) {
                  // Tentar disparar click nativo
                  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
                  return a.href || a.getAttribute('href') || ''
                }
              }
            }
            return ''
          }, { accountDigits }).catch(() => '')
          if (href && href.startsWith('http')) {
            appendJobLog(job, 'hubxp_lookup', 'Navegando diretamente pelo href do <a>', { account: accountDigits, href })
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null)
          }
          await delay(400)
        }
      }
      appendJobLog(job, 'hubxp_lookup', 'Resultado da conta clicado (direct shadow anchor)', {
        account: accountDigits,
        strategy: directAnchor.strategy,
        text: directAnchor.text,
        cx: directAnchor.cx,
        cy: directAnchor.cy,
        urlFinal: await page.evaluate(() => window.location?.href || '').catch(() => ''),
      })
      return true
    } catch (clickErr) {
      appendJobLog(job, 'hubxp_lookup', 'Erro ao clicar direct shadow anchor', {
        account: accountDigits,
        error: String(clickErr?.message || clickErr).slice(0, 200),
      })
    }
  } else {
    appendJobLog(job, 'hubxp_lookup', 'Direct shadow anchor nao encontrado, tentando scan generico', {
      account: accountDigits,
      hostsCount: directAnchor?.hostsCount || 0,
      debugAnchors: directAnchor?.debugAnchors || [],
      error: directAnchor?.error || null,
    })
  }

  // Fase 2: Scan generico — buscar resultados em componentes de resultado (fallback)
  const clickInfo = await page.evaluate((payload) => {
    const digits = String(payload?.accountDigits || '').replace(/\D/g, '')
    if (!digits) return { found: false, reason: 'NO_DIGITS' }

    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()

    const resultComponents = [
      'search-customers-results',
      'search-customers',
      'soma-search-results',
      'search-results',
      'customer-results',
      'hub-search-results',
    ]
    const candidates = []
    const debugInfo = { hostsFound: [], totalNodes: 0, candidateTexts: [], skippedDivs: 0 }

    for (const tag of resultComponents) {
      const hosts = deepFind(document, tag)
      if (hosts.length) debugInfo.hostsFound.push(`${tag}(${hosts.length})`)
      for (const host of hosts) {
        const roots = [host]
        if (host.shadowRoot) roots.unshift(host.shadowRoot)
        for (const root of roots) {
          // Priorizar a, li, h3 — evitar DIV (wrappers grandes)
          const nodes = []
          try { nodes.push(...root.querySelectorAll('a, li, [role="option"], [role="listitem"], button, h3, p, span')) } catch {}
          debugInfo.totalNodes += nodes.length
          for (const node of nodes) {
            const text = normalize(node?.innerText || node?.textContent || '')
            if (!text) continue
            // Pular textos que contenham "resultados encontrados" — wrapper header
            if (/resultados?\s+encontrad/i.test(text) && node.tagName !== 'A') continue

            const isAnchor = node.tagName === 'A'
            const r = node.getBoundingClientRect()
            if (r.width < 3 || r.height < 3) continue

            const textDigits = text.replace(/\D/g, '')
            const hasDigits = textDigits.includes(digits)
            if (!hasDigits) continue

            const hasContaLabel = /conta xp|conta|cliente|codigo|c[oó]digo/.test(text)
            let priority = 50
            if (isAnchor && hasDigits && hasContaLabel) priority = 0
            else if (isAnchor && hasDigits) priority = 2
            else if (hasDigits && hasContaLabel && node.tagName === 'LI') priority = 3
            else if (hasDigits && hasContaLabel) priority = 5
            else if (hasDigits) priority = 10

            candidates.push({
              text: text.slice(0, 160),
              top: r.top,
              left: r.left,
              cx: Math.round(r.left + r.width / 2),
              cy: Math.round(r.top + r.height / 2),
              width: Math.round(r.width),
              height: Math.round(r.height),
              tagName: node.tagName,
              isAnchor,
              priority,
            })

            if (debugInfo.candidateTexts.length < 10) {
              debugInfo.candidateTexts.push(`${node.tagName}[p=${priority}]:${text.slice(0, 80)}`)
            }
          }
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      if (a.top !== b.top) return a.top - b.top
      return a.left - b.left
    })
    const chosen = candidates[0] || null

    if (!chosen) return { found: false, reason: 'NO_MATCH', debug: debugInfo }

    return {
      found: true,
      mode: 'generic_scan',
      text: chosen.text,
      cx: chosen.cx,
      cy: chosen.cy,
      top: Math.round(chosen.top),
      left: Math.round(chosen.left),
      width: chosen.width,
      height: chosen.height,
      tagName: chosen.tagName,
      priority: chosen.priority,
      candidatesCount: candidates.length,
      debug: debugInfo,
    }
  }, { accountDigits }).catch((err) => ({ found: false, reason: 'EVAL_ERROR', errorMsg: String(err?.message || err).slice(0, 200) }))

  if (!clickInfo?.found) {
    appendJobLog(job, 'hubxp_lookup', 'clickFirstAccountResultStrict scan generico nao encontrou resultado', {
      account: accountDigits,
      reason: clickInfo?.reason || 'unknown',
      debug: clickInfo?.debug || null,
    })
    return false
  }

  // Fase 3: Clicar com Playwright mouse.click nas coordenadas reais
  try {
    const cx = clickInfo.cx
    const cy = clickInfo.cy
    appendJobLog(job, 'hubxp_lookup', 'Clicando no resultado via mouse.click nativo (scan generico)', {
      account: accountDigits,
      cx, cy,
      tagName: clickInfo.tagName,
      text: clickInfo.text,
      mode: clickInfo.mode,
      priority: clickInfo.priority,
      debug: clickInfo.debug,
    })
    await page.mouse.click(cx, cy)
    await delay(500)

    const urlAfterClick = await page.evaluate(() => window.location?.href || '').catch(() => '')
    const navigated = /posicao-consolidada|visao-atual-cliente|oda|perfil|cliente/i.test(urlAfterClick)
    if (!navigated) {
      appendJobLog(job, 'hubxp_lookup', 'Click generico nao navegou, tentando novamente...', {
        account: accountDigits,
        urlAfterClick,
      })
      await page.mouse.click(cx + 2, cy + 2)
      await delay(400)
    }
  } catch (clickErr) {
    appendJobLog(job, 'hubxp_lookup', 'Erro ao clicar via mouse.click (scan generico)', {
      account: accountDigits,
      error: String(clickErr?.message || clickErr).slice(0, 200),
    })
  }

  appendJobLog(job, 'hubxp_lookup', 'Resultado da conta clicado (strict shadow scan generico)', {
    account: accountDigits,
    text: clickInfo.text || '',
    tagName: clickInfo.tagName || '',
    cx: clickInfo.cx,
    cy: clickInfo.cy,
  })
  return true
}

const clickFirstAccountResultByLocator = async (job, page, accountDigits) => {
  const digits = String(accountDigits || '').replace(/\D/g, '')
  const selectors = [
    'search-customers-results [role="option"]',
    'search-customers-results [role="listitem"]',
    'search-customers-results li',
    'search-customers-results a',
    'search-customers-results div',
    'search-customers [role="option"]',
    'search-customers [role="listitem"]',
    'search-customers li',
    'search-customers a',
    '[role="listbox"] [role="option"]',
    '[role="listbox"] li',
    '[class*="dropdown" i] li',
    '[class*="dropdown" i] a',
    '[class*="result" i] li',
    '[class*="result" i] a',
    '[class*="suggestion" i] li',
    '[class*="autocomplete" i] li',
  ]
  const modes = [
    { name: 'digits', useDigits: true },
    { name: 'first_visible', useDigits: false },
  ]

  for (const mode of modes) {
    for (const selector of selectors) {
      try {
        const count = await page.locator(selector).count()
        if (!count) continue
        for (let index = 0; index < Math.min(count, 8); index += 1) {
          const row = page.locator(selector).nth(index)
          const visible = await row.isVisible({ timeout: 120 }).catch(() => false)
          if (!visible) continue
          const text = scrubText(await row.textContent().catch(() => ''))
          if (mode.useDigits && digits) {
            const textDigits = text.replace(/\D/g, '')
            if (!textDigits.includes(digits)) continue
          }
          await row.scrollIntoViewIfNeeded().catch(() => null)
          await row.click({ timeout: 1200, force: true }).catch(() => null)
          appendJobLog(job, 'hubxp_lookup', 'Primeiro resultado da conta aberto (locator)', {
            account: accountDigits,
            selector,
            mode: mode.name,
            text: text.slice(0, 160),
          })
          return true
        }
      } catch {
        // tentar proximo selector
      }
    }
  }
  return false
}

const clickFirstAccountResult = async (job, page, accountDigits) => {
  const alreadyOpened = await page.evaluate(() => (
    /posicao-consolidada|visao-atual-cliente|oda/i.test(String(window.location?.href || ''))
  )).catch(() => false)
  if (alreadyOpened) {
    appendJobLog(job, 'hubxp_lookup', 'Pagina do cliente ja aberta apos busca', { account: accountDigits })
    return true
  }

  // Usar page.mouse.click com coordenadas (mais confiavel em Shadow DOM que JS .click())
  const quickCoords = await page.evaluate((payload) => {
    const digits = String(payload?.accountDigits || '').replace(/\D/g, '')
    if (!digits) return null

    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }

    const isVisible = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    // Priorizar <a> com title (estrutura confirmada do HubXP)
    const anchors = deepFind(document, 'search-customers-results a, search-customers a')
    for (const a of anchors) {
      if (!isVisible(a)) continue
      const text = String(a?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
      if (!text || !text.replace(/\D/g, '').includes(digits)) continue
      a.scrollIntoView({ behavior: 'instant', block: 'center' })
      const r = a.getBoundingClientRect()
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), text: text.slice(0, 120), tag: 'A' }
    }

    const rows = deepFind(document, 'search-customers-results li, search-customers-results div')
    for (const row of rows) {
      if (!isVisible(row)) continue
      const text = String(row?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
      if (!text || !text.replace(/\D/g, '').includes(digits)) continue
      row.scrollIntoView({ behavior: 'instant', block: 'center' })
      const r = row.getBoundingClientRect()
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), text: text.slice(0, 120), tag: row.tagName }
    }
    return null
  }, { accountDigits }).catch(() => null)

  if (quickCoords) {
    await page.mouse.click(quickCoords.cx, quickCoords.cy)
    await delay(300)
    appendJobLog(job, 'hubxp_lookup', 'Primeiro resultado da conta aberto (fast-path mouse.click)', {
      account: accountDigits,
      cx: quickCoords.cx,
      cy: quickCoords.cy,
      tag: quickCoords.tag,
      text: quickCoords.text,
    })
    return true
  }

  const scoredCoords = await page.evaluate((payload) => {
    const digits = String(payload?.accountDigits || '').replace(/\D/g, '')
    if (!digits) return null

    const deepAll = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepAll(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }

    const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const isVisible = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    const candidates = deepAll(document, 'a, button, [role="link"], [role="button"], [role="row"], tr, li, [role="option"], [class*="result" i]')
    let best = null
    let bestScore = -1

    for (const el of candidates) {
      if (!isVisible(el)) continue
      const text = normalize(el.innerText || el.textContent || '')
      if (!text) continue
      const numbers = text.replace(/\D/g, '')
      if (!numbers.includes(digits)) continue

      let score = 1
      const rootHostTag = String(el?.getRootNode?.()?.host?.tagName || '').toLowerCase()
      if (rootHostTag.includes('search-customers-results')) score += 120
      if (rootHostTag.includes('search-customers')) score += 40
      if (/cliente|conta|codigo|c[oó]digo/.test(text)) score += 8
      if (/conta xp/.test(text)) score += 55
      if (el.tagName === 'A') score += 30
      if (el.matches?.('a, button, [role="link"], [role="button"]')) score += 10
      if (el.tagName === 'H3') score += 26
      try { if (el.closest('search-customers-results')) score += 90 } catch {}
      if (el.matches?.('tr, [role="row"], li')) score += 6
      if (text.length < 220) score += 2

      if (score > bestScore) {
        best = el
        bestScore = score
      }
    }

    if (!best) return null
    best.scrollIntoView({ behavior: 'instant', block: 'center' })
    const r = best.getBoundingClientRect()
    return {
      cx: Math.round(r.left + r.width / 2),
      cy: Math.round(r.top + r.height / 2),
      text: normalize(best.textContent || '').slice(0, 120),
      tag: best.tagName,
      score: bestScore,
    }
  }, { accountDigits }).catch(() => null)

  if (scoredCoords) {
    await page.mouse.click(scoredCoords.cx, scoredCoords.cy)
    await delay(300)
    appendJobLog(job, 'hubxp_lookup', 'Primeiro resultado da conta aberto (scored mouse.click)', {
      account: accountDigits,
      cx: scoredCoords.cx,
      cy: scoredCoords.cy,
      tag: scoredCoords.tag,
      score: scoredCoords.score,
      text: scoredCoords.text,
    })
    return true
  }
  return false
}

const clickFirstAccountResultByKeyboard = async (job, fieldLocator, accountDigits) => {
  if (!fieldLocator) return false
  try {
    await fieldLocator.click({ timeout: 900 }).catch(() => null)
    await delay(200)
    await fieldLocator.press('ArrowDown').catch(() => null)
    await delay(200)
    await fieldLocator.press('Enter').catch(() => null)
    await delay(500)
    appendJobLog(job, 'hubxp_lookup', 'Primeiro resultado da conta aberto (fallback teclado)', { account: accountDigits })
    return true
  } catch {
    return false
  }
}

const clickFirstAccountResultByPageKeyboard = async (job, page, accountDigits) => {
  try {
    await page.keyboard.press('ArrowDown').catch(() => null)
    await delay(200)
    await page.keyboard.press('Enter').catch(() => null)
    await delay(500)
    appendJobLog(job, 'hubxp_lookup', 'Primeiro resultado da conta aberto (fallback teclado global)', { account: accountDigits })
    return true
  } catch {
    return false
  }
}

const ensurePosicaoConsolidadaForLookup = async (job, page, timeoutMs = 9000) => {
  const hasPosicaoUrl = () => /posicao-consolidada|visao-atual-cliente|oda/i.test(getPageUrl(page))
  if (hasPosicaoUrl()) return true

  const startedAt = now()
  while (now() - startedAt <= timeoutMs) {
    if (hasPosicaoUrl()) return true
    const clicked = await clickTab(page, ['POSIÇÃO CONSOLIDADA', 'Posição Consolidada', 'Visão Atual do Cliente'], {
      timeout: 900,
    }).catch(() => false)
    if (clicked) {
      await Promise.race([
        page.waitForURL(/posicao-consolidada|visao-atual-cliente|oda/i, { timeout: 2200 }).catch(() => null),
        page.waitForLoadState('domcontentloaded', { timeout: 1600 }).catch(() => null),
        delay(180),
      ])
      if (hasPosicaoUrl()) return true
    }
    await delay(140)
  }
  return hasPosicaoUrl()
}

const extractClientInfoFromPage = async (page) => {
  return page.evaluate(() => {
    const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim()
    const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i
    const deepFind = (root, selector) => {
      const out = []
      try { out.push(...root.querySelectorAll(selector)) } catch {}
      const all = root.querySelectorAll('*')
      for (const el of all) {
        if (el.shadowRoot) {
          try { out.push(...deepFind(el.shadowRoot, selector)) } catch {}
        }
      }
      return out
    }
    const isVisible = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const pushEmail = (bucket, value, score = 1) => {
      const cleaned = normalize(value).toLowerCase().replace(/^mailto:/, '')
      if (!cleaned || !emailRegex.test(cleaned)) return
      const prev = bucket.get(cleaned) || 0
      bucket.set(cleaned, Math.max(prev, score))
    }

    const emailsMap = new Map()

    // Caminho principal observado no HubXP: data-testid="description" com title contendo e-mail.
    const descriptionNodes = deepFind(document, '[data-testid="description"], [title*="@"]')
    for (const node of descriptionNodes) {
      if (!isVisible(node)) continue
      const title = normalize(node.getAttribute?.('title') || '')
      const text = normalize(node.textContent || '')
      const parentText = normalize(node.parentElement?.innerText || '').toLowerCase()
      const hasEmailLabel = /e-?mail/.test(parentText)
      if (title && title.includes('@')) pushEmail(emailsMap, title, hasEmailLabel ? 120 : 95)
      if (text && text.includes('@')) pushEmail(emailsMap, text, hasEmailLabel ? 105 : 80)
    }

    const mailtos = deepFind(document, 'a[href^="mailto:"]')
    for (const link of mailtos) {
      pushEmail(emailsMap, link.getAttribute('href') || '', 90)
      pushEmail(emailsMap, link.textContent || '', 85)
    }

    const bodyText = normalize(document?.body?.innerText || '')
    const emailMatches = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []
    for (const match of emailMatches) {
      pushEmail(emailsMap, match, 40)
    }

    // Fallback orientado por linhas (mais leve que varrer todos os elementos label/span/div).
    const lines = bodyText
      .split('\n')
      .map((line) => normalize(line))
      .filter(Boolean)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].toLowerCase()
      if (!/e-?mail/.test(line)) continue
      const sameLineMatches = lines[i].match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []
      for (const match of sameLineMatches) pushEmail(emailsMap, match, 112)
      const nextLine = lines[i + 1] || ''
      const nextMatches = nextLine.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []
      for (const match of nextMatches) pushEmail(emailsMap, match, 108)
    }

    const emails = Array.from(emailsMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([email]) => email)

    let clientName = ''
    const headings = deepFind(document, 'h1, h2, h3, [role="heading"], [class*="title" i], [class*="nome" i]')
    for (const el of headings) {
      if (!isVisible(el)) continue
      const text = normalize(el.textContent || '')
      if (!text) continue
      if (/@/.test(text)) continue
      if (text.length < 3 || text.length > 120) continue
      if (/hub xp|xpi|home|dashboard/i.test(text)) continue
      clientName = text
      break
    }

    if (!clientName) {
      for (const line of lines) {
        const lower = line.toLowerCase()
        if (!/cliente|nome/.test(lower)) continue
        if (/@/.test(line)) continue
        if (line.length < 3 || line.length > 120) continue
        clientName = line
        break
      }
    }

    return {
      clientName: clientName || '',
      clientEmail: emails[0] || '',
      emails,
    }
  }).catch(() => ({ clientName: '', clientEmail: '', emails: [] }))
}

const resolveSingleClientOnHubxp = async (job, page, accountDigits, options = {}) => {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(4000, Math.min(60000, Number(options.timeoutMs)))
    : 10000
  const minWaitMs = Number.isFinite(Number(options.minWaitMs))
    ? Math.max(2000, Math.min(10000, Number(options.minWaitMs)))
    : 2000
  const resultWaitMs = Math.max(2200, Math.min(9000, timeoutMs))
  const strictResultWaitMs = Math.max(1800, Math.min(5000, resultWaitMs))
  const extraPostSearchWaitMs = Math.max(0, minWaitMs - HUBXP_LOOKUP_MIN_POST_SEARCH_WAIT_MS)
  const lookupStartedAt = now()
  let clickedResult = false
  let lastSearch = null

  // Verificar se a pagina esta autenticada antes de iniciar a busca
  const pageAuthenticated = await isAuthenticated(page).catch(() => false)
  if (!pageAuthenticated) {
    appendJobLog(job, 'hubxp_lookup', 'Pagina de lookup nao autenticada. Tentando navegar para Home...', {
      account: accountDigits,
      url: getPageUrl(page),
    })
    await gotoHubxpHomeForLookup(job, page)
    const retryAuth = await isAuthenticated(page).catch(() => false)
    if (!retryAuth) {
      throw createHttpError(
        409,
        'JOB_NOT_AUTHENTICATED',
        'Sessao HubXP expirou durante o lookup. Faca login novamente.',
        { account: accountDigits, url: getPageUrl(page) },
        'hubxp_lookup',
      )
    }
  }

  const lookupAttempts = [
    {
      name: 'reuso_tela_atual_strict',
      strictOnly: true,
      navigateHome: false,
      fieldWaitMs: 2600,
    },
    {
      name: 'home_strict',
      strictOnly: true,
      navigateHome: true,
      fieldWaitMs: 5200,
    },
    {
      name: 'home_fallback',
      strictOnly: false,
      navigateHome: true,
      fieldWaitMs: 7200,
    },
    {
      name: 'home_fallback_retry',
      strictOnly: false,
      navigateHome: true,
      fieldWaitMs: 9000,
    },
  ]

  for (let cycle = 0; cycle < lookupAttempts.length && !clickedResult; cycle += 1) {
    const attempt = lookupAttempts[cycle]
    if (attempt.navigateHome) {
      await gotoHubxpHomeForLookup(job, page)
    }

    appendJobLog(job, 'hubxp_lookup', `Tentativa ${cycle + 1}: pesquisando conta na Home`, {
      account: accountDigits,
      attempt: attempt.name,
      strictOnly: attempt.strictOnly,
      elapsedMs: now() - lookupStartedAt,
      url: getPageUrl(page),
    })
    const searched = await searchAccountFromHome(job, page, accountDigits, {
      fieldWaitMs: attempt.fieldWaitMs,
      strictOnly: attempt.strictOnly,
    })
    lastSearch = searched
    if (!searched?.ok) continue

    if (extraPostSearchWaitMs > 0) {
      await delay(extraPostSearchWaitMs)
    }

    // Esperar mais tempo para resultados renderizarem no Shadow DOM
    await delay(800)
    const strictResultVisible = await waitForStrictAccountResultFromHome(
      page,
      accountDigits,
      strictResultWaitMs,
    ).catch(() => false)
    const hasResult = strictResultVisible || await waitForAccountResultFromHome(
      page,
      accountDigits,
      resultWaitMs,
    ).catch(() => false)
    if (!hasResult) {
      // Esperar um pouco mais — resultados em Shadow DOM podem demorar
      await delay(1200)
      appendJobLog(job, 'hubxp_lookup', 'Resultado da conta ainda nao visivel; capturando DOM debug e tentando abrir.', {
        account: accountDigits,
        cycle: cycle + 1,
        attempt: attempt.name,
        strictOnly: attempt.strictOnly,
        elapsedMs: now() - lookupStartedAt,
      })
      // Capturar debug do DOM para entender estrutura
      const domDebug = await page.evaluate(() => {
        const deepTags = (root, depth = 0) => {
          if (depth > 4) return []
          const tags = []
          const all = root.querySelectorAll('*')
          for (const el of all) {
            if (el.shadowRoot) {
              const tag = el.tagName.toLowerCase()
              const childCount = el.shadowRoot.querySelectorAll('*').length
              tags.push({ tag, shadow: true, childCount, depth })
              tags.push(...deepTags(el.shadowRoot, depth + 1))
            }
          }
          return tags
        }
        return {
          url: window.location?.href || '',
          shadowComponents: deepTags(document).slice(0, 30),
          bodyText: (document.body?.innerText || '').slice(0, 500),
        }
      }).catch(() => null)
      if (domDebug) {
        appendJobLog(job, 'hubxp_lookup', 'DOM debug apos busca', {
          account: accountDigits,
          url: domDebug.url,
          shadowComponents: domDebug.shadowComponents,
          bodyText: domDebug.bodyText?.slice(0, 200),
        })
      }
    }

    clickedResult = await clickFirstAccountResultStrict(job, page, accountDigits).catch(() => false)
    if (!clickedResult) {
      clickedResult = await clickFirstAccountResultByLocator(job, page, accountDigits).catch(() => false)
    }
    if (!clickedResult) {
      clickedResult = await clickFirstAccountResult(job, page, accountDigits).catch(() => false)
    }
    if (!clickedResult) {
      clickedResult = await clickFirstAccountResultByKeyboard(job, searched.fieldLocator, accountDigits).catch(() => false)
    }
    if (!clickedResult) {
      clickedResult = await clickFirstAccountResultByPageKeyboard(job, page, accountDigits).catch(() => false)
    }
  }

  if (!clickedResult) {
    throw createHttpError(
      404,
      'CLIENT_RESULT_NOT_FOUND',
      'Nao foi possivel localizar resultado da conta na busca da Home.',
      {
        account: accountDigits,
        elapsedMs: now() - lookupStartedAt,
        lastFieldSelector: lastSearch?.fieldSelector || null,
        lastFieldStrategy: lastSearch?.fieldStrategy || null,
      },
      'hubxp_lookup',
    )
  }

  appendJobLog(job, 'hubxp_lookup', 'Conta aberta para extracao de e-mail.', {
    account: accountDigits,
    elapsedMs: now() - lookupStartedAt,
    url: getPageUrl(page),
  })

  await Promise.race([
    page.waitForURL(/posicao-consolidada|visao-atual-cliente|oda/i, { timeout: 4500 }).catch(() => null),
    page.waitForLoadState('domcontentloaded', { timeout: 2800 }).catch(() => null),
    delay(260),
  ])
  await ensurePosicaoConsolidadaForLookup(job, page, Math.max(2000, Math.min(7000, timeoutMs))).catch(() => false)

  const startedAt = now()
  while (now() - startedAt <= timeoutMs) {
    const info = await extractClientInfoFromPage(page)
    if (info?.clientEmail) {
      return {
        account: accountDigits,
        clientName: scrubText(info.clientName || ''),
        clientEmail: scrubText(info.clientEmail || '').toLowerCase(),
      }
    }
    await delay(180)
  }

  throw createHttpError(
    404,
    'CLIENT_EMAIL_NOT_FOUND',
    'Nao foi possivel localizar e-mail do cliente.',
    { account: accountDigits, timeoutMs },
    'hubxp_lookup',
  )
}

const registerHubxpOrdersRoutes = (app) => {
  ensureSweep()

  app.post('/api/hubxp/orders/start', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      const requestedJobId = String(body.jobId || '').trim()
      if (requestedJobId) {
        try {
          job = resolveJob(requestedJobId, userKey)
        } catch (resolveError) {
          if (resolveError?.status === 404 || resolveError?.code === 'JOB_NOT_FOUND') {
            job = createJob(userKey)
          } else {
            throw resolveError
          }
        }
      } else {
        job = createJob(userKey)
      }
      const result = await performLogin(job, body)
      res.json({
        ok: true,
        status: result.status,
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/orders/otp', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      const result = await submitOtp(job, body.otp)
      res.json({
        ok: true,
        status: result.status,
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/orders/fetch', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)

      // Se async=true, dispara coleta em background e retorna imediato
      const asyncMode = body.async !== false
      if (asyncMode) {
        // Validar antes de disparar
        if (!job.page) throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para coleta.', null, 'navigate_orders')
        if (job.running) throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, 'collecting')
        // Permitir re-coleta apos FAILED (browser ainda vivo, apenas coleta falhou)
        const fetchAllowed = new Set([STATUS.AUTHENTICATED, STATUS.SUCCESS, STATUS.FAILED])
        if (!fetchAllowed.has(job.status)) {
          throw createHttpError(409, 'JOB_NOT_AUTHENTICATED', 'Sessao nao autenticada.', null, 'post_login')
        }

        // Dispara em background
        fetchOrders(job, body).catch(() => null)
        return res.json({
          ok: true,
          status: STATUS.COLLECTING,
          job: buildJobSnapshot(job),
        })
      }

      // Modo sincrono (legacy)
      const result = await fetchOrders(job, body)
      res.json({
        ok: true,
        ...result,
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  // Endpoint para buscar resultados da coleta
  app.get('/api/hubxp/orders/results/:jobId', async (req, res) => {
    let job = null
    try {
      const userKey = resolveRequestUserKey(req)
      job = resolveJob(req.params.jobId, userKey)
      if (!job._collectedData) {
        return res.json({
          ok: true,
          status: job.status,
          job: buildJobSnapshot(job),
          rows: [],
          columns: [],
          totalRows: 0,
        })
      }
      const data = job._collectedData
      res.json({
        ok: true,
        status: STATUS.SUCCESS,
        columns: data.columns,
        rows: data.rows,
        totalRows: data.totalRows,
        pagesScanned: data.pagesScanned,
        collectedAt: data.collectedAt,
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.get('/api/hubxp/orders/status/:jobId', async (req, res) => {
    let job = null
    try {
      const userKey = resolveRequestUserKey(req)
      job = resolveJob(req.params.jobId, userKey)
      touchJob(job)
      res.json({ ok: true, job: buildJobSnapshot(job) })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  // ===== Fluxo manual (DEV): gravar passos e reutilizar no modo automatico =====
  app.post('/api/hubxp/flow/record/start', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      if (!job.page) throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para gravacao.', null, 'flow_record_start')
      if (job.running) throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, 'flow_record_start')
      const flow = await startManualFlowRecording(job)
      res.json({
        ok: true,
        status: 'RECORDING',
        flow,
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/flow/record/stop', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      const flow = await stopManualFlowRecording(job)
      res.json({
        ok: true,
        status: 'RECORDED',
        flow,
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.get('/api/hubxp/flow/:jobId', async (req, res) => {
    let job = null
    try {
      const userKey = resolveRequestUserKey(req)
      job = resolveJob(req.params.jobId, userKey)
      touchJob(job)
      const summary = getManualFlowSummary(job)
      const events = Array.isArray(job?._manualFlow?.events) ? job._manualFlow.events : []
      res.json({
        ok: true,
        flow: {
          ...summary,
          events,
        },
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/flow/clear', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      if (job?._manualFlowRecording?.active) {
        job._manualFlowRecording = { active: false, startedAt: null }
      }
      job._manualFlow = null
      appendJobLog(job, 'flow_record', 'Fluxo manual removido.')
      touchJob(job)
      res.json({
        ok: true,
        status: 'CLEARED',
        flow: getManualFlowSummary(job),
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/flow/import', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      if (job.running) throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, 'flow_import')

      const incomingEvents = Array.isArray(body.events) ? body.events : []
      const rawEvents = incomingEvents.length ? incomingEvents : (toBoolean(body.defaultFlow, true) ? buildDefaultManualFlowEvents() : [])
      const events = compressManualFlowEvents(rawEvents)
      if (!events.length) {
        throw createHttpError(400, 'FLOW_EVENTS_REQUIRED', 'Nenhum evento valido para importar.', null, 'flow_import')
      }

      const updatedAt = now()
      job._manualFlow = {
        version: 1,
        startedAt: null,
        updatedAt,
        events,
      }
      job._manualFlowRecording = { active: false, startedAt: null }
      appendJobLog(job, 'flow_record', `Fluxo manual importado com ${events.length} passos.`)
      touchJob(job)

      res.json({
        ok: true,
        status: 'IMPORTED',
        flow: {
          ...getManualFlowSummary(job),
          events,
        },
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/flow/replay', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      const replayMode = scrubText(body.mode || 'prepare_filters') || 'prepare_filters'
      job = resolveJob(body.jobId, userKey)
      if (!job.page) throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para replay.', null, 'flow_replay')
      if (job.running) throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, 'flow_replay')
      const replay = await replayManualFlow(
        job,
        job.page,
        body.variables && typeof body.variables === 'object' ? body.variables : {},
        {
          mode: replayMode,
          maxEvents: body.maxEvents,
        },
      )
      if (replayMode === 'prepare_filters' && replay.stoppedAt !== 'filter_action') {
        throw createHttpError(
          400,
          'FLOW_REPLAY_INCOMPLETE',
          'Replay nao chegou ate o clique de Filtrar.',
          replay,
          'flow_replay',
        )
      }
      if (!replay.ok) {
        throw createHttpError(400, 'FLOW_REPLAY_FAILED', 'Fluxo manual nao executado.', replay, 'flow_replay')
      }
      appendJobLog(job, 'flow_replay', 'Replay manual executado.', {
        executed: replay.executed,
        mode: replayMode,
      })
      touchJob(job)
      res.json({
        ok: true,
        status: 'REPLAYED',
        replay,
        flow: getManualFlowSummary(job),
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/apuracao/bovespa/fetch', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)

      const asyncMode = body.async !== false
      if (asyncMode) {
        if (!job.page) throw createHttpError(409, 'JOB_NOT_READY', 'Sessao nao iniciada para coleta.', null, 'apuracao_bovespa')
        if (job.running) throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, 'apuracao_bovespa')
        // Permitir re-coleta apos FAILED (browser ainda vivo, apenas coleta falhou)
        const fetchAllowed = new Set([STATUS.AUTHENTICATED, STATUS.SUCCESS, STATUS.FAILED])
        if (!fetchAllowed.has(job.status)) {
          throw createHttpError(409, 'JOB_NOT_AUTHENTICATED', 'Sessao nao autenticada.', null, 'apuracao_bovespa')
        }

        fetchApuracaoBovespa(job, body).catch(() => null)
        return res.json({
          ok: true,
          status: STATUS.COLLECTING,
          job: buildJobSnapshot(job),
        })
      }

      const result = await fetchApuracaoBovespa(job, body)
      res.json({
        ok: true,
        ...result,
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/apuracao/bovespa/abort', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      if (!job.running) {
        job._abortApuracao = false
        if (job.status === STATUS.COLLECTING) {
          setJobStatus(job, STATUS.FAILED, 'apuracao_bovespa', 'Processo interrompido pelo usuario.')
        }
        touchJob(job)
        return res.json({ ok: true, status: 'IDLE', job: buildJobSnapshot(job) })
      }
      job._abortApuracao = true
      appendJobLog(job, 'apuracao_bovespa', 'Processo de apuracao interrompido pelo usuario')
      setJobStatus(job, STATUS.COLLECTING, 'apuracao_bovespa_abort', 'Interrompendo processo e fechando browsers...')
      touchJob(job)
      res.json({ ok: true, status: 'ABORT_REQUESTED', job: buildJobSnapshot(job) })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.get('/api/hubxp/apuracao/bovespa/results/:jobId', async (req, res) => {
    let job = null
    try {
      const userKey = resolveRequestUserKey(req)
      job = resolveJob(req.params.jobId, userKey)
      touchJob(job)
      const data = job._apuracaoBovespaData
      if (!data) {
        return res.json({
          ok: true,
          status: job.status,
          job: buildJobSnapshot(job),
          rows: [],
          columns: [],
          totalRows: 0,
          accountRuns: [],
          failedAccounts: [],
          summary: {
            success: 0,
            no_notes: 0,
            failed: 0,
            accountsProcessed: 0,
            accountsTotal: Number(job.progress?.accountsTotal || 0),
            notesListed: 0,
            notesProcessed: 0,
            pagesScanned: 0,
          },
        })
      }
      res.json({
        ok: true,
        status: job.status,
        columns: data.columns,
        rows: data.rows,
        totalRows: data.totalRows,
        collectedAt: data.collectedAt,
        accountRuns: Array.isArray(data.accountRuns) ? data.accountRuns : [],
        failedAccounts: Array.isArray(data.failedAccounts) ? data.failedAccounts : [],
        summary: data.summary || null,
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/hubxp/clients/resolve', async (req, res) => {
    let job = null
    let shouldDestroyDedicatedJob = false
    let sharedLookupLocked = false
    let lookupPage = null
    let ownsLookupPage = false
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      const mode = scrubText(body.mode || 'shared').toLowerCase() || 'shared'
      if (!['shared', 'dedicated'].includes(mode)) {
        throw createHttpError(400, 'INVALID_MODE', 'Modo de resolucao invalido. Use mode=\"shared\" ou mode=\"dedicated\".')
      }

      const credentials = body.credentials && typeof body.credentials === 'object' ? body.credentials : {}
      const username = scrubText(credentials.username || body.username || '')
      const password = credentials.password == null ? body.password : credentials.password
      const accounts = sanitizeAccountInputRows(body.accounts)
      if (!accounts.length) {
        throw createHttpError(400, 'ACCOUNTS_REQUIRED', 'Informe ao menos uma conta valida para consulta.')
      }
      if (accounts.length > 50) {
        throw createHttpError(400, 'ACCOUNTS_LIMIT_EXCEEDED', 'Maximo de 50 contas por execucao.')
      }

      const { minWaitMs, timeoutMs, retryPerAccount } = parseHubxpLookupConfig(body)

      if (mode === 'shared') {
        const sharedJobId = scrubText(body.jobId || '')
        if (!sharedJobId) {
          throw createHttpError(400, 'JOB_ID_REQUIRED', 'jobId da sessao HubXP e obrigatorio para mode=\"shared\".')
        }
        job = resolveJob(sharedJobId, userKey)
        if (job.running) {
          throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao HubXP.')
        }
        if (job.status !== STATUS.AUTHENTICATED && job.status !== STATUS.SUCCESS) {
          throw createHttpError(409, 'JOB_NOT_AUTHENTICATED', 'Sessao HubXP nao autenticada para lookup compartilhado.')
        }
        if (!job.page) {
          throw createHttpError(409, 'JOB_NOT_READY', 'Pagina HubXP indisponivel para lookup compartilhado.')
        }
        job.running = true
        sharedLookupLocked = true
        touchJob(job)
        appendJobLog(job, 'hubxp_lookup', 'Iniciando lookup compartilhado de clientes.', {
          accounts: accounts.length,
          minWaitMs,
          timeoutMs,
          retryPerAccount,
        })
        const sharedLookup = await createSharedLookupPage(job)
        lookupPage = sharedLookup?.page || job.page
        ownsLookupPage = Boolean(sharedLookup?.isolated && lookupPage && lookupPage !== job.page)
      } else {
        job = createJob(userKey)
        shouldDestroyDedicatedJob = true
        appendJobLog(job, 'hubxp_lookup', 'Iniciando job dedicado de lookup de clientes.', {
          accounts: accounts.length,
          minWaitMs,
          timeoutMs,
          retryPerAccount,
        })

        await performLogin(job, {
          headless: true,
          username,
          password,
          loginUrl: body.loginUrl || DEFAULT_ENTRY_URL,
          loginTimeoutMs: body.loginTimeoutMs,
        })

        if (job.status !== STATUS.AUTHENTICATED && job.status !== STATUS.SUCCESS) {
          throw createHttpError(409, 'JOB_NOT_AUTHENTICATED', 'Sessao HubXP nao autenticada para lookup dedicado.')
        }
        if (!job.page) {
          throw createHttpError(409, 'JOB_NOT_READY', 'Pagina HubXP indisponivel para lookup dedicado.')
        }
        lookupPage = job.page
      }

      const rows = []
      let resolved = 0
      let failed = 0
      const accountCache = new Map()

      for (const account of accounts) {
        if (accountCache.has(account)) {
          const cached = accountCache.get(account)
          const cloned = {
            ...cached,
            account,
            cacheHit: true,
          }
          rows.push(cloned)
          if (cloned.status === 'RESOLVED') resolved += 1
          else failed += 1
          continue
        }

        let attempts = 0
        let row = null
        let lastError = null
        const maxAttempts = retryPerAccount + 1

        while (attempts < maxAttempts) {
          attempts += 1
          try {
            const targetPage = lookupPage || job.page
            const resolvedClient = await resolveSingleClientOnHubxp(job, targetPage, account, { minWaitMs, timeoutMs })
            row = {
              account,
              clientName: resolvedClient.clientName || '',
              clientEmail: resolvedClient.clientEmail,
              status: 'RESOLVED',
              attempts,
            }
            resolved += 1
            break
          } catch (error) {
            lastError = error
            appendJobLog(job, 'hubxp_lookup', 'Falha no lookup da conta', {
              account,
              attempt: attempts,
              message: error?.message || 'Falha desconhecida.',
            })
            if (attempts < maxAttempts) {
              await delay(300)
            }
          }
        }

        if (!row) {
          failed += 1
          const serialized = serializeError(lastError || createHttpError(
            500,
            'CLIENT_LOOKUP_FAILED',
            'Falha ao resolver cliente no HubXP.',
          ))
          row = {
            account,
            status: 'FAILED',
            attempts: maxAttempts,
            error: {
              code: serialized.code || 'CLIENT_LOOKUP_FAILED',
              message: serialized.message || 'Falha ao resolver cliente no HubXP.',
            },
          }
        }

        rows.push(row)
        accountCache.set(account, row)
      }

      return res.json({
        ok: true,
        summary: {
          total: accounts.length,
          resolved,
          failed,
        },
        rows,
      })
    } catch (error) {
      respondError(res, error, job)
    } finally {
      if (ownsLookupPage && lookupPage) {
        await lookupPage.close().catch(() => null)
      }
      if (sharedLookupLocked && job) {
        job._lookupRunning = false
        job.running = false
        touchJob(job)
      }
      if (shouldDestroyDedicatedJob && job?.id) {
        await destroyJob(job.id, 'clients_resolve').catch(() => null)
      }
    }
  })

  app.post('/api/hubxp/orders/cleanup', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = resolveRequestUserKey(req, body)
      const jobId = String(body.jobId || '').trim()
      if (!jobId) {
        throw createHttpError(400, 'JOB_ID_REQUIRED', 'jobId nao informado para cleanup.')
      }
      job = resolveJob(jobId, userKey)
      await destroyJob(jobId, 'manual')
      res.json({ ok: true, status: STATUS.CLEANED, jobId })
    } catch (error) {
      respondError(res, error, job)
    }
  })
}

module.exports = {
  registerHubxpOrdersRoutes,
  STATUS,
}
