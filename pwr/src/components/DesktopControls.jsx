import { useEffect, useMemo, useState } from 'react'
import { getAppConfig, isDesktop, selectWorkDir } from '../services/nativeStorage'

const defaultConfig = { workDir: '', updateBaseUrl: '', license: { enabled: false }, auth: { enabled: false } }

const DesktopControls = () => {
  const [config, setConfig] = useState(defaultConfig)
  const [updateState, setUpdateState] = useState({ status: 'idle', message: '', progress: 0 })

  useEffect(() => {
    if (!isDesktop()) return undefined
    let active = true

    const load = async () => {
      try {
        const nextConfig = await getAppConfig()
        if (active && nextConfig) setConfig(nextConfig)
      } catch {
        // noop
      }
      try {
        const status = await window.electronAPI?.updates?.getStatus?.()
        if (active && status) setUpdateState(status)
      } catch {
        // noop
      }
    }

    load()

    const unsubscribe = window.electronAPI?.updates?.onStatus?.((payload) => {
      if (!active || !payload) return
      setUpdateState(payload)
    })

    return () => {
      active = false
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  const status = updateState?.status || 'idle'
  const progress = useMemo(() => {
    const raw = Number(updateState?.progress ?? 0)
    if (!Number.isFinite(raw)) return 0
    return Math.max(0, Math.min(100, raw))
  }, [updateState?.progress])

  const canCheck = ['idle', 'not-available', 'error'].includes(status)
  const canDownload = status === 'available'
  const canInstall = status === 'downloaded'
  const isBusy = ['checking', 'downloading', 'installing'].includes(status)
  const isDisabled = status === 'disabled'

  const handleCheck = async () => {
    if (isDisabled || isBusy) return
    try {
      await window.electronAPI?.updates?.check?.()
    } catch {
      // noop
    }
  }

  const handleDownload = async () => {
    if (isDisabled || isBusy) return
    try {
      await window.electronAPI?.updates?.download?.()
    } catch {
      // noop
    }
  }

  const handleInstall = async () => {
    if (isDisabled || isBusy) return
    try {
      await window.electronAPI?.updates?.install?.()
    } catch {
      // noop
    }
  }

  const handleSelectWorkDir = async () => {
    if (isBusy) return
    try {
      const result = await selectWorkDir()
      if (result?.config) {
        setConfig(result.config)
        return
      }
      if (result?.workDir) {
        setConfig((prev) => ({ ...prev, workDir: result.workDir }))
      }
    } catch {
      // noop
    }
  }

  if (!isDesktop()) return null

  return (
    <div className="desktop-controls">
      <div className="desktop-section">
        <div className="desktop-title">Atualizacoes</div>
        <div className="desktop-meta">
          {updateState?.message || (isDisabled ? 'Atualizacoes indisponiveis.' : 'Pronto para verificar.')}
        </div>
        {status === 'downloading' ? (
          <div className="progress-bar">
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        <div className="desktop-actions">
          {canCheck ? (
            <button className="btn btn-secondary btn-compact" type="button" onClick={handleCheck} disabled={isDisabled}>
              Atualizar agora
            </button>
          ) : null}
          {canDownload ? (
            <button className="btn btn-primary btn-compact" type="button" onClick={handleDownload}>
              Baixar atualizacao
            </button>
          ) : null}
          {canInstall ? (
            <button className="btn btn-primary btn-compact" type="button" onClick={handleInstall}>
              Reiniciar e atualizar
            </button>
          ) : null}
          {isBusy && !canDownload && !canInstall ? (
            <span className="muted">Processando...</span>
          ) : null}
        </div>
      </div>
      <div className="desktop-section">
        <div className="desktop-title">Pasta de trabalho</div>
        <div className="desktop-meta desktop-path">
          {config.workDir ? config.workDir : 'Nenhuma pasta vinculada.'}
        </div>
        <div className="desktop-actions">
          <button className="btn btn-secondary btn-compact" type="button" onClick={handleSelectWorkDir}>
            Selecionar pasta
          </button>
        </div>
      </div>
    </div>
  )
}

export default DesktopControls
