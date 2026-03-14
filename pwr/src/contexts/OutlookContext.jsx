/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../hooks/useToast'
import { getCurrentUserKey, normalizeUserKey } from '../services/currentUser'
import {
  cleanupOutlookSession,
  getOutlookMonitorEvents,
  getOutlookSessionStatus,
  sendOutlookAccounts,
  startOutlookMonitor,
  startOutlookSession,
  stopOutlookMonitor,
} from '../services/outlookMail'
import { resolveHubxpClients } from '../services/hubxpClientLookup'
import { notifyDesktop } from '../services/desktopNotify'

const OutlookContext = createContext(null)

const DEFAULT_INTERVAL_MS = 30000
const DEFAULT_TEMPLATE = {
  format: 'text',
  subject: 'Atualizacao conta [conta]',
  body: 'Cliente [nome_cliente] - e-mail [email_cliente]',
  from: '',
}
const MAX_HISTORY_ITEMS = 120
const MAX_NOTIFIED_IDS = 3000
const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const safeJsonParse = (value, fallback = null) => {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const readLocal = (key, fallback = null) => {
  if (typeof window === 'undefined') return fallback
  try {
    const value = window.localStorage.getItem(key)
    if (value == null) return fallback
    return value
  } catch {
    return fallback
  }
}

const writeLocal = (key, value) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

const removeLocal = (key) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

const storageKeys = (userKey) => ({
  jobId: `pwr.outlook.job_id.${userKey}`,
  credentials: `pwr.outlook.credentials.${userKey}`,
  rules: `pwr.outlook.rules.${userKey}`,
  template: `pwr.outlook.template.${userKey}`,
  history: `pwr.outlook.history.${userKey}`,
  lastSeq: `pwr.outlook.last_seq.${userKey}`,
  notified: `pwr.outlook.notified.${userKey}`,
  monitor: `pwr.outlook.monitor.${userKey}`,
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

const migrateOutlookStorageForUser = (userKey) => {
  if (typeof window === 'undefined') return
  const target = storageKeys(userKey)
  const targetEntries = Object.entries(target)
  const legacyUsers = buildLegacyUserKeyVariants(userKey)
  if (!legacyUsers.length) return

  for (const legacyUser of legacyUsers) {
    const legacy = storageKeys(legacyUser)
    for (const [field, targetKey] of targetEntries) {
      if (readLocal(targetKey) != null) continue
      const legacyKey = legacy[field]
      if (!legacyKey) continue
      const legacyValue = readLocal(legacyKey)
      if (legacyValue != null) {
        writeLocal(targetKey, legacyValue)
      }
    }
  }
}

const sanitizeRuleText = (value) => String(value || '').trim()

const normalizeRule = (rule, index = 0) => {
  const id = String(rule?.id || `rule-${Date.now()}-${index}`).trim()
  return {
    id: id || `rule-${Date.now()}-${index}`,
    enabled: rule?.enabled !== false,
    senderExact: sanitizeRuleText(rule?.senderExact).toLowerCase(),
    subjectContains: sanitizeRuleText(rule?.subjectContains).toLowerCase(),
  }
}

const readRules = (key) => {
  const parsed = safeJsonParse(readLocal(key), [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((item, index) => normalizeRule(item, index))
    .filter((rule) => rule.senderExact || rule.subjectContains)
}

const readTemplate = (key) => {
  const parsed = safeJsonParse(readLocal(key), null)
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_TEMPLATE }
  return {
    format: 'text',
    subject: String(parsed.subject || DEFAULT_TEMPLATE.subject),
    body: String(parsed.body || DEFAULT_TEMPLATE.body),
    from: String(parsed.from || ''),
  }
}

const readCredentials = (key) => {
  const parsed = safeJsonParse(readLocal(key), null)
  return {
    username: String(parsed?.username || ''),
    password: String(parsed?.password || ''),
  }
}

const readHistory = (key) => {
  const parsed = safeJsonParse(readLocal(key), [])
  return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY_ITEMS) : []
}

const readNotifiedIds = (key) => {
  const parsed = safeJsonParse(readLocal(key), [])
  return Array.isArray(parsed) ? parsed.filter(Boolean).slice(-MAX_NOTIFIED_IDS) : []
}

const readMonitorConfig = (key) => {
  const parsed = safeJsonParse(readLocal(key), null)
  return {
    intervalMs: Number.isFinite(Number(parsed?.intervalMs))
      ? Math.max(10000, Math.min(5 * 60 * 1000, Number(parsed.intervalMs)))
      : DEFAULT_INTERVAL_MS,
    autoStart: parsed?.autoStart !== false,
  }
}

const normalizeLine = (line, index = 0) => {
  const account = String(line?.account || '').replace(/\D/g, '')
  const cc = String(line?.cc || '').trim()
  const id = String(line?.id || line?.rowId || `row-${index + 1}`).trim() || `row-${index + 1}`
  return {
    id,
    rowId: id,
    account,
    cc,
  }
}

const normalizeSendLines = (lines) => {
  if (!Array.isArray(lines)) return []
  return lines
    .map((line, index) => normalizeLine(line, index))
    .filter((line) => line.account)
}

const buildDuplicateAccounts = (lines = []) => {
  const counts = new Map()
  for (const line of lines) {
    counts.set(line.account, (counts.get(line.account) || 0) + 1)
  }
  return Array.from(counts.entries())
    .filter(([, total]) => total > 1)
    .map(([account]) => account)
}

const createClientError = (message, code, details = null) => {
  const error = new Error(message)
  error.code = code
  if (details) error.details = details
  return error
}

export const OutlookProvider = ({ children }) => {
  const { notify } = useToast()
  const [userKey] = useState(() => normalizeUserKey(getCurrentUserKey(), 'guest'))
  const keys = useMemo(() => storageKeys(userKey), [userKey])

  const [jobId, setJobId] = useState(() => {
    migrateOutlookStorageForUser(userKey)
    return String(readLocal(keys.jobId, '') || '').trim()
  })
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lastError, setLastError] = useState(null)
  const [credentials, setCredentials] = useState(() => readCredentials(keys.credentials))
  const [rules, setRules] = useState(() => readRules(keys.rules))
  const [template, setTemplateState] = useState(() => readTemplate(keys.template))
  const [history, setHistory] = useState(() => readHistory(keys.history))
  const [events, setEvents] = useState([])
  const [lastSeq, setLastSeq] = useState(() => {
    const raw = readLocal(keys.lastSeq, '0')
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  })
  const [monitorConfig, setMonitorConfig] = useState(() => readMonitorConfig(keys.monitor))
  const [notifiedIds, setNotifiedIds] = useState(() => readNotifiedIds(keys.notified))

  const lastSeqRef = useRef(lastSeq)
  const notifiedSetRef = useRef(new Set(notifiedIds))
  const keepAliveTimerRef = useRef(null)
  const eventsPollTimerRef = useRef(null)
  const autoStartRef = useRef('')

  useEffect(() => {
    lastSeqRef.current = lastSeq
  }, [lastSeq])

  useEffect(() => {
    notifiedSetRef.current = new Set(notifiedIds)
  }, [notifiedIds])

  useEffect(() => {
    writeLocal(keys.credentials, JSON.stringify(credentials))
  }, [credentials, keys.credentials])

  useEffect(() => {
    writeLocal(keys.rules, JSON.stringify(rules))
  }, [keys.rules, rules])

  useEffect(() => {
    writeLocal(keys.template, JSON.stringify(template))
  }, [keys.template, template])

  useEffect(() => {
    writeLocal(keys.history, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)))
  }, [history, keys.history])

  useEffect(() => {
    writeLocal(keys.notified, JSON.stringify(notifiedIds.slice(-MAX_NOTIFIED_IDS)))
  }, [keys.notified, notifiedIds])

  useEffect(() => {
    writeLocal(keys.monitor, JSON.stringify(monitorConfig))
  }, [keys.monitor, monitorConfig])

  useEffect(() => {
    writeLocal(keys.lastSeq, String(lastSeq))
  }, [keys.lastSeq, lastSeq])

  const addHistory = useCallback((entry) => {
    const snapshot = entry && typeof entry === 'object' ? entry : {}
    setHistory((prev) => {
      const next = [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          at: new Date().toISOString(),
          ...snapshot,
        },
        ...prev,
      ]
      return next.slice(0, MAX_HISTORY_ITEMS)
    })
  }, [])

  const storeJobId = useCallback((nextJobId) => {
    const value = String(nextJobId || '').trim()
    setJobId(value)
    if (value) writeLocal(keys.jobId, value)
    else removeLocal(keys.jobId)
  }, [keys.jobId])

  const clearSessionLocal = useCallback(() => {
    storeJobId('')
    setJob(null)
    setEvents([])
    setLastSeq(0)
    setLastError(null)
    autoStartRef.current = ''
    removeLocal(keys.lastSeq)
  }, [keys.lastSeq, storeJobId])

  const syncStatus = useCallback(async (id, { silent = false } = {}) => {
    const target = String(id || jobId || '').trim()
    if (!target) return null
    try {
      const payload = await getOutlookSessionStatus(target, userKey)
      if (payload?.job) {
        setJob(payload.job)
        if (payload.job.id && payload.job.id !== jobId) {
          storeJobId(payload.job.id)
        }
        return payload.job
      }
      return null
    } catch (error) {
      if (!silent) setLastError(error)
      if (error?.status === 404 || error?.code === 'JOB_NOT_FOUND') {
        clearSessionLocal()
      }
      return null
    }
  }, [clearSessionLocal, jobId, storeJobId, userKey])

  const startSession = useCallback(async ({ headless = false } = {}) => {
    setBusy(true)
    setLastError(null)
    try {
      let payload = null
      try {
        payload = await startOutlookSession({
          userKey,
          jobId: jobId || undefined,
          headless,
          username: credentials.username || undefined,
          password: credentials.password || undefined,
        })
      } catch (error) {
        const staleSession = error?.status === 404 || error?.code === 'JOB_NOT_FOUND'
        if (!staleSession) throw error

        clearSessionLocal()
        payload = await startOutlookSession({
          userKey,
          headless,
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

  const cleanupSession = useCallback(async () => {
    if (!jobId) return
    setBusy(true)
    setLastError(null)
    try {
      await cleanupOutlookSession({ userKey, jobId })
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

  const startMonitor = useCallback(async ({
    intervalMs = monitorConfig.intervalMs || DEFAULT_INTERVAL_MS,
  } = {}) => {
    if (!jobId) throw createClientError('Sessao Outlook nao iniciada.', 'OUTLOOK_SESSION_REQUIRED')
    const activeRules = rules
      .map((item, index) => normalizeRule(item, index))
      .filter((rule) => rule.enabled && (rule.senderExact || rule.subjectContains))
    const monitorRules = activeRules.length
      ? activeRules
      : [{
          id: 'rule-all',
          enabled: true,
          senderExact: '',
          subjectContains: '',
        }]
    setBusy(true)
    setLastError(null)
    try {
      const payload = await startOutlookMonitor({
        userKey,
        jobId,
        intervalMs,
        startWindow: 'new_only',
        rules: monitorRules,
      })
      if (payload?.job) setJob(payload.job)
      setMonitorConfig((prev) => ({
        ...prev,
        intervalMs,
      }))
      addHistory({
        kind: 'monitor_start',
        status: 'STARTED',
        intervalMs,
        rules: monitorRules.length,
      })
      return payload
    } catch (error) {
      setLastError(error)
      throw error
    } finally {
      setBusy(false)
    }
  }, [addHistory, jobId, monitorConfig.intervalMs, rules, userKey])

  const stopMonitor = useCallback(async () => {
    if (!jobId) return
    setBusy(true)
    setLastError(null)
    try {
      const payload = await stopOutlookMonitor({ userKey, jobId })
      if (payload?.job) setJob(payload.job)
      addHistory({
        kind: 'monitor_stop',
        status: 'STOPPED',
      })
      return payload
    } catch (error) {
      setLastError(error)
      throw error
    } finally {
      setBusy(false)
    }
  }, [addHistory, jobId, userKey])

  const updateCredential = useCallback((field, value) => {
    setCredentials((prev) => ({
      ...prev,
      [field]: value,
    }))
  }, [])

  const setTemplate = useCallback((patch) => {
    setTemplateState((prev) => ({
      ...prev,
      ...(patch && typeof patch === 'object' ? patch : {}),
      format: 'text',
    }))
  }, [])

  const addRule = useCallback(() => {
    setRules((prev) => ([
      ...prev,
      normalizeRule({
        id: `rule-${Date.now()}`,
        enabled: true,
        senderExact: '',
        subjectContains: '',
      }, prev.length),
    ]))
  }, [])

  const updateRule = useCallback((ruleId, patch = {}) => {
    setRules((prev) => prev.map((item, index) => {
      if (item.id !== ruleId) return item
      return normalizeRule({ ...item, ...patch }, index)
    }))
  }, [])

  const removeRule = useCallback((ruleId) => {
    setRules((prev) => prev.filter((item) => item.id !== ruleId))
  }, [])

  const updateMonitorConfig = useCallback((patch = {}) => {
    setMonitorConfig((prev) => ({
      ...prev,
      ...patch,
    }))
  }, [])

  const setMonitorSenders = useCallback((senders = []) => {
    const source = Array.isArray(senders) ? senders : [senders]
    const normalized = Array.from(new Set(
      source
        .map((item) => sanitizeRuleText(item).toLowerCase())
        .filter((email) => email && SIMPLE_EMAIL_REGEX.test(email)),
    ))

    if (!normalized.length) return []

    setRules(normalized.map((sender, index) => normalizeRule({
      id: `rule-auto-${Date.now()}-${index + 1}`,
      enabled: true,
      senderExact: sender,
      subjectContains: '',
    }, index)))

    addHistory({
      kind: 'monitor_rules_auto',
      status: 'UPDATED',
      senders: normalized.length,
    })

    return normalized
  }, [addHistory])

  const pollEvents = useCallback(async ({ silent = true } = {}) => {
    if (!jobId) return null
    try {
      const payload = await getOutlookMonitorEvents({
        userKey,
        jobId,
        afterSeq: lastSeqRef.current,
      })
      if (payload?.job) setJob(payload.job)

      const incoming = Array.isArray(payload?.events) ? payload.events : []
      if (incoming.length) {
        setEvents((prev) => [...prev, ...incoming].slice(-300))
        const nextSeq = Number.isFinite(Number(payload?.lastSeq))
          ? Number(payload.lastSeq)
          : Math.max(...incoming.map((item) => Number(item.seq || 0)))
        if (Number.isFinite(nextSeq)) {
          setLastSeq(Math.max(lastSeqRef.current, nextSeq))
          lastSeqRef.current = Math.max(lastSeqRef.current, nextSeq)
        }

        const newMatches = []
        for (const event of incoming) {
          if (event?.type !== 'message_match') continue
          const messageId = String(event.messageId || '').trim()
          if (!messageId || notifiedSetRef.current.has(messageId)) continue
          notifiedSetRef.current.add(messageId)
          newMatches.push(event)
        }

        if (newMatches.length) {
          const nextNotified = Array.from(notifiedSetRef.current).slice(-MAX_NOTIFIED_IDS)
          setNotifiedIds(nextNotified)
          for (const item of newMatches) {
            const sender = String(item.sender || '').trim()
            const subject = String(item.subject || '').trim()
            const message = `${sender || 'Sem remetente'} - ${subject || 'Sem assunto'}`
            await notifyDesktop({
              title: 'Outlook - novo e-mail',
              body: message,
              tag: item.messageId || undefined,
              fallback: (_title, bodyText) => notify(bodyText, 'warning'),
            })
            addHistory({
              kind: 'monitor_match',
              status: 'MATCH',
              sender,
              subject,
              ruleId: item.ruleId || null,
              messageId: item.messageId || null,
            })
          }
        }
      } else if (Number.isFinite(Number(payload?.lastSeq)) && Number(payload.lastSeq) > lastSeqRef.current) {
        setLastSeq(Number(payload.lastSeq))
        lastSeqRef.current = Number(payload.lastSeq)
      }
      return payload
    } catch (error) {
      if (!silent) setLastError(error)
      return null
    }
  }, [addHistory, jobId, notify, userKey])

  const executeSendFlow = useCallback(async ({
    lines,
    hubxpJobId,
    hubxpCredentials,
    preLookup,
    allowDuplicates = false,
    retryPerAccount = 1,
  }) => {
    if (!jobId) throw createClientError('Sessao Outlook nao iniciada.', 'OUTLOOK_SESSION_REQUIRED')
    const status = String(job?.status || '')
    const authenticated = status === 'AUTHENTICATED' || status === 'MONITORING' || status === 'SUCCESS'
    if (!authenticated) {
      throw createClientError('Sessao Outlook nao autenticada. Abra o Outlook e faca login.', 'OUTLOOK_NOT_AUTHENTICATED')
    }

    const normalizedLines = normalizeSendLines(lines)
    if (!normalizedLines.length) {
      throw createClientError('Informe ao menos uma linha de conta valida.', 'SEND_LINES_REQUIRED')
    }
    if (normalizedLines.length > 50) {
      throw createClientError('Maximo de 50 contas por execucao.', 'SEND_LINES_LIMIT_EXCEEDED')
    }

    const duplicateAccounts = buildDuplicateAccounts(normalizedLines)
    if (duplicateAccounts.length && !allowDuplicates) {
      throw createClientError('Existem contas duplicadas no lote. Confirme para manter repeticoes.', 'DUPLICATE_ACCOUNTS', {
        duplicateAccounts,
      })
    }

    const sharedLookupJobId = String(hubxpJobId || '').trim()
    const lookupCredentials = hubxpCredentials && typeof hubxpCredentials === 'object'
      ? {
          username: String(hubxpCredentials.username || '').trim(),
          password: String(hubxpCredentials.password || ''),
        }
      : { username: '', password: '' }
    const hasDedicatedCredentials = Boolean(lookupCredentials.username && lookupCredentials.password)

    setBusy(true)
    setLastError(null)
    try {
      const runDedicatedLookup = async ({ loginTimeoutMs = 30000 } = {}) => {
        try {
          return await resolveHubxpClients({
            userKey,
            mode: 'dedicated',
            accounts: normalizedLines.map((line) => line.account),
            credentials: hasDedicatedCredentials ? lookupCredentials : undefined,
            loginTimeoutMs,
            minWaitMs: 2000,
            timeoutMs: 10000,
            retryPerAccount: 1,
          })
        } catch (error) {
          const code = String(error?.code || '')
          if (!hasDedicatedCredentials && code === 'JOB_NOT_AUTHENTICATED') {
            throw createClientError(
              'Sessao HubXP nao iniciada. Abra o HubXP e faca login para resolver conta -> e-mail.',
              'HUBXP_SESSION_REQUIRED',
            )
          }
          if (!hasDedicatedCredentials && code === 'LOGIN_TIMEOUT') {
            throw createClientError(
              'Backend HubXP desatualizado para lookup compartilhado. Reinicie o app para aplicar a atualizacao.',
              'HUBXP_SHARED_MODE_UNAVAILABLE',
            )
          }
          throw error
        }
      }

      let lookup = null
      const preLookupRows = Array.isArray(preLookup?.rows) ? preLookup.rows : null
      if (preLookupRows && preLookupRows.length) {
        lookup = preLookup
      } else {
        if (sharedLookupJobId) {
          try {
            lookup = await resolveHubxpClients({
              userKey,
              mode: 'shared',
              jobId: sharedLookupJobId,
              accounts: normalizedLines.map((line) => line.account),
              minWaitMs: 2000,
              timeoutMs: 10000,
              retryPerAccount: 1,
            })
          } catch (sharedLookupError) {
            const sharedCode = String(sharedLookupError?.code || '')
            if (sharedCode === 'INVALID_MODE') {
              if (!hasDedicatedCredentials) {
                throw createClientError(
                  'Backend HubXP desatualizado para lookup compartilhado. Reinicie o app para aplicar a atualizacao.',
                  'HUBXP_SHARED_MODE_UNAVAILABLE',
                )
              }
              lookup = await runDedicatedLookup({ loginTimeoutMs: 30000 })
            } else {
              const retryWithDedicated = hasDedicatedCredentials && [
                'JOB_NOT_FOUND',
                'JOB_NOT_AUTHENTICATED',
                'JOB_NOT_READY',
                'JOB_BUSY',
              ].includes(sharedCode)
              if (!retryWithDedicated) throw sharedLookupError
              lookup = await runDedicatedLookup({ loginTimeoutMs: 30000 })
            }
          }
        } else {
          lookup = await runDedicatedLookup({ loginTimeoutMs: 30000 })
        }
      }

      const lookupRows = Array.isArray(lookup?.rows) ? lookup.rows : []
      const rowsToSend = []
      const lookupMap = new Map()

      normalizedLines.forEach((line, index) => {
        const resolved = lookupRows[index] || null
        lookupMap.set(line.id, resolved)
        if (resolved?.status === 'RESOLVED' && resolved?.clientEmail) {
          rowsToSend.push({
            rowId: line.id,
            account: line.account,
            to: resolved.clientEmail,
            clientName: String(resolved.clientName || ''),
            cc: line.cc || '',
          })
        }
      })

      let sendResult = null
      if (rowsToSend.length) {
        sendResult = await sendOutlookAccounts({
          userKey,
          jobId,
          template,
          rows: rowsToSend,
          retryPerAccount,
        })
        if (sendResult?.job) setJob(sendResult.job)
      }

      const sendMap = new Map(
        (Array.isArray(sendResult?.rows) ? sendResult.rows : [])
          .map((item) => [String(item.rowId || ''), item]),
      )

      const mergedRows = normalizedLines.map((line, index) => {
        const resolved = lookupMap.get(line.id)
        if (!resolved || resolved.status !== 'RESOLVED' || !resolved.clientEmail) {
          return {
            rowId: line.id,
            index: index + 1,
            account: line.account,
            cc: line.cc || '',
            status: 'FAILED',
            source: 'lookup',
            attempts: Number(resolved?.attempts || 0),
            error: resolved?.error || {
              code: 'CLIENT_EMAIL_NOT_FOUND',
              message: 'Nao foi possivel localizar e-mail do cliente.',
            },
          }
        }

        const sent = sendMap.get(line.id)
        if (!sent) {
          return {
            rowId: line.id,
            index: index + 1,
            account: line.account,
            to: resolved.clientEmail,
            cc: line.cc || '',
            status: 'FAILED',
            source: 'send',
            attempts: 0,
            error: {
              code: 'SEND_RESULT_MISSING',
              message: 'Resultado de envio nao retornou para esta linha.',
            },
          }
        }

        return {
          ...sent,
          index: index + 1,
          source: 'send',
          clientName: resolved.clientName || '',
          clientEmail: resolved.clientEmail || sent.to || '',
        }
      })

      const sent = mergedRows.filter((item) => item.status === 'SENT').length
      const failed = mergedRows.length - sent
      const summary = {
        total: mergedRows.length,
        sent,
        failed,
      }

      addHistory({
        kind: 'send_accounts',
        status: failed ? 'PARTIAL' : 'SUCCESS',
        summary,
        rows: mergedRows.slice(0, 60),
        template,
      })

      return {
        ok: true,
        summary,
        rows: mergedRows,
        lookup,
        send: sendResult,
      }
    } catch (error) {
      setLastError(error)
      throw error
    } finally {
      setBusy(false)
    }
  }, [addHistory, job?.status, jobId, template, userKey])

  useEffect(() => {
    if (!jobId) return undefined
    void syncStatus(jobId, { silent: true })

    if (keepAliveTimerRef.current) clearInterval(keepAliveTimerRef.current)
    keepAliveTimerRef.current = setInterval(() => {
      void syncStatus(jobId, { silent: true })
    }, 30000)

    return () => {
      if (keepAliveTimerRef.current) clearInterval(keepAliveTimerRef.current)
      keepAliveTimerRef.current = null
    }
  }, [jobId, syncStatus])

  const monitorEnabled = Boolean(job?.monitor?.enabled)
  useEffect(() => {
    if (eventsPollTimerRef.current) {
      clearInterval(eventsPollTimerRef.current)
      eventsPollTimerRef.current = null
    }
    if (!jobId || !monitorEnabled) return undefined
    void pollEvents({ silent: true })
    eventsPollTimerRef.current = setInterval(() => {
      void pollEvents({ silent: true })
    }, 5000)
    return () => {
      if (eventsPollTimerRef.current) clearInterval(eventsPollTimerRef.current)
      eventsPollTimerRef.current = null
    }
  }, [jobId, monitorEnabled, pollEvents])

  const hasActiveRules = useMemo(
    () => rules.some((rule) => rule.enabled && (rule.senderExact || rule.subjectContains)),
    [rules],
  )
  useEffect(() => {
    if (!jobId) return
    const status = String(job?.status || '')
    const authenticated = status === 'AUTHENTICATED' || status === 'MONITORING' || status === 'SUCCESS'
    if (!authenticated) return
    if (!monitorConfig.autoStart) return
    if (!hasActiveRules) return
    if (monitorEnabled) return
    if (autoStartRef.current === jobId) return
    autoStartRef.current = jobId
    void startMonitor({ intervalMs: monitorConfig.intervalMs }).catch(() => {
      autoStartRef.current = ''
    })
  }, [
    hasActiveRules,
    job?.status,
    jobId,
    monitorConfig.autoStart,
    monitorConfig.intervalMs,
    monitorEnabled,
    startMonitor,
  ])

  const isAuthenticated = monitorEnabled
    || job?.status === 'AUTHENTICATED'
    || job?.status === 'SUCCESS'
    || false

  const value = useMemo(() => ({
    userKey,
    jobId,
    job,
    busy,
    lastError,
    credentials,
    rules,
    template,
    history,
    events,
    lastSeq,
    monitorConfig,
    isAuthenticated,
    monitorEnabled,
    updateCredential,
    storeJobId,
    clearSessionLocal,
    syncStatus,
    startSession,
    cleanupSession,
    startMonitor,
    stopMonitor,
    updateMonitorConfig,
    setMonitorSenders,
    addRule,
    updateRule,
    removeRule,
    setTemplate,
    pollEvents,
    executeSendFlow,
    addHistory,
  }), [
    addHistory,
    addRule,
    busy,
    clearSessionLocal,
    cleanupSession,
    credentials,
    events,
    executeSendFlow,
    history,
    isAuthenticated,
    job,
    jobId,
    lastError,
    lastSeq,
    monitorConfig,
    monitorEnabled,
    pollEvents,
    removeRule,
    rules,
    setTemplate,
    startMonitor,
    startSession,
    stopMonitor,
    storeJobId,
    syncStatus,
    template,
    updateCredential,
    updateMonitorConfig,
    setMonitorSenders,
    updateRule,
    userKey,
  ])

  return (
    <OutlookContext.Provider value={value}>
      {children}
    </OutlookContext.Provider>
  )
}

export const useOutlook = () => {
  const ctx = useContext(OutlookContext)
  if (!ctx) {
    throw new Error('useOutlook deve ser usado dentro de <OutlookProvider>.')
  }
  return ctx
}
