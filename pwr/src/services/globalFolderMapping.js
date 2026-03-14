/**
 * Global Folder → Menu mapping.
 *
 * Persists which subdirectory of the global folder is linked to each menu.
 * This lets the user pick one root folder and assign a subfolder per module,
 * then "Sync All" reads every mapped folder and runs the appropriate import.
 */

const STORAGE_PREFIX = 'pwr.global.folder.mapping.'

const buildKey = (userKey, menuKey) => `${STORAGE_PREFIX}${userKey || 'anon'}.${menuKey}`

const safeParse = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Registry of menus that support global-folder sync.
 * `key`       – unique identifier stored in localStorage
 * `label`     – human-readable name shown in UI
 * `hints`     – file-name tokens used to auto-pick the best spreadsheet
 * `syncModule`– which import module / function to call during sync-all
 */
export const MENU_REGISTRY = [
  {
    key: 'estruturadas',
    label: 'Estruturadas',
    path: '/receita/estruturadas',
    hints: ['estrutur', 'operac', 'export'],
    syncModule: 'estruturadas',
  },
  {
    key: 'bovespa',
    label: 'Bovespa',
    path: '/receita/bovespa',
    hints: ['bovespa', 'bov'],
    syncModule: 'bovespa',
  },
  {
    key: 'bmf',
    label: 'BMF',
    path: '/receita/bmf',
    hints: ['bmf', 'futuro'],
    syncModule: 'bmf',
  },
  {
    key: 'comissao-xp',
    label: 'Comissao XP',
    path: '/receita/comissao-xp',
    hints: ['xp', 'comissao'],
    syncModule: 'comissao-xp',
  },
  {
    key: 'tags',
    label: 'Tags e Vinculos',
    path: '/tags',
    hints: ['tags', 'tag', 'vincul'],
    syncModule: 'tags',
  },
  {
    key: 'vencimento',
    label: 'Vencimento',
    path: '/vencimento',
    hints: ['vencimento', 'relatorio', 'posicao'],
    syncModule: 'vencimento',
  },
  {
    key: 'projecao-vencimento',
    label: 'Projecao de Vencimento',
    path: '/projecao-vencimento',
    hints: ['projecao', 'vencimento', 'relatorio', 'posicao'],
    syncModule: 'projecao-vencimento',
  },
  {
    key: 'historico-operacoes',
    label: 'Historico de Operacoes',
    path: '/historico-operacoes',
    hints: ['historico', 'vencimento', 'estruturas'],
    syncModule: 'historico-operacoes',
  },
  {
    key: 'antecipacao',
    label: 'Antecipacao',
    path: '/antecipacao',
    hints: ['antecipacao', 'antecip', 'posicoesdisponiveis'],
    syncModule: 'antecipacao',
  },
]

/**
 * Save the mapping: which directory (from the global folder) is linked to a menu.
 */
export const saveMenuMapping = (userKey, menuKey, directoryInfo) => {
  if (!userKey || !menuKey) return null
  const payload = {
    version: 1,
    menuKey,
    source: directoryInfo?.source || 'electron',
    folderPath: directoryInfo?.folderPath || null,
    folderName: directoryInfo?.folderName || null,
    isRoot: Boolean(directoryInfo?.isRoot),
    savedAt: Date.now(),
  }
  try {
    localStorage.setItem(buildKey(userKey, menuKey), JSON.stringify(payload))
  } catch {
    return null
  }
  return payload
}

/**
 * Load the mapping for a specific menu.
 */
export const loadMenuMapping = (userKey, menuKey) => {
  if (!userKey || !menuKey) return null
  try {
    return safeParse(localStorage.getItem(buildKey(userKey, menuKey)))
  } catch {
    return null
  }
}

/**
 * Load all mappings for all menus.
 */
export const loadAllMenuMappings = (userKey) => {
  if (!userKey) return {}
  const result = {}
  for (const menu of MENU_REGISTRY) {
    const mapping = loadMenuMapping(userKey, menu.key)
    if (mapping) result[menu.key] = mapping
  }
  return result
}

/**
 * Clear a mapping for a specific menu.
 */
export const clearMenuMapping = (userKey, menuKey) => {
  if (!userKey || !menuKey) return
  try {
    localStorage.removeItem(buildKey(userKey, menuKey))
  } catch {
    // noop
  }
}

/**
 * Count how many menus have active mappings.
 */
export const countActiveMappings = (userKey) => {
  if (!userKey) return 0
  return MENU_REGISTRY.reduce((count, menu) => {
    const mapping = loadMenuMapping(userKey, menu.key)
    return mapping ? count + 1 : count
  }, 0)
}

/**
 * Custom event name for mapping changes.
 */
export const MAPPING_UPDATED_EVENT = 'pwr:global-folder-mapping-updated'

export const emitMappingUpdated = (userKey, menuKey) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(MAPPING_UPDATED_EVENT, {
    detail: { userKey, menuKey, updatedAt: Date.now() },
  }))
}
