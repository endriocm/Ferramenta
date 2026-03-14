import { loadXlsx } from './xlsxLoader'

const isUnsafeFormula = (value) => /^[=+\-@]/.test(value)
const INVALID_SHEET_NAME_RE = /[\\/?*[\]:]/g

const sanitizeCell = (value) => {
  if (value == null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? value : ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = String(value)
  return isUnsafeFormula(text) ? `'${text}` : text
}

const normalizeRows = (rows) => rows.map((row) => row.map((cell) => sanitizeCell(cell)))

const normalizeColumns = (columns) => (
  Array.isArray(columns)
    ? columns.map((column) => sanitizeCell(column))
    : []
)

const unwrapXlsxModule = (moduleRef) => {
  if (!moduleRef) return moduleRef
  if (moduleRef.utils && typeof moduleRef.write === 'function') return moduleRef
  if (moduleRef.default?.utils && typeof moduleRef.default?.write === 'function') return moduleRef.default
  return moduleRef
}

const loadStyledXlsx = async () => {
  try {
    const moduleRef = await import('xlsx-js-style')
    return unwrapXlsxModule(moduleRef)
  } catch {
    return null
  }
}

const resolveWriter = async ({ preferStyles = false }) => {
  if (preferStyles) {
    const styled = await loadStyledXlsx()
    if (styled) return styled
  }
  const fallback = await loadXlsx()
  return unwrapXlsxModule(fallback)
}

const sanitizeSheetName = (name, fallback, usedNames) => {
  const base = String(name || fallback || 'Export')
    .replace(INVALID_SHEET_NAME_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim() || String(fallback || 'Export')
  const trimmedBase = base.slice(0, 31)
  if (!usedNames.has(trimmedBase)) {
    usedNames.add(trimmedBase)
    return trimmedBase
  }

  let index = 2
  while (index < 1000) {
    const suffix = ` (${index})`
    const prefix = trimmedBase.slice(0, Math.max(1, 31 - suffix.length))
    const candidate = `${prefix}${suffix}`
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate)
      return candidate
    }
    index += 1
  }

  const fallbackName = `Export ${Date.now()}`.slice(0, 31)
  usedNames.add(fallbackName)
  return fallbackName
}

const buildWorksheet = ({
  XLSX,
  columns = [],
  rows = [],
  columnWidths = null,
  decorateWorksheet = null,
}) => {
  const normalizedColumns = normalizeColumns(columns)
  const normalizedDataRows = normalizeRows(Array.isArray(rows) ? rows : [])
  const data = normalizeRows([normalizedColumns, ...normalizedDataRows])
  const worksheet = XLSX.utils.aoa_to_sheet(data)

  if (Array.isArray(columnWidths) && columnWidths.length) {
    worksheet['!cols'] = columnWidths.map((width) => {
      const parsed = Number(width)
      return { wch: Number.isFinite(parsed) && parsed > 0 ? parsed : 12 }
    })
  }

  if (typeof decorateWorksheet === 'function') {
    decorateWorksheet({
      worksheet,
      XLSX,
      data,
      columns: normalizedColumns,
      rows: normalizedDataRows,
      headerRowIndex: 0,
      firstDataRowIndex: 1,
    })
  }

  return worksheet
}

export const exportXlsx = async ({
  fileName,
  sheetName = 'Export',
  columns = [],
  rows = [],
  useStyles = false,
  columnWidths = null,
  decorateWorksheet = null,
  extraSheets = [],
}) => {
  const additionalSheets = Array.isArray(extraSheets)
    ? extraSheets.filter((sheet) => sheet && typeof sheet === 'object')
    : []
  const preferStyles = Boolean(useStyles)
    || typeof decorateWorksheet === 'function'
    || additionalSheets.some((sheet) => Boolean(sheet.useStyles) || typeof sheet.decorateWorksheet === 'function')
  const XLSX = await resolveWriter({
    preferStyles,
  })
  const workbook = XLSX.utils.book_new()
  const usedSheetNames = new Set()

  const mainSheet = buildWorksheet({
    XLSX,
    columns,
    rows,
    columnWidths,
    decorateWorksheet,
  })
  XLSX.utils.book_append_sheet(
    workbook,
    mainSheet,
    sanitizeSheetName(sheetName, 'Export', usedSheetNames),
  )

  additionalSheets.forEach((sheet, index) => {
    const worksheet = buildWorksheet({
      XLSX,
      columns: sheet.columns,
      rows: sheet.rows,
      columnWidths: sheet.columnWidths,
      decorateWorksheet: sheet.decorateWorksheet,
    })
    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      sanitizeSheetName(sheet.sheetName, `Export ${index + 2}`, usedSheetNames),
    )
  })

  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })

  if (window?.electronAPI?.saveFile) {
    const result = await window.electronAPI.saveFile({
      buffer,
      defaultPath: fileName,
    })
    return result
  }

  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
  return { fileName }
}
