import { loadXlsx } from './xlsxLoader'

const isUnsafeFormula = (value) => /^[=+\-@]/.test(value)

const sanitizeCell = (value) => {
  if (value == null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? value : ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = String(value)
  return isUnsafeFormula(text) ? `'${text}` : text
}

const normalizeRows = (rows) => rows.map((row) => row.map((cell) => sanitizeCell(cell)))

export const exportXlsx = async ({
  fileName,
  sheetName = 'Export',
  columns = [],
  rows = [],
}) => {
  const XLSX = await loadXlsx()
  const data = normalizeRows([columns, ...rows])
  const worksheet = XLSX.utils.aoa_to_sheet(data)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
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
