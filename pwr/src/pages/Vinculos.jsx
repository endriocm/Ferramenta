import { useCallback, useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Badge from '../components/Badge'
import { useToast } from '../hooks/useToast'
import { getCurrentUserKey } from '../services/currentUser'
import { formatNumber } from '../utils/format'
import {
  IMPORT_BINDING_REGISTRY,
  IMPORT_BINDINGS_EVENT,
  IMPORT_CATALOG_EVENT,
  ensureImportCatalogMigrated,
  findCatalogFilesForBinding,
  loadImportBindings,
  loadImportCatalog,
  saveImportBinding,
  saveImportCatalog,
} from '../services/importCatalog'
import { syncAllMenus } from '../services/globalSyncAll'

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

const Vinculos = () => {
  const { notify } = useToast()
  const [userKey] = useState(() => getCurrentUserKey())
  const [catalog, setCatalog] = useState(null)
  const [bindings, setBindings] = useState({ version: 1, entries: [] })
  const [syncing, setSyncing] = useState(false)
  const [syncResults, setSyncResults] = useState(null)
  const [syncProgress, setSyncProgress] = useState(null)
  const [scanning, setScanning] = useState(false)

  const refreshAll = useCallback(async () => {
    if (!userKey) return
    await ensureImportCatalogMigrated(userKey)
    setCatalog(loadImportCatalog(userKey))
    setBindings(loadImportBindings(userKey))
  }, [userKey])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    const handler = (event) => {
      const detailUserKey = String(event?.detail?.userKey || '').trim()
      if (detailUserKey && detailUserKey !== String(userKey || '')) return
      setCatalog(loadImportCatalog(userKey))
      setBindings(loadImportBindings(userKey))
    }
    window.addEventListener(IMPORT_CATALOG_EVENT, handler)
    window.addEventListener(IMPORT_BINDINGS_EVENT, handler)
    return () => {
      window.removeEventListener(IMPORT_CATALOG_EVENT, handler)
      window.removeEventListener(IMPORT_BINDINGS_EVENT, handler)
    }
  }, [userKey])

  const bindingRows = useMemo(() => {
    return IMPORT_BINDING_REGISTRY.map((spec) => {
      const entry = (bindings?.entries || []).find(
        (e) => e.bindingKey === spec.bindingKey && e.roleKey === spec.roleKey,
      )
      const files = catalog ? findCatalogFilesForBinding(userKey, spec.bindingKey, spec.roleKey, { catalog }) : []
      const boundFile = entry?.fileId
        ? (catalog?.files || []).find((f) => f.id === entry.fileId) || null
        : null
      return {
        spec,
        entry,
        files,
        boundFile,
        boundFileId: entry?.fileId || '',
      }
    })
  }, [bindings, catalog, userKey])

  const activeCount = useMemo(
    () => bindingRows.filter((r) => r.boundFile).length,
    [bindingRows],
  )

  const handleChangeBinding = useCallback((bindingKey, roleKey, fileId) => {
    if (!userKey) return
    saveImportBinding(userKey, bindingKey, roleKey, fileId)
    setBindings(loadImportBindings(userKey))
  }, [userKey])

  const handleRescan = useCallback(async () => {
    if (scanning) return
    const rootPath = String(catalog?.rootPath || '').trim()
    const scanFn = window?.electronAPI?.scanImportFolder
    if (!userKey || !rootPath || typeof scanFn !== 'function') {
      notify('Nenhuma pasta de importacao disponivel. Importe uma pasta em Dados > Importacao.', 'warning')
      return
    }
    setScanning(true)
    try {
      const files = await scanFn(rootPath)
      const saved = saveImportCatalog(userKey, {
        rootPath,
        rootName: catalog?.rootName,
        scannedAt: Date.now(),
        files,
      })
      setCatalog(saved)
      setBindings(loadImportBindings(userKey))
      notify(`Reimportacao concluida. ${saved?.fileCount || 0} planilha(s).`, 'success')
    } catch (error) {
      notify(error?.message || 'Falha ao reimportar pasta.', 'warning')
    } finally {
      setScanning(false)
    }
  }, [catalog?.rootName, catalog?.rootPath, notify, scanning, userKey])

  const handleSyncAll = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setSyncResults(null)
    setSyncProgress(null)
    try {
      const result = await syncAllMenus({
        onProgress: (info) => {
          setSyncProgress({ ...info })
        },
      })
      setSyncResults(result)
      const msg = `Sincronizacao concluida: ${result.successCount} sucesso, ${result.failCount} falha(s), ${result.skipCount} ignorado(s).`
      notify(msg, result.failCount ? 'warning' : 'success')
    } catch (error) {
      notify(error?.message || 'Falha na sincronizacao geral.', 'warning')
    } finally {
      setSyncing(false)
    }
  }, [notify, syncing])

  const syncProgressLabel = syncProgress
    ? `Processando ${syncProgress.label || syncProgress.menuKey} (${(syncProgress.index || 0) + 1}/${syncProgress.total || '?'})...`
    : null

  return (
    <div className="page">
      <PageHeader
        title="Vinculos e Sincronizacao"
        subtitle="Gerencie os arquivos vinculados a cada modulo e sincronize tudo de uma vez."
        meta={[
          { label: 'Pasta', value: catalog?.rootName || 'Nenhuma' },
          { label: 'Planilhas', value: formatNumber(catalog?.fileCount || 0) },
          { label: 'Vinculos ativos', value: `${activeCount} / ${IMPORT_BINDING_REGISTRY.length}` },
        ]}
        actions={[
          {
            label: scanning ? 'Reimportando...' : 'Reimportar pasta',
            icon: 'sync',
            variant: 'btn-secondary',
            onClick: handleRescan,
            disabled: scanning || syncing || !catalog?.rootPath,
          },
          {
            label: syncing ? 'Sincronizando...' : 'Sincronizar tudo',
            icon: 'sync',
            variant: 'btn-primary',
            onClick: handleSyncAll,
            disabled: syncing || scanning || !activeCount,
          },
        ]}
      />

      {syncing && syncProgressLabel ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Progresso</h3>
              <p className="muted">{syncProgressLabel}</p>
            </div>
          </div>
          <div className="progress-bar indeterminate" role="progressbar" aria-valuenow={0} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: '40%' }} />
          </div>
        </section>
      ) : null}

      {syncResults ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Resultado da sincronizacao</h3>
            </div>
          </div>
          <div className="sync-result">
            <div>
              <strong>{syncResults.successCount}</strong>
              <span>Sucesso</span>
            </div>
            <div>
              <strong>{syncResults.failCount}</strong>
              <span>Falhas</span>
            </div>
            <div>
              <strong>{syncResults.skipCount}</strong>
              <span>Ignorados</span>
            </div>
          </div>
          {Array.isArray(syncResults.results) && syncResults.results.length ? (
            <div className="file-picker-list" style={{ marginTop: 8 }}>
              {syncResults.results.map((item) => (
                <div key={item.menuKey} className="file-picker-item">
                  <div>
                    <strong>{item.label || item.menuKey}</strong>
                    {item.ok ? (
                      <span className="muted">{formatNumber(item.imported || 0)} linha(s) importada(s)</span>
                    ) : (
                      <span style={{ color: 'var(--color-text-danger, #ef4444)' }}>{item.error || 'Falha'}</span>
                    )}
                  </div>
                  <Badge tone={item.ok ? 'green' : 'amber'}>{item.ok ? 'OK' : 'Erro'}</Badge>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Vinculos por modulo</h3>
            <p className="muted">
              Escolha qual planilha do catalogo sera usada em cada aba.
              Depois clique em &quot;Sincronizar tudo&quot; para processar todos de uma vez.
            </p>
          </div>
        </div>

        <div className="file-picker-list">
          {bindingRows.map((row) => {
            const key = `${row.spec.bindingKey}.${row.spec.roleKey}`
            return (
              <div key={key} className="file-picker-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>{row.spec.label}</strong>
                  {row.boundFile ? (
                    <Badge tone="green">Vinculado</Badge>
                  ) : (
                    <Badge tone="amber">Sem vinculo</Badge>
                  )}
                </div>
                <select
                  className="input"
                  value={row.boundFileId}
                  onChange={(event) => handleChangeBinding(row.spec.bindingKey, row.spec.roleKey, event.target.value)}
                  disabled={syncing || !row.files.length}
                >
                  <option value="">— Nenhum arquivo selecionado —</option>
                  {row.files.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.fileName} ({file.relativePath || file.filePath || ''})
                    </option>
                  ))}
                </select>
                {row.boundFile ? (
                  <span className="muted" style={{ fontSize: '0.82em' }}>
                    {row.boundFile.relativePath || row.boundFile.filePath}
                    {row.boundFile.lastModified ? ` — ${formatDateTimeLabel(row.boundFile.lastModified)}` : ''}
                  </span>
                ) : row.files.length === 0 ? (
                  <span className="muted" style={{ fontSize: '0.82em' }}>
                    Nenhuma planilha disponivel. Importe uma pasta em Dados &gt; Importacao.
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

export default Vinculos
