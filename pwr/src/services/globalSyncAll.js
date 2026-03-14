/**
 * Centralised "Sync-All" runner.
 *
 * Reads global-folder mappings for every registered menu,
 * resolves the best spreadsheet from each mapped subfolder,
 * calls the appropriate parser + saver, and emits update events.
 *
 * Designed to run from the Topbar without any specific page mounted.
 */

import { IMPORT_BINDING_REGISTRY, loadImportBindings, loadImportCatalog } from './importCatalog'
import { getCurrentUserKey } from './currentUser'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Read a file via Electron into ArrayBuffer.
 */
const readElectronFile = async (filePath) => {
  const readFn = window?.electronAPI?.readFile
  if (typeof readFn !== 'function') return null
  return readFn(filePath)
}

/**
 * Convert raw Buffer / Uint8Array / ArrayBuffer into ArrayBuffer.
 */
const toArrayBuffer = (raw) => {
  if (!raw) return null
  if (raw instanceof ArrayBuffer) return raw
  if (raw instanceof Uint8Array) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  if (raw?.buffer instanceof ArrayBuffer) return raw.buffer
  return null
}

/* ------------------------------------------------------------------ */
/*  Per-module sync functions (lazy-imported)                          */
/* ------------------------------------------------------------------ */

const syncEstruturadasModule = async (file, { tagIndex }) => {
  const { parseStructuredReceitasFile } = await import('./revenueImport')
  const { saveStructuredRevenue } = await import('./revenueStructured')
  const result = await parseStructuredReceitasFile(file, { tagIndex })
  if (!result.ok) return { ok: false, error: result.error?.message || 'Falha na importacao' }
  const entries = Array.isArray(result.entries) ? result.entries : []
  saveStructuredRevenue(entries)
  return { ok: true, imported: entries.length }
}

const syncBovespaModule = async (file, { tagIndex }) => {
  const { parseBovespaReceitasFile } = await import('./revenueImport')
  const { saveRevenueList } = await import('./revenueStore')
  const result = await parseBovespaReceitasFile(file, {
    mercado: 'bov',
    fatorReceita: 0.9335 * 0.8285,
    tagIndex,
  })
  if (!result.ok) return { ok: false, error: result.error?.message || 'Falha na importacao' }
  const entries = Array.isArray(result.entries) ? result.entries : []
  saveRevenueList('bovespa', entries)
  return { ok: true, imported: entries.length }
}

const syncBmfModule = async (file, { tagIndex }) => {
  const { parseBovespaReceitasFile } = await import('./revenueImport')
  const { saveRevenueList } = await import('./revenueStore')
  const result = await parseBovespaReceitasFile(file, {
    mercado: 'bmf',
    fatorReceita: 0.9435 * 0.8285,
    tagIndex,
  })
  if (!result.ok) return { ok: false, error: result.error?.message || 'Falha na importacao' }
  const entries = Array.isArray(result.entries) ? result.entries : []
  saveRevenueList('bmf', entries)
  return { ok: true, imported: entries.length }
}

const syncComissaoXpModule = async (file, { tagIndex }) => {
  const { parseXpCommissionFile } = await import('./revenueImport')
  const { saveXpRevenue } = await import('./revenueXpCommission')
  const result = await parseXpCommissionFile(file, { tagIndex })
  if (!result.ok) return { ok: false, error: result.error?.message || 'Falha na importacao' }
  const entries = Array.isArray(result.entries) ? result.entries : []
  await saveXpRevenue(entries)
  return { ok: true, imported: entries.length }
}

const syncTagsModule = async (file, { userKey }) => {
  const { parseTagsXlsx, saveTags } = await import('./tags')
  const parsed = await parseTagsXlsx(file)
  await saveTags(userKey, parsed)
  window.dispatchEvent(new CustomEvent('pwr:tags-updated', { detail: { userKey } }))
  return { ok: true, imported: parsed?.stats?.totalRows ?? 0 }
}

const syncVencimentoModule = async (file, { userKey }) => {
  const { parseWorkbookBuffer } = await import('./excel')
  const { saveLastImported } = await import('./vencimentoCache')
  const { saveLink } = await import('./vencimentoLink')

  let buffer = null
  if (file?.filePath && window?.electronAPI?.readFile) {
    const raw = await readElectronFile(file.filePath)
    buffer = toArrayBuffer(raw)
  }
  if (!buffer) return { ok: false, error: 'Nao foi possivel ler o arquivo.' }

  const rows = await parseWorkbookBuffer(buffer)
  if (!rows || !rows.length) return { ok: false, error: 'Nenhuma linha encontrada.' }

  saveLastImported(userKey, {
    rows,
    fileName: file.fileName || file.name || '',
    importedAt: Date.now(),
    source: 'electron',
  })
  await saveLink(userKey, {
    source: 'electron',
    folderPath: file.folderPath || '',
    fileName: file.fileName || file.name || '',
  })

  const broadcastEvent = new CustomEvent('pwr:vencimento-broadcast', {
    detail: { kind: 'cache', userKey },
  })
  window.dispatchEvent(broadcastEvent)
  return { ok: true, imported: rows.length }
}

const syncProjecaoVencimentoModule = async (file, { userKey }) => {
  // Projecao uses the same data source as Vencimento.
  // Re-running the parse and saving to vencimento cache is enough;
  // when the Projecao page opens it re-reads from the shared cache.
  return syncVencimentoModule(file, { userKey })
}

const syncAntecipacaoModule = async (file, { userKey }) => {
  const { parseAntecipacaoWorkbookBuffer } = await import('./antecipacaoParser')

  let buffer = null
  if (file?.filePath && window?.electronAPI?.readFile) {
    const raw = await readElectronFile(file.filePath)
    buffer = toArrayBuffer(raw)
  } else {
    buffer = toArrayBuffer(file)
  }

  if (!buffer) return { ok: false, error: 'Nao foi possivel ler o arquivo.' }

  const rows = await parseAntecipacaoWorkbookBuffer(buffer)
  const storageKey = `pwr.antecipacao.state.${String(userKey || 'guest').trim() || 'guest'}`
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    rows: Array.isArray(rows) ? rows : [],
    importMeta: {
      fileName: file?.fileName || file?.name || '',
      importedAt: new Date().toISOString(),
    },
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(payload))
  } catch {
    return { ok: false, error: 'Falha ao salvar os dados da importacao.' }
  }
  return { ok: true, imported: payload.rows.length }
}

const syncHistoricoOperacoesModule = async (file, { userKey }) => {
  const { parseHistoricoWorkbookBuffer } = await import('./historicoOperacoesParser')
  const {
    buildHistoricalRowFromParsedRow,
    replaceHistoricoLegacyRows,
  } = await import('./historicoOperacoes')

  let buffer = null
  if (file?.filePath && window?.electronAPI?.readFile) {
    const raw = await readElectronFile(file.filePath)
    buffer = toArrayBuffer(raw)
  } else {
    buffer = toArrayBuffer(file)
  }

  if (!buffer) return { ok: false, error: 'Nao foi possivel ler o arquivo.' }

  const rows = await parseHistoricoWorkbookBuffer(buffer)
  const legacyRows = Array.isArray(rows) ? rows.map((row) => buildHistoricalRowFromParsedRow(row)) : []
  try {
    replaceHistoricoLegacyRows(legacyRows, {
      fileName: file?.fileName || file?.name || '',
      importedAt: new Date().toISOString(),
    }, userKey)
  } catch {
    return { ok: false, error: 'Falha ao salvar os dados da importacao.' }
  }
  return { ok: true, imported: legacyRows.length }
}

const MODULE_RUNNERS = {
  estruturadas: syncEstruturadasModule,
  bovespa: syncBovespaModule,
  bmf: syncBmfModule,
  'comissao-xp': syncComissaoXpModule,
  tags: syncTagsModule,
  vencimento: syncVencimentoModule,
  'projecao-vencimento': syncProjecaoVencimentoModule,
  antecipacao: syncAntecipacaoModule,
  'historico-operacoes': syncHistoricoOperacoesModule,
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

// Modules that need the file pre-read into a raw buffer before being passed to the runner.
// Vencimento and historico-operacoes handle their own file reading internally.
const PRE_READ_MODULES = new Set(['estruturadas', 'bovespa', 'bmf', 'comissao-xp', 'tags', 'antecipacao'])

/**
 * Run sync for all menus that have an active binding in the import catalog.
 *
 * @param {object} options
 * @param {function} options.onProgress – called after each item with
 *        `{ menuKey, label, index, total, ok, error, imported }`
 * @returns {Promise<{ results: object[], successCount: number, failCount: number, skipCount: number }>}
 */
export const syncAllMenus = async ({ onProgress } = {}) => {
  const userKey = getCurrentUserKey()
  if (!userKey) return { results: [], successCount: 0, failCount: 0, skipCount: 0 }

  const catalog = loadImportCatalog(userKey)
  if (!catalog) return { results: [], successCount: 0, failCount: 0, skipCount: 0 }

  const bindings = loadImportBindings(userKey)

  // Build the list of items to sync: only specs that have a runner and a bound file
  const activeItems = []
  for (const spec of IMPORT_BINDING_REGISTRY) {
    const runner = MODULE_RUNNERS[spec.bindingKey]
    if (!runner) continue
    const binding = bindings.entries.find(
      (e) => e.bindingKey === spec.bindingKey && e.roleKey === spec.roleKey,
    )
    if (!binding?.fileId) continue
    const file = (catalog.files || []).find((f) => f.id === binding.fileId)
    if (!file) continue
    activeItems.push({ spec, file, runner })
  }

  if (!activeItems.length) return { results: [], successCount: 0, failCount: 0, skipCount: 0 }

  let tagIndex = null
  try {
    const { getTagIndex } = await import('../lib/tagsStore')
    tagIndex = await getTagIndex()
  } catch {
    tagIndex = null
  }

  const results = []
  let successCount = 0
  let failCount = 0
  const skipCount = 0

  for (let i = 0; i < activeItems.length; i++) {
    const { spec, file, runner } = activeItems[i]
    try {
      let fileInput = file
      if (file.filePath && window?.electronAPI?.readFile && PRE_READ_MODULES.has(spec.bindingKey)) {
        const raw = await readElectronFile(file.filePath)
        if (!raw) {
          failCount++
          results.push({ menuKey: spec.bindingKey, label: spec.label, ok: false, error: 'Falha ao ler arquivo' })
          if (onProgress) onProgress({ menuKey: spec.bindingKey, label: spec.label, index: i, total: activeItems.length, ok: false, error: 'Falha leitura', imported: 0 })
          continue
        }
        fileInput = raw
      }

      const result = await runner(fileInput, { userKey, tagIndex })
      if (result.ok) successCount++
      else failCount++
      results.push({ menuKey: spec.bindingKey, label: spec.label, ...result })
      if (onProgress) {
        onProgress({ menuKey: spec.bindingKey, label: spec.label, index: i, total: activeItems.length, ok: result.ok, error: result.error || null, imported: result.imported || 0 })
      }
    } catch (error) {
      failCount++
      const msg = error?.message || 'Erro desconhecido'
      results.push({ menuKey: spec.bindingKey, label: spec.label, ok: false, error: msg })
      if (onProgress) {
        onProgress({ menuKey: spec.bindingKey, label: spec.label, index: i, total: activeItems.length, ok: false, error: msg, imported: 0 })
      }
    }
  }

  // Emit global update event so any mounted pages refresh their data
  window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
  window.dispatchEvent(new CustomEvent('pwr:tags-updated', { detail: { userKey } }))

  return { results, successCount, failCount, skipCount }
}
