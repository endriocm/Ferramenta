/**
 * Convert an Excel serial date number to { y, m, d } components.
 * Drop-in replacement for XLSX.SSF.parse_date_code() used in date normalization.
 *
 * Excel epoch: serial 1 = 1900-01-01.
 * Handles the famous 1900 leap-year bug (serial 60 = Feb 29, 1900).
 */
export function excelSerialToDateComponents(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial) || serial < 1) return null
  const n = Math.floor(serial)
  if (n === 60) return { y: 1900, m: 2, d: 29 } // Excel 1900 bug date
  const day = n > 60 ? n - 1 : n
  const date = new Date(Date.UTC(1900, 0, day))
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
  }
}
