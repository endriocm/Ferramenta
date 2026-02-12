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

const captureNodeAsPng = async (node, backgroundColor = '#f3f4f6') => {
  if (!node) throw new Error('Elemento do card nao encontrado para exportacao.')
  if (document.fonts?.ready) {
    await document.fonts.ready
  }
  const { toPng } = await loadImageLib()
  return toPng(node, {
    cacheBust: true,
    pixelRatio: Math.max(2, window.devicePixelRatio || 1),
    backgroundColor,
  })
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
