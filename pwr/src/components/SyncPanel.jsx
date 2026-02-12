import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'

const CSV_COLUMNS = [
  'rowIndex',
  'reasonCode',
  'duplicateKey',
  'reasonMessage',
  'firstSeenRowIndex',
  'data',
  'codigoCliente',
  'conta',
  'cliente',
  'assessor',
  'broker',
  'ativo',
  'estrutura',
  'comissao',
  'quantidade',
  'precoCompra',
  'corretagem',
  'volumeNegociado',
  'tipoCorretagem',
  'mercado',
]

const pickValue = (...values) => {
  for (const value of values) {
    if (value != null && value !== '') return value
  }
  return ''
}

const escapeCsv = (value) => {
  const text = value == null ? '' : String(value)
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

const buildCsv = (rows, columns = CSV_COLUMNS) => {
  const header = columns.join(',')
  const lines = rows.map((row) => columns.map((key) => escapeCsv(row[key])).join(','))
  return [header, ...lines].join('\r\n')
}

const buildTimestamp = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

const sanitizeLabel = (value) => String(value || 'import')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const buildDetailRows = (items, type) => {
  return (Array.isArray(items) ? items : []).map((item) => {
    const raw = item?.raw || {}
    const normalized = item?.normalized || {}
    const dataValue = pickValue(
      normalized.data,
      normalized.dataEntrada,
      normalized.dataInclusao,
      raw.data,
      raw.dataEntrada,
      raw.dataInclusao,
    )
    const codigoCliente = pickValue(normalized.codigoCliente, raw.codigoCliente, raw.conta, raw.cliente)
    return {
      rowIndex: item?.rowIndex ?? '',
      reasonCode: item?.reasonCode ?? (type === 'duplicated' ? 'duplicate' : ''),
      duplicateKey: item?.duplicateKey ?? '',
      reasonMessage: item?.reasonMessage ?? (item?.firstSeenRowIndex ? `Duplicado (primeira linha ${item.firstSeenRowIndex})` : ''),
      firstSeenRowIndex: item?.firstSeenRowIndex ?? '',
      data: dataValue,
      codigoCliente,
      conta: pickValue(normalized.conta, raw.conta),
      cliente: pickValue(normalized.cliente, raw.cliente),
      assessor: pickValue(normalized.assessor, raw.assessor),
      broker: pickValue(normalized.broker, raw.broker),
      ativo: pickValue(normalized.ativo, raw.ativo),
      estrutura: pickValue(normalized.estrutura, raw.estrutura),
      comissao: pickValue(normalized.comissao, raw.comissao),
      quantidade: pickValue(normalized.quantidade, raw.quantidade),
      precoCompra: pickValue(normalized.precoCompra, raw.precoCompra),
      corretagem: pickValue(normalized.corretagem, raw.corretagem),
      volumeNegociado: pickValue(normalized.volumeNegociado, normalized.volume, raw.volumeNegociado, raw.volume),
      tipoCorretagem: pickValue(normalized.tipoCorretagem, raw.tipoCorretagem),
      mercado: pickValue(normalized.mercado, raw.mercado),
    }
  })
}

const downloadCsv = (filename, csvString) => {
  const blob = new Blob([`\uFEFF${csvString}`], { type: 'text/csv;charset=utf-8;' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

const DEFAULT_STEPS = [
  'Selecionar fonte',
  'Validar arquivos',
  'Processar linhas',
  'Consolidar base',
  'Concluir',
]

const SyncPanel = ({
  label = 'Sincronizacao inteligente',
  helper = 'Escolha a fonte e acompanhe o processamento.',
  onSync,
  onFileSelected,
  selectedFile: selectedFileProp,
  onSelectedFileChange,
  result,
  running: runningProp,
  progress: progressProp,
  progressInfo,
  onCancel,
  onReprocessRejected,
  reprocessRunning = false,
  reprocessProgress,
  onCancelReprocess,
  steps = DEFAULT_STEPS,
  accept = '.xlsx,.xls',
  directory = false,
}) => {
  const [stage, setStage] = useState(0)
  const [runningInternal, setRunningInternal] = useState(false)
  const [selectedFileInternal, setSelectedFileInternal] = useState(null)
  const selectedFile = selectedFileProp !== undefined ? selectedFileProp : selectedFileInternal
  const setSelectedFile = onSelectedFileChange || setSelectedFileInternal
  const inputIdRef = useRef(`sync-${Math.random().toString(36).slice(2)}`)
  const isControlled = typeof runningProp === 'boolean'
  const running = isControlled ? runningProp : runningInternal

  const startSync = async () => {
    if (!onSync || running) return
    if (!isControlled) setRunningInternal(true)
    try {
      await onSync(selectedFile)
    } finally {
      if (!isControlled) setRunningInternal(false)
    }
  }

  const progress = useMemo(() => ((stage + (running ? 0.4 : 1)) / steps.length) * 100, [stage, running, steps.length])
  const hasExternalProgress = Number.isFinite(progressProp)
  const progressValue = hasExternalProgress
    ? Math.max(0, Math.min(1, progressProp)) * 100
    : progress
  const progressClassName = hasExternalProgress ? '' : (running ? 'indeterminate' : '')
  const progressLabel = progressInfo?.total
    ? `Processando ${progressInfo.processed} / ${progressInfo.total}`
    : null
  const details = result?.details || {}
  const hasRejectedDetails = Array.isArray(details.rejected) && details.rejected.length > 0
  const hasDuplicatedDetails = Array.isArray(details.duplicated) && details.duplicated.length > 0
  const reprocessLabel = reprocessProgress?.total
    ? `Reprocessando ${reprocessProgress.processed} / ${reprocessProgress.total}`
    : null

  const handleExportDetails = (type) => {
    const items = type === 'duplicated' ? details.duplicated : details.rejected
    const rows = buildDetailRows(items, type)
    if (!rows.length) return
    const moduleLabel = sanitizeLabel(result?.moduleLabel || label)
    const stamp = buildTimestamp()
    const suffix = (details?.canceled || details?.reprocessCanceled) ? '-cancelado' : ''
    const namePrefix = type === 'duplicated' ? 'import-duplicados' : 'import-rejeitados'
    const filename = `${namePrefix}-${moduleLabel}-${stamp}${suffix}.csv`
    const csv = buildCsv(rows)
    downloadCsv(filename, csv)
  }

  const handleReprocessClick = () => {
    if (!onReprocessRejected || reprocessRunning) return
    onReprocessRejected()
  }

  useEffect(() => {
    if (!running) {
      setStage(0)
      return
    }
    let active = true
    let current = 0
    setStage(0)
    const timer = setInterval(() => {
      if (!active) return
      current = Math.min(current + 1, steps.length - 1)
      setStage(current)
      if (current >= steps.length - 1) {
        clearInterval(timer)
      }
    }, 450)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [running, steps.length])

  const canSync = Boolean(onSync) && Boolean(selectedFile)

  const selectedFileLabel = selectedFile?.name
    || selectedFile?.fileName
    || selectedFile?.file?.name
    || ''

  return (
    <section className="panel sync-panel">
      <div className="panel-head">
        <div>
          <h3>{label}</h3>
          <p className="muted">{helper}</p>
        </div>
        <div className="panel-actions">
          <label className="btn btn-secondary" htmlFor={inputIdRef.current}>
            <Icon name="upload" size={16} />
            {directory ? 'Selecionar pasta' : 'Selecionar arquivo'}
          </label>
          <input
            id={inputIdRef.current}
            type="file"
            accept={accept}
            onChange={async (event) => {
              const fileList = Array.from(event.target.files || [])
              const payload = directory ? fileList : fileList[0] || null
              let next = payload
              if (onFileSelected) {
                const result = await onFileSelected(payload)
                if (result !== undefined) {
                  next = result
                }
              }
              if (Array.isArray(next)) {
                next = next[0] || null
              }
              setSelectedFile(next)
            }}
            multiple={directory}
            webkitdirectory={directory ? 'true' : undefined}
            directory={directory ? 'true' : undefined}
            hidden
          />
          <button className="btn btn-primary" type="button" onClick={startSync} disabled={!canSync || running}>
            <Icon name="sync" size={16} />
            {running ? 'Processando' : 'Sincronizar'}
          </button>
          {running && onCancel ? (
            <button className="btn btn-secondary" type="button" onClick={onCancel}>
              Cancelar
            </button>
          ) : null}
        </div>
      </div>

      {selectedFile ? (
        <div className="muted">Arquivo selecionado: {selectedFileLabel}</div>
      ) : null}

      <div className="steps">
        {steps.map((step, index) => {
          const isActive = index === stage && running
          const isDone = (!running && result) || index < stage
          return (
            <div key={step} className={`step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
              <div className="step-icon">
                {isDone ? <Icon name="check" size={14} /> : <span>{index + 1}</span>}
              </div>
              <span>{step}</span>
            </div>
          )
        })}
      </div>
      <div className={`progress-bar ${progressClassName}`} role="progressbar" aria-valuenow={progressValue} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${progressValue}%` }} />
      </div>
      {running && progressLabel ? <div className="muted">{progressLabel}</div> : null}

      {result ? (
        <>
          <div className="sync-result">
            <div>
              <strong>{result.importados}</strong>
              <span>Importados</span>
            </div>
            <div>
              <strong>{result.duplicados}</strong>
              <span>Duplicados</span>
            </div>
            <div>
              <strong>{result.rejeitados}</strong>
              <span>Rejeitados</span>
            </div>
            <div>
              <strong>{result.avisos}</strong>
              <span>Avisos</span>
            </div>
            {Array.isArray(result.extra) ? result.extra.map((item) => (
              <div key={item.label}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </div>
            )) : null}
          </div>
          {Array.isArray(result.warnings) && result.warnings.length ? (
            <div className="sync-warnings">
              <strong>Avisos</strong>
              <div className="sync-warnings-list">
                {result.warnings.map((warning, index) => (
                  <span key={`${warning.code || 'warn'}-${index}`} className="sync-warning-item">
                    {warning.message || warning}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {hasRejectedDetails || hasDuplicatedDetails ? (
            <div className="sync-actions">
              {hasRejectedDetails ? (
                <button className="btn btn-secondary" type="button" onClick={() => handleExportDetails('rejected')}>
                  Exportar rejeitados (CSV)
                </button>
              ) : null}
              {hasDuplicatedDetails ? (
                <button className="btn btn-secondary" type="button" onClick={() => handleExportDetails('duplicated')}>
                  Exportar duplicados (CSV)
                </button>
              ) : null}
              {hasRejectedDetails && onReprocessRejected ? (
                <button className="btn btn-secondary" type="button" onClick={handleReprocessClick} disabled={reprocessRunning}>
                  {reprocessRunning ? 'Reprocessando…' : 'Reprocessar rejeitados'}
                </button>
              ) : null}
              {reprocessRunning && onCancelReprocess ? (
                <button className="btn btn-secondary" type="button" onClick={onCancelReprocess}>
                  Cancelar reprocessamento
                </button>
              ) : null}
            </div>
          ) : null}
          {reprocessRunning && reprocessLabel ? <div className="muted">{reprocessLabel}</div> : null}
        </>
      ) : (
        <div className="muted">{running ? 'Processando arquivos em tempo real.' : 'Nenhuma sincronizacao recente.'}</div>
      )}
    </section>
  )
}

export default SyncPanel
