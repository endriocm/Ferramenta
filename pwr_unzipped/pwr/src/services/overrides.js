const STORAGE_KEY = 'pwr.vencimento.overrides'

export const loadOverrides = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export const saveOverrides = (overrides) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

export const updateOverride = (overrides, id, next) => {
  return {
    ...overrides,
    [id]: {
      ...(overrides[id] || { high: 'auto', low: 'auto', cupomManual: '', qtyBonus: 0, bonusDate: '', bonusNote: '' }),
      ...next,
    },
  }
}

export const clearOverride = (overrides, id) => {
  const next = { ...overrides }
  delete next[id]
  return next
}
