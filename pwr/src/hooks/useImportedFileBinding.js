import { useCallback, useEffect, useMemo, useState } from 'react'
import { getCurrentUserKey } from '../services/currentUser'
import {
  IMPORT_BINDINGS_EVENT,
  IMPORT_CATALOG_EVENT,
  ensureImportCatalogMigrated,
  findCatalogFilesForBinding,
  getBindingFile,
  loadImportBinding,
  loadImportCatalog,
  saveImportBinding,
} from '../services/importCatalog'

const getFileOptionLabel = (file) => String(file?.fileName || file?.name || '').trim() || 'Arquivo'

const useImportedFileBinding = (bindingKey, roleKey = 'default') => {
  const userKey = getCurrentUserKey()
  const [catalog, setCatalog] = useState(null)
  const [options, setOptions] = useState([])
  const [value, setValueState] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [missing, setMissing] = useState(false)
  const [loading, setLoading] = useState(false)

  const refreshFromCatalog = useCallback(async () => {
    if (!userKey || !bindingKey) {
      setCatalog(null)
      setOptions([])
      setValueState('')
      setSelectedFile(null)
      setMissing(false)
      return null
    }

    setLoading(true)
    try {
      await ensureImportCatalogMigrated(userKey)
      const nextCatalog = loadImportCatalog(userKey)
      const nextBinding = loadImportBinding(userKey, bindingKey, roleKey)
      const files = findCatalogFilesForBinding(userKey, bindingKey, roleKey, { catalog: nextCatalog })
      const currentFile = nextBinding?.fileId
        ? getBindingFile(userKey, bindingKey, roleKey, { catalog: nextCatalog })
        : null

      setCatalog(nextCatalog || null)
      setOptions(files.map((file) => ({
        value: file.id,
        label: getFileOptionLabel(file),
        description: file.relativePath || file.filePath || file.folderPath || '',
        file,
      })))
      setSelectedFile(currentFile || null)
      setMissing(Boolean(nextBinding?.fileId) && !currentFile)
      setValueState(currentFile?.id || '')
      return currentFile || null
    } finally {
      setLoading(false)
    }
  }, [bindingKey, roleKey, userKey])

  useEffect(() => {
    void refreshFromCatalog()
  }, [refreshFromCatalog])

  useEffect(() => {
    const handler = (event) => {
      const detailUserKey = String(event?.detail?.userKey || '').trim()
      if (detailUserKey && detailUserKey !== String(userKey || '')) return
      void refreshFromCatalog()
    }
    window.addEventListener(IMPORT_CATALOG_EVENT, handler)
    window.addEventListener(IMPORT_BINDINGS_EVENT, handler)
    return () => {
      window.removeEventListener(IMPORT_CATALOG_EVENT, handler)
      window.removeEventListener(IMPORT_BINDINGS_EVENT, handler)
    }
  }, [refreshFromCatalog, userKey])

  const setValue = useCallback((nextValue) => {
    if (!userKey || !bindingKey) return
    const normalized = String(nextValue || '').trim()
    saveImportBinding(userKey, bindingKey, roleKey, normalized)
    const nextSelected = options.find((option) => option.value === normalized)?.file || null
    setValueState(nextSelected?.id || '')
    setSelectedFile(nextSelected)
    setMissing(false)
  }, [bindingKey, options, roleKey, userKey])

  const emptyMessage = useMemo(() => {
    if (loading) return ''
    if (!catalog?.files?.length) return 'Importe uma pasta no menu lateral para habilitar os arquivos.'
    if (!options.length) return 'Nenhum arquivo importado disponivel para este modulo.'
    if (missing) return 'O arquivo vinculado nao existe mais na importacao atual.'
    return ''
  }, [catalog?.files?.length, loading, missing, options.length])

  return {
    catalog,
    options,
    value,
    selectedFile,
    loading,
    missing,
    emptyMessage,
    setValue,
    refreshFromCatalog,
  }
}

export default useImportedFileBinding
