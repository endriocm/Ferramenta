import { useCallback, useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import { useToast } from '../hooks/useToast'
import { getCurrentUserKey } from '../services/currentUser'
import {
  clearImportBindings,
  clearImportCatalog,
  ensureImportCatalogMigrated,
  IMPORT_CATALOG_EVENT,
  loadImportCatalog,
  saveImportCatalog,
} from '../services/importCatalog'

const formatDateTimeLabel = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const Importacao = () => {
  const { notify } = useToast()
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState(null)

  const recentFiles = useMemo(() => (
    [...(catalog?.files || [])]
      .sort((left, right) => (Number(right?.lastModified || 0) - Number(left?.lastModified || 0)))
      .slice(0, 5)
  ), [catalog?.files])

  const allFiles = useMemo(() => (
    [...(catalog?.files || [])]
      .sort((left, right) => String(left?.relativePath || '').localeCompare(String(right?.relativePath || ''), 'pt-BR'))
  ), [catalog?.files])

  const refreshCatalog = useCallback(async () => {
    const userKey = getCurrentUserKey()
    if (!userKey) {
      setCatalog(null)
      return null
    }
    await ensureImportCatalogMigrated(userKey)
    const nextCatalog = loadImportCatalog(userKey)
    setCatalog(nextCatalog)
    return nextCatalog
  }, [])

  useEffect(() => {
    void refreshCatalog()

    const handleCatalogUpdated = (event) => {
      const detailUserKey = String(event?.detail?.userKey || '').trim()
      const userKey = String(getCurrentUserKey() || '').trim()
      if (detailUserKey && detailUserKey !== userKey) return
      setCatalog(loadImportCatalog(userKey))
    }

    window.addEventListener(IMPORT_CATALOG_EVENT, handleCatalogUpdated)
    return () => window.removeEventListener(IMPORT_CATALOG_EVENT, handleCatalogUpdated)
  }, [refreshCatalog])

  const handleSelectFolder = useCallback(async () => {
    if (busy) return
    const userKey = getCurrentUserKey()
    const selectFn = window?.electronAPI?.selectImportFolder
    if (!userKey || typeof selectFn !== 'function') {
      notify('Importacao central disponivel apenas no app desktop.', 'warning')
      return
    }

    setBusy(true)
    try {
      const result = await selectFn()
      if (!result?.folderPath) {
        notify('Selecao de pasta cancelada.', 'warning')
        return
      }
      const saved = saveImportCatalog(userKey, {
        rootPath: result.folderPath,
        rootName: result.folderName,
        scannedAt: Date.now(),
        files: result.files,
      })
      setCatalog(saved)
      notify(`Importacao atualizada. ${saved?.fileCount || 0} planilha(s) catalogada(s).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao importar pasta: ${error.message}` : 'Falha ao importar pasta.', 'warning')
    } finally {
      setBusy(false)
    }
  }, [busy, notify])

  const handleRescan = useCallback(async () => {
    if (busy) return
    const userKey = getCurrentUserKey()
    const rootPath = String(catalog?.rootPath || '').trim()
    const scanFn = window?.electronAPI?.scanImportFolder
    if (!userKey || !rootPath || typeof scanFn !== 'function') {
      notify('Nenhuma pasta de importacao disponivel para reimportar.', 'warning')
      return
    }

    setBusy(true)
    try {
      const files = await scanFn(rootPath)
      const saved = saveImportCatalog(userKey, {
        rootPath,
        rootName: catalog?.rootName,
        scannedAt: Date.now(),
        files,
      })
      setCatalog(saved)
      notify(`Reimportacao concluida. ${saved?.fileCount || 0} planilha(s) catalogada(s).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao reimportar: ${error.message}` : 'Falha ao reimportar pasta.', 'warning')
    } finally {
      setBusy(false)
    }
  }, [busy, catalog?.rootName, catalog?.rootPath, notify])

  const handleClear = useCallback(async () => {
    if (busy) return
    const userKey = getCurrentUserKey()
    if (!userKey) return

    setBusy(true)
    try {
      clearImportCatalog(userKey)
      clearImportBindings(userKey)
      setCatalog(null)
      notify('Importacao central limpa.', 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao limpar importacao: ${error.message}` : 'Falha ao limpar importacao.', 'warning')
    } finally {
      setBusy(false)
    }
  }, [busy, notify])

  return (
    <div className="page">
      <PageHeader
        title="Importacao"
        subtitle="Selecione uma pasta raiz, catalogue as planilhas recursivamente e use esses arquivos nos outros modulos."
        meta={[
          { label: 'Pasta atual', value: catalog?.rootName || 'Nenhuma' },
          { label: 'Planilhas', value: catalog?.fileCount || 0 },
          { label: 'Ultima varredura', value: catalog?.scannedAt ? formatDateTimeLabel(catalog.scannedAt) : '-' },
        ]}
        actions={[
          { label: busy ? 'Processando...' : 'Selecionar pasta', icon: 'upload', variant: 'btn-secondary', onClick: handleSelectFolder, disabled: busy },
          { label: 'Reimportar', icon: 'sync', variant: 'btn-secondary', onClick: handleRescan, disabled: busy || !catalog?.rootPath },
          { label: 'Limpar importacao', icon: 'close', variant: 'btn-danger', onClick: handleClear, disabled: busy || !catalog?.fileCount },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Resumo da pasta</h3>
            <p className="muted">A varredura busca planilhas em todas as subpastas, de forma recursiva.</p>
          </div>
        </div>
        <div className="sync-result">
          <div>
            <strong>{catalog?.rootPath || 'Nenhuma pasta selecionada'}</strong>
            <span className="muted">Caminho raiz</span>
          </div>
          <div>
            <strong>{catalog?.fileCount || 0}</strong>
            <span className="muted">Planilhas catalogadas</span>
          </div>
          <div>
            <strong>{catalog?.scannedAt ? formatDateTimeLabel(catalog.scannedAt) : '-'}</strong>
            <span className="muted">Ultima varredura</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Arquivos mais recentes</h3>
            <p className="muted">Os modulos usam estes arquivos vinculados a partir deste catalogo.</p>
          </div>
        </div>
        {recentFiles.length ? (
          <div className="file-picker-list">
            {recentFiles.map((file) => (
              <div key={file.id} className="file-picker-item">
                <div>
                  <strong>{file.fileName}</strong>
                  <div className="muted">{file.relativePath || file.filePath}</div>
                </div>
                <span className="muted">{formatDateTimeLabel(file.lastModified)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">Nenhuma planilha catalogada ainda.</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Catalogo completo</h3>
            <p className="muted">Lista de arquivos disponiveis para os vinculos dos modulos.</p>
          </div>
        </div>
        {allFiles.length ? (
          <div className="file-picker-list">
            {allFiles.map((file) => (
              <div key={file.id} className="file-picker-item">
                <div>
                  <strong>{file.fileName}</strong>
                  <div className="muted">{file.relativePath || file.filePath}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">Nenhum arquivo disponivel.</div>
        )}
      </section>
    </div>
  )
}

export default Importacao
