const XLSX_CDN = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'

export const loadXlsx = async () => {
  try {
    return await import('xlsx')
  } catch {
    return await import(/* @vite-ignore */ XLSX_CDN)
  }
}
