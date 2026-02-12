import { useEffect, useMemo, useState } from 'react'
import { isDesktop } from '../services/nativeStorage'

const formatBytes = (value) => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let current = amount
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024
    index += 1
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

const DesktopControls = () => {
  const [updateState, setUpdateState] = useState({
    status: 'idle',
    message: '',
    progress: 0,
    bytesPerSecond: 0,
    transferred: 0,
    total: 0,
  })
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    if (!isDesktop()) return undefined
    let active = true
    const unsubscribers = []

    const handleStateEvent = (payload) => {
      if (!payload) return
      const state = String(payload.state || '')
      if (!state) return
      if (state === 'checking') {
        setUpdateState((prev) => ({
          ...prev,
          status: 'checking',
          message: 'Verificando atualizacoes...',
          progress: 0,
          bytesPerSecond: 0,
          transferred: 0,
          total: 0,
        }))
        return
      }
      if (state === 'available') {
        setUpdateState((prev) => ({
          ...prev,
          status: 'available',
          info: payload.info,
          message: 'Atualizacao disponivel.',
          progress: 0,
          bytesPerSecond: 0,
          transferred: 0,
          total: 0,
        }))
        return
      }
      if (state === 'not-available') {
        setUpdateState((prev) => ({
          ...prev,
          status: 'not-available',
          info: payload.info,
          message: 'Nenhuma atualizacao encontrada.',
          progress: 0,
          bytesPerSecond: 0,
          transferred: 0,
          total: 0,
        }))
        return
      }
      if (state === 'downloaded') {
        setUpdateState((prev) => ({
          ...prev,
          status: 'downloaded',
          info: payload.info,
          message: 'Atualizacao pronta para instalar.',
          progress: 100,
          bytesPerSecond: 0,
        }))
        return
      }
      if (state === 'error') {
        const message = payload.message ? String(payload.message) : 'Falha ao atualizar.'
        setUpdateState((prev) => ({
          ...prev,
          status: 'error',
          message,
          progress: 0,
          bytesPerSecond: 0,
          transferred: 0,
          total: 0,
        }))
      }
    }

    const handleProgressEvent = (payload) => {
      if (!payload) return
      const raw = Number(payload.percent ?? payload.progress ?? 0)
      const progress = Number.isFinite(raw) ? raw : 0
      setUpdateState((prev) => ({
        ...prev,
        status: 'downloading',
        progress,
        bytesPerSecond: Number.isFinite(payload.bytesPerSecond) ? payload.bytesPerSecond : 0,
        transferred: Number.isFinite(payload.transferred) ? payload.transferred : 0,
        total: Number.isFinite(payload.total) ? payload.total : 0,
        message: 'Baixando atualizacao...',
      }))
    }

    const load = async () => {
      try {
        const status = await window.electronAPI?.updates?.getStatus?.()
        if (active && status) setUpdateState(status)
      } catch {
        // noop
      }
      try {
        const version = await window.electronAPI?.app?.getVersion?.()
        if (active && version) setAppVersion(String(version))
      } catch {
        // noop
      }
    }

    load()

    const unsubscribeStatus = window.electronAPI?.updates?.onStatus?.((payload) => {
      if (!active || !payload) return
      setUpdateState(payload)
    })

    if (typeof unsubscribeStatus === 'function') unsubscribers.push(unsubscribeStatus)

    const unsubscribeState = window.electronAPI?.updates?.onState?.((payload) => {
      if (!active || !payload) return
      handleStateEvent(payload)
    })

    if (typeof unsubscribeState === 'function') unsubscribers.push(unsubscribeState)

    const unsubscribeProgress = window.electronAPI?.updates?.onProgress?.((payload) => {
      if (!active || !payload) return
      handleProgressEvent(payload)
    })

    if (typeof unsubscribeProgress === 'function') unsubscribers.push(unsubscribeProgress)

    return () => {
      active = false
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [])

  const status = updateState?.status || 'idle'
  const progress = useMemo(() => {
    const raw = Number(updateState?.progress ?? 0)
    if (!Number.isFinite(raw)) return 0
    return Math.max(0, Math.min(100, raw))
  }, [updateState?.progress])

  const canDownload = status === 'available'
  const canInstall = status === 'downloaded'
  const isBusy = ['checking', 'downloading', 'installing'].includes(status)
  const isDisabled = status === 'disabled'
  const isDownloading = status === 'downloading'
  const hasTotal = Number.isFinite(updateState?.total) && updateState.total > 0
  const isIndeterminate = isDownloading && progress <= 0 && !hasTotal
  const statusMessage = useMemo(() => {
    if (status === 'downloading') {
      const rounded = Math.round(progress)
      return `Baixando atualizacao... ${rounded}%`
    }
    return updateState?.message || (isDisabled ? 'Atualizacoes indisponiveis.' : 'Pronto para verificar.')
  }, [isDisabled, progress, status, updateState?.message])
  const progressDetails = useMemo(() => {
    if (status !== 'downloading') return ''
    const parts = []
    const percent = Number.isFinite(progress) ? Math.round(progress) : 0
    if (percent > 0) parts.push(`${percent}%`)
    const transferred = formatBytes(updateState?.transferred)
    const total = formatBytes(updateState?.total)
    if (transferred && total) parts.push(`${transferred} / ${total}`)
    const speed = formatBytes(updateState?.bytesPerSecond)
    if (speed) parts.push(`${speed}/s`)
    return parts.join(' | ')
  }, [progress, status, updateState?.bytesPerSecond, updateState?.total, updateState?.transferred])
  const primaryAction = useMemo(() => {
    if (isDisabled) return { label: 'Atualizacoes indisponiveis', action: null, disabled: true }
    if (status === 'checking') return { label: 'Verificando...', action: null, disabled: true }
    if (status === 'downloading') return { label: 'Baixando...', action: null, disabled: true }
    if (status === 'installing') return { label: 'Instalando...', action: null, disabled: true }
    if (canInstall) return { label: 'Reiniciar e atualizar', action: 'install', disabled: false }
    if (canDownload) return { label: 'Baixar atualizacao', action: 'download', disabled: false }
    return { label: 'Atualizar agora', action: 'check', disabled: false }
  }, [canDownload, canInstall, isDisabled, status])

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
    setUpdateState((prev) => ({
      ...prev,
      status: 'downloading',
      message: 'Baixando atualizacao...',
      progress: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
    }))
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
  const handlePrimaryAction = async () => {
    if (primaryAction.disabled) return
    if (primaryAction.action === 'install') return handleInstall()
    if (primaryAction.action === 'download') return handleDownload()
    return handleCheck()
  }

  if (!isDesktop()) return null

  return (
    <div className="desktop-controls">
      <div className="desktop-section">
        <div className="desktop-title">Atualizacoes</div>
        <div className="desktop-meta">
          {statusMessage}
        </div>
        {isDownloading ? (
          <>
            <div
              className={`progress-bar${isIndeterminate ? ' indeterminate' : ''}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={isIndeterminate ? undefined : Math.round(progress)}
              aria-valuetext={statusMessage}
            >
              <span style={isIndeterminate ? undefined : { width: `${progress}%` }} />
            </div>
            {progressDetails ? <div className="muted">{progressDetails}</div> : null}
          </>
        ) : null}
        <div className="desktop-actions">
          <button
            className="btn btn-primary btn-compact"
            type="button"
            onClick={handlePrimaryAction}
            disabled={primaryAction.disabled}
          >
            {primaryAction.label}
          </button>
        </div>
        {appVersion ? <div className="desktop-meta">Versao da plataforma: {appVersion}</div> : null}
      </div>
    </div>
  )
}

export default DesktopControls
