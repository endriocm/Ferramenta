/**
 * Client for the XLSX Web Worker.
 * Provides parseXlsxInWorker(buffer) that returns parsed sheets off-main-thread.
 */

let worker = null
let nextId = 0
const pending = new Map()

function getWorker() {
  if (!worker) {
    worker = new Worker(
      new URL('../workers/xlsx.worker.js', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (e) => {
      const { id, error, ...data } = e.data
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (error) entry.reject(new Error(error))
      else entry.resolve(data)
    }
    worker.onerror = (e) => {
      const err = new Error(e.message || 'XLSX Worker error')
      for (const [, entry] of pending) {
        entry.reject(err)
      }
      pending.clear()
    }
  }
  return worker
}

function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
  }
  return input
}

/**
 * Parse an XLSX buffer in a Web Worker (off main thread).
 *
 * @param {ArrayBuffer|Uint8Array} buffer — the file contents
 * @param {{ cellDates?: boolean }} options
 * @returns {Promise<{
 *   sheetNames: string[],
 *   sheets: Record<string, {
 *     rows: object[],
 *     rawRows: any[][],
 *     meta: { sheetRef: string, fullRef: string, rowCount: number, rawRowCount: number,
 *             estimatedExcelRows: number, estimatedDataRows: number, headerRows: number }
 *   }>
 * }>}
 */
export function parseXlsxInWorker(buffer, { cellDates = true } = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    const w = getWorker()
    const ab = toArrayBuffer(buffer)
    w.postMessage({ id, buffer: ab, cellDates })
  })
}
