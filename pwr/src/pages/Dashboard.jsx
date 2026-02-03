import { useMemo, useRef, useState } from 'react'

import { formatCurrency, formatNumber } from '../utils/format'

import { normalizeDateKey } from '../utils/dateKey'

import { loadStructuredRevenue } from '../services/revenueStructured'

import { loadRevenueByType } from '../services/revenueStore'

import { enrichRow } from '../services/tags'

import { useGlobalFilters } from '../contexts/GlobalFilterContext'

import { filterByApuracaoMonths, formatMonthLabel } from '../services/apuracao'

const ASSESSOR_RANK_LIMIT = 7

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

let compactCurrencyFormatter = null

try {

  compactCurrencyFormatter = new Intl.NumberFormat('pt-BR', {

    style: 'currency',

    currency: 'BRL',

    notation: 'compact',

    maximumFractionDigits: 1,

  })

} catch {

  compactCurrencyFormatter = null

}

const formatCurrencyCompact = (value) => {

  const safeValue = Number.isFinite(value) ? value : 0

  if (compactCurrencyFormatter) {

    return compactCurrencyFormatter.format(safeValue)

  }

  const abs = Math.abs(safeValue)

  if (abs < 1000) return formatCurrency(safeValue)

  const sign = safeValue < 0 ? '-' : ''

  if (abs >= 1000000000) return `${sign}R$ ${(abs / 1000000000).toFixed(1)}B`

  if (abs >= 1000000) return `${sign}R$ ${(abs / 1000000).toFixed(1)}M`

  return `${sign}R$ ${(abs / 1000).toFixed(1)}k`

}

const buildChartScale = (values, tickCount = 5) => {

  const safeValues = values.filter((value) => Number.isFinite(value))

  const domainMin = safeValues.length ? Math.min(0, ...safeValues) : 0

  const domainMax = safeValues.length ? Math.max(0, ...safeValues) : 0

  const range = domainMax - domainMin || 1

  const normalizedTickCount = Math.max(tickCount, 4)

  const ticks = Array.from({ length: normalizedTickCount }, (_, index) => {

    const ratio = normalizedTickCount === 1 ? 0 : index / (normalizedTickCount - 1)

    return {

      value: domainMin + ratio * range,

      percent: ratio * 100,

    }

  })

  return { domainMin, domainMax, range, ticks }

}

const normalizeSeries = (values, scale) =>

  values.map((value) => {

    const safeValue = Number.isFinite(value) ? value : 0

    const percent = ((safeValue - scale.domainMin) / scale.range) * 100

    return clamp(percent, 0, 100)

  })

const getEntryDateKey = (entry) => {

  const key = normalizeDateKey(entry?.dataEntrada || entry?.data || entry?.vencimento)

  return key || ''

}

const getEntryValue = (entry) => {

  const value = entry?.receita ?? entry?.comissao ?? entry?.valor ?? entry?.value

  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : 0

}

const normalizeKey = (value) => String(value || '')

  .trim()

  .toLowerCase()

  .normalize('NFD')

  .replace(/[\u0300-\u036f]/g, '')

const aggregateByKey = (entries, keyFn) => {

  const map = new Map()

  entries.forEach((entry) => {

    const key = keyFn(entry)

    if (!key) return

    map.set(key, (map.get(key) || 0) + getEntryValue(entry))

  })

  return map

}

const collectUniqueClients = (entries) => {

  const set = new Set()

  entries.forEach((entry) => {

    const code = entry?.codigoCliente ?? entry?.cliente ?? entry?.codigo ?? ''

    const normalized = String(code || '').trim()

    if (normalized) set.add(normalized)

  })

  return set

}

const Dashboard = () => {

  const { tagsIndex, selectedBroker, selectedAssessor, apuracaoMonths } = useGlobalFilters()

  const [granularity, setGranularity] = useState('monthly')

  const [originFilter, setOriginFilter] = useState('all')

  const [activeIndex, setActiveIndex] = useState(null)

  const [tooltip, setTooltip] = useState({ open: false, index: null, x: 0, y: 0, flip: false })

  const chartRef = useRef(null)

  const structuredEntries = useMemo(() => loadStructuredRevenue(), [])

  const bovespaEntries = useMemo(() => loadRevenueByType('Bovespa'), [])

  const bmfEntries = useMemo(() => loadRevenueByType('BMF'), [])

  const isManualEntry = (entry) => {

    if (!entry) return false

    if (String(entry?.source || '').toLowerCase() == 'manual') return true

    const id = String(entry?.id || '')

    if (id.startsWith('mn-')) return true

    return false

  }

  const bovespaVariavel = useMemo(

    () => bovespaEntries.filter((entry) => !isManualEntry(entry) && normalizeKey(entry?.tipoCorretagem) === 'variavel'),

    [bovespaEntries],

  )

  const bmfVariavel = useMemo(

    () => bmfEntries.filter((entry) => !isManualEntry(entry) && normalizeKey(entry?.tipoCorretagem) === 'variavel'),

    [bmfEntries],

  )

  const structuredScoped = useMemo(

    () => filterByApuracaoMonths(structuredEntries, apuracaoMonths, (entry) => entry.dataEntrada || entry.data),

    [structuredEntries, apuracaoMonths],

  )

  const bovespaScoped = useMemo(

    () => filterByApuracaoMonths(bovespaVariavel, apuracaoMonths, (entry) => entry.data || entry.dataEntrada),

    [bovespaVariavel, apuracaoMonths],

  )

  const bmfScoped = useMemo(

    () => filterByApuracaoMonths(bmfVariavel, apuracaoMonths, (entry) => entry.data || entry.dataEntrada),

    [bmfVariavel, apuracaoMonths],

  )

  const structuredEnriched = useMemo(

    () => structuredScoped.map((entry) => enrichRow(entry, tagsIndex)),

    [structuredScoped, tagsIndex],

  )

  const bovespaEnriched = useMemo(

    () => bovespaScoped.map((entry) => enrichRow(entry, tagsIndex)),

    [bovespaScoped, tagsIndex],

  )

  const bmfEnriched = useMemo(

    () => bmfScoped.map((entry) => enrichRow(entry, tagsIndex)),

    [bmfScoped, tagsIndex],

  )

  const normalizedAssessorFilter = useMemo(() => {
    const values = selectedAssessor.map(normalizeKey).filter(Boolean)
    return values.length ? new Set(values) : null
  }, [selectedAssessor])

  const structuredFiltered = useMemo(() => {
    return structuredEnriched.filter((entry) => {
      if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
      if (normalizedAssessorFilter?.size) {
        const assessorKey = normalizeKey(entry?.assessor)
        if (!normalizedAssessorFilter.has(assessorKey)) return false
      }
      return true
    })
  }, [structuredEnriched, selectedBroker, normalizedAssessorFilter])

  const bovespaFiltered = useMemo(() => {
    return bovespaEnriched.filter((entry) => {
      if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
      if (normalizedAssessorFilter?.size) {
        const assessorKey = normalizeKey(entry?.assessor)
        if (!normalizedAssessorFilter.has(assessorKey)) return false
      }
      return true
    })
  }, [bovespaEnriched, selectedBroker, normalizedAssessorFilter])

  const bmfFiltered = useMemo(() => {
    return bmfEnriched.filter((entry) => {
      if (selectedBroker.length && !selectedBroker.includes(String(entry.broker || '').trim())) return false
      if (normalizedAssessorFilter?.size) {
        const assessorKey = normalizeKey(entry?.assessor)
        if (!normalizedAssessorFilter.has(assessorKey)) return false
      }
      return true
    })
  }, [bmfEnriched, selectedBroker, normalizedAssessorFilter])

  const includeStructured = originFilter === 'all' || originFilter === 'estruturadas'

  const includeBovespa = originFilter === 'all' || originFilter === 'bovespa'

  const includeBmf = originFilter === 'all' || originFilter === 'bmf'

  const structuredActive = includeStructured ? structuredFiltered : []

  const bovespaActive = includeBovespa ? bovespaFiltered : []

  const bmfActive = includeBmf ? bmfFiltered : []

  const dailyAllowed = !apuracaoMonths.all && apuracaoMonths.months.length === 1

  const resolvedGranularity = dailyAllowed ? granularity : 'monthly'


  const keyFn = useMemo(() => {

    if (resolvedGranularity === 'daily') return (entry) => getEntryDateKey(entry)

    return (entry) => String(getEntryDateKey(entry)).slice(0, 7)

  }, [resolvedGranularity])

  const structuredMapAll = useMemo(() => aggregateByKey(structuredFiltered, keyFn), [structuredFiltered, keyFn])

  const bovespaMapAll = useMemo(() => aggregateByKey(bovespaFiltered, keyFn), [bovespaFiltered, keyFn])

  const bmfMapAll = useMemo(() => aggregateByKey(bmfFiltered, keyFn), [bmfFiltered, keyFn])

  const allKeys = useMemo(() => {

    const keys = new Set([...structuredMapAll.keys(), ...bovespaMapAll.keys(), ...bmfMapAll.keys()])

    return Array.from(keys).sort()

  }, [structuredMapAll, bovespaMapAll, bmfMapAll])

  const windowedKeys = useMemo(() => {

    const max = resolvedGranularity === 'daily' ? 31 : 24

    return allKeys.slice(-max)

  }, [allKeys, resolvedGranularity])

  const series = useMemo(() => {

    return windowedKeys.map((key) => ({

      key,

      estruturadas: structuredMapAll.get(key) || 0,

      bovespa: bovespaMapAll.get(key) || 0,

      bmf: bmfMapAll.get(key) || 0,

    }))

  }, [windowedKeys, structuredMapAll, bovespaMapAll, bmfMapAll])

  const totalsByOriginAll = useMemo(() => {

    return series.reduce(

      (acc, item) => {

        acc.estruturadas += item.estruturadas

        acc.bovespa += item.bovespa

        acc.bmf += item.bmf

        return acc

      },

      { estruturadas: 0, bovespa: 0, bmf: 0 },

    )

  }, [series])

  const totalsByOrigin = useMemo(() => {

    if (originFilter === 'bovespa') return { estruturadas: 0, bovespa: totalsByOriginAll.bovespa, bmf: 0 }

    if (originFilter === 'bmf') return { estruturadas: 0, bovespa: 0, bmf: totalsByOriginAll.bmf }

    if (originFilter === 'estruturadas') return { estruturadas: totalsByOriginAll.estruturadas, bovespa: 0, bmf: 0 }

    return totalsByOriginAll

  }, [originFilter, totalsByOriginAll])

  const totalOverall = totalsByOrigin.estruturadas + totalsByOrigin.bovespa + totalsByOrigin.bmf

  const visibleTotals = totalOverall

  const uniqueBovespa = useMemo(() => collectUniqueClients(bovespaActive), [bovespaActive])

  const uniqueEstruturadas = useMemo(() => collectUniqueClients(structuredActive), [structuredActive])

  const uniqueByBroker = useMemo(() => {

    const map = new Map()

    structuredActive.forEach((entry) => {

      const broker = String(entry?.broker || '').trim() || '—'

      const code = String(entry?.codigoCliente || '').trim()

      if (!code) return

      if (!map.has(broker)) map.set(broker, new Set())

      map.get(broker).add(code)

    })

    return Array.from(map.entries())

      .map(([broker, set]) => ({ broker, count: set.size }))

      .sort((a, b) => b.count - a.count)

  }, [structuredActive])

  const maxBrokerCount = uniqueByBroker.reduce((max, row) => Math.max(max, row.count), 1)

  const totalSeries = series.map((item) => item.estruturadas + item.bovespa + item.bmf)

  const estrutSeries = series.map((item) => item.estruturadas)

  const bovespaSeries = series.map((item) => item.bovespa)

  const bmfSeries = series.map((item) => item.bmf)

  const barSeries = useMemo(() => {

    if (originFilter === 'bovespa') return bovespaSeries

    if (originFilter === 'bmf') return bmfSeries

    if (originFilter === 'estruturadas') return estrutSeries

    return totalSeries

  }, [originFilter, totalSeries, bovespaSeries, bmfSeries, estrutSeries])

  const chartScale = buildChartScale(barSeries, 5)

  const barScaled = normalizeSeries(barSeries, chartScale)

  const chartTicks = barSeries.length

    ? chartScale.ticks.map((tick) => ({ ...tick, label: formatCurrency(tick.value) }))

    : []

  const hasChartData = barSeries.length > 0

  const brokerRevenueRank = useMemo(

    () => {

      const map = new Map()

      const allEntries = [...structuredActive, ...bovespaActive, ...bmfActive]

      allEntries.forEach((entry) => {

        const broker = String(entry?.broker || '').trim() || '—'

        if (!map.has(broker)) {

          map.set(broker, { receita: 0, assessores: new Set(), clientes: new Set() })

        }

        const record = map.get(broker)

        record.receita += getEntryValue(entry)

        const assessor = String(entry?.assessor || '').trim()

        if (assessor) record.assessores.add(assessor)

        const client = String(entry?.codigoCliente || entry?.cliente || entry?.conta || '').trim()

        if (client) record.clientes.add(client)

      })

      return Array.from(map.entries())

        .map(([broker, data]) => ({

          broker,

          receita: data.receita,

          assessores: data.assessores.size,

          clientes: data.clientes.size,

        }))

        .sort((a, b) => b.receita - a.receita)

        .slice(0, 10)

    },

    [structuredActive, bovespaActive, bmfActive],

  )

  const assessorRank = useMemo(() => {

    const map = new Map()

    const allEntries = [...structuredActive, ...bovespaActive, ...bmfActive]

    allEntries.forEach((entry) => {

      const assessor = String(entry?.assessor || '').trim() || 'Sem assessor'

      map.set(assessor, (map.get(assessor) || 0) + getEntryValue(entry))

    })

    return Array.from(map.entries())

      .map(([assessor, value]) => ({ assessor, value }))

      .sort((a, b) => b.value - a.value)

      .slice(0, ASSESSOR_RANK_LIMIT)

  }, [structuredActive, bovespaActive, bmfActive])

  const maxAssessorValue = assessorRank.reduce((max, item) => Math.max(max, item.value), 1)


  const formatLabel = (key) => {

    if (!key) return ''

    if (resolvedGranularity === 'daily') {

      const [, month, day] = String(key).split('-')

      return `${day}/${month}`

    }

    return formatMonthLabel(String(key).slice(0, 7))

  }

  const isDaily = resolvedGranularity === 'daily'

  const gridColumns = Math.max(barSeries.length, 1)

  const chartGridStyle = { '--chart-columns': gridColumns }

  const showCompactValues = barSeries.length >= 16

  const dailyLabelStep = isDaily

    ? (barSeries.length >= 26 ? 3 : barSeries.length >= 16 ? 2 : 1)

    : 1

  const formatDailyLabel = (key, index) => {

    if (!isDaily) return formatLabel(key)

    if (dailyLabelStep === 1) return formatLabel(key)

    if (index === 0 || index === barSeries.length - 1 || index % dailyLabelStep === 0) {

      return formatLabel(key)

    }

    return ''

  }

  const handleGranularityChange = (next) => {

    setGranularity(next)

    setTooltip({ open: false, index: null, x: 0, y: 0, flip: false })

    setActiveIndex(null)

  }

  const handleBarEnter = (index, event) => {

    setActiveIndex(index)

    const target = event?.currentTarget

    const chartNode = chartRef.current

    if (!target || !chartNode) return

    const chartRect = chartNode.getBoundingClientRect()

    const targetRect = target.getBoundingClientRect()

    const rawX = targetRect.left + targetRect.width / 2 - chartRect.left

    const rawY = targetRect.top - chartRect.top

    const minX = 120

    const maxX = Math.max(chartRect.width - 120, minX)

    const x = clamp(rawX, minX, maxX)

    const flip = rawY < 90

    const y = flip ? rawY + 12 : rawY - 8

    setTooltip({ open: true, index, x, y, flip })

  }

  const handleBarLeave = () => {

    setActiveIndex(null)

    setTooltip({ open: false, index: null, x: 0, y: 0, flip: false })

  }

  const safeTooltipIndex = tooltip.index !== null && tooltip.index < barSeries.length ? tooltip.index : null

  const tooltipOpen = tooltip.open && safeTooltipIndex !== null

  const tooltipData = safeTooltipIndex !== null ? series[safeTooltipIndex] : null

  const tooltipTotal = safeTooltipIndex !== null ? totalSeries[safeTooltipIndex] : 0

  const tooltipLabel = safeTooltipIndex !== null ? formatLabel(windowedKeys[safeTooltipIndex]) : ''

  return (

    <div className="dashboard">

      <section className="kpi-grid">

        <div className="card kpi-card">

          <div className="kpi-label">Receita total</div>

          <div className="kpi-value">{formatCurrency(visibleTotals)}</div>

        </div>

        <div className="card kpi-card">

          <div className="kpi-label">Clientes unicos em Bovespa</div>

          <div className="kpi-value">{formatNumber(uniqueBovespa.size)}</div>

        </div>

        <div className="card kpi-card">

          <div className="kpi-label">Clientes unicos em Estruturas</div>

          <div className="kpi-value">{formatNumber(uniqueEstruturadas.size)}</div>

        </div>

      </section>

      <p className="muted">Apuracao considera apenas Variavel.</p>

      <section className="mini-grid">

        <div className="card mini-card">

          <div className="mini-label">Bovespa</div>

          <div className="mini-value">{formatCurrency(totalsByOrigin.bovespa)}</div>

        </div>

        <div className="card mini-card">

          <div className="mini-label">BMF</div>

          <div className="mini-value">{formatCurrency(totalsByOrigin.bmf)}</div>

        </div>

        <div className="card mini-card">

          <div className="mini-label">Estruturadas</div>

          <div className="mini-value">{formatCurrency(totalsByOrigin.estruturadas)}</div>

        </div>

      </section>

      <section className="dashboard-bottom">

        <div className="card chart-card">

          <div className="card-head">

            <div>

              <h3>Fluxo operacional</h3>

              <p className="muted">Movimento consolidado por periodo</p>

            </div>

            <div className="page-list">

              <button

                className={`page-number ${resolvedGranularity === 'monthly' ? 'active' : ''}`}

                type="button"

                onClick={() => handleGranularityChange('monthly')}

              >

                Mensal

              </button>

              <button

                className={`page-number ${resolvedGranularity === 'daily' ? 'active' : ''}`}

                type="button"

                onClick={() => handleGranularityChange('daily')}

                disabled={!dailyAllowed}

              >

                Diario

              </button>

            </div>

          </div>

          <div className={`chart flow-chart ${isDaily ? 'is-daily' : ''}`} ref={chartRef}>

            {chartTicks.length ? (

              <>

                <div className="chart-lines">

                  {chartTicks.map((tick, index) => (

                    <span key={`line-${index}`} className="chart-line" style={{ bottom: `${tick.percent}%` }} />

                  ))}

                </div>

                <div className="chart-ticks">

                  {chartTicks.map((tick, index) => (

                    <span key={`tick-${index}`} className="chart-tick" style={{ bottom: `${tick.percent}%` }}>

                      {tick.label}

                    </span>

                  ))}

                </div>

              </>

            ) : null}

            {hasChartData ? (

              <>

                <div className="chart-grid" style={chartGridStyle}>

                  {barSeries.map((value, index) => {

                    const key = windowedKeys[index] || `${value}-${index}`

                    const isActive = activeIndex === index

                    const height = barScaled[index] || 0

                    const dayData = series[index] || { bovespa: 0, bmf: 0, estruturadas: 0 }

                    const columnStyle = { '--bar-height': `${height}%` }

                    const valueLabel = showCompactValues ? formatCurrencyCompact(value) : formatCurrency(value)

                    const dateLabel = formatDailyLabel(windowedKeys[index], index)

                    const ariaLabel = `${formatLabel(windowedKeys[index])} - Valor ${formatCurrency(value)}; bovespa ${formatCurrency(dayData.bovespa)}; BMF ${formatCurrency(dayData.bmf)}; Estrutura ${formatCurrency(dayData.estruturadas)}`

                    return (

                      <div key={key} className="chart-col" style={columnStyle}>

                        <span className="chart-value-label">{valueLabel}</span>

                        <button

                          type="button"

                          className={`chart-bar ${isActive ? 'is-active' : ''}`}

                          style={{ height: `${height}%` }}

                          onMouseEnter={(event) => handleBarEnter(index, event)}

                          onMouseLeave={handleBarLeave}

                          onFocus={(event) => handleBarEnter(index, event)}

                          onBlur={handleBarLeave}

                          aria-label={ariaLabel}

                        />

                        <span className="chart-date-label">{dateLabel}</span>

                      </div>

                    )

                  })}

                </div>

                {tooltipOpen ? (

                  <div className={`chart-tooltip ${tooltip.flip ? 'is-flipped' : ''}`} style={{ left: tooltip.x, top: tooltip.y }}>

                    <div className="chart-tooltip-title">{tooltipLabel || 'Periodo indisponivel'}</div>

                    <div className="chart-tooltip-row chart-tooltip-row--total">

                      <span>Total</span>

                      <strong>{formatCurrency(tooltipTotal)}</strong>

                    </div>

                    <div className="chart-tooltip-row chart-tooltip-row--bovespa">

                      <span>Bovespa</span>

                      <strong>{formatCurrency(tooltipData?.bovespa ?? 0)}</strong>

                    </div>

                    <div className="chart-tooltip-row chart-tooltip-row--bmf">

                      <span>BMF</span>

                      <strong>{formatCurrency(tooltipData?.bmf ?? 0)}</strong>

                    </div>

                    <div className="chart-tooltip-row chart-tooltip-row--estrutura">

                      <span>Estrutura</span>

                      <strong>{formatCurrency(tooltipData?.estruturadas ?? 0)}</strong>

                    </div>

                  </div>

                ) : null}

              </>

            ) : (

              <div className="chart-empty">Sem dados</div>

            )}

          </div>

<div className="chart-footer">

            <div>

              <span className="muted">Total</span>

              <strong>{formatCurrency(totalOverall)}</strong>

            </div>

          </div>

          <div className="assessor-rank">

            <div className="assessor-rank-head">

              <strong>Ranking de assessores</strong>

              <span className="muted">Top {ASSESSOR_RANK_LIMIT}</span>

            </div>

            {assessorRank.length ? (

              <div className="assessor-rank-list">

                {assessorRank.map((item) => (

                  <div key={item.assessor} className="assessor-rank-item">

                    <div className="assessor-rank-main">

                      <span className="assessor-name" title={item.assessor}>{item.assessor}</span>

                      <span className="assessor-value">{formatCurrency(item.value)}</span>

                    </div>

                    <div className="assessor-bar">

                      <span style={{ width: `${maxAssessorValue ? (item.value / maxAssessorValue) * 100 : 0}%` }} />

                    </div>

                  </div>

                ))}

              </div>

            ) : (

              <div className="assessor-rank-empty">Sem dados de assessores.</div>

            )}

          </div>

        </div>

        <div className="card segment-card">

          <div className="card-head">

            <h3>Distribuicao por origem</h3>

            <div className="page-list">

              <button

                className={`page-number ${originFilter === 'all' ? 'active' : ''}`}

                type="button"

                onClick={() => setOriginFilter('all')}

              >

                Todas

              </button>

              <button

                className={`page-number ${originFilter === 'bovespa' ? 'active' : ''}`}

                type="button"

                onClick={() => setOriginFilter('bovespa')}

              >

                Bovespa

              </button>

              <button

                className={`page-number ${originFilter === 'bmf' ? 'active' : ''}`}

                type="button"

                onClick={() => setOriginFilter('bmf')}

              >

                BMF

              </button>

              <button

                className={`page-number ${originFilter === 'estruturadas' ? 'active' : ''}`}

                type="button"

                onClick={() => setOriginFilter('estruturadas')}

              >

                Estruturadas

              </button>

            </div>

          </div>

          <div className="segment-list">

            {[

              { label: 'Bovespa', value: totalsByOrigin.bovespa, tone: 'cyan' },

              { label: 'BMF', value: totalsByOrigin.bmf, tone: 'violet' },

              { label: 'Estruturadas', value: totalsByOrigin.estruturadas, tone: 'amber' },

            ].map((segment) => {

              const percent = totalOverall ? (segment.value / totalOverall) * 100 : 0

              return (

                <div key={segment.label} className="segment-row">

                  <div className={`segment-dot ${segment.tone}`} />

                  <div className="segment-info">

                    <strong>{segment.label}</strong>

                    <span>{percent.toFixed(1)}% do volume</span>

                  </div>

                  <div className="segment-bar">

                    <span style={{ width: `${percent}%` }} className={segment.tone} />

                  </div>

                </div>

              )

            })}

          </div>

          <div className="segment-total">

            <div>

              <span className="muted">Total consolidado</span>

              <strong>{formatCurrency(totalOverall)}</strong>

            </div>

          </div>

          <div className="segment-total">

            <div>

              <span className="muted">Distribuicao de CPFs por broker (Estruturas)</span>

              <div className="segment-list">

                {uniqueByBroker.map((item) => (

                  <div key={item.broker} className="segment-row">

                    <div className="segment-dot cyan" />

                    <div className="segment-info">

                      <strong>{item.broker}</strong>

                      <span>{item.count} clientes unicos</span>

                    </div>

                    <div className="segment-bar">

                      <span style={{ width: `${(item.count / maxBrokerCount) * 100}%` }} className="cyan" />

                    </div>

                  </div>

                ))}

              </div>

            </div>

          </div>

          <div className="segment-total">

            <div>

              <span className="muted">Rank Receita por Broker (todas origens)</span>

              <div className="segment-list">

                {brokerRevenueRank.map((item) => (

                  <div key={item.broker} className="segment-row">

                    <div className="segment-dot violet" />

                    <div className="segment-info">

                      <strong>{item.broker}</strong>

                      <span>{formatCurrency(item.receita)} • {item.assessores} assessores • {item.clientes} clientes</span>

                    </div>

                    <div className="segment-bar">

                      <span style={{ width: `${totalOverall ? (item.receita / totalOverall) * 100 : 0}%` }} className="violet" />

                    </div>

                  </div>

                ))}

              </div>

            </div>

          </div>

        </div>

      </section>

    </div>

  )

}

export default Dashboard

