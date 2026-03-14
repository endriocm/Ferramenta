const CDI_SERIES = [
  { id: 12, label: 'BCB SGS 12 (CDI diario)' },
  { id: 4389, label: 'BCB SGS 4389 (fallback)' },
]

const ANNUAL_BUSINESS_DAYS = 252

const toNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[^\d,.-]/g, '')
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeDate = (value) => {
  if (!value) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const match = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (match) {
      const [, day, month, year] = match
      return `${year}-${month}-${day}`
    }
    const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const annualizeFromDailyPct = (dailyPct) => {
  if (!Number.isFinite(dailyPct)) return null
  const dailyRate = dailyPct / 100
  if (dailyRate <= -1) return null
  const annual = ((1 + dailyRate) ** ANNUAL_BUSINESS_DAYS - 1) * 100
  return Number.isFinite(annual) ? annual : null
}

const formatBrDate = (date) => {
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = String(date.getFullYear())
  return `${day}/${month}/${year}`
}

const buildDateWindow = () => {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 120)
  return {
    dataInicial: formatBrDate(start),
    dataFinal: formatBrDate(end),
  }
}

const inferAnnualPct = (rawPct) => {
  if (!Number.isFinite(rawPct)) return { annualPct: null, inferredFromDaily: false }
  if (rawPct > 2) {
    return { annualPct: rawPct, inferredFromDaily: false }
  }
  const annualized = annualizeFromDailyPct(rawPct)
  return { annualPct: annualized, inferredFromDaily: true }
}

const fetchSeries = async (seriesId) => {
  const { dataInicial, dataFinal } = buildDateWindow()
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${seriesId}/dados?formato=json&dataInicial=${encodeURIComponent(dataInicial)}&dataFinal=${encodeURIComponent(dataFinal)}`
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PWR-Ferramenta/1.0',
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const error = new Error(`BCB ${seriesId} indisponivel (${response.status})`)
    error.status = response.status
    error.body = body
    throw error
  }
  const payload = await response.json()
  if (!Array.isArray(payload) || !payload.length) {
    throw new Error(`BCB ${seriesId} sem dados`)
  }
  for (let i = payload.length - 1; i >= 0; i -= 1) {
    const entry = payload[i]
    const rawPct = toNumber(entry?.valor)
    const asOf = normalizeDate(entry?.data)
    if (!Number.isFinite(rawPct) || !asOf) continue
    return { rawPct, asOf }
  }
  throw new Error(`BCB ${seriesId} sem valores validos`)
}

const mapError = (sourceErrors) => {
  const error = new Error('Falha ao consultar CDI no Banco Central.')
  error.status = 502
  error.details = sourceErrors
  return error
}

const getCdiSnapshot = async () => {
  const errors = []
  for (const series of CDI_SERIES) {
    try {
      const raw = await fetchSeries(series.id)
      const { annualPct, inferredFromDaily } = inferAnnualPct(raw.rawPct)
      if (!Number.isFinite(annualPct)) {
        throw new Error(`Nao foi possivel anualizar serie ${series.id}`)
      }
      const monthlyPct = annualPct / 12
      return {
        annualPct: round(annualPct, 4),
        monthlyPct: round(monthlyPct, 4),
        source: inferredFromDaily
          ? `${series.label} anualizado (252 dias uteis)`
          : series.label,
        asOf: raw.asOf,
      }
    } catch (error) {
      errors.push({
        source: series.label,
        message: error?.message || 'erro desconhecido',
      })
    }
  }
  throw mapError(errors)
}

module.exports = {
  getCdiSnapshot,
}
