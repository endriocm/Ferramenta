import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadXlsx } from '../services/xlsxLoader'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import Icon from '../components/Icons'
import { useToast } from '../hooks/useToast'
import { useHubxp } from '../contexts/HubxpContext'
import { fetchHubxpApuracaoBovespa, getHubxpApuracaoBovespaResults, abortHubxpApuracaoBovespa } from '../services/hubxpApuracaoBovespa'
import { appendManualRevenueBatch } from '../services/revenueStore'

const getToday = () => {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const parseAccountsFromFile = async (file) => {
  if (!file) return { accounts: [], accountMeta: {} }
  const XLSX = await loadXlsx()
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheetName = wb.SheetNames?.[0]
  const sheet = sheetName ? wb.Sheets[sheetName] : null
  if (!sheet) return { accounts: [], accountMeta: {} }

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  if (!Array.isArray(rows) || !rows.length) return { accounts: [], accountMeta: {} }

  const firstRow = Array.isArray(rows[0]) ? rows[0] : []
  const header = firstRow.map((cell) => String(cell || '').trim().toLowerCase())
  const contaIdx = header.findIndex((h) => h.includes('conta') || h.includes('cód') || h.includes('cod'))
  const tagIdx = header.findIndex((h) => h === 'tag' || h.includes('assessor'))
  const brokerIdx = header.findIndex((h) => h === 'broker' || h.includes('corretora') || h.includes('escritorio'))
  const nomeIdx = header.findIndex((h) => h === 'nome' || h.includes('cliente') || h.includes('razao'))

  // Quando nenhum header de conta e reconhecido, detectar a melhor coluna automaticamente.
  // O Excel pode ter datas em coluna A e contas em coluna B (sem header).
  const detectBestAccountColumn = () => {
    if (contaIdx >= 0) return { startAt: 1, idx: contaIdx }
    // Sem header reconhecido: avaliar colunas para encontrar a que parece conter contas
    const maxCols = Math.min(firstRow.length || 1, 6)
    const isDateLike = (value) => {
      if (value instanceof Date) return true
      const s = String(value || '').trim()
      return /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s) || /^\d{4}[/.-]\d{1,2}[/.-]\d{1,2}$/.test(s)
    }
    let bestCol = 0
    let bestScore = -1
    for (let col = 0; col < maxCols; col += 1) {
      let uniqueDigits = new Set()
      let dateCount = 0
      let validCount = 0
      const sampleSize = Math.min(rows.length, 30)
      for (let r = 0; r < sampleSize; r += 1) {
        const row = Array.isArray(rows[r]) ? rows[r] : []
        const cell = row[col]
        const raw = String(cell || '').trim()
        if (!raw) continue
        if (isDateLike(raw)) { dateCount += 1; continue }
        const digits = raw.replace(/\D/g, '')
        if (digits.length >= 4) {
          uniqueDigits.add(digits)
          validCount += 1
        }
      }
      // Colunas com muitas datas nao sao contas; preferir colunas com muitos valores unicos
      const score = uniqueDigits.size * 10 + validCount - dateCount * 20
      if (score > bestScore) {
        bestScore = score
        bestCol = col
      }
    }
    return { startAt: 0, idx: bestCol }
  }

  const { startAt, idx } = detectBestAccountColumn()

  const accounts = []
  const accountMeta = {}
  for (let i = startAt; i < rows.length; i += 1) {
    const row = Array.isArray(rows[i]) ? rows[i] : []
    const cell = row[idx]
    const digits = String(cell || '').replace(/\D/g, '')
    if (!digits) continue
    if (digits.length < 4) continue
    if (!accounts.includes(digits)) accounts.push(digits)
    if (!accountMeta[digits]) {
      accountMeta[digits] = {
        tag: tagIdx >= 0 ? String(row[tagIdx] || '').trim() : '',
        broker: brokerIdx >= 0 ? String(row[brokerIdx] || '').trim() : '',
        clienteNome: nomeIdx >= 0 ? String(row[nomeIdx] || '').trim() : '',
      }
    }
  }
  return { accounts, accountMeta }
}

const formatBRL = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

const parseMoneyValue = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
  if (!cleaned) return null
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

const toPositiveMoney = (value) => {
  const parsed = parseMoneyValue(value)
  if (parsed == null) return null
  return Math.abs(parsed)
}

const roundMoney = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Number(num.toFixed(2))
}

const TAXA_RULE_FIXED = 100
const TAXA_RULE_THRESHOLD = 15000
const TAXA_RULE_PERCENT = 0.005
const TAXA_RULE_ADDER = 25.21
const TAXA_RULE_TOLERANCE = 0.01

const calculateExpectedTaxaOperacional = (valorOperacoes) => {
  const valor = toPositiveMoney(valorOperacoes)
  if (valor == null) return null
  if (valor <= TAXA_RULE_THRESHOLD) return TAXA_RULE_FIXED
  return roundMoney((valor * TAXA_RULE_PERCENT) + TAXA_RULE_ADDER)
}

const buildTaxaAudit = (row = {}) => {
  const valorOperacoes = toPositiveMoney(row.valorOperacoes)
  const taxaOperacional = toPositiveMoney(row.taxaOperacional)
  const expectedTaxa = calculateExpectedTaxaOperacional(valorOperacoes)
  const needsAdjustment = (
    valorOperacoes != null
    && taxaOperacional != null
    && expectedTaxa != null
    && taxaOperacional > expectedTaxa + TAXA_RULE_TOLERANCE
  )
  return {
    valorOperacoes,
    taxaOperacional,
    expectedTaxa,
    adjustedTaxa: needsAdjustment ? expectedTaxa : null,
    needsAdjustment,
  }
}

const DEFAULT_APURACAO_RESULT_COLUMNS = [
  'conta',
  'tag',
  'broker',
  'cliente',
  'data',
  'valorOperacoes',
  'valorFinanceiro',
  'taxaOperacional',
  'taxaOperacionalAjustada',
  'corretagem',
  'outrasTaxas',
  'totalTaxas',
  'bolsa',
  'pdfPages',
  'pdfScanned',
]

const APURACAO_MONEY_COLUMNS = new Set([
  'valorOperacoes',
  'valorFinanceiro',
  'taxaOperacional',
  'taxaOperacionalAjustada',
  'corretagem',
  'outrasTaxas',
  'totalTaxas',
])

const APURACAO_COLUMN_LABELS = {
  conta: 'Conta',
  tag: 'Tag',
  broker: 'Broker',
  cliente: 'Cliente',
  data: 'Data',
  valorOperacoes: 'Valor das operacoes',
  valorFinanceiro: 'Valor financeiro',
  taxaOperacional: 'Taxa Operacional',
  taxaOperacionalAjustada: 'Taxa Ajustada (Regra)',
  corretagem: 'Corretagem',
  outrasTaxas: 'Outras taxas',
  totalTaxas: 'Total de taxas',
  bolsa: 'Bolsa',
  pdfPages: 'Paginas PDF',
  pdfScanned: 'PDF lido',
}

const normalizeApuracaoResultColumns = (columns = []) => {
  const source = Array.isArray(columns) && columns.length ? columns : DEFAULT_APURACAO_RESULT_COLUMNS
  const out = []
  const seen = new Set()
  const append = (value) => {
    const key = String(value || '').trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(key)
  }
  source.forEach(append)
  if (!seen.has('taxaOperacionalAjustada')) {
    const taxaIndex = out.indexOf('taxaOperacional')
    if (taxaIndex >= 0) out.splice(taxaIndex + 1, 0, 'taxaOperacionalAjustada')
    else out.push('taxaOperacionalAjustada')
  }
  return out
}

const buildApuracaoResultRow = (row = {}, index = 0, accountMeta = {}) => {
  const meta = accountMeta[String(row.conta || '').replace(/\D/g, '')] || {}
  const taxaAudit = buildTaxaAudit(row)
  return {
    id: row.id || `nota-${index + 1}`,
    ...row,
    tag: row.tag || meta.tag || '',
    broker: row.broker || meta.broker || '',
    cliente: row.cliente || meta.clienteNome || '',
    valorOperacoes: taxaAudit.valorOperacoes ?? row.valorOperacoes ?? null,
    taxaOperacional: taxaAudit.taxaOperacional ?? row.taxaOperacional ?? null,
    taxaOperacionalAjustada: taxaAudit.adjustedTaxa,
    taxaOperacionalAjusteDivergente: taxaAudit.needsAdjustment,
  }
}

const normalizeApuracaoResultsPayload = (payload, accountMeta = {}) => ({
  columns: normalizeApuracaoResultColumns(payload?.columns),
  rows: (Array.isArray(payload?.rows) ? payload.rows : []).map((row, index) => buildApuracaoResultRow(row, index, accountMeta)),
  accountRuns: Array.isArray(payload?.accountRuns) ? payload.accountRuns : [],
  failedAccounts: Array.isArray(payload?.failedAccounts) ? payload.failedAccounts : [],
  summary: payload?.summary && typeof payload.summary === 'object' ? payload.summary : null,
})

const STATUS_LABEL = {
  DISCONNECTED: 'Desconectado',
  CREATED: 'Pronto',
  STARTING: 'Autenticando',
  OTP_REQUIRED: 'OTP necessario',
  AUTHENTICATED: 'Logado',
  COLLECTING: 'Coletando',
  SUCCESS: 'Concluido',
  FAILED: 'Falha',
  CLEANED: 'Encerrado',
}

const formatLogDateTime = (value) => {
  if (!value) return '-'
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return String(value)
  return dt.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

const formatLogLine = (entry = {}) => {
  const when = formatLogDateTime(entry.at)
  const stage = String(entry.stage || 'log').toUpperCase()
  const message = String(entry.message || '').trim()
  const meta = entry.meta && typeof entry.meta === 'object'
    ? Object.entries(entry.meta)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value)
        return `${key}=${rendered}`
      })
      .join(' | ')
    : ''
  return `[${when}] [${stage}] ${message}${meta ? ` | ${meta}` : ''}`
}

const isDesktopRuntime = typeof window !== 'undefined' && (
  window.location.protocol === 'file:' ||
  Boolean(window.electronAPI)
)
const DESKTOP_BROWSER_WORKERS = 3
const RETRYABLE_FAILURE_CODES = new Set(['NOTAS_PAGE_NOT_READY', 'WORKER_DISTRIBUTION_UNBALANCED'])
const FOCUSED_DIAGNOSTIC_STAGES = new Set(['notas_nav', 'notas_filter', 'ui_reset', 'pdf'])

const normalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()

const resolveRevenueOrigin = (row = {}) => {
  const raw = `${row.bolsa || ''} ${row.mercado || ''} ${row.line || ''}`
  const token = normalizeText(raw).replace(/[^a-z0-9]+/g, '')
  if (!token) return 'Bovespa'
  if (token.includes('estrutur')) return 'Estruturadas'
  if (token.includes('bmf') || token.includes('futuro') || token.includes('deriv')) return 'BMF'
  return 'Bovespa'
}

const buildManualImportKey = (row = {}, origem = 'Bovespa', valor = 0) => {
  const conta = String(row.conta || '').replace(/\D/g, '')
  const data = String(row.data || '').slice(0, 10)
  const bolsa = normalizeText(row.bolsa || row.mercado || row.line || '')
  const cliente = normalizeText(row.cliente || '')
  const valorOperacoes = toPositiveMoney(row.valorOperacoes)
  const taxaOperacional = toPositiveMoney(row.taxaOperacional)
  return [
    'apuracao_bovespa',
    origem,
    conta,
    data,
    bolsa,
    valorOperacoes == null ? '' : valorOperacoes.toFixed(2),
    taxaOperacional == null ? '' : taxaOperacional.toFixed(2),
    Number(valor || 0).toFixed(2),
    cliente,
  ].join('|')
}

const buildCorretagemImportKey = (row = {}, origem = 'Bovespa') => {
  const conta = String(row.conta || '').replace(/\D/g, '')
  const data = String(row.data || '').slice(0, 10)
  const bolsa = normalizeText(row.bolsa || row.mercado || row.line || '')
  return `apuracao_bov_corr|${origem}|${conta}|${data}|${bolsa}`
}

const isRetryableFailure = (job) => {
  const code = String(job?.error?.code || '').trim().toUpperCase()
  if (RETRYABLE_FAILURE_CODES.has(code)) return true
  const msg = normalizeText(`${job?.error?.message || ''} ${job?.progress?.message || ''}`)
  return (
    msg.includes('notas_page_not_ready')
    || msg.includes('nenhum browser chegou na tela de notas de negociacao')
    || msg.includes('worker_distribution_unbalanced')
    || msg.includes('modo estrito de distribuicao ativo')
  )
}

const analyzeAccountRuns = (runs = []) => {
  const grouped = new Map()
  const workerSet = new Set()
  for (const run of runs) {
    const account = String(run?.account || run?.conta || '').replace(/\D/g, '')
    if (!account) continue
    if (!grouped.has(account)) grouped.set(account, [])
    grouped.get(account).push(run)
    const workerValue = run?.worker
    if (workerValue != null && String(workerValue).trim() !== '') {
      workerSet.add(String(workerValue).trim())
    }
  }

  const duplicateAccounts = []
  const multiWorkerAccounts = []
  grouped.forEach((group, account) => {
    if (group.length > 1) {
      duplicateAccounts.push(account)
    }
    const workers = [...new Set(group
      .map((item) => (item?.worker == null ? '' : String(item.worker).trim()))
      .filter(Boolean))]
    if (workers.length > 1) {
      multiWorkerAccounts.push(`${account} (${workers.join(', ')})`)
    }
  })

  return {
    workersUsed: workerSet.size,
    duplicateAccounts,
    multiWorkerAccounts,
    duplicateCount: duplicateAccounts.length + multiWorkerAccounts.length,
  }
}

const buildFocusedFailureLogs = (entries = []) => {
  const filtered = entries.filter((entry) => FOCUSED_DIAGNOSTIC_STAGES.has(String(entry?.stage || '')))
  return filtered.slice(-30).map((entry) => formatLogLine(entry))
}

const parseAccountsFromText = (text) => {
  if (!text.trim()) return []
  const lines = text.split(/[\n,;\t]+/)
  const result = []
  for (const line of lines) {
    const digits = line.trim().replace(/\D/g, '')
    if (digits.length >= 4 && !result.includes(digits)) result.push(digits)
  }
  return result
}

const getPeriodPreset = (preset) => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  if (preset === 'hoje') {
    const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    return { dateFrom: d, dateTo: d }
  }
  if (preset === 'este_mes') {
    const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    return { dateFrom: from, dateTo: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}` }
  }
  if (preset === 'mes_anterior') {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    return { dateFrom: from, dateTo: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(lastDay)}` }
  }
  return null
}

const ApuracaoBovespa = () => {
  const { notify } = useToast()
  const hubxp = useHubxp()
  const today = useMemo(() => getToday(), [])

  const [filters, setFilters] = useState({
    dateFrom: today,
    dateTo: today,
  })

  const [fileInfo, setFileInfo] = useState({ name: '', count: 0 })
  const [accounts, setAccounts] = useState([])
  const [accountMeta, setAccountMeta] = useState({})
  const [pastedText, setPastedText] = useState('')
  const [pastedAccounts, setPastedAccounts] = useState([])
  const [rows, setRows] = useState([])
  const [corretagemOverrides, setCorretagemOverrides] = useState({})
  const [resultColumns, setResultColumns] = useState(DEFAULT_APURACAO_RESULT_COLUMNS)
  const [accountRuns, setAccountRuns] = useState([])
  const [failedAccounts, setFailedAccounts] = useState([])
  const [resultSummary, setResultSummary] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lastError, setLastError] = useState(null)
  const [focusedFailureLogs, setFocusedFailureLogs] = useState([])

  const allAccounts = useMemo(() => {
    const merged = [...accounts]
    for (const acc of pastedAccounts) {
      if (!merged.includes(acc)) merged.push(acc)
    }
    return merged
  }, [accounts, pastedAccounts])

  const pollingRef = useRef(null)
  const resultPollingRef = useRef(null)
  const fetchedResultsRef = useRef(null)
  const hydratedResultsRef = useRef(null)
  const retryStateRef = useRef({ attempted: false, lastPayload: null })

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    if (resultPollingRef.current) {
      clearInterval(resultPollingRef.current)
      resultPollingRef.current = null
    }
  }, [])

  const applyResultsPayload = useCallback((payload) => {
    const normalized = normalizeApuracaoResultsPayload(payload, accountMeta)
    setRows(normalized.rows)
    setResultColumns(normalized.columns)
    setAccountRuns(normalized.accountRuns)
    setFailedAccounts(normalized.failedAccounts)
    setResultSummary(normalized.summary)
    return normalized
  }, [accountMeta])

  const loadCurrentResults = useCallback(async () => {
    if (!hubxp.jobId) return null
    const payload = await getHubxpApuracaoBovespaResults(hubxp.jobId, hubxp.userKey)
    applyResultsPayload(payload)
    return payload
  }, [applyResultsPayload, hubxp.jobId, hubxp.userKey])

  const startPolling = useCallback((jobId) => {
    if (!jobId) return
    stopPolling()
    pollingRef.current = setInterval(() => {
      void hubxp.syncStatus(jobId, { silent: true })
    }, 1200)
    // Poll incremental results every 3s while collecting
    resultPollingRef.current = setInterval(() => {
      if (!hubxp.jobId) return
      getHubxpApuracaoBovespaResults(hubxp.jobId, hubxp.userKey)
        .then((payload) => {
          applyResultsPayload(payload)
        })
        .catch(() => null) // Ignorar erros de polling incremental
    }, 3000)
  }, [applyResultsPayload, hubxp, stopPolling])

  useEffect(() => () => stopPolling(), [stopPolling])

  useEffect(() => {
    if (!hubxp.jobId || !hubxp.job) return
    if (hubxp.job.status !== 'COLLECTING') return
    fetchedResultsRef.current = null
    hydratedResultsRef.current = null
    if (!busy) setBusy(true)
    if (!pollingRef.current || !resultPollingRef.current) {
      startPolling(hubxp.jobId)
    }
    void loadCurrentResults().catch(() => null)
  }, [busy, hubxp.job, hubxp.jobId, loadCurrentResults, startPolling])

  useEffect(() => {
    if (!hubxp.jobId) return
    if (busy) return
    const statusToken = String(hubxp.job?.status || '').trim().toUpperCase()
    if (statusToken !== 'SUCCESS' && statusToken !== 'FAILED') return
    const hydrationKey = `${hubxp.jobId}|${statusToken}|${Object.keys(accountMeta).length}`
    if (hydratedResultsRef.current === hydrationKey) return
    hydratedResultsRef.current = hydrationKey
    void loadCurrentResults().catch(() => {
      hydratedResultsRef.current = null
    })
  }, [accountMeta, busy, hubxp.job?.status, hubxp.jobId, loadCurrentResults])

  const status = hubxp.job?.status || (hubxp.jobId ? 'CREATED' : 'DISCONNECTED')
  const statusLabel = STATUS_LABEL[status] || status
  const progress = hubxp.job?.progress || {}
  const progressMsg = progress.message || (hubxp.isAuthenticated ? 'Sessao pronta.' : 'Conecte a sessao HubXP no topo.')
  const totalSteps = Number.isFinite(Number(progress.totalPages)) ? Number(progress.totalPages) : null
  const currentStep = Number.isFinite(Number(progress.currentPage)) ? Number(progress.currentPage) : 0
  const processed = Number.isFinite(Number(progress.rowsCollected)) ? Number(progress.rowsCollected) : 0
  const accountsProcessed = Number.isFinite(Number(progress.accountsProcessed)) ? Number(progress.accountsProcessed) : 0
  const accountsFailed = Number.isFinite(Number(progress.accountsFailed)) ? Number(progress.accountsFailed) : 0
  const accountsTotal = Number.isFinite(Number(progress.accountsTotal)) ? Number(progress.accountsTotal) : allAccounts.length

  const panelBusy = busy || hubxp.busy

  const logEntries = useMemo(
    () => (Array.isArray(hubxp.job?.logs) ? [...hubxp.job.logs] : []),
    [hubxp.job?.logs],
  )
  const terminalLogLines = useMemo(
    () => logEntries.slice(-240).map((entry) => formatLogLine(entry)),
    [logEntries],
  )
  const runAnalysis = useMemo(() => analyzeAccountRuns(accountRuns), [accountRuns])

  useEffect(() => {
    if (!hubxp.jobId) return
    if (!busy) return
    if (!hubxp.job) return
    const terminal = hubxp.job.status === 'SUCCESS' || hubxp.job.status === 'FAILED'
    if (!terminal) return
    const terminalKey = [
      hubxp.jobId,
      hubxp.job.status,
      hubxp.job.progress?.finishedAt || '',
      hubxp.job.error?.code || '',
      hubxp.job.error?.message || '',
    ].join('|')
    if (fetchedResultsRef.current === terminalKey) return
    fetchedResultsRef.current = terminalKey

    const canAutoRetry = (
      hubxp.job.status === 'FAILED'
      && !retryStateRef.current.attempted
      && Boolean(retryStateRef.current.lastPayload)
      && isRetryableFailure(hubxp.job)
    )

    if (canAutoRetry) {
      retryStateRef.current.attempted = true
      notify('Falha inicial de navegacao/distribuicao detectada. Executando retry automatico (1/1)...', 'warning')
      void (async () => {
        try {
          const authPayload = await hubxp.startSession({ headless: true })
          if (authPayload?.job) hubxp.setJob(authPayload.job)
          const retryPayload = retryStateRef.current.lastPayload
          if (!retryPayload) {
            throw new Error('Payload do retry nao disponivel.')
          }
          const fetchPayload = await fetchHubxpApuracaoBovespa(retryPayload)
          if (fetchPayload?.job) hubxp.setJob(fetchPayload.job)
          fetchedResultsRef.current = null
          startPolling(hubxp.jobId)
        } catch (retryError) {
          setLastError(retryError)
          setFocusedFailureLogs(buildFocusedFailureLogs(logEntries))
          notify(retryError?.message || 'Retry automatico falhou.', 'warning')
          setBusy(false)
          stopPolling()
        }
      })()
      return
    }

    getHubxpApuracaoBovespaResults(hubxp.jobId, hubxp.userKey)
      .then((payload) => {
        const normalized = applyResultsPayload(payload)
        const analysis = analyzeAccountRuns(normalized.accountRuns)
        const failMsg = hubxp.job.error?.message || hubxp.job.progress?.message || 'Concluido com falhas.'
        if (hubxp.job.status === 'FAILED') {
          setFocusedFailureLogs(buildFocusedFailureLogs(logEntries))
        } else {
          setFocusedFailureLogs([])
        }

        const failedCount = normalized.failedAccounts.length
        if (hubxp.job.status === 'SUCCESS' && failedCount === 0 && analysis.duplicateCount === 0) {
          setLastError(null)
          notify(`Apuracao concluida: ${normalized.rows.length} notas carregadas.`, 'success')
          return
        }
        const warnings = []
        if (failedCount > 0) warnings.push(`${failedCount} conta(s) com erro tecnico.`)
        if (analysis.duplicateCount > 0) {
          warnings.push(`Execucao inconsistente: ${analysis.duplicateCount} duplicidade(s) em accountRuns.`)
        }
        if (hubxp.job.status === 'FAILED') warnings.push(failMsg)
        const warningText = warnings.join(' ')
        const finalText = `Concluido com falhas: ${normalized.rows.length} notas. ${warningText}`.trim()
        notify(finalText, 'warning')
        setLastError(new Error(finalText))
      })
      .catch((error) => {
        setLastError(error)
        if (hubxp.job?.status === 'FAILED') {
          setFocusedFailureLogs(buildFocusedFailureLogs(logEntries))
        }
        notify(error?.message || 'Falha ao carregar resultados.', 'warning')
      })
      .finally(() => {
        setBusy(false)
        stopPolling()
      })
  }, [applyResultsPayload, busy, hubxp, hubxp.job, hubxp.jobId, logEntries, notify, startPolling, stopPolling])

  const handleRun = useCallback(async () => {
    if (panelBusy) return

    if (!hubxp.jobId) {
      notify('Conecte o HubXP no topo (botao HubXP).', 'warning')
      return
    }

    if (!hubxp.isAuthenticated) {
      notify('Sessao HubXP nao autenticada. Clique em HubXP no topo e faca login.', 'warning')
      return
    }

    if (!allAccounts.length) {
      notify('Adicione contas via Excel ou cole no campo de texto antes de executar.', 'warning')
      return
    }

    setBusy(true)
    setLastError(null)
    setFocusedFailureLogs([])
    fetchedResultsRef.current = null
    hydratedResultsRef.current = null
    retryStateRef.current = { attempted: false, lastPayload: null }
    setRows([])
    setCorretagemOverrides({})
    setResultColumns(DEFAULT_APURACAO_RESULT_COLUMNS)
    setAccountRuns([])
    setFailedAccounts([])
    setResultSummary(null)

    try {
      const desiredConcurrency = isDesktopRuntime
        ? Math.min(DESKTOP_BROWSER_WORKERS, allAccounts.length || DESKTOP_BROWSER_WORKERS)
        : 1
      const requestPayload = {
        userKey: hubxp.userKey,
        jobId: hubxp.jobId,
        accounts: allAccounts,
        filters,
        accountMeta,
        concurrency: desiredConcurrency,
        reuseSinglePage: !isDesktopRuntime,
        perNoteRetries: isDesktopRuntime ? 2 : 1,
        preferPdfBytes: false,
        tableFallbackOnPdfError: true,
        tableFastPath: false,
        strictCompletion: true,
        adaptiveRateLimit: true,
        strictWorkerDistribution: false,
      }
      retryStateRef.current = { attempted: false, lastPayload: requestPayload }
      const payload = await fetchHubxpApuracaoBovespa(requestPayload)
      if (payload?.job) hubxp.setJob(payload.job)
      startPolling(hubxp.jobId)
    } catch (error) {
      setLastError(error)
      notify(error?.message || 'Falha ao iniciar apuracao.', 'warning')
      setBusy(false)
    }
  }, [allAccounts, accountMeta, filters, hubxp, notify, panelBusy, startPolling])

  const tableColumns = useMemo(() => {
    return normalizeApuracaoResultColumns(resultColumns).map((key) => {
      if (key === 'taxaOperacionalAjustada') {
        return {
          key,
          label: APURACAO_COLUMN_LABELS[key] || key,
          render: (row) => (
            row.taxaOperacionalAjustada != null
              ? <span className="text-negative">{formatBRL(row.taxaOperacionalAjustada)}</span>
              : '-'
          ),
        }
      }
      if (APURACAO_MONEY_COLUMNS.has(key)) {
        return {
          key,
          label: APURACAO_COLUMN_LABELS[key] || key,
          render: (row) => formatBRL(row[key]),
        }
      }
      if (key === 'pdfScanned') {
        return {
          key,
          label: APURACAO_COLUMN_LABELS[key] || key,
          render: (row) => (row[key] ? 'Sim' : 'Nao'),
        }
      }
      return {
        key,
        label: APURACAO_COLUMN_LABELS[key] || key,
      }
    })
  }, [resultColumns])

  const handleAbort = useCallback(async () => {
    if (!hubxp.jobId) return
    try {
      const payload = await abortHubxpApuracaoBovespa(hubxp.jobId, hubxp.userKey)
      if (payload?.job) hubxp.setJob(payload.job)
      notify('Interrupcao solicitada. Aguardando encerramento dos browsers...', 'warning')
      startPolling(hubxp.jobId)
    } catch (error) {
      notify(error?.message || 'Falha ao interromper processo.', 'warning')
      stopPolling()
      setBusy(false)
    }
  }, [hubxp, notify, startPolling, stopPolling])

  const handleExportToManual = useCallback(() => {
    if (!rows.length) {
      notify('Nenhuma nota para exportar.', 'warning')
      return
    }
    const timestamp = Date.now()
    const entriesToExport = []
    rows.forEach((row, index) => {
      const valor = toPositiveMoney(row.taxaOperacionalAjustada) ?? toPositiveMoney(row.taxaOperacional)
      if (valor == null || valor === 0) return
      const origem = resolveRevenueOrigin(row)
      const dataRef = String(row.data || '').slice(0, 10) || filters.dateFrom
      entriesToExport.push({
        id: `bov-${timestamp}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        data: dataRef,
        dataEntrada: dataRef,
        origem,
        tipoCorretagem: 'variavel',
        codigoCliente: String(row.conta || '').trim(),
        conta: String(row.conta || '').trim(),
        cliente: String(row.conta || row.cliente || '').trim(),
        assessor: String(row.tag || '').trim() || 'Sem assessor',
        broker: String(row.broker || '').trim(),
        ativo: '',
        corretagem: Number(valor.toFixed(6)),
        receita: Number(valor.toFixed(6)),
        valor: Number(valor.toFixed(6)),
        source: 'apuracao_bovespa',
        importKey: buildManualImportKey(row, origem, valor),
        createdAt: timestamp,
      })
    })

    if (!entriesToExport.length) {
      notify('Nenhum lancamento com valor valido para exportar.', 'warning')
      return
    }

    const { addedCount, skippedCount } = appendManualRevenueBatch(entriesToExport, { dedupeByImportKey: true })

    if (addedCount > 0) {
      const duplicateNote = skippedCount > 0 ? ` ${skippedCount} duplicado(s) ignorado(s).` : ''
      notify(`${addedCount} lancamento(s) exportado(s) para Receita Manual.${duplicateNote}`, 'success')
      return
    }

    if (skippedCount > 0) {
      notify('Todas as notas desta exportacao ja estavam salvas.', 'warning')
    } else {
      notify('Nenhum lancamento com valor valido para exportar.', 'warning')
    }
  }, [rows, filters.dateFrom, notify])

  const corretagemRows = useMemo(() => rows.map((row) => {
    const corretagemXP = toPositiveMoney(row.taxaOperacional)
    const esperada = toPositiveMoney(row.taxaOperacionalAjustada)
    const temAjuste = row.taxaOperacionalAjusteDivergente === true && esperada != null
    const consideradaCalc = temAjuste ? esperada : corretagemXP
    const considerada = corretagemOverrides[row.id] != null ? corretagemOverrides[row.id] : consideradaCalc
    return { row, corretagemXP, esperada, temAjuste, considerada }
  }), [rows, corretagemOverrides])

  const handleSubirReceita = useCallback(() => {
    if (!corretagemRows.length) {
      notify('Nenhuma nota para subir.', 'warning')
      return
    }
    const timestamp = Date.now()
    const entriesToImport = []
    corretagemRows.forEach(({ row, considerada }, index) => {
      if (considerada == null || considerada === 0) return
      const origem = resolveRevenueOrigin(row)
      const dataRef = String(row.data || '').slice(0, 10) || filters.dateFrom
      entriesToImport.push({
        id: `bov-corr-${timestamp}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        data: dataRef,
        dataEntrada: dataRef,
        origem,
        tipoCorretagem: 'variavel',
        codigoCliente: String(row.conta || '').trim(),
        conta: String(row.conta || '').trim(),
        cliente: String(row.conta || row.cliente || '').trim(),
        assessor: String(row.tag || '').trim() || 'Sem assessor',
        broker: String(row.broker || '').trim(),
        ativo: '',
        corretagem: Number(considerada.toFixed(6)),
        receita: Number(considerada.toFixed(6)),
        valor: Number(considerada.toFixed(6)),
        source: 'apuracao_bovespa',
        importKey: buildCorretagemImportKey(row, origem),
        createdAt: timestamp,
      })
    })

    if (!entriesToImport.length) {
      notify('Nenhum lancamento com valor valido para subir.', 'warning')
      return
    }

    const { addedCount, skippedCount, replacedCount } = appendManualRevenueBatch(entriesToImport, {
      dedupeByImportKey: true,
      replaceOnImportKey: true,
    })

    const parts = []
    if (addedCount > 0) parts.push(`${addedCount} novo(s)`)
    if (replacedCount > 0) parts.push(`${replacedCount} atualizado(s)`)
    if (skippedCount > 0) parts.push(`${skippedCount} ignorado(s)`)

    if (addedCount > 0 || replacedCount > 0) {
      notify(`Receita subida: ${parts.join(', ')}.`, 'success')
    } else {
      notify('Nenhuma alteracao: todos os registros ja estavam identicos.', 'warning')
    }
  }, [corretagemRows, filters.dateFrom, notify])

  const handleExportExcel = useCallback(async () => {
    if (!rows.length) return
    const XLSX = await loadXlsx()
    const headers = tableColumns.map((c) => c.label || c.key)
    const keys = tableColumns.map((c) => c.key)
    const numericKeys = APURACAO_MONEY_COLUMNS
    const taxaAjustadaColumn = keys.indexOf('taxaOperacionalAjustada')
    const data = rows.map((row) => keys.map((key) => {
      if (numericKeys.has(key)) {
        const val = toPositiveMoney(row[key])
        if (val == null) return null
        return roundMoney(val)
      }
      const val = row[key]
      return val != null ? String(val) : ''
    }))

    const ws = XLSX.utils.aoa_to_sheet([headers, ...data])
    for (let rowIndex = 0; rowIndex < data.length; rowIndex += 1) {
      for (let colIndex = 0; colIndex < keys.length; colIndex += 1) {
        if (!numericKeys.has(keys[colIndex])) continue
        const value = data[rowIndex][colIndex]
        if (typeof value !== 'number') continue
        const ref = XLSX.utils.encode_cell({ r: rowIndex + 1, c: colIndex })
        const cell = ws[ref]
        if (!cell) continue
        cell.t = 'n'
        cell.z = '#,##0.00'
      }

      if (taxaAjustadaColumn >= 0 && typeof data[rowIndex][taxaAjustadaColumn] === 'number') {
        const ref = XLSX.utils.encode_cell({ r: rowIndex + 1, c: taxaAjustadaColumn })
        const cell = ws[ref]
        if (!cell) continue
        cell.s = {
          ...(cell.s || {}),
          font: {
            ...((cell.s && cell.s.font) || {}),
            color: { rgb: 'FFFF0000' },
          },
        }
      }
    }

    const printableCell = (value) => {
      if (value == null) return ''
      if (typeof value === 'number') return formatBRL(value)
      return String(value)
    }
    ws['!cols'] = headers.map((h, i) => {
      const maxLen = Math.max(h.length, ...data.map((r) => printableCell(r[i]).length))
      return { wch: Math.min(maxLen + 2, 50) }
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Apuracao Bovespa')
    const dateLabel = filters.dateFrom === filters.dateTo ? filters.dateFrom : `${filters.dateFrom}_a_${filters.dateTo}`
    XLSX.writeFile(wb, `Apuracao_Bovespa_${dateLabel}.xlsx`)
    notify('Arquivo Excel exportado com sucesso.', 'success')
  }, [filters.dateFrom, filters.dateTo, notify, rows, tableColumns])

  return (
    <div className="page">
      <PageHeader
        title="Apuracao Bovespa (HubXP)"
        subtitle="Extrai dados das Notas de Negociacao (Valor das operacoes e Taxa Operacional)."
        meta={[
          { label: 'Status', value: statusLabel },
          { label: 'Contas', value: allAccounts.length },
          { label: 'Notas', value: rows.length },
          { label: 'Progresso', value: totalSteps ? `${currentStep}/${totalSteps}` : '-' },
        ]}
        actions={[
          {
            label: panelBusy ? 'Processando...' : 'Extrair Apuracao Bovespa',
            icon: 'sync',
            onClick: handleRun,
            disabled: panelBusy,
          },
          ...(panelBusy ? [{
            label: 'Interromper',
            icon: 'x',
            onClick: handleAbort,
            variant: 'btn-danger',
          }] : []),
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Parametros</h3>
            <p className="muted">Selecione o periodo e informe as contas via Excel ou colando no campo de texto.</p>
          </div>
        </div>

        <div className="form-grid hubxp-form-grid">
          <label>
            Data inicial
            <input
              className="input"
              type="date"
              value={filters.dateFrom}
              onChange={(event) => setFilters((prev) => ({ ...prev, dateFrom: event.target.value }))}
              disabled={panelBusy}
            />
          </label>
          <label>
            Data final
            <input
              className="input"
              type="date"
              value={filters.dateTo}
              onChange={(event) => setFilters((prev) => ({ ...prev, dateTo: event.target.value }))}
              disabled={panelBusy}
            />
          </label>
          <label>
            Excel com contas
            <input
              className="input"
              type="file"
              accept=".xlsx,.xls"
              disabled={panelBusy}
              onChange={(event) => {
                const file = event.target.files?.[0] || null
                if (!file) return
                setFileInfo({ name: file.name, count: 0 })
                void parseAccountsFromFile(file)
                  .then((result) => {
                    setAccounts(result.accounts)
                    setAccountMeta(result.accountMeta)
                    setFileInfo({ name: file.name, count: result.accounts.length })
                    notify(`Contas carregadas: ${result.accounts.length}`, result.accounts.length ? 'success' : 'warning')
                  })
                  .catch((err) => {
                    setAccounts([])
                    setAccountMeta({})
                    setFileInfo({ name: file.name, count: 0 })
                    notify(err?.message ? `Falha ao ler Excel: ${err.message}` : 'Falha ao ler Excel.', 'warning')
                  })
              }}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 6, margin: '10px 0 4px' }}>
          {['hoje', 'este_mes', 'mes_anterior'].map((preset) => {
            const labels = { hoje: 'Hoje', este_mes: 'Este mes', mes_anterior: 'Mes anterior' }
            return (
              <button
                key={preset}
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '2px 10px' }}
                disabled={panelBusy}
                onClick={() => {
                  const range = getPeriodPreset(preset)
                  if (range) setFilters(range)
                }}
              >
                {labels[preset]}
              </button>
            )
          })}
        </div>

        {fileInfo.name ? (
          <div className="muted" style={{ marginTop: 6 }}>
            Arquivo: <strong>{fileInfo.name}</strong> ({fileInfo.count} contas)
          </div>
        ) : null}

        <label style={{ display: 'block', marginTop: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Colar contas</span>
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            (uma por linha, virgula ou ponto e virgula — combina com o arquivo)
          </span>
          <textarea
            className="input"
            rows={4}
            placeholder={'12345\n67890\n11223'}
            disabled={panelBusy}
            value={pastedText}
            style={{ display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace', resize: 'vertical' }}
            onChange={(event) => {
              const text = event.target.value
              setPastedText(text)
              const parsed = parseAccountsFromText(text)
              setPastedAccounts(parsed)
            }}
          />
          {pastedAccounts.length > 0 ? (
            <span className="muted" style={{ fontSize: 12 }}>
              {pastedAccounts.length} conta(s) reconhecida(s) no texto
            </span>
          ) : null}
        </label>

        {allAccounts.length > 0 && (accounts.length > 0 || pastedAccounts.length > 0) ? (
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            Total combinado: <strong>{allAccounts.length}</strong> conta(s)
            {accounts.length > 0 && pastedAccounts.length > 0
              ? ` (${accounts.length} do arquivo + ${pastedAccounts.length} coladas)`
              : null}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Progresso</h3>
            <p className="muted">{progressMsg}</p>
          </div>
        </div>

        <div className={`progress-bar ${panelBusy && !totalSteps ? 'indeterminate' : ''}`}>
          <span style={{ width: totalSteps ? `${Math.min(100, Math.max(0, (currentStep / totalSteps) * 100))}%` : (panelBusy ? '35%' : '0%') }} />
        </div>

        <div className="sync-result hubxp-sync-grid">
          <div>
            <strong>{accountsTotal ? `${accountsProcessed}/${accountsTotal}` : (accountsProcessed || '-')}</strong>
            <span className="muted">Contas processadas</span>
          </div>
          <div>
            <strong>{accountsFailed || 0}</strong>
            <span className="muted">Contas com falha</span>
          </div>
          <div>
            <strong>{currentStep || '-'}</strong>
            <span className="muted">Conta atual</span>
          </div>
          <div>
            <strong>{processed || 0}</strong>
            <span className="muted">Notas processadas</span>
          </div>
          <div>
            <strong>{hubxp.jobId || '-'}</strong>
            <span className="muted">Job ID</span>
          </div>
          <div>
            <strong>{runAnalysis.workersUsed || 0}</strong>
            <span className="muted">Workers utilizados</span>
          </div>
          <div>
            <strong>{runAnalysis.duplicateCount || 0}</strong>
            <span className="muted">Duplicatas detectadas</span>
          </div>
        </div>

        {lastError ? (
          <div className="sync-warnings">
            <strong>ERRO</strong>
            {lastError.message || 'Falha inesperada.'}
          </div>
        ) : null}

        {failedAccounts.length ? (
          <div className="sync-warnings" style={{ marginTop: 10 }}>
            <strong>CONTAS COM FALHA ({failedAccounts.length})</strong>
            <div style={{ marginTop: 6 }}>
              {failedAccounts.slice(0, 12).map((item, idx) => (
                <div key={`${item.account || item.conta || idx}`} className="muted">
                  {(item.account || item.conta || '-')} - {item.errorCode || 'FALHA_TECNICA'}{item.errorMessage ? `: ${item.errorMessage}` : ''}
                </div>
              ))}
              {failedAccounts.length > 12 ? (
                <div className="muted">... e mais {failedAccounts.length - 12} conta(s).</div>
              ) : null}
            </div>
          </div>
        ) : null}

        {runAnalysis.duplicateCount > 0 ? (
          <div className="sync-warnings" style={{ marginTop: 10 }}>
            <strong>EXECUCAO INCONSISTENTE</strong>
            <div className="muted" style={{ marginTop: 6 }}>
              Duplicatas detectadas em accountRuns: {runAnalysis.duplicateCount}
            </div>
            {runAnalysis.duplicateAccounts.length ? (
              <div className="muted">Contas repetidas: {runAnalysis.duplicateAccounts.join(', ')}</div>
            ) : null}
            {runAnalysis.multiWorkerAccounts.length ? (
              <div className="muted">Contas em workers diferentes: {runAnalysis.multiWorkerAccounts.join(', ')}</div>
            ) : null}
          </div>
        ) : null}

        <div className="hubxp-log-terminal-wrap">
          <div className="hubxp-log-terminal-head">
            <strong>Terminal do processo</strong>
          </div>
          <pre className="hubxp-log-terminal">
            {terminalLogLines.length ? terminalLogLines.join('\n') : 'Aguardando logs do processo...'}
          </pre>
        </div>

        {focusedFailureLogs.length ? (
          <div className="sync-warnings" style={{ marginTop: 10 }}>
            <strong>DIAGNOSTICO (notas_nav/notas_filter/ui_reset/pdf)</strong>
            <pre className="hubxp-log-terminal" style={{ marginTop: 8, maxHeight: 220 }}>
              {focusedFailureLogs.join('\n')}
            </pre>
          </div>
        ) : null}

      </section>

      {corretagemRows.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Corretagem para Receita</h3>
              <p className="muted">
                Relatório XP é soberano. Quando veio maior que o esperado, o valor ajustado é usado.
                Edite a coluna &ldquo;Considerada&rdquo; se necessário antes de subir.
              </p>
            </div>
            <div className="panel-actions">
              <button className="btn btn-primary" type="button" onClick={handleSubirReceita}>
                <Icon name="upload" size={16} />
                Subir Receita
              </button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Conta</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Tag</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Data</th>
                  <th style={{ textAlign: 'right', padding: '6px 10px', fontWeight: 600 }}>Corretagem XP</th>
                  <th style={{ textAlign: 'right', padding: '6px 10px', fontWeight: 600 }}>Ajuste (Esperada)</th>
                  <th style={{ textAlign: 'right', padding: '6px 10px', fontWeight: 600 }}>Considerada</th>
                </tr>
              </thead>
              <tbody>
                {corretagemRows.map(({ row, corretagemXP, esperada, temAjuste, considerada }) => (
                  <tr
                    key={row.id}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      background: temAjuste ? 'rgba(255,80,80,0.06)' : undefined,
                    }}
                  >
                    <td style={{ padding: '5px 10px' }}>{row.conta}</td>
                    <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{row.tag || '-'}</td>
                    <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{row.data || '-'}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right' }}>{corretagemXP != null ? formatBRL(corretagemXP) : '-'}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--negative, #e53e3e)' }}>
                      {temAjuste && esperada != null ? formatBRL(esperada) : '-'}
                    </td>
                    <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={corretagemOverrides[row.id] != null ? corretagemOverrides[row.id] : (considerada ?? '')}
                        onChange={(e) => {
                          const val = e.target.value === '' ? undefined : Number(e.target.value)
                          setCorretagemOverrides((prev) => {
                            const next = { ...prev }
                            if (val == null) delete next[row.id]
                            else next[row.id] = val
                            return next
                          })
                        }}
                        style={{
                          width: 110,
                          textAlign: 'right',
                          padding: '3px 6px',
                          borderRadius: 4,
                          border: '1px solid var(--border)',
                          background: 'var(--input-bg, var(--surface))',
                          color: 'var(--text)',
                          fontSize: 13,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Resultados</h3>
            <p className="muted">
              {rows.length
                ? `${rows.length} notas carregadas.${failedAccounts.length ? ` ${failedAccounts.length} conta(s) com falha.` : ''}`
                : 'Nenhum resultado ainda.'}
              {resultSummary ? ` (Contas processadas: ${resultSummary.accountsProcessed || 0}/${resultSummary.accountsTotal || 0})` : ''}
              {accountRuns.length ? ` (Runs: ${accountRuns.length})` : ''}
              {accountRuns.length ? ` (Workers: ${runAnalysis.workersUsed || 0})` : ''}
              {runAnalysis.duplicateCount > 0 ? ` (Duplicatas: ${runAnalysis.duplicateCount})` : ''}
            </p>
          </div>
          {rows.length ? (
            <div className="panel-actions">
              <button className="btn btn-primary" type="button" onClick={handleExportToManual}>
                <Icon name="upload" size={16} />
                Enviar para Receita Manual
              </button>
              <button className="btn btn-secondary" type="button" onClick={handleExportExcel}>
                <Icon name="download" size={16} />
                Exportar Excel
              </button>
            </div>
          ) : null}
        </div>

        <DataTable
          columns={tableColumns}
          rows={rows}
          emptyMessage="Nenhuma nota processada ainda."
        />
      </section>
    </div>
  )
}

export default ApuracaoBovespa
