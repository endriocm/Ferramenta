const DEFAULT_BACKGROUND = '#0b1118'
const DEFAULT_MARGIN_MM = 8

let imageLibPromise = null
let pdfLibPromise = null

const loadImageLib = async () => {
  if (!imageLibPromise) {
    imageLibPromise = import('html-to-image')
  }
  return imageLibPromise
}

const loadPdfLib = async () => {
  if (!pdfLibPromise) {
    pdfLibPromise = import('jspdf')
  }
  return pdfLibPromise
}

const pad = (value) => String(value).padStart(2, '0')

const buildDefaultFileName = () => {
  const now = new Date()
  const datePart = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-')
  const timePart = [pad(now.getHours()), pad(now.getMinutes())].join('-')
  return `dashboard_${datePart}_${timePart}.pdf`
}

const waitForFonts = async () => {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    await document.fonts.ready
  }
}

const waitForFrame = async () => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}

const getPixelRatio = () => {
  if (typeof window === 'undefined') return 1.5
  const deviceRatio = Number(window.devicePixelRatio || 1)
  return Math.min(2, Math.max(1.5, deviceRatio))
}

const captureNodeAsPng = async (node, backgroundColor) => {
  if (!node) throw new Error('Secao da dashboard indisponivel para exportacao.')
  await waitForFonts()
  const { toPng } = await loadImageLib()
  return toPng(node, {
    cacheBust: true,
    pixelRatio: getPixelRatio(),
    backgroundColor,
  })
}

const loadImage = (dataUrl) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('Falha ao preparar a captura da dashboard.'))
  image.src = dataUrl
})

const getPageMetrics = (pdf, marginMm) => {
  const pageSize = pdf.internal.pageSize
  const width = pageSize.getWidth()
  const height = pageSize.getHeight()
  return {
    pageWidth: width,
    pageHeight: height,
    maxWidth: width - (marginMm * 2),
    maxHeight: height - (marginMm * 2),
  }
}

const addCenteredImage = (pdf, imageUrl, image, marginMm) => {
  const { pageWidth, pageHeight, maxWidth, maxHeight } = getPageMetrics(pdf, marginMm)
  const ratio = Math.min(maxWidth / image.width, maxHeight / image.height)
  const renderWidth = image.width * ratio
  const renderHeight = image.height * ratio
  const x = (pageWidth - renderWidth) / 2
  const y = (pageHeight - renderHeight) / 2
  pdf.addImage(imageUrl, 'PNG', x, y, renderWidth, renderHeight, undefined, 'FAST')
}

const applyTemporaryStyles = (elements, stylePatch) => {
  const list = Array.isArray(elements) ? elements : []
  const patch = stylePatch && typeof stylePatch === 'object' ? stylePatch : null
  const cleanups = []
  if (!patch) return () => {}

  list.forEach((element) => {
    if (!element?.style) return
    const previous = {}
    Object.entries(patch).forEach(([key, value]) => {
      previous[key] = element.style[key]
      element.style[key] = value
    })
    cleanups.push(() => {
      Object.entries(previous).forEach(([key, value]) => {
        element.style[key] = value
      })
    })
  })

  return () => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      try {
        cleanups[index]()
      } catch {
        // noop
      }
    }
  }
}

const captureGoalsSections = async (goalsNode, backgroundColor) => {
  const goalsGrid = goalsNode?.querySelector?.('.broker-goals-grid') || null
  const goalCards = goalsGrid
    ? Array.from(goalsGrid.querySelectorAll('.broker-goal-scenario'))
    : []
  const tableWraps = Array.from(
    goalsNode?.querySelectorAll?.('.table-wrap, .broker-goal-table-wrap') || [],
  )

  const restoreGridStyles = applyTemporaryStyles(
    goalsGrid ? [goalsGrid] : [],
    { gridTemplateColumns: 'minmax(0, 1fr)' },
  )
  const restoreTableStyles = applyTemporaryStyles(
    tableWraps,
    {
      maxHeight: 'none',
      overflow: 'visible',
      overflowY: 'visible',
      overflowX: 'visible',
    },
  )

  const previousDisplay = goalsGrid?.style?.display ?? ''
  let headerImageUrl = ''
  const blockImageUrls = []

  try {
    await waitForFrame()

    if (goalsGrid) goalsGrid.style.display = 'none'
    await waitForFrame()
    headerImageUrl = await captureNodeAsPng(goalsNode, backgroundColor)

    if (goalsGrid) goalsGrid.style.display = previousDisplay
    await waitForFrame()

    for (const card of goalCards) {
      blockImageUrls.push(await captureNodeAsPng(card, backgroundColor))
    }
  } finally {
    if (goalsGrid) goalsGrid.style.display = previousDisplay
    restoreTableStyles()
    restoreGridStyles()
    await waitForFrame()
  }

  return {
    headerImageUrl,
    blockImageUrls,
  }
}

export const exportDashboardPdf = async ({
  overviewNode,
  goalsNode,
  fileName,
  backgroundColor = DEFAULT_BACKGROUND,
} = {}) => {
  if (!overviewNode || !goalsNode) {
    throw new Error('Nao foi possivel localizar as secoes da dashboard para exportacao.')
  }

  const resolvedFileName = String(fileName || '').trim() || buildDefaultFileName()
  const { jsPDF } = await loadPdfLib()
  const overviewImageUrl = await captureNodeAsPng(overviewNode, backgroundColor)
  const {
    headerImageUrl: goalsHeaderImageUrl,
    blockImageUrls: goalsBlockImageUrls,
  } = await captureGoalsSections(goalsNode, backgroundColor)

  const [overviewImage, goalsHeaderImage, ...goalsBlockImages] = await Promise.all([
    loadImage(overviewImageUrl),
    loadImage(goalsHeaderImageUrl),
    ...goalsBlockImageUrls.map((url) => loadImage(url)),
  ])

  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  })

  addCenteredImage(pdf, overviewImageUrl, overviewImage, DEFAULT_MARGIN_MM)
  pdf.addPage('a4', 'landscape')
  addCenteredImage(pdf, goalsHeaderImageUrl, goalsHeaderImage, DEFAULT_MARGIN_MM)

  for (let index = 0; index < goalsBlockImages.length; index += 1) {
    const blockImage = goalsBlockImages[index]
    const blockImageUrl = goalsBlockImageUrls[index]
    if (!blockImage || !blockImageUrl) continue
    pdf.addPage('a4', 'landscape')
    addCenteredImage(pdf, blockImageUrl, blockImage, DEFAULT_MARGIN_MM)
  }

  pdf.save(resolvedFileName)

  return {
    ok: true,
    fileName: resolvedFileName,
  }
}
