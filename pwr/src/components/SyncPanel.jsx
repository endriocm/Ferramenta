import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'

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
      <div className="progress-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${progress}%` }} />
      </div>

      {result ? (
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
        </div>
      ) : (
        <div className="muted">{running ? 'Processando arquivos em tempo real.' : 'Nenhuma sincronizacao recente.'}</div>
      )}
    </section>
  )
}

export default SyncPanel
