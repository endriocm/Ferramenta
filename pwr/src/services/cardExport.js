const sanitizeFilePart = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, '_')
  .replace(/[^a-z0-9_-]/g, '')

const downloadDataUrl = (dataUrl, fileName) => {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = fileName
  anchor.click()
}

let imageLibPromise = null
const loadImageLib = async () => {
  if (!imageLibPromise) {
    imageLibPromise = import('html-to-image')
  }
  return imageLibPromise
}

let pdfLibPromise = null
const loadPdfLib = async () => {
  if (!pdfLibPromise) {
    pdfLibPromise = import('jspdf')
  }
  return pdfLibPromise
}

const EXPORT_4K_WIDTH = 3840
const EXPORT_4K_HEIGHT = 2160

const captureNodeAsPng = async (node, backgroundColor = '#f3f4f6') => {
  if (!node) throw new Error('Elemento do card nao encontrado para exportacao.')
  if (document.fonts?.ready) {
    await document.fonts.ready
  }
  const { toCanvas } = await loadImageLib()
  const sourceCanvas = await toCanvas(node, {
    cacheBust: true,
    pixelRatio: Math.max(2, window.devicePixelRatio || 1),
    backgroundColor,
  })

  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = EXPORT_4K_WIDTH
  outputCanvas.height = EXPORT_4K_HEIGHT
  const ctx = outputCanvas.getContext('2d')
  if (!ctx) throw new Error('Falha ao preparar canvas de exportacao.')

  ctx.fillStyle = backgroundColor
  ctx.fillRect(0, 0, EXPORT_4K_WIDTH, EXPORT_4K_HEIGHT)

  const fitRatio = Math.min(
    EXPORT_4K_WIDTH / sourceCanvas.width,
    EXPORT_4K_HEIGHT / sourceCanvas.height,
  )
  const renderWidth = sourceCanvas.width * fitRatio
  const renderHeight = sourceCanvas.height * fitRatio
  const x = (EXPORT_4K_WIDTH - renderWidth) / 2
  const y = (EXPORT_4K_HEIGHT - renderHeight) / 2
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(sourceCanvas, x, y, renderWidth, renderHeight)

  return outputCanvas.toDataURL('image/png')
}

const isNavigatorImageClipboardAvailable = () => (
  typeof window !== 'undefined'
  && typeof navigator !== 'undefined'
  && typeof navigator.clipboard?.write === 'function'
  && typeof window.ClipboardItem !== 'undefined'
)

const writeDataUrlToNavigatorClipboard = async (dataUrl) => {
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error('Falha ao preparar imagem para copia.')
  const blob = await response.blob()
  const mime = blob.type || 'image/png'
  const item = new window.ClipboardItem({ [mime]: blob })
  await navigator.clipboard.write([item])
}

export const buildCardFileName = ({ templateLabel, ticker, maturityDate, extension }) => {
  const safeTemplate = sanitizeFilePart(templateLabel || 'card')
  const safeTicker = sanitizeFilePart(ticker || 'ativo')
  const safeDate = sanitizeFilePart(maturityDate || '')
  const datePart = safeDate ? `_${safeDate}` : ''
  return `${safeTemplate}_${safeTicker}${datePart}.${extension}`
}

export const exportCardAsPng = async ({ node, templateLabel, ticker, maturityDate }) => {
  const imageUrl = await captureNodeAsPng(node)
  const fileName = buildCardFileName({
    templateLabel,
    ticker,
    maturityDate,
    extension: 'png',
  })
  downloadDataUrl(imageUrl, fileName)
  return { ok: true, fileName }
}

export const exportCardAsPdf = async ({ node, templateLabel, ticker, maturityDate }) => {
  const imageUrl = await captureNodeAsPng(node)
  const { jsPDF } = await loadPdfLib()
  const image = new Image()
  image.src = imageUrl

  await new Promise((resolve, reject) => {
    image.onload = () => resolve(true)
    image.onerror = () => reject(new Error('Falha ao gerar imagem para PDF.'))
  })

  const pageWidthMm = 210
  const pageHeightMm = 297
  const marginMm = 8
  const usableWidth = pageWidthMm - (marginMm * 2)
  const scale = usableWidth / image.width
  const renderHeight = image.height * scale
  const fittedHeight = Math.min(renderHeight, pageHeightMm - (marginMm * 2))
  const yOffset = marginMm + ((pageHeightMm - (marginMm * 2) - fittedHeight) / 2)

  const pdf = new jsPDF({
    orientation: renderHeight > usableWidth ? 'portrait' : 'landscape',
    unit: 'mm',
    format: 'a4',
  })
  const pageSize = pdf.internal.pageSize
  const pdfWidth = pageSize.getWidth()
  const pdfHeight = pageSize.getHeight()
  const maxWidth = pdfWidth - (marginMm * 2)
  const maxHeight = pdfHeight - (marginMm * 2)
  const ratio = Math.min(maxWidth / image.width, maxHeight / image.height)
  const width = image.width * ratio
  const height = image.height * ratio
  const x = (pdfWidth - width) / 2
  const y = (pdfHeight - height) / 2
  pdf.addImage(imageUrl, 'PNG', x, y, width, height, undefined, 'FAST')

  const fileName = buildCardFileName({
    templateLabel,
    ticker,
    maturityDate,
    extension: 'pdf',
  })
  pdf.save(fileName)
  return { ok: true, fileName, yOffset, fittedHeight }
}

export const copyCardImageToClipboard = async ({ node, backgroundColor } = {}) => {
  const imageUrl = await captureNodeAsPng(node, backgroundColor)

  if (typeof window !== 'undefined' && typeof window.electronAPI?.clipboard?.writeImageDataUrl === 'function') {
    const ok = await window.electronAPI.clipboard.writeImageDataUrl(imageUrl)
    if (!ok) throw new Error('Falha ao copiar imagem no desktop.')
    return { ok: true, mode: 'electron' }
  }

  if (isNavigatorImageClipboardAvailable()) {
    await writeDataUrlToNavigatorClipboard(imageUrl)
    return { ok: true, mode: 'web' }
  }

  throw new Error('Copia de imagem nao suportada neste ambiente.')
}
