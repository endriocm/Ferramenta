/**
 * Compatibility wrapper for pages that still speak in "global folder" terms.
 *
 * The new source of truth is the imported-file catalog. This hook keeps the
 * old shape (`directoryOptions`, `directoryValue`, `resolvedFile`) so pages can
 * be migrated incrementally without breaking runtime behavior.
 */

import { useMemo } from 'react'
import useImportedFileBinding from './useImportedFileBinding'

const useGlobalFolderMenu = (menuKey) => {
  const binding = useImportedFileBinding(menuKey)

  const directoryOptions = useMemo(() => (
    binding.options.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      directory: {
        ...option.file,
        // Older pages read `option.directory.folderPath` to render the helper.
        folderPath: option.description || option.file?.folderPath || '',
      },
    }))
  ), [binding.options])

  return {
    directoryOptions,
    directoryValue: binding.value,
    onDirectoryChange: binding.setValue,
    loading: binding.loading,
    emptyMessage: binding.emptyMessage,
    resolvedFile: binding.selectedFile,
    globalFolderLink: binding.catalog,
    refreshFile: binding.refreshFromCatalog,
  }
}

export default useGlobalFolderMenu
