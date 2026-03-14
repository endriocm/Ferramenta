const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')

const DEFAULT_ENTRY_URL = 'https://outlook.office.com/'
const DEFAULT_JOB_TTL_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 30 * 1000
const MAX_LOG_ITEMS = 400
const DEFAULT_MONITOR_INTERVAL_MS = 30 * 1000
const ALLOW_LEGACY_GUEST = String(process.env.OUTLOOK_ALLOW_LEGACY_GUEST || '').trim() === '1'

const OUTLOOK_RUNTIME_DIR = process.env.OUTLOOK_RUNTIME_DIR
  ? path.resolve(process.env.OUTLOOK_RUNTIME_DIR)
  : path.resolve(path.join(process.cwd(), 'tmp', 'outlook-debug'))
const LEGACY_SESSION_FILE = process.env.OUTLOOK_SESSION_FILE
  ? path.resolve(process.env.OUTLOOK_SESSION_FILE)
  : path.join(OUTLOOK_RUNTIME_DIR, 'outlook-session.json')

const jobs = new Map()
let sweepTimer = null
let playwrightLoader = null

const STATUS = {
  CREATED: 'CREATED',
  STARTING: 'STARTING',
  AUTHENTICATED: 'AUTHENTICATED',
  MONITORING: 'MONITORING',
  SENDING: 'SENDING',
  FAILED: 'FAILED',
  CLEANED: 'CLEANED',
}

const now = () => Date.now()

const shortId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const scrubText = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()

const toBoolean = (value, fallback = false) => {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'sim'].includes(normalized)) return true
  if (['0', 'false', 'no', 'nao', 'não'].includes(normalized)) return false
  return fallback
}

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const sanitizeUserKey = (userKey) => normalizeUserKey(userKey)
  .replace(/[^a-z0-9._:-]/gi, '_')
  .replace(/[:]/g, '__')

const sanitizeUserKeyExact = (userKey) => scrubText(userKey).toLowerCase()
  .replace(/[^a-z0-9._:-]/gi, '_')
  .replace(/[:]/g, '__')

const createHttpError = (status, code, message, details = null, stage = null) => {
  const error = new Error(message || 'Erro na requisicao.')
  error.status = status || 500
  error.code = code || 'INTERNAL_ERROR'
  if (details) error.details = details
  if (stage) error.stage = stage
  return error
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
      out[key] = scrubText(value).slice(0, 220)
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
      return
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 12)
      return
    }
    if (typeof value === 'object') out[key] = '[object]'
  })
  return out
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

const buildMonitorSnapshot = (monitor) => ({
  enabled: Boolean(monitor?.enabled),
  intervalMs: Number(monitor?.intervalMs || DEFAULT_MONITOR_INTERVAL_MS),
  startedAt: monitor?.startedAt || null,
  baselineAt: monitor?.baselineAt || null,
  rules: Array.isArray(monitor?.rules) ? monitor.rules : [],
  lastSeq: Number(monitor?.lastSeq || 0),
  eventsCount: Array.isArray(monitor?.events) ? monitor.events.length : 0,
  message: scrubText(monitor?.message || ''),
})

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
    sent: Number(job.progress?.sent || 0),
    failed: Number(job.progress?.failed || 0),
    total: Number(job.progress?.total || 0),
    message: scrubText(job.progress?.message || ''),
    startedAt: job.progress?.startedAt || null,
    finishedAt: job.progress?.finishedAt || null,
    elapsedMs: Number(job.progress?.elapsedMs || 0),
  },
  monitor: buildMonitorSnapshot(job.monitor),
  error: job.error || null,
  lastResult: job.lastResult || null,
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
      sent: 0,
      failed: 0,
      total: 0,
      message: 'Aguardando inicio.',
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
    },
    monitor: {
      enabled: false,
      timer: null,
      intervalMs: DEFAULT_MONITOR_INTERVAL_MS,
      rules: [],
      events: [],
      lastSeq: 0,
      knownMessageIds: new Set(),
      baselineAt: null,
      startedAt: null,
      message: 'Monitor inativo.',
    },
    _queue: Promise.resolve(),
    lastResult: null,
  }
  jobs.set(job.id, job)
  appendJobLog(job, 'job', 'Job Outlook criado', { userKey: normalizedUser })
  return job
}

const resolveJob = (jobId, userKey = null) => {
  const key = scrubText(jobId)
  if (!key) throw createHttpError(400, 'JOB_ID_REQUIRED', 'jobId nao informado.')
  const job = jobs.get(key)
  if (!job) throw createHttpError(404, 'JOB_NOT_FOUND', 'Sessao Outlook nao encontrada.')
  const requestedUser = normalizeUserKey(userKey)
  if (requestedUser && job.userKey !== requestedUser) {
    throw createHttpError(403, 'JOB_FORBIDDEN', 'Este job nao pertence ao usuario informado.')
  }
  return job
}

const stopMonitorTimer = (job) => {
  if (job?.monitor?.timer) {
    clearInterval(job.monitor.timer)
    job.monitor.timer = null
  }
}

const closeJobResources = async (job) => {
  stopMonitorTimer(job)
  const closeSafe = async (target) => {
    if (!target) return
    try { await target.close() } catch { /* noop */ }
  }
  await closeSafe(job.page)
  await closeSafe(job.context)
  await closeSafe(job.browser)
  job.page = null
  job.context = null
  job.browser = null
  job.browserHeadless = null
}

const destroyJob = async (jobId, reason = 'manual') => {
  const job = jobs.get(jobId)
  if (!job) return
  await closeJobResources(job)
  job.running = false
  job.status = STATUS.CLEANED
  job.stage = 'finished'
  job.progress.message = `Sessao Outlook encerrada (${reason}).`
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
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}

const getSessionFileForUser = (userKey) => path.join(
  OUTLOOK_RUNTIME_DIR,
  `outlook-session-${sanitizeUserKey(userKey)}.json`,
)

const getSessionFileForExactUserKey = (userKey) => path.join(
  OUTLOOK_RUNTIME_DIR,
  `outlook-session-${sanitizeUserKeyExact(userKey)}.json`,
)

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

const saveSessionForUser = async (state, userKey) => {
  const filePath = getSessionFileForUser(userKey)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8')
  return filePath
}

const readStorageStateFile = async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.cookies)) return parsed
  } catch {
    // noop
  }
  return null
}

const loadSessionForUser = async (userKey) => {
  const { sessionFile: userSessionFile, candidates } = resolveUserSessionFileCandidates(userKey)
  const userState = await readStorageStateFile(userSessionFile)
  if (userState) return { state: userState, sessionFile: userSessionFile, migratedFromLegacy: false }

  for (const candidate of candidates) {
    if (!candidate || candidate === userSessionFile) continue
    const candidateState = await readStorageStateFile(candidate)
    if (!candidateState) continue
    const migrated = await migrateSessionFileToCanonical(candidate, userSessionFile, candidateState)
    const migratedState = migrated ? await readStorageStateFile(userSessionFile) : null
    return {
      state: migratedState || candidateState,
      sessionFile: userSessionFile,
      migratedFromLegacy: migrated,
      sourceSessionFile: candidate,
    }
  }

  const legacyState = await readStorageStateFile(LEGACY_SESSION_FILE)
  if (!legacyState) return { state: null, sessionFile: userSessionFile, migratedFromLegacy: false }

  let migrated = false
  try {
    await fs.mkdir(path.dirname(userSessionFile), { recursive: true })
    await fs.rename(LEGACY_SESSION_FILE, userSessionFile)
    migrated = true
  } catch {
    await saveSessionForUser(legacyState, normalizeUserKey(userKey))
      .then(() => {
        migrated = true
      })
      .catch(() => null)
    if (migrated) {
      await fs.unlink(LEGACY_SESSION_FILE).catch(() => null)
    }
  }

  const migratedState = migrated ? await readStorageStateFile(userSessionFile) : null
  return {
    state: migratedState || legacyState,
    sessionFile: userSessionFile,
    migratedFromLegacy: migrated,
  }
}

const getPlaywright = async () => {
  if (!playwrightLoader) {
    playwrightLoader = import('playwright')
      .catch(() => import('playwright-core'))
      .then((mod) => {
        if (!mod?.chromium?._browserType && !process.env.OUTLOOK_BROWSER_CHANNEL) {
          process.env.OUTLOOK_BROWSER_CHANNEL = 'msedge'
        }
        return mod
      })
      .catch((error) => {
        throw createHttpError(
          503,
          'PLAYWRIGHT_UNAVAILABLE',
          'Playwright nao encontrado para Outlook.',
          error?.message,
          'init_browser',
        )
      })
  }
  const mod = await playwrightLoader
  if (!mod?.chromium) {
    throw createHttpError(503, 'PLAYWRIGHT_UNAVAILABLE', 'Chromium indisponivel no Playwright.', null, 'init_browser')
  }
  return mod.chromium
}

const ensureJobPage = async (job, options = {}) => {
  if (job.page && job.context && job.browser) {
    const pageClosed = typeof job.page?.isClosed === 'function' ? job.page.isClosed() : false
    const browserConnected = typeof job.browser?.isConnected === 'function'
      ? job.browser.isConnected()
      : true
    if (!pageClosed && browserConnected) return
    appendJobLog(job, 'init_browser', 'Sessao Outlook anterior invalida; recriando navegador.')
    await closeJobResources(job)
  }
  const chromium = await getPlaywright()
  const launchHeadless = toBoolean(options.headless, false)
  const headlessViewport = {
    width: toPositiveInt(process.env.OUTLOOK_HEADLESS_VIEWPORT_WIDTH, 1600),
    height: toPositiveInt(process.env.OUTLOOK_HEADLESS_VIEWPORT_HEIGHT, 1000),
  }
  const headedWindowSize = scrubText(process.env.OUTLOOK_HEADED_WINDOW_SIZE || '')
  const launchArgs = ['--disable-dev-shm-usage']
  if (launchHeadless) {
    launchArgs.push(`--window-size=${headlessViewport.width},${headlessViewport.height}`)
  } else {
    launchArgs.push('--start-maximized')
    if (/^\d{3,5},\d{3,5}$/.test(headedWindowSize)) {
      launchArgs.push(`--window-size=${headedWindowSize}`)
    }
  }
  const browser = await chromium.launch({
    headless: launchHeadless,
    channel: process.env.OUTLOOK_BROWSER_CHANNEL || undefined,
    args: launchArgs,
  })
  const contextOpts = {
    viewport: launchHeadless ? headlessViewport : null,
    ignoreHTTPSErrors: true,
  }
  if (options.storageState) contextOpts.storageState = options.storageState
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  await page.route(/\.(woff2?|ttf|eot|otf|mp4|webm|ogg)$/i, (route) => route.abort()).catch(() => null)
  await page.route(/google-analytics|googletagmanager|hotjar|segment|amplitude|mixpanel|doubleclick|facebook\.com\/tr/i, (route) => route.abort()).catch(() => null)
  job.browser = browser
  job.browserHeadless = Boolean(launchHeadless)
  job.context = context
  job.page = page
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
          left: 80,
          top: 60,
          width: 1440,
          height: 900,
        },
      }).catch(() => null)
    }
    await cdp.detach().catch(() => null)
  } catch {
    // ignore CDP failures
  }
  try {
    await page.bringToFront()
    return true
  } catch {
    return false
  }
}

const getPageUrl = (page) => {
  try {
    return scrubText(page?.url?.() || '')
  } catch {
    return ''
  }
}

const pickVisibleLocator = async (page, selectors = []) => {
  for (const selector of selectors) {
    const loc = page.locator(selector).first()
    if (await loc.isVisible().catch(() => false)) {
      return { locator: loc, selector }
    }
  }
  return null
}

const clickByTexts = async (page, texts = []) => {
  for (const text of texts) {
    const loc = page.getByRole('button', { name: new RegExp(text, 'i') }).first()
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 3000 }).catch(() => null)
      return true
    }
  }
  return false
}

const detectLoginScreen = async (page) => {
  const emailField = await pickVisibleLocator(page, [
    'input[type="email"]',
    'input[name*="login" i]',
    'input[name*="user" i]',
  ])
  if (emailField) return true
  const passwordField = await pickVisibleLocator(page, ['input[type="password"]'])
  if (passwordField) return true
  return false
}

const isAuthenticated = async (page) => {
  if (!page) return false
  const url = getPageUrl(page).toLowerCase()
  if (!url) return false
  if (/login|signin|oauth2|authorize/.test(url)) return false
  if (!/outlook\.office\.com|office\.com|live\.com/.test(url)) return false

  const loginVisible = await detectLoginScreen(page).catch(() => false)
  if (loginVisible) return false

  const hasMailUi = await page.locator([
    'button[aria-label*="new mail" i]',
    'button[title*="new mail" i]',
    '[aria-label*="inbox" i]',
    '[role="navigation"]',
    '[data-app-section="Mail"]',
  ].join(',')).first().isVisible().catch(() => false)

  if (hasMailUi) return true

  const body = scrubText(await page.locator('body').innerText().catch(() => ''))
  if (!body) return false
  if (/sign in|entrar|acessar conta|senha|password/i.test(body)) return false
  return /new mail|inbox|caixa de entrada|outlook/i.test(body)
}

const runAutofill = async (job, page, { username = '', password = '' } = {}) => {
  const trimmedUser = scrubText(username)
  const rawPassword = String(password || '')

  if (trimmedUser) {
    const userField = await pickVisibleLocator(page, [
      'input[type="email"]',
      'input[name*="login" i]',
      'input[name*="user" i]',
      'input[id*="login" i]',
    ])
    if (userField?.locator) {
      await userField.locator.fill(trimmedUser).catch(() => null)
      await clickByTexts(page, ['Next', 'Avancar', 'Próximo', 'Entrar'])
      appendJobLog(job, 'autofill', 'Usuario preenchido no Outlook', { selector: userField.selector })
      await delay(700)
    }
  }

  if (rawPassword) {
    const passwordField = await pickVisibleLocator(page, ['input[type="password"]'])
    if (passwordField?.locator) {
      await passwordField.locator.fill(rawPassword).catch(() => null)
      await clickByTexts(page, ['Sign in', 'Entrar', 'Avancar', 'Próximo'])
      appendJobLog(job, 'autofill', 'Senha preenchida no Outlook', { selector: passwordField.selector })
      await delay(700)
    }
  }
}

const saveCurrentSession = async (job) => {
  if (!job?.context) return null
  const state = await job.context.storageState()
  job._savedStorageState = state
  const filePath = await saveSessionForUser(state, job.userKey)
  appendJobLog(job, 'save_session', 'Sessao Outlook salva em disco', { sessionFile: filePath })
  return filePath
}

const switchToHeadless = async (job) => {
  if (!job?.browser || !job?.context || !job?.page) return false
  if (job.browserHeadless === true) return true
  try {
    const state = await job.context.storageState()
    await closeJobResources(job)
    await ensureJobPage(job, { headless: true, storageState: state })
    appendJobLog(job, 'headless', 'Sessao Outlook alternada para headless')
    return true
  } catch (error) {
    appendJobLog(job, 'headless', 'Falha ao alternar para headless', { error: error?.message })
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
      await saveSessionForUser(state, job.userKey).catch(() => null)
    }
    await closeJobResources(job)
    await ensureJobPage(job, { headless: false, storageState: state || undefined })
    await ensureBrowserWindowVisible(job.page).catch(() => null)
    appendJobLog(job, 'visible', 'Sessao Outlook reaberta em modo visivel.')
    return true
  } catch (error) {
    appendJobLog(job, 'visible', 'Falha ao alternar Outlook para visivel', { error: error?.message })
    return false
  }
}

const ensureHeadlessExecution = async (job, stage = 'outlook') => {
  if (!job?.page || !job?.context || !job?.browser) return
  if (job.browserHeadless === true) return
  appendJobLog(job, stage, 'Alternando sessao Outlook para headless...')
  const switched = await switchToHeadless(job)
  if (!switched) appendJobLog(job, stage, 'Mantendo sessao Outlook no modo atual.')
}

const ensureHeadlessAfterAuthentication = async (job, preferHeadless = false) => {
  if (!preferHeadless) {
    if (job?.browserHeadless === true) {
      appendJobLog(job, 'auth', 'Sessao Outlook estava headless; tentando abrir browser visivel...')
      const switched = await switchToVisible(job)
      if (!switched) {
        appendJobLog(job, 'auth', 'Nao foi possivel abrir browser Outlook visivel.')
        return false
      }
    }
    await ensureBrowserWindowVisible(job?.page).catch(() => null)
    const authenticated = await isAuthenticated(job?.page).catch(() => false)
    if (!authenticated) {
      appendJobLog(job, 'auth', 'Sessao perdeu autenticacao apos ajuste de visibilidade; novo login sera necessario.')
      return false
    }
    appendJobLog(job, 'auth', 'Mantendo sessao Outlook visivel apos autenticacao.')
    return true
  }
  await ensureHeadlessExecution(job, 'auth')
  return true
}

const performLogin = async (job, payload = {}) => {
  const requestedHeadless = toBoolean(payload.headless, false)

  if (!requestedHeadless && job.page && !job.running && job.browserHeadless === true) {
    appendJobLog(job, 'open_login', 'Sessao Outlook estava headless; preparando browser visivel para login.')
    const switched = await switchToVisible(job)
    if (!switched) {
      await closeJobResources(job).catch(() => null)
    }
  }

  if (job.page && !job.running) {
    const stillAuthenticated = await isAuthenticated(job.page).catch(() => false)
    if (stillAuthenticated) {
      const readyAfterModeAdjust = await ensureHeadlessAfterAuthentication(job, requestedHeadless)
      if (readyAfterModeAdjust) {
        setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Sessao Outlook reaproveitada.')
        appendJobLog(job, 'auth', 'Sessao reaproveitada sem novo login')
        return { status: STATUS.AUTHENTICATED, reused: true }
      }
      await closeJobResources(job).catch(() => null)
    }
  }

  if (!job.page) {
    const loaded = await loadSessionForUser(job.userKey)
    if (loaded.state) {
      appendJobLog(job, 'restore_session', 'Tentando restaurar sessao Outlook...', {
        sessionFile: loaded.sessionFile,
        migratedFromLegacy: loaded.migratedFromLegacy,
      })
      try {
        await ensureJobPage(job, { headless: requestedHeadless, storageState: loaded.state })
        const entryUrl = scrubText(payload.loginUrl || process.env.OUTLOOK_ENTRY_URL || DEFAULT_ENTRY_URL) || DEFAULT_ENTRY_URL
        await job.page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await job.page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null)
        if (await isAuthenticated(job.page).catch(() => false)) {
          const readyAfterModeAdjust = await ensureHeadlessAfterAuthentication(job, requestedHeadless)
          if (readyAfterModeAdjust) {
            setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Sessao Outlook restaurada do ultimo login.')
            appendJobLog(job, 'restore_session', 'Sessao restaurada com sucesso')
            return { status: STATUS.AUTHENTICATED, reused: true }
          }
        }
      } catch (error) {
        appendJobLog(job, 'restore_session', 'Falha ao restaurar sessao', { error: error?.message })
      }
      await closeJobResources(job)
    }
  }

  if (job.running) {
    throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, 'auth')
  }

  job.running = true
  job.error = null
  job.progress.startedAt = now()
  job.progress.finishedAt = null

  const entryUrl = scrubText(payload.loginUrl || process.env.OUTLOOK_ENTRY_URL || DEFAULT_ENTRY_URL) || DEFAULT_ENTRY_URL
  const headless = requestedHeadless
  const loginTimeoutMs = Number.isFinite(Number(payload.loginTimeoutMs))
    ? Math.max(30000, Number(payload.loginTimeoutMs))
    : 5 * 60 * 1000

  setJobStatus(job, STATUS.STARTING, 'open_login', 'Abrindo navegador para login Outlook...')
  appendJobLog(job, 'open_login', 'Abrindo login Outlook', { entryUrl, headless })

  try {
    await ensureJobPage(job, { headless })
    const page = job.page
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null)

    const username = scrubText(payload.username)
    const password = String(payload.password || '')
    if (username || password) {
      await runAutofill(job, page, { username, password }).catch(() => null)
    }

    if (await isAuthenticated(page).catch(() => false)) {
      await saveCurrentSession(job).catch(() => null)
      setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Sessao Outlook autenticada.')
      appendJobLog(job, 'auth', 'Login concluido sem espera adicional')
      await ensureHeadlessAfterAuthentication(job, requestedHeadless).catch(() => false)
      return { status: STATUS.AUTHENTICATED }
    }

    setJobStatus(job, STATUS.STARTING, 'waiting_manual_login', 'Aguardando login manual no Outlook...')
    appendJobLog(job, 'waiting_manual_login', 'Aguardando usuario concluir login/MFA no navegador.')

    const startedWaiting = now()
    let authenticated = false
    while (now() - startedWaiting < loginTimeoutMs) {
      if (await isAuthenticated(page).catch(() => false)) {
        authenticated = true
        break
      }
      await delay(1000)
    }

    if (!authenticated) {
      throw createHttpError(
        408,
        'LOGIN_TIMEOUT',
        `Login Outlook nao concluido em ${Math.round(loginTimeoutMs / 1000)}s.`,
        { url: getPageUrl(page) },
        'waiting_manual_login',
      )
    }

    await saveCurrentSession(job).catch(() => null)
    setJobStatus(job, STATUS.AUTHENTICATED, 'ready', 'Login Outlook concluido com sucesso.')
    appendJobLog(job, 'auth', 'Login manual concluido', { url: getPageUrl(page) })
    await ensureHeadlessAfterAuthentication(job, requestedHeadless).catch(() => false)
    return { status: STATUS.AUTHENTICATED }
  } catch (error) {
    job.error = serializeError(error)
    setJobStatus(job, STATUS.FAILED, error?.stage || 'auth', job.error.message)
    appendJobLog(job, error?.stage || 'auth', 'Falha na autenticacao Outlook', {
      code: job.error.code,
      url: getPageUrl(job.page),
    })
    throw error
  } finally {
    job.running = false
    job.progress.elapsedMs = Math.max(0, now() - (job.progress.startedAt || now()))
    touchJob(job)
  }
}

const normalizeRules = (rules) => {
  if (!Array.isArray(rules)) return []
  return rules
    .map((rule, index) => {
      const id = scrubText(rule?.id) || `rule-${index + 1}`
      const senderExact = scrubText(rule?.senderExact).toLowerCase()
      const subjectContains = scrubText(rule?.subjectContains).toLowerCase()
      const enabled = toBoolean(rule?.enabled, true)
      return { id, enabled, senderExact, subjectContains }
    })
    .filter((rule) => rule.enabled)
}

const hashMessageId = (input) => crypto
  .createHash('sha1')
  .update(String(input || ''))
  .digest('hex')

const extractInboxMessages = async (page) => {
  const raw = await page.evaluate(() => {
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
    const rows = Array.from(document.querySelectorAll('[role="row"]'))
    const items = []
    for (const row of rows) {
      const text = String(row.innerText || '').trim()
      if (!text || text.length < 8) continue

      // Extrair email do texto completo da row
      const emailsFromText = text.match(emailRegex) || []
      const emailFromRow = emailsFromText[0] || ''

      // Buscar elemento do remetente com mais seletores
      const senderSelectors = [
        '[data-automationid*="sender" i]',
        '[data-automationid="MessageListSenderSpan"]',
        'span[class*="sender" i]',
        'span[class*="from" i]',
        '[title*="@"]',
        '[aria-label*="from" i]',
        '[aria-label*="de" i]',
      ]
      let senderEl = null
      for (const sel of senderSelectors) {
        senderEl = row.querySelector(sel)
        if (senderEl) break
      }

      // Extrair nome e email separadamente
      const senderName = String(senderEl?.textContent || '').trim()
      const senderTitle = String(senderEl?.getAttribute?.('title') || '').trim()
      const senderLabel = String(senderEl?.getAttribute?.('aria-label') || '').trim()
      // Buscar email em title, aria-label ou no texto do row
      const senderEmailFromAttr = (senderTitle.match(emailRegex) || [])[0]
        || (senderLabel.match(emailRegex) || [])[0]
        || ''
      const senderEmail = senderEmailFromAttr || emailFromRow || ''
      // O sender final: preferir email se disponivel, senao nome
      const sender = senderEmail || senderName || senderTitle || ''
      // Guardar o nome separado para matching flexivel
      const senderDisplayName = senderName || senderTitle || ''

      const subjectEl = row.querySelector(
        '[data-automationid*="subject" i], [aria-label*="subject" i], [aria-label*="assunto" i]',
      )
      const timeEl = row.querySelector('time, [data-automationid*="received" i], [aria-label*="received" i]')

      const lines = text.split('\n').map((line) => String(line || '').trim()).filter(Boolean)
      const subject = String(
        subjectEl?.textContent
        || subjectEl?.getAttribute?.('title')
        || lines[1]
        || lines[0]
        || '',
      ).trim()

      const messageId = String(
        row.getAttribute('data-convid')
        || row.getAttribute('data-itemid')
        || row.getAttribute('id')
        || `${sender}|${subject}|${timeEl?.textContent || ''}`,
      ).trim()

      if (!sender && !subject) continue
      items.push({ messageId, sender, senderDisplayName, senderEmail, subject })
      if (items.length >= 80) break
    }
    return items
  }).catch(() => [])

  return Array.isArray(raw)
    ? raw
      .map((item) => {
        const sender = scrubText(item?.sender)
        const senderDisplayName = scrubText(item?.senderDisplayName)
        const senderEmail = scrubText(item?.senderEmail)
        const subject = scrubText(item?.subject)
        const baseId = scrubText(item?.messageId) || `${sender}|${subject}`
        if (!sender && !subject) return null
        return {
          messageId: hashMessageId(baseId),
          sender,
          senderDisplayName,
          senderEmail,
          subject,
          senderLower: sender.toLowerCase(),
          senderDisplayNameLower: senderDisplayName.toLowerCase(),
          senderEmailLower: senderEmail.toLowerCase(),
          subjectLower: subject.toLowerCase(),
        }
      })
      .filter(Boolean)
    : []
}

const matchRule = (message, rules = []) => {
  for (const rule of rules) {
    if (!rule?.enabled) continue
    // Matching flexivel: comparar senderExact com email, nome exibido, ou sender combinado
    let senderOk = false
    if (!rule.senderExact) {
      senderOk = true
    } else {
      const ruleVal = rule.senderExact.toLowerCase()
      senderOk = (
        message.senderLower === ruleVal
        || message.senderEmailLower === ruleVal
        || message.senderDisplayNameLower === ruleVal
        || message.senderLower.includes(ruleVal)
        || ruleVal.includes(message.senderEmailLower) && message.senderEmailLower.length > 3
      )
    }
    const subjectOk = !rule.subjectContains || message.subjectLower.includes(rule.subjectContains)
    if (senderOk && subjectOk) return rule
  }
  return null
}

const appendMonitorEvent = (job, event) => {
  const monitor = job.monitor
  monitor.lastSeq += 1
  const normalized = {
    seq: monitor.lastSeq,
    at: new Date().toISOString(),
    type: event.type || 'message_match',
    ruleId: event.ruleId || null,
    messageId: event.messageId || null,
    sender: scrubText(event.sender),
    subject: scrubText(event.subject),
  }
  monitor.events.push(normalized)
  if (monitor.events.length > 2000) {
    monitor.events.splice(0, monitor.events.length - 2000)
  }
}

const queueJob = async (job, factory, stage = 'queue') => {
  const run = async () => {
    if (job.running) {
      throw createHttpError(409, 'JOB_BUSY', 'Existe uma operacao em andamento para esta sessao.', null, stage)
    }
    job.running = true
    try {
      return await factory()
    } finally {
      job.running = false
      touchJob(job)
    }
  }
  job._queue = Promise.resolve(job._queue)
    .catch(() => null)
    .then(run)
  return job._queue
}

const runMonitorTick = async (job) => {
  if (!job?.monitor?.enabled) return
  if (job.running) return
  if (job.status !== STATUS.AUTHENTICATED && job.status !== STATUS.MONITORING) return

  await queueJob(job, async () => {
    if (!job.monitor.enabled) return
    setJobStatus(job, STATUS.MONITORING, 'monitoring', 'Monitorando Inbox...')
    try {
      // NAO alternar para headless durante monitoramento — destroi sessao SSO visivel
      // Apenas verificar se a pagina esta ativa
      if (!job.page || job.page.isClosed?.()) {
        appendJobLog(job, 'monitoring', 'Pagina Outlook fechada, monitor parado.')
        job.monitor.enabled = false
        return
      }
      await job.page.goto('https://outlook.office.com/mail/inbox', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })
      await job.page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null)
      const messages = await extractInboxMessages(job.page)
      if (!job.monitor.baselineAt) {
        for (const message of messages) job.monitor.knownMessageIds.add(message.messageId)
        job.monitor.baselineAt = now()
        job.monitor.message = `Baseline carregada (${messages.length} mensagens).`
        appendJobLog(job, 'monitoring', 'Baseline inicial carregada', { count: messages.length })
        touchJob(job)
        return
      }

      let matches = 0
      for (const message of messages) {
        if (job.monitor.knownMessageIds.has(message.messageId)) continue
        job.monitor.knownMessageIds.add(message.messageId)
        const matchedRule = matchRule(message, job.monitor.rules)
        if (!matchedRule) continue
        matches += 1
        appendMonitorEvent(job, {
          type: 'message_match',
          ruleId: matchedRule.id,
          messageId: message.messageId,
          sender: message.sender,
          subject: message.subject,
        })
      }
      job.monitor.message = matches
        ? `${matches} novo(s) e-mail(s) com match de regra.`
        : 'Sem novos e-mails com match.'
      if (matches) appendJobLog(job, 'monitoring', 'Novos e-mails com match detectados', { matches })
      touchJob(job)
    } catch (error) {
      appendJobLog(job, 'monitoring', 'Falha no monitoramento', { error: error?.message })
      job.monitor.message = error?.message || 'Falha no monitoramento.'
      if (job.monitor.enabled) {
        setJobStatus(job, STATUS.MONITORING, 'monitoring', 'Monitor ativo com erro temporario.')
      }
    }
  }, 'monitoring')
}

const startMonitor = async (job, payload = {}) => {
  if (!job.page) throw createHttpError(409, 'JOB_NOT_READY', 'Sessao Outlook nao iniciada.', null, 'monitor_start')
  if (job.status !== STATUS.AUTHENTICATED && job.status !== STATUS.MONITORING) {
    throw createHttpError(409, 'JOB_NOT_AUTHENTICATED', 'Sessao Outlook nao autenticada.', null, 'monitor_start')
  }
  const intervalMs = Number.isFinite(Number(payload.intervalMs))
    ? Math.max(10000, Math.min(5 * 60 * 1000, Number(payload.intervalMs)))
    : DEFAULT_MONITOR_INTERVAL_MS
  let rules = normalizeRules(payload.rules)
  if (!rules.length) {
    rules = [{ id: 'rule-all', enabled: true, senderExact: '', subjectContains: '' }]
  }

  stopMonitorTimer(job)
  job.monitor.enabled = true
  job.monitor.intervalMs = intervalMs
  job.monitor.rules = rules
  job.monitor.startedAt = now()
  job.monitor.message = 'Monitor inicializado.'

  if (scrubText(payload.startWindow).toLowerCase() === 'new_only') {
    job.monitor.baselineAt = null
    job.monitor.knownMessageIds = new Set()
  }

  job.monitor.timer = setInterval(() => {
    void runMonitorTick(job)
  }, intervalMs)
  if (typeof job.monitor.timer.unref === 'function') job.monitor.timer.unref()

  setJobStatus(job, STATUS.MONITORING, 'monitor_start', 'Monitor de Inbox ativo.', {
    startedAt: job.progress.startedAt || now(),
  })
  appendJobLog(job, 'monitor_start', 'Monitor Outlook iniciado', {
    intervalMs,
    rules: rules.length,
  })

  void runMonitorTick(job)
  touchJob(job)
  return { status: STATUS.MONITORING }
}

const stopMonitor = (job) => {
  stopMonitorTimer(job)
  job.monitor.enabled = false
  job.monitor.message = 'Monitor inativo.'
  setJobStatus(job, STATUS.AUTHENTICATED, 'monitor_stop', 'Monitor de Inbox parado.')
  appendJobLog(job, 'monitor_stop', 'Monitor Outlook interrompido')
  touchJob(job)
  return { status: STATUS.AUTHENTICATED }
}

const buildTemplateVars = (row, userKey) => {
  const nowIso = new Date().toISOString()
  return {
    conta: scrubText(row?.account),
    nome_cliente: scrubText(row?.clientName || row?.nomeCliente),
    email_cliente: scrubText(row?.to || row?.emailCliente),
    cc: scrubText(row?.cc),
    data_envio: nowIso,
    usuario_logado: scrubText(userKey),
  }
}

const applyTemplate = (value, vars = {}) => String(value || '')
  .replace(/\[([a-z0-9_]+)\]/gi, (_m, key) => {
    const token = String(key || '').toLowerCase()
    return vars[token] != null ? String(vars[token]) : ''
  })

const sanitizeAddressList = (value) => String(value || '')
  .split(/[;,]/)
  .map((item) => scrubText(item))
  .filter(Boolean)
  .join(';')

const COMPOSE_NEW_MAIL_SELECTORS = [
  'button[aria-label*="new mail" i]',
  'button[title*="new mail" i]',
  'button[aria-label*="new message" i]',
  'button[title*="new message" i]',
  'button[aria-label*="novo e-mail" i]',
  'button[title*="novo e-mail" i]',
  'button[aria-label*="novo email" i]',
  'button[title*="novo email" i]',
  'button[aria-label*="nova mensagem" i]',
  'button[title*="nova mensagem" i]',
]

const COMPOSE_TO_SELECTORS = [
  // Seletores especificos para o campo "Para" do compose — excluindo barras de busca
  'input[aria-label="Para"]',
  'input[aria-label="To"]',
  'div[aria-label="Para"][contenteditable="true"]',
  'div[aria-label="To"][contenteditable="true"]',
  'input[aria-label*="para" i]:not([aria-label*="pesquis" i]):not([aria-label*="search" i]):not([role="search"])',
  'input[aria-label*="to" i][role="combobox"]',
  'input[aria-label*="to," i]',
  'div[aria-label*="para" i][contenteditable="true"]:not([aria-label*="pesquis" i])',
  'div[aria-label*="to" i][contenteditable="true"]:not([aria-label*="search" i])',
  'input[placeholder*="para" i]',
  'input[placeholder*="to" i]:not([placeholder*="search" i]):not([placeholder*="pesquis" i])',
  'input[aria-label*="to" i]:not([aria-label*="pesquis" i]):not([aria-label*="search" i]):not([role="search"]):not([type="search"])',
]

const COMPOSE_CC_SELECTORS = [
  'input[aria-label*="cc" i]',
  'div[aria-label*="cc" i][contenteditable="true"]',
  'input[placeholder*="cc" i]',
]

const COMPOSE_SUBJECT_SELECTORS = [
  'input[aria-label*="subject" i]',
  'input[aria-label*="assunto" i]',
  'input[placeholder*="add a subject" i]',
  'input[placeholder*="assunto" i]',
  'input[name*="subject" i]',
]

const COMPOSE_BODY_SELECTORS = [
  'div[aria-label*="message body" i][contenteditable="true"]',
  'div[aria-label*="corpo da mensagem" i][contenteditable="true"]',
  'div[aria-label*="mensagem" i][contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'textarea[aria-label*="message body" i]',
  'textarea[aria-label*="mensagem" i]',
]

const COMPOSE_FROM_INPUT_SELECTORS = [
  'input[aria-label*="from" i]',
  'input[aria-label*="de" i]',
  'div[aria-label*="from" i][contenteditable="true"]',
  'div[aria-label*="de" i][contenteditable="true"]',
  'input[placeholder*="from" i]',
  'input[placeholder*="de" i]',
]

const COMPOSE_FROM_TOGGLE_SELECTORS = [
  'button[aria-label*="from" i]',
  'button[title*="from" i]',
  'button[aria-label*="de" i]',
  'button[title*="de" i]',
]

const COMPOSE_SEND_SELECTORS = [
  'button[aria-label*="send" i]',
  'button[title*="send" i]',
  'button[aria-label*="enviar" i]',
  'button[title*="enviar" i]',
]

const clickVisibleSelector = async (page, selectors = []) => {
  for (const selector of selectors) {
    const loc = page.locator(selector).first()
    if (!(await loc.isVisible().catch(() => false))) continue
    await loc.click({ timeout: 4000 }).catch(() => null)
    await delay(120)
    return true
  }
  return false
}

const writeFieldValue = async (page, locator, value, { submitToken = false } = {}) => {
  const text = String(value || '')
  if (!text) return
  const filled = await locator.fill(text).then(() => true).catch(() => false)
  if (!filled) {
    await locator.click({ timeout: 3000 }).catch(() => null)
    await page.keyboard.press('Control+A').catch(() => null)
    await page.keyboard.type(text, { delay: 12 }).catch(() => null)
  }
  if (submitToken) {
    await locator.press('Enter').catch(async () => {
      await page.keyboard.press('Enter').catch(() => null)
    })
  }
}

const ensureComposeWindow = async (job, page) => {
  await page.goto('https://outlook.office.com/mail/inbox', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null)
  await delay(400)

  let opened = await clickVisibleSelector(page, COMPOSE_NEW_MAIL_SELECTORS)
  if (!opened) {
    for (const re of [/new mail/i, /new message/i, /novo e-?mail/i, /nova mensagem/i]) {
      const btn = page.getByRole('button', { name: re }).first()
      if (!(await btn.isVisible().catch(() => false))) continue
      await btn.click({ timeout: 4000 }).catch(() => null)
      opened = true
      break
    }
  }
  if (!opened) {
    opened = await clickByTexts(page, ['New mail', 'New message', 'Novo email', 'Novo e-mail', 'Nova mensagem'])
  }
  if (!opened) {
    throw createHttpError(502, 'COMPOSE_BUTTON_NOT_FOUND', 'Botao "Novo email" nao encontrado no Outlook.', null, 'send')
  }

  const composeReady = await Promise.race([
    page.locator(COMPOSE_TO_SELECTORS.join(',')).first().waitFor({ state: 'visible', timeout: 7000 }).then(() => true).catch(() => false),
    page.locator(COMPOSE_SUBJECT_SELECTORS.join(',')).first().waitFor({ state: 'visible', timeout: 7000 }).then(() => true).catch(() => false),
    page.locator(COMPOSE_BODY_SELECTORS.join(',')).first().waitFor({ state: 'visible', timeout: 7000 }).then(() => true).catch(() => false),
  ])
  if (!composeReady) {
    throw createHttpError(502, 'COMPOSE_FORM_NOT_READY', 'Formulario de novo email nao abriu corretamente.', null, 'send')
  }
}

const selectComposeSenderAddress = async (page, fromAddressRaw) => {
  const fromAddress = scrubText(String(fromAddressRaw || '').split(/[;,]/)[0]).toLowerCase()
  if (!fromAddress) return true

  const findAndClickAddressOption = async () => {
    const escaped = fromAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'i')
    const candidates = [
      page.getByRole('option', { name: regex }).first(),
      page.getByRole('menuitem', { name: regex }).first(),
      page.getByRole('button', { name: regex }).first(),
      page.getByText(regex).first(),
    ]
    for (const locator of candidates) {
      if (!(await locator.isVisible().catch(() => false))) continue
      await locator.click({ timeout: 3000 }).catch(() => null)
      return true
    }
    return false
  }

  let fromField = await pickVisibleLocator(page, COMPOSE_FROM_INPUT_SELECTORS)
  if (!fromField) {
    await clickVisibleSelector(page, COMPOSE_FROM_TOGGLE_SELECTORS).catch(() => false)
    await clickByTexts(page, ['From', 'De', 'Mostrar de', 'Show from']).catch(() => false)
    await delay(220)
    fromField = await pickVisibleLocator(page, COMPOSE_FROM_INPUT_SELECTORS)
  }

  if (fromField?.locator) {
    await writeFieldValue(page, fromField.locator, fromAddress, { submitToken: true })
    await delay(220)
    return true
  }

  const openedPicker = await clickVisibleSelector(page, COMPOSE_FROM_TOGGLE_SELECTORS).catch(() => false)
  if (openedPicker || await clickByTexts(page, ['From', 'De']).catch(() => false)) {
    await delay(200)
    if (await findAndClickAddressOption()) return true
  }

  return false
}

const sendSingleEmailByComposeUi = async (job, { to, cc, subject, body, from }) => {
  const toList = sanitizeAddressList(to)
  if (!toList) throw createHttpError(400, 'RECIPIENT_REQUIRED', 'Destinatario principal nao informado.', null, 'send')
  const ccList = sanitizeAddressList(cc)
  const fromAddress = scrubText(String(from || '').split(/[;,]/)[0]).toLowerCase()
  const page = job.page

  appendJobLog(job, 'send', 'Abrindo composer via botao Novo email...')
  await ensureComposeWindow(job, page)

  if (fromAddress) {
    const selectedFrom = await selectComposeSenderAddress(page, fromAddress)
    if (!selectedFrom) {
      throw createHttpError(
        502,
        'FROM_ADDRESS_NOT_SELECTED',
        `Nao foi possivel selecionar o remetente ${fromAddress} no Outlook.`,
        { fromAddress },
        'send',
      )
    }
  }

  let toField = await pickVisibleLocator(page, COMPOSE_TO_SELECTORS)
  // Validar que o campo encontrado nao e a barra de pesquisa
  if (toField?.locator) {
    const isSearchBar = await toField.locator.evaluate((el) => {
      // Verificar se o elemento esta dentro de um container de busca
      const closest = el.closest('[role="search"], [aria-label*="Search" i], [aria-label*="Pesquisar" i], [data-testid*="search" i]')
      if (closest) return true
      // Verificar se o aria-label indica busca
      const label = (el.getAttribute('aria-label') || '').toLowerCase()
      if (label.includes('pesquis') || label.includes('search') || label.includes('buscar')) return true
      // Verificar posicao — barra de pesquisa fica no topo (y < 80px)
      const rect = el.getBoundingClientRect()
      if (rect.top < 80 && rect.width > 300) return true
      return false
    }).catch(() => false)
    if (isSearchBar) {
      appendJobLog(job, 'send', 'Primeiro match do campo Para era a barra de pesquisa; tentando alternativas...')
      toField = null
      // Tentar localizar pelo label "Para" no compose
      for (const altSelector of [
        'input[aria-label="Para"]',
        'input[aria-label="To"]',
        'div[aria-label="Para"][contenteditable="true"]',
        'div[aria-label="To"][contenteditable="true"]',
      ]) {
        const candidates = page.locator(altSelector)
        const count = await candidates.count().catch(() => 0)
        for (let i = 0; i < count; i++) {
          const loc = candidates.nth(i)
          if (!(await loc.isVisible().catch(() => false))) continue
          const isSearch = await loc.evaluate((el) => {
            const rect = el.getBoundingClientRect()
            return rect.top < 80 && rect.width > 300
          }).catch(() => false)
          if (!isSearch) {
            toField = { locator: loc, selector: altSelector }
            break
          }
        }
        if (toField) break
      }
    }
  }
  if (!toField) {
    throw createHttpError(502, 'TO_FIELD_NOT_FOUND', 'Campo Para nao encontrado no Outlook.', null, 'send')
  }
  await writeFieldValue(page, toField.locator, toList, { submitToken: true })

  if (ccList) {
    let ccField = await pickVisibleLocator(page, COMPOSE_CC_SELECTORS)
    if (!ccField) {
      await clickByTexts(page, ['Cc', 'CC']).catch(() => false)
      await delay(200)
      ccField = await pickVisibleLocator(page, COMPOSE_CC_SELECTORS)
    }
    if (ccField) {
      await writeFieldValue(page, ccField.locator, ccList, { submitToken: true })
    } else {
      appendJobLog(job, 'send', 'Campo CC nao encontrado; seguindo sem CC.', { cc: ccList })
    }
  }

  const subjectField = await pickVisibleLocator(page, COMPOSE_SUBJECT_SELECTORS)
  if (!subjectField) {
    throw createHttpError(502, 'SUBJECT_FIELD_NOT_FOUND', 'Campo Assunto nao encontrado no Outlook.', null, 'send')
  }
  await writeFieldValue(page, subjectField.locator, scrubText(subject))

  const bodyField = await pickVisibleLocator(page, COMPOSE_BODY_SELECTORS)
  if (!bodyField) {
    throw createHttpError(502, 'BODY_FIELD_NOT_FOUND', 'Campo Corpo da mensagem nao encontrado no Outlook.', null, 'send')
  }
  await bodyField.locator.click({ timeout: 3000 }).catch(() => null)
  // Aguardar assinatura carregar antes de digitar
  await delay(800)
  const bodyText = String(body || '')
  if (bodyText) {
    // Mantem assinatura padrao do Outlook: posiciona cursor no inicio absoluto e digita o texto.
    await page.keyboard.press('Control+Home').catch(() => null)
    await delay(120)
    await page.keyboard.type(bodyText, { delay: 12 }).catch(() => null)
    await page.keyboard.press('Enter').catch(() => null)
    await page.keyboard.press('Enter').catch(() => null)
  }

  let sent = await clickVisibleSelector(page, COMPOSE_SEND_SELECTORS)
  if (!sent) {
    for (const re of [/send/i, /enviar/i]) {
      const btn = page.getByRole('button', { name: re }).first()
      if (!(await btn.isVisible().catch(() => false))) continue
      await btn.click({ timeout: 4000 }).catch(() => null)
      sent = true
      break
    }
  }
  if (!sent) {
    sent = await clickByTexts(page, ['Send', 'Enviar'])
  }
  if (!sent) {
    throw createHttpError(502, 'SEND_BUTTON_NOT_FOUND', 'Botao de envio nao encontrado no Outlook.', null, 'send')
  }

  appendJobLog(job, 'send', 'Email enviado via fluxo Novo email (UI).', {
    to: toList,
    from: fromAddress || null,
    hasCc: Boolean(ccList),
    subject: scrubText(subject),
  })
  await delay(1400)
}

const sendSingleEmailByDeepLink = async (job, { to, cc, subject, body, from }) => {
  const toList = sanitizeAddressList(to)
  if (!toList) throw createHttpError(400, 'RECIPIENT_REQUIRED', 'Destinatario principal nao informado.', null, 'send')
  const ccList = sanitizeAddressList(cc)
  const fromAddress = scrubText(String(from || '').split(/[;,]/)[0]).toLowerCase()
  const params = new URLSearchParams()
  params.set('to', toList)
  if (ccList) params.set('cc', ccList)
  if (fromAddress) params.set('from', fromAddress)
  params.set('subject', scrubText(subject))
  params.set('body', String(body || ''))
  const composeUrl = `https://outlook.office.com/mail/deeplink/compose?${params.toString()}`

  await job.page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await job.page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null)
  await delay(1000)

  const sendButton = job.page.getByRole('button', { name: /send|enviar/i }).first()
  let clicked = false
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click({ timeout: 5000 }).catch(() => null)
    clicked = true
  }
  if (!clicked) {
    clicked = await clickByTexts(job.page, ['Send', 'Enviar'])
  }
  if (!clicked) {
    throw createHttpError(502, 'SEND_BUTTON_NOT_FOUND', 'Botao de envio nao encontrado no Outlook.', null, 'send')
  }
  await delay(1400)
}

const sendSingleEmail = async (job, { to, cc, subject, body, from }) => {
  try {
    await sendSingleEmailByComposeUi(job, { to, cc, subject, body, from })
  } catch (composeError) {
    appendJobLog(job, 'send', 'Falha no fluxo Novo email; tentando fallback deeplink.', {
      error: composeError?.message || 'unknown',
      code: composeError?.code || null,
    })
    await sendSingleEmailByDeepLink(job, { to, cc, subject, body, from })
  }
}

const normalizeSendRows = (rows = []) => {
  if (!Array.isArray(rows)) return []
  return rows
    .map((row, index) => {
      const account = String(row?.account || '').replace(/\D/g, '')
      if (!account) return null
      return {
        rowId: scrubText(row?.rowId) || `row-${index + 1}`,
        account,
        to: scrubText(row?.to),
        clientName: scrubText(row?.clientName || row?.nomeCliente),
        cc: scrubText(row?.cc),
      }
    })
    .filter(Boolean)
}

const sendAccounts = async (job, payload = {}) => {
  if (!job.page) throw createHttpError(409, 'JOB_NOT_READY', 'Sessao Outlook nao iniciada.', null, 'send')
  if (job.status !== STATUS.AUTHENTICATED && job.status !== STATUS.MONITORING) {
    throw createHttpError(409, 'JOB_NOT_AUTHENTICATED', 'Sessao Outlook nao autenticada.', null, 'send')
  }
  const rows = normalizeSendRows(payload.rows)
  if (!rows.length) throw createHttpError(400, 'SEND_ROWS_REQUIRED', 'Nenhuma conta valida informada para envio.', null, 'send')

  const retryPerAccount = Number.isFinite(Number(payload.retryPerAccount))
    ? Math.max(0, Math.min(3, Number(payload.retryPerAccount)))
    : 1
  const headlessSend = toBoolean(payload.headlessSend, false)

  return queueJob(job, async () => {
    job.error = null
    job.progress.startedAt = now()
    job.progress.finishedAt = null
    job.progress.sent = 0
    job.progress.failed = 0
    job.progress.total = rows.length
    setJobStatus(job, STATUS.SENDING, 'send', 'Enviando e-mails pelo Outlook...')
    appendJobLog(job, 'send', 'Execucao de envio iniciada', { total: rows.length })
    if (headlessSend) {
      await ensureHeadlessExecution(job, 'send')
    } else {
      appendJobLog(job, 'send', 'Mantendo sessao Outlook no modo atual para envio.')
    }

    const template = payload.template && typeof payload.template === 'object' ? payload.template : {}
    const subjectTpl = String(template.subject || '')
    const bodyTpl = String(template.body || '')
    const fromTpl = scrubText(template.from || template.sender || '')

    const resultRows = []

    for (const row of rows) {
      let success = false
      let lastError = null
      const vars = buildTemplateVars(row, job.userKey)
      const subject = applyTemplate(subjectTpl, vars)
      const body = applyTemplate(bodyTpl, vars)
      const from = applyTemplate(fromTpl, vars)
      for (let attempt = 1; attempt <= retryPerAccount + 1; attempt += 1) {
        try {
          await sendSingleEmail(job, {
            to: row.to,
            cc: row.cc,
            subject,
            body,
            from,
          })
          success = true
          resultRows.push({
            rowId: row.rowId,
            account: row.account,
            to: row.to,
            cc: row.cc || '',
            status: 'SENT',
            attempts: attempt,
            subject,
          })
          job.progress.sent += 1
          break
        } catch (error) {
          lastError = error
          appendJobLog(job, 'send', 'Falha ao enviar conta', {
            account: row.account,
            attempt,
            error: error?.message,
          })
          if (attempt < retryPerAccount + 1) await delay(1200)
        }
      }

      if (!success) {
        job.progress.failed += 1
        resultRows.push({
          rowId: row.rowId,
          account: row.account,
          to: row.to,
          cc: row.cc || '',
          status: 'FAILED',
          attempts: retryPerAccount + 1,
          subject,
          error: serializeError(lastError || createHttpError(500, 'SEND_FAILED', 'Falha ao enviar e-mail.')),
        })
      }

      touchJob(job)
    }

    const finishedAt = now()
    job.progress.finishedAt = finishedAt
    job.progress.elapsedMs = Math.max(0, finishedAt - (job.progress.startedAt || finishedAt))
    const hasFailures = resultRows.some((item) => item.status === 'FAILED')
    if (job.monitor.enabled) {
      setJobStatus(
        job,
        STATUS.MONITORING,
        'send_done',
        hasFailures
          ? `Envio concluido com falhas (${job.progress.sent}/${rows.length}).`
          : `Envio concluido com sucesso (${rows.length}/${rows.length}).`,
      )
    } else {
      setJobStatus(
        job,
        STATUS.AUTHENTICATED,
        'send_done',
        hasFailures
          ? `Envio concluido com falhas (${job.progress.sent}/${rows.length}).`
          : `Envio concluido com sucesso (${rows.length}/${rows.length}).`,
      )
    }

    const summary = {
      total: rows.length,
      sent: job.progress.sent,
      failed: job.progress.failed,
    }
    appendJobLog(job, 'send_done', 'Execucao de envio finalizada', summary)
    job.lastResult = {
      kind: 'send_accounts',
      summary,
      rows: resultRows,
      finishedAt,
    }
    touchJob(job)

    return {
      ok: true,
      status: hasFailures ? 'PARTIAL' : 'SUCCESS',
      summary,
      rows: resultRows,
      job: buildJobSnapshot(job),
    }
  }, 'send')
}

const respondError = (res, error, job = null) => {
  const serialized = serializeError(error)
  res.status(serialized.status || 500).json({
    ok: false,
    error: serialized,
    job: job ? buildJobSnapshot(job) : null,
  })
}

const getRequestUserKey = (req = {}, bodyOverride = null) => {
  const body = bodyOverride && typeof bodyOverride === 'object'
    ? bodyOverride
    : (req.body && typeof req.body === 'object' ? req.body : {})
  const query = req.query && typeof req.query === 'object' ? req.query : {}
  const headerUserKey = scrubText(req?.headers?.['x-user-key'] || req?.headers?.['x-userkey'] || '')
  const candidate = body.userKey || query.userKey || headerUserKey || ''
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

const registerOutlookRoutes = (app) => {
  ensureSweep()

  app.post('/api/outlook/session/start', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = getRequestUserKey(req, body)
      const requestedJobId = scrubText(body.jobId)
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

  app.get('/api/outlook/session/status/:jobId', async (req, res) => {
    try {
      const userKey = getRequestUserKey(req)
      const job = resolveJob(req.params.jobId, userKey)
      touchJob(job)
      res.json({ ok: true, job: buildJobSnapshot(job) })
    } catch (error) {
      respondError(res, error)
    }
  })

  app.post('/api/outlook/session/cleanup', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = getRequestUserKey(req, body)
      const job = resolveJob(body.jobId, userKey)
      await destroyJob(job.id, 'manual')
      res.json({ ok: true, status: STATUS.CLEANED, jobId: job.id })
    } catch (error) {
      respondError(res, error)
    }
  })

  app.post('/api/outlook/monitor/start', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = getRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      const result = await startMonitor(job, body)
      res.json({
        ok: true,
        status: result.status,
        monitor: buildMonitorSnapshot(job.monitor),
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.post('/api/outlook/monitor/stop', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = getRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      const result = stopMonitor(job)
      res.json({
        ok: true,
        status: result.status,
        monitor: buildMonitorSnapshot(job.monitor),
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error, job)
    }
  })

  app.get('/api/outlook/monitor/events/:jobId', async (req, res) => {
    try {
      const userKey = getRequestUserKey(req)
      const job = resolveJob(req.params.jobId, userKey)
      const afterSeq = Number.isFinite(Number(req.query?.afterSeq))
        ? Math.max(0, Number(req.query.afterSeq))
        : 0
      const events = Array.isArray(job.monitor?.events)
        ? job.monitor.events.filter((event) => Number(event.seq || 0) > afterSeq)
        : []
      touchJob(job)
      res.json({
        ok: true,
        events,
        lastSeq: Number(job.monitor?.lastSeq || 0),
        monitor: buildMonitorSnapshot(job.monitor),
        job: buildJobSnapshot(job),
      })
    } catch (error) {
      respondError(res, error)
    }
  })

  app.post('/api/outlook/send/accounts', async (req, res) => {
    let job = null
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const userKey = getRequestUserKey(req, body)
      job = resolveJob(body.jobId, userKey)
      const result = await sendAccounts(job, body)
      res.json(result)
    } catch (error) {
      respondError(res, error, job)
    }
  })
}

module.exports = {
  registerOutlookRoutes,
  STATUS,
}
