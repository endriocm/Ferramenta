import { useEffect, useMemo, useState } from 'react'
import Icon from './Icons'
import { syncSteps, syncResultsMock } from '../data/revenue'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const SyncPanel = ({ label = 'Sincronizacao inteligente', helper = 'Escolha a fonte e acompanhe o processamento.' }) => {
  const [stage, setStage] = useState(0)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [result, setResult] = useState(null)

  const startSync = async () => {
    if (running) return
    setRunning(true)
    setDone(false)
    setResult(null)
    for (let i = 0; i < syncSteps.length; i += 1) {
      setStage(i)
      // simulate step duration
      await delay(500)
    }
    await delay(400)
    setRunning(false)
    setDone(true)
    setResult(syncResultsMock)
  }

  const progress = useMemo(() => ((stage + (running ? 0.4 : 1)) / syncSteps.length) * 100, [stage, running])

  useEffect(() => {
    if (!running && !done) {
      setStage(0)
    }
  }, [running, done])

  return (
    <section className="panel sync-panel">
      <div className="panel-head">
        <div>
          <h3>{label}</h3>
          <p className="muted">{helper}</p>
        </div>
        <div className="panel-actions">
          <label className="btn btn-secondary" htmlFor="folder-select">
            <Icon name="upload" size={16} />
            Selecionar pasta
          </label>
          <input id="folder-select" type="file" webkitdirectory="true" directory="true" hidden />
          <button className="btn btn-primary" type="button" onClick={startSync}>
            <Icon name="sync" size={16} />
            {running ? 'Processando' : 'Sincronizar'}
          </button>
        </div>
      </div>

      <div className="steps">
        {syncSteps.map((step, index) => {
          const isActive = index === stage && running
          const isDone = done || index < stage
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
