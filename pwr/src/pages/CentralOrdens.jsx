import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadXlsx } from '../services/xlsxLoader'
import PageHeader from '../components/PageHeader'
import DataTable from '../components/DataTable'
import MultiSelect from '../components/MultiSelect'
import PieChart from '../components/PieChart'
import Icon from '../components/Icons'
import { copyCardImageToClipboard } from '../services/cardExport'
import {
  fetchHubxpOrders,
  getHubxpResults,
} from '../services/hubxpOrders'
import { appendManualRevenueBatch } from '../services/revenueStore'
import { enrichRow } from '../services/tags'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { useToast } from '../hooks/useToast'
import { useHubxp } from '../contexts/HubxpContext'

const getToday = () => {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const STATUS_LABEL = {
  CREATED: 'Pronto para iniciar',
  STARTING: 'Autenticando',
  OTP_REQUIRED: 'Aguardando OTP',
  AUTHENTICATED: 'Autenticado',
  COLLECTING: 'Coletando ordens',
  SUCCESS: 'Coleta concluida',
  FAILED: 'Falha',
  CLEANED: 'Sessao encerrada',
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

const normalizeErrorInfo = (error) => {
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : 'Falha ao executar operacao na Central de Ordens.'

  return {
    message,
    code: error?.code || null,
    stage: error?.stage || error?.payload?.error?.stage || error?.payload?.job?.stage || null,
  }
}

const buildMultiOptions = (values) => {
  const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return unique.map((value) => ({ value, label: value }))
}

const sortUniqueTextValues = (values) => Array.from(
  new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ),
).sort((a, b) => a.localeCompare(b, 'pt-BR'))

const isSameTextSet = (left, right) => {
  const leftList = sortUniqueTextValues(left)
  const rightList = sortUniqueTextValues(right)
  if (leftList.length !== rightList.length) return false
  for (let i = 0; i < leftList.length; i += 1) {
    if (leftList[i] !== rightList[i]) return false
  }
  return true
}

const parseROA = (value) => {
  if (value == null || value === '') return 0
  const cleaned = String(value).replace(/R\$\s*/i, '').replace(/\./g, '').replace(',', '.').trim()
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : 0
}

const formatRevenueCurrency = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return 'R$ 0,00'
  return `R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const formatRevenueExcelValue = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

const parseSortableNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw
    .replace(/R\$\s*/ig, '')
    .replace(/\s+/g, '')
    .replace(/[^0-9,.-]/g, '')
  if (!cleaned || /^[-.,]+$/.test(cleaned)) return null
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

// Busca valor em row por substring case-insensitive no nome da chave
const findRowValue = (row, ...patterns) => {
  if (!row) return undefined
  for (const pat of patterns) {
    // Tentar acesso direto primeiro
    if (row[pat] !== undefined) return row[pat]
  }
  // Busca fuzzy por substring
  const keys = Object.keys(row)
  for (const pat of patterns) {
    const lower = pat.toLowerCase()
    for (const key of keys) {
      if (key.toLowerCase().includes(lower)) return row[key]
    }
  }
  return undefined
}

// Verifica se o status e "aprovado" usando match parcial
const isApprovedStatus = (raw) => {
  const s = String(raw || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (!s) return false
  // Padroes de status aprovados
  if (/pendente.*registro/.test(s)) return true
  if (/pendente.*execu/.test(s)) return true
  if (/totalmente.*execut/.test(s)) return true
  if (/^execut(ad[oa])?$/.test(s)) return true
  return false
}

const isCancelledStatus = (raw) => {
  const s = String(raw || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return /cancelad/.test(s) || /cancel/.test(s)
}

const normalizeTextKey = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

const normalizeFieldToken = (value) => normalizeTextKey(value).replace(/[^a-z0-9]/g, '')

const isReceitaBrutaField = (value) => {
  const token = normalizeFieldToken(value)
  return token === 'receitabruta' || token === 'receitabrutatotal'
}

const isNomeClienteField = (value) => normalizeFieldToken(value) === 'nomecliente'
const isContaField = (value) => {
  const token = normalizeFieldToken(value)
  return token === 'cliente' || token === 'conta' || token === 'codigocliente' || token === 'codigodocliente'
}

const isReceitaBrutaColumn = (column) => {
  if (!column) return false
  return isReceitaBrutaField(column.key) || isReceitaBrutaField(column.label)
}

const normalizeDateValue = (value) => {
  if (!value) return ''
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  const raw = String(value).trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const isoWithTime = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/)
  if (isoWithTime) return `${isoWithTime[1]}-${isoWithTime[2]}-${isoWithTime[3]}`
  const br = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/)
  if (br) return `${br[3]}-${br[2]}-${br[1]}`
  return ''
}

const resolveOrderDate = (row, fallbackDate) => {
  const rawDate = findRowValue(
    row,
    'Data',
    'Data da ordem',
    'Data da operacao',
    'Data de criacao',
    'Criado em',
    'Data de execucao',
  )
  return normalizeDateValue(rawDate) || normalizeDateValue(fallbackDate) || getToday()
}

const resolveOrderOrigin = (row) => {
  const tipoOperacao = normalizeTextKey(findRowValue(row, 'Tipo de operação', 'Tipo de operacao', 'tipoOperacao'))
  if (tipoOperacao.includes('bmf')) return 'BMF'
  if (tipoOperacao.includes('bovespa')) return 'Bovespa'
  if (tipoOperacao.includes('estrutur')) return 'Estruturadas'
  return 'Estruturadas'
}

const buildCentralOrderImportKey = (row, { date, value, conta, ativo, origem }) => {
  const orderCode = String(
    findRowValue(
      row,
      'Número da ordem',
      'Numero da ordem',
      'Nº da ordem',
      'No da ordem',
      'Order ID',
      'Id da ordem',
      'Id ordem',
    ) || '',
  ).trim()
  const type = String(findRowValue(row, 'Tipo de operação', 'Tipo de operacao', 'tipoOperacao') || '').trim()
  const valueKey = Number.isFinite(Number(value)) ? Number(value).toFixed(6) : '0.000000'
  return [
    'central-ordens',
    date || '',
    normalizeTextKey(origem),
    normalizeTextKey(orderCode),
    normalizeTextKey(conta),
    normalizeTextKey(ativo),
    normalizeTextKey(type),
    valueKey,
  ].join('|')
}

const mapApprovedOrderToManualEntry = (row, { fallbackDate, createdAt }) => {
  const statusRaw = String(findRowValue(row, 'Status', 'status') || '').trim()
  if (!isApprovedStatus(statusRaw)) return null

  const revenue = parseROA(findRowValue(row, 'ROA All', 'ROA', 'roa', 'roa_all', 'ROA_All', 'Receita'))
  if (!Number.isFinite(revenue) || revenue === 0) return null

  const date = resolveOrderDate(row, fallbackDate)
  const conta = String(findRowValue(row, 'Cliente', 'Conta', 'codigoCliente', 'Código Cliente', 'Codigo Cliente') || row?.codigoCliente || '').trim()
  const cliente = conta || String(findRowValue(row, 'Cliente') || '').trim()
  const assessor = String(findRowValue(row, 'Assessor', 'assessor') || row?.assessor || '').trim() || 'Sem assessor'
  const broker = String(findRowValue(row, 'Broker', 'broker') || row?.broker || '').trim()
  const ativo = String(findRowValue(row, 'Ativo', 'ativo') || row?.Ativo || row?.ativo || '').trim()
  const origem = resolveOrderOrigin(row)
  const numericRevenue = Number(revenue.toFixed(6))
  const importKey = buildCentralOrderImportKey(row, {
    date,
    value: numericRevenue,
    conta,
    ativo,
    origem,
  })

  return {
    id: `mn-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    data: date,
    dataEntrada: date,
    origem,
    tipoCorretagem: 'variavel',
    codigoCliente: conta,
    conta,
    cliente: cliente || conta || 'Sem conta',
    assessor,
    broker,
    ativo,
    corretagem: numericRevenue,
    receita: numericRevenue,
    valor: numericRevenue,
    source: 'manual',
    sourceDetail: 'central-ordens',
    importKey,
    createdAt,
  }
}

const CentralOrdens = () => {
  const { notify } = useToast()
  const hubxp = useHubxp()
  const { tagsIndex } = useGlobalFilters()
  const today = useMemo(() => getToday(), [])

  const [filters, setFilters] = useState({
    dateFrom: today,
    dateTo: today,
    search: '',
    status: [],
    broker: [],
    assessor: [],
    cliente: [],
    ativo: [],
    estrutura: [],
    tipoOperacao: [],
  })
  const [sortBy, setSortBy] = useState('')
  const [sortDirection, setSortDirection] = useState('desc')

  const [rows, setRows] = useState([])
  const [columns, setColumns] = useState([])
  const [busy, setBusy] = useState(false)
  const [copyingChartKey, setCopyingChartKey] = useState('')
  const [lastError, setLastError] = useState(null)
  const job = hubxp.job

  const pollingRef = useRef(null)
  const pieChartRefs = useRef({})

  const setPieChartRef = useCallback((chartKey) => (node) => {
    if (!chartKey) return
    if (node) {
      pieChartRefs.current[chartKey] = node
      return
    }
    delete pieChartRefs.current[chartKey]
  }, [])

  const stopPolling = useCallback(() => {
    if (!pollingRef.current) return
    clearInterval(pollingRef.current)
    pollingRef.current = null
  }, [])

  const startPolling = useCallback((jobId) => {
    if (!jobId) return
    stopPolling()
    pollingRef.current = setInterval(() => {
      void hubxp.syncStatus(jobId, { silent: true })
    }, 1200)
  }, [hubxp, stopPolling])

  useEffect(() => () => stopPolling(), [stopPolling])

  // Quando coleta termina (SUCCESS ou FAILED), buscar resultados e liberar UI
  // waitingForCollectRef: true quando estamos esperando uma coleta terminar.
  // Previne race condition: quando runFetch seta busy=true, job.status ainda
  // pode ser SUCCESS da coleta anterior. Sem esta flag, o useEffect dispara
  // getHubxpResults prematuramente e busca dados vazios (ja limpos no servidor).
  const waitingForCollectRef = useRef(false)
  // isStartingCollectRef: true durante a janela entre setBusy(true) e hubxp.setJob(COLLECTING).
  // Impede o handler de FAILED disparar com status antigo quando iniciamos nova coleta.
  const isStartingCollectRef = useRef(false)
  useEffect(() => {
    if (!job?.id) return
    // So buscar resultados quando REALMENTE recebemos um novo SUCCESS
    // e estamos ESPERANDO por ele (waitingForCollectRef === true).
    if (job.status === 'SUCCESS' && busy && waitingForCollectRef.current) {
      waitingForCollectRef.current = false
      getHubxpResults(job.id, hubxp.userKey)
        .then((payload) => {
          if (!waitingForCollectRef.current) {
            // Nao houve nova coleta — podemos atualizar os dados
            setColumns(Array.isArray(payload?.columns) ? payload.columns : [])
            setRows(Array.isArray(payload?.rows) ? payload.rows : [])
            const totalRows = Number.isFinite(Number(payload?.totalRows)) ? Number(payload.totalRows) : 0
            notify(`Coleta concluida: ${totalRows} ordens carregadas.`, 'success')
          }
        })
        .catch((error) => {
          if (!waitingForCollectRef.current) {
            const info = normalizeErrorInfo(error)
            setLastError(info)
            notify(info.message, 'warning')
          }
        })
        .finally(() => {
          if (!waitingForCollectRef.current) {
            setBusy(false)
            stopPolling()
          }
        })
    }
    // Ignorar FAILED residual do job anterior durante a janela de inicializacao de nova coleta.
    // Sem essa guarda, setBusy(true) causa um render com busy=true + job.status=FAILED (antigo),
    // disparando este handler e revertendo o busy para false antes da nova coleta comecar.
    if (job.status === 'FAILED' && busy && !isStartingCollectRef.current) {
      waitingForCollectRef.current = false
      const msg = job.error?.message || job.progress?.message || 'Coleta falhou.'
      const errorPayload = { message: msg, code: job.error?.code || null, stage: job.error?.stage || null }
      queueMicrotask(() => {
        setBusy(false)
        stopPolling()
        setLastError(errorPayload)
        notify(msg, 'warning')
      })
    }
    // Marcar que estamos esperando quando o job transita para COLLECTING.
    // Isso HABILITA o fetch de resultados no proximo SUCCESS.
    if (job.status === 'COLLECTING' && busy) {
      isStartingCollectRef.current = false
      waitingForCollectRef.current = true
    }
  }, [job, busy, hubxp.userKey, notify, stopPolling])

  const runFetch = useCallback(async (jobId) => {
    if (!jobId) return
    // NAO setar waitingForCollectRef aqui — ele sera setado quando
    // o job transitar para COLLECTING (via polling ou resposta do fetch).
    // Isso evita que o useEffect dispare prematuramente com status SUCCESS antigo.
    waitingForCollectRef.current = false
    // Sinaliza janela de inicializacao para bloquear handler de FAILED residual.
    isStartingCollectRef.current = true
    setBusy(true)
    setLastError(null)
    // Limpar dados antigos imediatamente
    setRows([])
    setColumns([])

    try {
      // Dispara coleta em background (retorna imediato com status COLLECTING)
      const payload = await fetchHubxpOrders({ userKey: hubxp.userKey, jobId, filters })
      // Janela de inicializacao encerrada — COLLECTING ja foi confirmado pelo servidor
      isStartingCollectRef.current = false
      if (payload?.job) hubxp.setJob(payload.job)
      // Inicia polling — o syncStatus já atualiza o job state
      startPolling(jobId)
    } catch (error) {
      isStartingCollectRef.current = false
      const info = normalizeErrorInfo(error)
      setLastError(info)
      notify(info.message, 'warning')
      setBusy(false)
    }
  }, [filters, hubxp, notify, startPolling])

  const handleRefresh = useCallback(async () => {
    if (busy || hubxp.busy) return
    if (!hubxp.jobId) {
      notify('Conecte o HubXP no topo (botao HubXP).', 'warning')
      return
    }
    if (!hubxp.isAuthenticated) {
      notify('Sessao HubXP nao autenticada. Clique em HubXP no topo e faca login.', 'warning')
      return
    }
    await runFetch(hubxp.jobId)
  }, [busy, hubxp, notify, runFetch])

  const status = job?.status || 'CREATED'
  const statusLabel = STATUS_LABEL[status] || status

  const progress = job?.progress || {}
  const currentPage = Number.isFinite(Number(progress.currentPage)) ? Number(progress.currentPage) : 0
  const totalPages = Number.isFinite(Number(progress.totalPages)) ? Number(progress.totalPages) : null
  const rowsCollected = Number.isFinite(Number(progress.rowsCollected)) ? Number(progress.rowsCollected) : rows.length

  const progressPercent = totalPages && totalPages > 0
    ? Math.min(100, Math.max(0, (currentPage / totalPages) * 100))
    : (busy ? 35 : 0)

  const enrichedRows = useMemo(() => {
    return (rows || []).map((row, index) => {
      const base = {
        id: row?.id || `ordem-${index + 1}`,
        ...row,
      }
      // Map "Cliente" column to codigoCliente for tag lookup
      if (base.Cliente && !base.codigoCliente) base.codigoCliente = base.Cliente

      // Separar "Ativo e Estrutura" em colunas independentes
      const ativoEstrutura = base['Ativo e Estrutura'] || ''
      if (ativoEstrutura) {
        // Formato tipico: "BBAS3 Collar Ui", "BOVA11 Put Spread", "A1MD34 Doc Bidirecional"
        // O ativo e o primeiro token (ticker), o resto e a estrutura
        const parts = ativoEstrutura.trim().split(/\s+/)
        if (parts.length >= 2) {
          if (!base.Ativo) base.Ativo = parts[0]
          if (!base.Estrutura) base.Estrutura = parts.slice(1).join(' ')
        } else {
          if (!base.Ativo) base.Ativo = ativoEstrutura
          if (!base.Estrutura) base.Estrutura = ''
        }
        if (!base.ativo) base.ativo = base.Ativo
      }

      if (base['Tipo de operação'] || base['Tipo de operacao']) base.tipoOperacao = base['Tipo de operação'] || base['Tipo de operacao']
      const enriched = enrichRow(base, tagsIndex)
      // Garantir aliases em lowercase para filtragem (HubXP retorna headers capitalizados: "Broker", "Assessor", etc.)
      if (!enriched.broker && enriched.Broker) enriched.broker = enriched.Broker
      if (!enriched.assessor && enriched.Assessor) enriched.assessor = enriched.Assessor
      if (!enriched.status && enriched.Status) enriched.status = enriched.Status
      const receitaLiquida = parseROA(findRowValue(enriched, 'ROA All', 'ROA', 'roa', 'roa_all', 'ROA_All', 'Receita'))
      if (Number.isFinite(receitaLiquida)) {
        enriched.receitaBruta = Number((receitaLiquida * 2).toFixed(6))
      }
      return enriched
    })
  }, [rows, tagsIndex])

  const brokerFilterOptions = useMemo(() => buildMultiOptions(enrichedRows.map((r) => r.broker)), [enrichedRows])
  const assessorFilterOptions = useMemo(() => buildMultiOptions(enrichedRows.map((r) => r.assessor)), [enrichedRows])
  const statusFilterOptions = useMemo(() => buildMultiOptions(enrichedRows.map((r) => r.Status || r.status)), [enrichedRows])
  const clienteFilterOptions = useMemo(() => buildMultiOptions(enrichedRows.map((r) => r.codigoCliente || r.Cliente || r.conta || r.cliente)), [enrichedRows])
  const ativoFilterOptions = useMemo(() => buildMultiOptions(enrichedRows.map((r) => r.Ativo || r.ativo)), [enrichedRows])
  const estruturaFilterOptions = useMemo(() => buildMultiOptions(enrichedRows.map((r) => r.Estrutura || r.estrutura)), [enrichedRows])
  const tipoOperacaoFilterOptions = useMemo(() => buildMultiOptions(enrichedRows.map((r) => r.tipoOperacao || r['Tipo de operação'] || r['Tipo de operacao'])), [enrichedRows])
  const statusValues = useMemo(
    () => sortUniqueTextValues(enrichedRows.map((r) => String(r.Status || r.status || '').trim())),
    [enrichedRows],
  )
  const approvedStatusValues = useMemo(
    () => statusValues.filter((statusValue) => isApprovedStatus(statusValue)),
    [statusValues],
  )
  const pendingStatusValues = useMemo(
    () => statusValues.filter((statusValue) => !isApprovedStatus(statusValue)),
    [statusValues],
  )

  const filteredRows = useMemo(() => {
    return enrichedRows.filter((entry) => {
      // Central de Ordens e uma pagina de extracao ao vivo — dados extraidos do HubXP
      // devem ser exibidos integralmente. Apenas filtros LOCAIS (da propria pagina) sao aplicados.
      // Filtros globais (selectedBroker, selectedAssessor, clientCodeFilter) NAO sao aplicados aqui
      // porque a extracao pode retornar clientes de qualquer broker/assessor, e esconder essas linhas
      // causa o problema de "0 de N ordens (filtradas)".

      const entryBroker = String(entry.broker || '').trim()
      const entryAssessor = String(entry.assessor || '').trim()

      // Local filters
      if (filters.search) {
        const query = filters.search.toLowerCase()
        const searchBase = `${entry.codigoCliente || ''} ${entry.Cliente || ''} ${entry.conta || ''} ${entry.cliente || ''} ${entry.Ativo || ''} ${entry.Estrutura || ''} ${entry.assessor || ''} ${entry.broker || ''} ${entry.Status || ''}`.toLowerCase()
        if (!searchBase.includes(query)) return false
      }
      if (filters.broker.length && entryBroker && !filters.broker.includes(entryBroker)) return false
      if (filters.assessor.length && entryAssessor && !filters.assessor.includes(entryAssessor)) return false
      if (filters.status.length) {
        const st = String(entry.Status || entry.status || '').trim()
        const hasMatch = filters.status.includes(st) || (!st && filters.status.includes('Sem status'))
        if (!hasMatch) return false
      }
      if (filters.cliente.length) {
        const cl = String(entry.codigoCliente || entry.Cliente || entry.conta || entry.cliente || '').trim()
        if (!filters.cliente.includes(cl)) return false
      }
      if (filters.ativo.length) {
        const at = String(entry.Ativo || entry.ativo || '').trim()
        if (!filters.ativo.includes(at)) return false
      }
      if (filters.estrutura.length) {
        const est = String(entry.Estrutura || entry.estrutura || '').trim()
        if (!filters.estrutura.includes(est)) return false
      }
      if (filters.tipoOperacao.length) {
        const tp = String(entry.tipoOperacao || entry['Tipo de operação'] || entry['Tipo de operacao'] || '').trim()
        if (!filters.tipoOperacao.includes(tp)) return false
      }
      return true
    })
  }, [enrichedRows, filters])

  const approvedRowsCount = useMemo(() => {
    let count = 0
    for (const row of filteredRows) {
      const status = String(findRowValue(row, 'Status', 'status') || '').trim()
      if (isApprovedStatus(status)) count += 1
    }
    return count
  }, [filteredRows])

  const chartData = useMemo(() => {
    if (!filteredRows.length) return []

    let approvedCount = 0
    let approvedRevenue = 0
    let pendingCount = 0
    let pendingRevenue = 0

    for (const row of filteredRows) {
      const status = String(findRowValue(row, 'Status', 'status') || '').trim().toLowerCase()
      if (isCancelledStatus(status)) continue
      const roa = parseROA(findRowValue(row, 'ROA All', 'ROA', 'roa', 'roa_all', 'ROA_All', 'Receita'))

      if (isApprovedStatus(status)) {
        approvedCount += 1
        approvedRevenue += roa
      } else {
        pendingCount += 1
        pendingRevenue += roa
      }
    }

    const slices = []
    if (approvedCount > 0) {
      slices.push({
        label: 'Aprovadas',
        value: approvedCount,
        count: approvedCount,
        revenue: approvedRevenue,
        color: '#22c55e',
      })
    }
    if (pendingCount > 0) {
      slices.push({
        label: 'Pendentes',
        value: pendingCount,
        count: pendingCount,
        revenue: pendingRevenue,
        color: '#f59e0b',
      })
    }
    return slices
  }, [filteredRows])

  const brokerSplitPieCharts = useMemo(() => {
    if (!filteredRows.length) return []
    const byBroker = new Map()
    for (const row of filteredRows) {
      const status = String(findRowValue(row, 'Status', 'status') || '').trim().toLowerCase()
      if (isCancelledStatus(status)) continue
      const broker = String(findRowValue(row, 'broker', 'Broker') || row?.broker || row?.Broker || '').trim() || 'Sem broker'
      const roa = parseROA(findRowValue(row, 'ROA All', 'ROA', 'roa', 'roa_all', 'ROA_All', 'Receita'))
      const current = byBroker.get(broker) || {
        broker,
        approvedCount: 0,
        approvedRevenue: 0,
        pendingCount: 0,
        pendingRevenue: 0,
      }
      if (isApprovedStatus(status)) {
        current.approvedCount += 1
        current.approvedRevenue += roa
      } else {
        current.pendingCount += 1
        current.pendingRevenue += roa
      }
      byBroker.set(broker, current)
    }

    return Array.from(byBroker.values())
      .map((entry) => ({
        broker: entry.broker,
        totalCount: entry.approvedCount + entry.pendingCount,
        data: [
          {
            label: 'Aprovadas',
            value: entry.approvedCount,
            count: entry.approvedCount,
            revenue: entry.approvedRevenue,
            color: '#22c55e',
          },
          {
            label: 'Pendentes',
            value: entry.pendingCount,
            count: entry.pendingCount,
            revenue: entry.pendingRevenue,
            color: '#f59e0b',
          },
        ],
      }))
      .sort((a, b) => b.totalCount - a.totalCount)
  }, [filteredRows])

  const activeApprovalSliceLabel = useMemo(() => {
    if (!filters.status.length) return ''
    if (approvedStatusValues.length && isSameTextSet(filters.status, approvedStatusValues)) return 'Aprovadas'
    if (pendingStatusValues.length && isSameTextSet(filters.status, pendingStatusValues)) return 'Pendentes'
    return ''
  }, [filters.status, approvedStatusValues, pendingStatusValues])

  const toggleStatusFilter = useCallback((targetStatuses) => {
    const normalizedTarget = sortUniqueTextValues(targetStatuses)
    setFilters((prev) => {
      const current = sortUniqueTextValues(prev.status)
      const nextStatus = isSameTextSet(current, normalizedTarget) ? [] : normalizedTarget
      return { ...prev, status: nextStatus }
    })
  }, [])

  const handleApprovalPieSliceClick = useCallback((slice) => {
    const label = String(slice?.label || '').trim()
    if (!label) return
    if (label === 'Aprovadas') {
      toggleStatusFilter(approvedStatusValues)
      return
    }
    if (label === 'Pendentes') {
      toggleStatusFilter(pendingStatusValues)
    }
  }, [approvedStatusValues, pendingStatusValues, toggleStatusFilter])

  const tableColumns = useMemo(() => {
    // Build columns with enriched fields first, then original columns
    const enrichedKeys = ['codigoCliente', 'assessor', 'broker']
    const enrichedLabels = { codigoCliente: 'Conta', assessor: 'Assessor', broker: 'Broker' }

    const headerList = Array.isArray(columns) && columns.length
      ? columns
      : enrichedRows[0]
        ? Object.keys(enrichedRows[0]).filter((key) => key !== 'id')
        : []

    // Determine which enriched keys actually have data
    const hasEnrichedData = enrichedKeys.filter((key) =>
      enrichedRows.some((row) => row[key] && String(row[key]).trim()),
    )
    const leadingEnrichedKeys = Array.from(new Set(['codigoCliente', ...hasEnrichedData]))

    // Build column list: original columns + new enriched columns not already present
    const result = []
    const seen = new Set()

    // Add enriched columns first (conta, assessor, broker)
    for (const key of leadingEnrichedKeys) {
      if (!seen.has(key)) {
        seen.add(key)
        if (key === 'codigoCliente') {
          result.push({
            key,
            label: enrichedLabels[key] || key,
            render: (row) => {
              const value = String(
                row?.codigoCliente
                || row?.Cliente
                || row?.conta
                || row?.cliente
                || '',
              ).trim()
              return value || 'Sem conta'
            },
          })
        } else {
          result.push({ key, label: enrichedLabels[key] || key })
        }
      }
    }

    // Then add original columns (skip internal/duplicate keys)
    const skipKeys = new Set(['id', 'codigoCliente', 'conta', 'ativo', 'tipoOperacao', 'Ativo e Estrutura', ...leadingEnrichedKeys])
    for (const header of headerList) {
      if (isNomeClienteField(header)) continue
      if (isContaField(header) && seen.has('codigoCliente')) continue
      if (!skipKeys.has(header) && !seen.has(header)) {
        seen.add(header)
        result.push({ key: header, label: header })
      }
    }

    // Inserir colunas Ativo e Estrutura separadas (após Conta)
    if (enrichedRows.some((r) => r.Ativo)) {
      const clienteIdx = result.findIndex((c) => c.key === 'codigoCliente' || c.key === 'Cliente')
      const insertAt = clienteIdx >= 0 ? clienteIdx + 1 : result.length
      if (!seen.has('Ativo')) {
        result.splice(insertAt, 0, { key: 'Ativo', label: 'Ativo' })
        seen.add('Ativo')
      }
      if (!seen.has('Estrutura')) {
        const ativoIdx = result.findIndex((c) => c.key === 'Ativo')
        result.splice(ativoIdx + 1, 0, { key: 'Estrutura', label: 'Estrutura' })
        seen.add('Estrutura')
      }
    }

    const hasReceitaBruta = enrichedRows.some((row) => Number.isFinite(Number(row?.receitaBruta)))
    if (hasReceitaBruta && !seen.has('receitaBruta')) {
      const roaIdx = result.findIndex((column) => {
        const key = String(column?.key || '').trim().toLowerCase()
        return key === 'roa all' || key === 'roa' || key === 'receita'
      })
      const insertAt = roaIdx >= 0 ? roaIdx + 1 : result.length
      result.splice(insertAt, 0, {
        key: 'receitaBruta',
        label: 'Receita Bruta',
        render: (row) => formatRevenueCurrency(row?.receitaBruta),
      })
      seen.add('receitaBruta')
    }

    const normalizedResult = result.map((column) => {
      if (!column || column.render || !isReceitaBrutaColumn(column)) return column
      return {
        ...column,
        render: (row) => formatRevenueCurrency(row?.[column.key]),
      }
    })

    // Oculta a 9ª coluna da grade do Central de Ordens (indice 8).
    if (normalizedResult.length >= 9) {
      normalizedResult.splice(8, 1)
    }

    return normalizedResult
  }, [columns, enrichedRows])

  const sortOptions = useMemo(() => {
    const base = tableColumns
      .filter((column) => column?.key)
      .map((column) => ({
        value: column.key,
        label: column.label || column.key,
      }))
    const hasDate = base.some((item) => item.value === 'Data')
    if (!hasDate) {
      base.unshift({ value: 'Data', label: 'Data' })
    }
    return base
  }, [tableColumns])

  const resolvedSortBy = useMemo(() => {
    if (!sortOptions.length) return ''
    const hasCurrent = sortOptions.some((option) => option.value === sortBy)
    if (hasCurrent) return sortBy
    const preferred = sortOptions.find((option) => option.value === 'ROA All')
    return (preferred || sortOptions[0]).value
  }, [sortBy, sortOptions])

  const sortedFilteredRows = useMemo(() => {
    if (!resolvedSortBy) return filteredRows

    const compareValues = (leftValue, rightValue) => {
      const leftDate = normalizeDateValue(leftValue)
      const rightDate = normalizeDateValue(rightValue)
      if (leftDate && rightDate) {
        return leftDate.localeCompare(rightDate)
      }

      const leftNumber = parseSortableNumber(leftValue)
      const rightNumber = parseSortableNumber(rightValue)
      if (leftNumber != null && rightNumber != null) {
        return leftNumber - rightNumber
      }

      return normalizeTextKey(leftValue).localeCompare(normalizeTextKey(rightValue), 'pt-BR', {
        numeric: true,
      })
    }

    const sorted = [...filteredRows].sort((a, b) => {
      const leftValue = a?.[resolvedSortBy]
      const rightValue = b?.[resolvedSortBy]
      const comparison = compareValues(leftValue, rightValue)
      if (comparison !== 0) return sortDirection === 'asc' ? comparison : -comparison
      return String(a?.id || '').localeCompare(String(b?.id || ''))
    })
    return sorted
  }, [filteredRows, resolvedSortBy, sortDirection])

  const logEntries = useMemo(
    () => (Array.isArray(job?.logs) ? [...job.logs] : []),
    [job],
  )

  const terminalLogLines = useMemo(
    () => logEntries.slice(-240).map((entry) => formatLogLine(entry)),
    [logEntries],
  )

  const handleExportExcel = useCallback(async () => {
    if (!sortedFilteredRows.length) return
    const XLSX = await loadXlsx()
    const headers = [
      'Conta',
      'Assessor',
      'Broker',
      'Ativo',
      'Estrutura',
      'ROA All',
      'Status',
      'ROA Bruto',
    ]
    const data = sortedFilteredRows.map((row) => {
      const conta = String(row?.codigoCliente || row?.Cliente || row?.conta || row?.cliente || '').trim()
      const assessor = String(row?.assessor || row?.Assessor || '').trim()
      const broker = String(row?.broker || row?.Broker || '').trim()
      const ativo = String(row?.Ativo || row?.ativo || '').trim()
      const estrutura = String(row?.Estrutura || row?.estrutura || '').trim()
      const roaAll = parseROA(findRowValue(row, 'ROA All', 'ROA', 'roa', 'roa_all', 'ROA_All', 'Receita'))
      const status = String(findRowValue(row, 'Status', 'status') || row?.Status || row?.status || '').trim()
      const roaBruto = Number.isFinite(Number(row?.receitaBruta))
        ? Number(row.receitaBruta)
        : Number((roaAll * 2).toFixed(6))

      return [
        conta || 'Sem conta',
        assessor || 'Sem assessor',
        broker || '--',
        ativo || '-',
        estrutura || '-',
        formatRevenueExcelValue(roaAll),
        status || 'Sem status',
        formatRevenueExcelValue(roaBruto),
      ]
    })
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data])
    // Auto-fit column widths
    ws['!cols'] = headers.map((h, i) => {
      const maxLen = Math.max(h.length, ...data.map((r) => (r[i] || '').length))
      return { wch: Math.min(maxLen + 2, 50) }
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Central de Ordens')
    const dateLabel = filters.dateFrom === filters.dateTo
      ? filters.dateFrom
      : `${filters.dateFrom}_a_${filters.dateTo}`
    XLSX.writeFile(wb, `Central_Ordens_${dateLabel}.xlsx`)
    notify('Arquivo Excel exportado com sucesso.', 'success')
  }, [sortedFilteredRows, filters.dateFrom, filters.dateTo, notify])

  const handlePushApprovedToManual = useCallback(() => {
    const fallbackDate = filters.dateTo || filters.dateFrom || getToday()
    const baseTimestamp = Date.now()
    const entriesToImport = filteredRows
      .map((row, index) => mapApprovedOrderToManualEntry(row, {
        fallbackDate,
        createdAt: baseTimestamp + index,
      }))
      .filter(Boolean)

    if (!entriesToImport.length) {
      notify('Nenhuma ordem aprovada com receita valida para importar.', 'warning')
      return
    }

    const { addedCount, skippedCount, replacedCount } = appendManualRevenueBatch(entriesToImport, {
      dedupeByImportKey: true,
      replaceOnImportKey: true,
    })

    if (addedCount > 0 || replacedCount > 0) {
      const parts = []
      if (addedCount > 0) parts.push(`${addedCount} receita(s) nova(s)`)
      if (replacedCount > 0) parts.push(`${replacedCount} receita(s) atualizada(s)`)
      const dedupeNote = skippedCount > 0
        ? ` ${skippedCount} registro(s) duplicado(s) no envio foram ignorados.`
        : ''
      notify(`${parts.join(' e ')} enviada(s) para Receita Manual.${dedupeNote}`, 'success')
      return
    }

    notify('Nenhuma receita foi enviada para a Receita Manual.', 'warning')
  }, [filteredRows, filters.dateFrom, filters.dateTo, notify])

  const handleCopyPieChart = useCallback(async (chartKey, chartTitle) => {
    const node = pieChartRefs.current?.[chartKey]
    if (!node) {
      notify('Grafico indisponivel para copiar.', 'warning')
      return
    }

    const panelNode = node.closest('.panel')
    const panelBackground = panelNode ? window.getComputedStyle(panelNode).backgroundColor : ''
    const captureBackground = panelBackground && panelBackground !== 'transparent' && panelBackground !== 'rgba(0, 0, 0, 0)'
      ? panelBackground
      : '#0f1520'

    setCopyingChartKey(chartKey)
    try {
      await copyCardImageToClipboard({ node, backgroundColor: captureBackground })
      notify(`Grafico "${chartTitle}" copiado.`, 'success')
    } catch (error) {
      notify(error?.message || 'Nao foi possivel copiar o grafico.', 'warning')
    } finally {
      setCopyingChartKey((current) => (current === chartKey ? '' : current))
    }
  }, [notify])

  const panelBusy = busy || hubxp.busy

  return (
    <div className="page">
      <PageHeader
        title="Central de Ordens (HubXP)"
        subtitle="Coleta automatizada de ordens com filtros e paginação (sessao HubXP no topo)."
        meta={[
          { label: 'Status', value: statusLabel },
          { label: 'Total', value: enrichedRows.length },
          { label: 'Filtradas', value: filteredRows.length },
          { label: 'Paginas', value: totalPages || currentPage || '-' },
        ]}
        actions={[
          {
            label: panelBusy ? 'Processando...' : 'Extrair Central de Ordens',
            icon: 'sync',
            onClick: handleRefresh,
            disabled: panelBusy,
          },
          {
            label: approvedRowsCount > 0 ? `Subir aprovadas (${approvedRowsCount})` : 'Subir aprovadas',
            icon: 'upload',
            onClick: handlePushApprovedToManual,
            disabled: panelBusy || approvedRowsCount === 0,
            variant: 'btn-secondary',
          },
          ...(rows.length > 0 ? [{
            label: 'Limpar dados',
            icon: 'trash',
            onClick: () => {
              if (window.confirm(`Excluir ${rows.length} registros coletados da Central de Ordens?`)) {
                setRows([])
                setColumns([])
                notify('Dados da Central de Ordens excluidos.', 'success')
              }
            },
            disabled: panelBusy,
            variant: 'btn-danger',
          }] : []),
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Parâmetros da coleta</h3>
            <p className="muted">Defina o período para extração no HubXP. Os filtros por coluna ficam na seção da tabela.</p>
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
            />
          </label>
          <label>
            Data final
            <input
              className="input"
              type="date"
              value={filters.dateTo}
              onChange={(event) => setFilters((prev) => ({ ...prev, dateTo: event.target.value }))}
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Progresso da coleta</h3>
            <p className="muted">{progress.message || 'Aguardando execução.'}</p>
          </div>
        </div>

        <div className={`progress-bar ${busy && !totalPages ? 'indeterminate' : ''}`}>
          <span style={{ width: `${progressPercent}%` }} />
        </div>

        <div className="sync-result hubxp-sync-grid">
          <div>
            <strong>{currentPage || '-'}</strong>
            <span className="muted">Pagina atual</span>
          </div>
          <div>
            <strong>{totalPages || '-'}</strong>
            <span className="muted">Total de paginas</span>
          </div>
          <div>
            <strong>{rowsCollected || 0}</strong>
            <span className="muted">Linhas coletadas</span>
          </div>
          <div>
            <strong>{job?.id || '-'}</strong>
            <span className="muted">Job ID</span>
          </div>
        </div>

        {lastError ? (
          <div className="sync-warnings">
            <strong>ERRO</strong>
            {lastError.message}
            {lastError.stage ? <span>Etapa: {lastError.stage}</span> : null}
            {lastError.code ? <span>Codigo: {lastError.code}</span> : null}
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
      </section>

      {filteredRows.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Resumo das Ordens</h3>
              <p className="muted">Aprovadas = Pendente de Registro + Pendente de Execução + Totalmente Executado</p>
            </div>
          </div>
          <div className="pie-chart-grid hubxp-orders-pie-row">
            <div className="hubxp-pie-card">
              <button
                type="button"
                className="icon-btn hubxp-pie-copy-btn"
                onClick={() => handleCopyPieChart('geral', 'Geral · Aprovadas vs Pendentes')}
                disabled={copyingChartKey === 'geral'}
                aria-label="Copiar grafico geral"
                title="Copiar grafico"
              >
                <Icon name="doc" size={15} />
              </button>
              <div className="hubxp-pie-capture" ref={setPieChartRef('geral')}>
                <PieChart
                  data={chartData}
                  title="Geral · Aprovadas vs Pendentes"
                  size={200}
                  onSliceClick={handleApprovalPieSliceClick}
                  activeSliceLabel={activeApprovalSliceLabel}
                />
              </div>
            </div>
            {brokerSplitPieCharts.map((chart) => (
              <div
                key={chart.broker}
                className="hubxp-pie-card"
              >
                <button
                  type="button"
                  className="icon-btn hubxp-pie-copy-btn"
                  onClick={() => handleCopyPieChart(`broker-${chart.broker}`, `${chart.broker} · ${chart.totalCount} ordens`)}
                  disabled={copyingChartKey === `broker-${chart.broker}`}
                  aria-label={`Copiar grafico de ${chart.broker}`}
                  title="Copiar grafico"
                >
                  <Icon name="doc" size={15} />
                </button>
                <div className="hubxp-pie-capture" ref={setPieChartRef(`broker-${chart.broker}`)}>
                  <PieChart
                    data={chart.data}
                    title={`${chart.broker} · ${chart.totalCount} ordens`}
                    size={200}
                    onSliceClick={handleApprovalPieSliceClick}
                    activeSliceLabel={activeApprovalSliceLabel}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Ordens coletadas</h3>
            <p className="muted">
              {filteredRows.length === enrichedRows.length
                ? `${enrichedRows.length} ordens encontradas.`
                : `${filteredRows.length} de ${enrichedRows.length} ordens (filtradas).`}
            </p>
          </div>
          <div className="panel-actions">
            {filteredRows.length > 0 && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleExportExcel}
              >
                <Icon name="download" size={16} />
                Exportar Excel
              </button>
            )}
            <label className="antecipacao-sort-field">
              <span>Ordenar por</span>
              <select
                className="input"
                value={resolvedSortBy}
                onChange={(event) => setSortBy(event.target.value)}
              >
                {sortOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="antecipacao-sort-field">
              <span>Direcao</span>
              <select
                className="input"
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value)}
              >
                <option value="desc">Decrescente</option>
                <option value="asc">Crescente</option>
              </select>
            </label>
          </div>
        </div>

        <div className="form-grid hubxp-form-grid hubxp-orders-filter-row">
          <label>
            Busca livre
            <input
              className="input"
              type="text"
              value={filters.search}
              onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
              placeholder="Conta, ativo, estrutura, assessor..."
            />
          </label>
          <label>
            Status
            <MultiSelect
              value={filters.status}
              options={statusFilterOptions}
              onChange={(value) => setFilters((prev) => ({ ...prev, status: value }))}
              placeholder="Todos"
            />
          </label>
          <label>
            Broker
            <MultiSelect
              value={filters.broker}
              options={brokerFilterOptions}
              onChange={(value) => setFilters((prev) => ({ ...prev, broker: value }))}
              placeholder="Todos"
            />
          </label>
          <label>
            Assessor
            <MultiSelect
              value={filters.assessor}
              options={assessorFilterOptions}
              onChange={(value) => setFilters((prev) => ({ ...prev, assessor: value }))}
              placeholder="Todos"
            />
          </label>
          <label>
            Conta
            <MultiSelect
              value={filters.cliente}
              options={clienteFilterOptions}
              onChange={(value) => setFilters((prev) => ({ ...prev, cliente: value }))}
              placeholder="Todos"
            />
          </label>
          <label>
            Ativo
            <MultiSelect
              value={filters.ativo}
              options={ativoFilterOptions}
              onChange={(value) => setFilters((prev) => ({ ...prev, ativo: value }))}
              placeholder="Todos"
            />
          </label>
          <label>
            Estrutura
            <MultiSelect
              value={filters.estrutura}
              options={estruturaFilterOptions}
              onChange={(value) => setFilters((prev) => ({ ...prev, estrutura: value }))}
              placeholder="Todas"
            />
          </label>
          <label>
            Tipo de operação
            <MultiSelect
              value={filters.tipoOperacao}
              options={tipoOperacaoFilterOptions}
              onChange={(value) => setFilters((prev) => ({ ...prev, tipoOperacao: value }))}
              placeholder="Todos"
            />
          </label>
        </div>

        <DataTable
          columns={tableColumns}
          rows={sortedFilteredRows}
          visibleRows={50}
          emptyMessage="Nenhuma ordem coletada ainda."
        />
      </section>
    </div>
  )
}

export default CentralOrdens
