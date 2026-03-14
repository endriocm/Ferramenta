/**
 * ocrService.js — Unified OCR interface.
 *
 * Strategy:
 *  1. Try native Windows OCR via Electron IPC (powershell → WinRT).
 *  2. If that fails (spawn error, not desktop, etc.) fall back to Tesseract.js
 *     running entirely in the browser (no external process needed).
 *
 * Both paths return the same shape: { ok, text, lines, source, error? }
 */

let tesseractWorker = null
let tesseractLoading = false
const tesseractQueue = []

const getTesseractWorker = async () => {
  if (tesseractWorker) return tesseractWorker
  if (tesseractLoading) {
    return new Promise((resolve, reject) => {
      tesseractQueue.push({ resolve, reject })
    })
  }

  tesseractLoading = true
  try {
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker('por+eng', 1, {
      logger: () => {},
    })
    tesseractWorker = worker
    tesseractLoading = false
    tesseractQueue.forEach(({ resolve }) => resolve(worker))
    tesseractQueue.length = 0
    return worker
  } catch (error) {
    tesseractLoading = false
    tesseractQueue.forEach(({ reject }) => reject(error))
    tesseractQueue.length = 0
    throw error
  }
}

const runTesseractOcr = async (dataUrl) => {
  const worker = await getTesseractWorker()
  const { data } = await worker.recognize(dataUrl)
  const text = String(data?.text || '').trim()
  const lines = text
    ? text.split('\n').map((l) => l.trim()).filter(Boolean)
    : []
  return { ok: true, text, lines, source: 'tesseract' }
}

const runNativeOcr = async (dataUrl) => {
  if (typeof window === 'undefined') return null
  if (typeof window.electronAPI?.ocr?.readImageDataUrl !== 'function') return null

  try {
    const result = await window.electronAPI.ocr.readImageDataUrl(dataUrl)
    if (result?.ok) {
      return {
        ok: true,
        text: String(result.text || '').trim(),
        lines: Array.isArray(result.lines)
          ? result.lines.map((l) => String(l || '').trim()).filter(Boolean)
          : [],
        source: 'windows-ocr',
      }
    }
    // Explicit failure from the native side
    return { ok: false, error: result?.error || 'OCR nativo retornou erro.' }
  } catch (error) {
    // Spawn errors, timeout, etc.
    return { ok: false, error: error?.message || 'Falha no OCR nativo.' }
  }
}

/**
 * Read text from an image data-URL.
 * Tries native Windows OCR first, falls back to Tesseract.js.
 *
 * @param {string} dataUrl  Base64 data-URL (data:image/...)
 * @returns {Promise<{ok: boolean, text?: string, lines?: string[], source?: string, error?: string}>}
 */
export const readImageText = async (dataUrl) => {
  if (!dataUrl || !String(dataUrl).startsWith('data:image/')) {
    return { ok: false, error: 'Formato de imagem invalido.' }
  }

  // 1. Try native OCR
  const nativeResult = await runNativeOcr(dataUrl)
  if (nativeResult?.ok) return nativeResult

  // 2. Fallback to Tesseract.js
  try {
    const tesseractResult = await runTesseractOcr(dataUrl)
    return tesseractResult
  } catch (error) {
    // Both methods failed — return best available error
    const nativeError = nativeResult?.error || ''
    const tesseractError = error?.message || 'Tesseract falhou.'
    return {
      ok: false,
      error: nativeError
        ? `OCR nativo: ${nativeError}. Tesseract: ${tesseractError}`
        : tesseractError,
    }
  }
}

/**
 * Terminate the Tesseract worker (call on app shutdown if desired).
 */
export const terminateOcrWorker = async () => {
  if (tesseractWorker) {
    try {
      await tesseractWorker.terminate()
    } catch {
      // noop
    }
    tesseractWorker = null
  }
}
