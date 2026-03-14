/**
 * Web Worker for XLSX parsing — moves CPU-heavy XLSX.read() + sheet_to_json()
 * off the main thread to keep the UI responsive during file imports.
 */

const XLSX_CDN = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'

let xlsx = null

async function ensureXlsx() {
  if (xlsx) return xlsx
  try {
    xlsx = await import('xlsx')
  } catch {
    xlsx = await import(/* @vite-ignore */ XLSX_CDN)
  }
  return xlsx
}

const CELL_REF_RE = /^[A-Z]+[0-9]+$/

function resolveSheetRange(sheet, XLSX) {
  const ref = sheet?.['!ref']
  let maxRow = -1
  let maxCol = -1

  if (ref) {
    const decoded = XLSX.utils.decode_range(ref)
    maxRow = decoded.e.r
    maxCol = decoded.e.c
  }

  const keys = Object.keys(sheet || {})
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (key[0] === '!') continue
    if (!CELL_REF_RE.test(key)) continue
    const cell = XLSX.utils.decode_cell(key)
    if (cell.r > maxRow) maxRow = cell.r
    if (cell.c > maxCol) maxCol = cell.c
  }

  if (maxRow < 0 || maxCol < 0) {
    return { sheetRef: ref || '', fullRef: ref || '', rowCount: 0 }
  }

  const fullRef = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: maxRow, c: maxCol },
  })

  return { sheetRef: ref || fullRef, fullRef, rowCount: maxRow + 1 }
}

function isCellNonEmpty(cell) {
  if (cell == null) return false
  if (typeof cell === 'string') return cell.trim() !== ''
  return true
}

function estimateExcelRows(rawRows, headerRows = 1) {
  if (!Array.isArray(rawRows) || !rawRows.length) {
    return { estimatedExcelRows: 0, estimatedDataRows: 0 }
  }
  let lastNonEmpty = -1
  for (let i = rawRows.length - 1; i >= 0; i--) {
    const row = rawRows[i]
    const nonEmpty = Array.isArray(row)
      ? row.some(isCellNonEmpty)
      : isCellNonEmpty(row)
    if (nonEmpty) { lastNonEmpty = i; break }
  }
  const total = lastNonEmpty >= 0 ? lastNonEmpty + 1 : 0
  return {
    estimatedExcelRows: total,
    estimatedDataRows: Math.max(0, total - headerRows),
  }
}

function processSheet(sheet, XLSX) {
  const meta = resolveSheetRange(sheet, XLSX)
  const range = meta.fullRef || undefined
  const rangeOpt = range ? { range } : {}

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', ...rangeOpt })
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', ...rangeOpt })

  const estimated = estimateExcelRows(rawRows, 1)
  return {
    rows,
    rawRows,
    meta: {
      ...meta,
      rawRowCount: rawRows.length,
      ...estimated,
      headerRows: 1,
    },
  }
}

self.onmessage = async (e) => {
  const { id, buffer, cellDates = true } = e.data
  try {
    const XLSX = await ensureXlsx()
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates })
    const sheets = {}
    for (const name of workbook.SheetNames) {
      sheets[name] = processSheet(workbook.Sheets[name], XLSX)
    }
    self.postMessage({ id, sheetNames: workbook.SheetNames, sheets })
  } catch (error) {
    self.postMessage({ id, error: error.message })
  }
}
