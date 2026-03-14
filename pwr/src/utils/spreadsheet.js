/**
 * Shared helpers for revenue pages and spreadsheet handling.
 * Eliminates ~400 LOC of duplication across RevenueBovespa, RevenueBmf,
 * RevenueStructured, CentralOrdens, Dashboard, and Vencimento.
 */

export const aggregateByKey = (entries, keyFn) => {
  const map = new Map()
  entries.forEach((entry) => {
    const key = keyFn(entry)
    if (!key) return
    map.set(key, (map.get(key) || 0) + (Number(entry.receita) || 0))
  })
  return map
}

export const buildMultiOptions = (values) => {
  const unique = Array.from(new Set(values.filter((value) => value != null && value !== '')))
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return unique.map((value) => ({ value, label: value }))
}

export const normalizeFileName = (name) => String(name || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const toFileArray = (files) => {
  if (Array.isArray(files)) return files
  if (files && typeof files === 'object' && 'name' in files) return [files]
  if (files && typeof files.length === 'number') return Array.from(files)
  return []
}

export const filterSpreadsheetCandidates = (files) => {
  return toFileArray(files)
    .filter((file) => file && file.name)
    .filter((file) => {
      const lower = file.name.toLowerCase()
      return (lower.endsWith('.xlsx') || lower.endsWith('.xls')) && !file.name.startsWith('~$')
    })
}

export const resolveCellValue = (row, column) => {
  if (typeof column?.exportValue === 'function') return column.exportValue(row)
  if (typeof column?.render === 'function') {
    const rendered = column.render(row)
    if (typeof rendered === 'string' || typeof rendered === 'number') return rendered
  }
  const raw = row?.[column?.key]
  return raw == null ? '' : raw
}

export const getToday = () => {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export const toArrayBuffer = (buffer) => {
  if (buffer instanceof ArrayBuffer) return buffer
  if (buffer?.buffer instanceof ArrayBuffer) return buffer.buffer
  return new Uint8Array(buffer).buffer
}
