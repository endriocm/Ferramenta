import { useEffect, useMemo, useRef, useState } from 'react'

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

} catch (error) {

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

const Sparkline = ({ data, tone = 'currentColor' }) => {

  if (!data.length) return null

  const pointCount = data.length

  const span = Math.max(pointCount - 1, 1)

  let points = ''

  if (pointCount === 1) {

    const safeValue = Number.isFinite(data[0]) ? data[0] : 0

    const y = 100 - clamp(safeValue, 0, 100)

    points = `0,${y} 100,${y}`

  } else {

    points = data

      .map((value, index) => {

        const safeValue = Number.isFinite(value) ? value : 0

        const clampedValue = clamp(safeValue, 0, 100)

        const x = (index / span) * 100

        const y = 100 - clampedValue

        return `${x},${y}`

      })

      .join(' ')

  }

  return (

    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="sparkline">

      <polyline points={points} fill="none" stroke={tone} strokeWidth="2" />

    </svg>

  )

}

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

  const { tagsIndex, selectedBroker, apuracaoMonths } = useGlobalFilters()

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

  const structuredFiltered = useMemo(

    () => (selectedBroker.length ? structuredEnriched.filter((entry) => selectedBroker.includes(String(entry.broker || '').trim())) : structuredEnriched),

    [structuredEnriched, selectedBroker],

  )

  const bovespaFiltered = useMemo(

    () => (selectedBroker.length ? bovespaEnriched.filter((entry) => selectedBroker.includes(String(entry.broker || '').trim())) : bovespaEnriched),

    [bovespaEnriched, selectedBroker],

  )

  const bmfFiltered = useMemo(

    () => (selectedBroker.length ? bmfEnriched.filter((entry) => selectedBroker.includes(String(entry.broker || '').trim())) : bmfEnriched),

    [bmfEnriched, selectedBroker],

  )

  const includeStructured = originFilter === 'all' || originFilter === 'estruturadas'

  const includeBovespa = originFilter === 'all' || originFilter === 'bovespa'

  const includeBmf = originFilter === 'all' || originFilter === 'bmf'

  const structuredActive = includeStructured ? structuredFiltered : []

  const bovespaActive = includeBovespa ? bovespaFiltered : []

  const bmfActive = includeBmf ? bmfFiltered : []

  const keyFn = useMemo(() => {

    if (granularity === 'daily') return (entry) => getEntryDateKey(entry)

    return (entry) => String(getEntryDateKey(entry)).slice(0, 7)

  }, [granularity])

  const structuredMap = useMemo(() => aggregateByKey(structuredActive, keyFn), [structuredActive, keyFn])

  const bovespaMap = useMemo(() => aggregateByKey(bovespaActive, keyFn), [bovespaActive, keyFn])

  const bmfMap = useMemo(() => aggregateByKey(bmfActive, keyFn), [bmfActive, keyFn])

  const allKeys = useMemo(() => {

    const keys = new Set([...structuredMap.keys(), ...bovespaMap.keys(), ...bmfMap.keys()])

    return Array.from(keys).sort()

  }, [structuredMap, bovespaMap, bmfMap])

  const windowedKeys = useMemo(() => {

    const max = granularity === 'daily' ? 31 : 24

    return allKeys.slice(-max)

  }, [allKeys, granularity])

  const series = useMemo(() => {

    return windowedKeys.map((key) => ({

      key,

      estruturadas: structuredMap.get(key) || 0,

      bovespa: bovespaMap.get(key) || 0,

      bmf: bmfMap.get(key) || 0,

    }))

  }, [windowedKeys, structuredMap, bovespaMap, bmfMap])

  const totalsByOrigin = useMemo(() => {

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

  const totalOverall = totalsByOrigin.estruturadas + totalsByOrigin.bovespa + totalsByOrigin.bmf

  const visibleTotals = useMemo(() => {

    if (originFilter === 'bovespa') return totalsByOrigin.bovespa

    if (originFilter === 'bmf') return totalsByOrigin.bmf

    if (originFilter === 'estruturadas') return totalsByOrigin.estruturadas

    return totalOverall

  }, [originFilter, totalOverall, totalsByOrigin])

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

  const chartScale = buildChartScale([...totalSeries, ...estrutSeries, ...bovespaSeries, ...bmfSeries], 5)

  const totalScaled = normalizeSeries(totalSeries, chartScale)

  const estrutScaled = normalizeSeries(estrutSeries, chartScale)

  const bovespaScaled = normalizeSeries(bovespaSeries, chartScale)

  const bmfScaled = normalizeSeries(bmfSeries, chartScale)

  const chartTicks = totalSeries.length

    ? chartScale.ticks.map((tick) => ({ ...tick, label: formatCurrency(tick.value) }))

    : []

  const hasChartData = totalSeries.length > 0

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

  const dailyAllowed = !apuracaoMonths.all && apuracaoMonths.months.length === 1

  useEffect(() => {

    if (granularity === 'daily' && !dailyAllowed) setGranularity('monthly')

  }, [dailyAllowed, granularity])

  useEffect(() => {

    if (activeIndex !== null && activeIndex >= totalSeries.length) setActiveIndex(null)

  }, [activeIndex, totalSeries.length])

  useEffect(() => {

    if (granularity !== 'daily' && tooltip.open) {

      setTooltip({ open: false, index: null, x: 0, y: 0, flip: false })

    }

  }, [granularity, tooltip.open])

  useEffect(() => {

    if (tooltip.index !== null && tooltip.index >= totalSeries.length) {

      setTooltip({ open: false, index: null, x: 0, y: 0, flip: false })

    }

  }, [tooltip.index, totalSeries.length])

  const formatLabel = (key) => {

    if (!key) return ''

    if (granularity === 'daily') {

      const [, month, day] = String(key).split('-')

      return `${day}/${month}`

    }

    return formatMonthLabel(String(key).slice(0, 7))

  }

  const isDaily = granularity === 'daily'

  const gridColumns = Math.max(totalSeries.length, 1)

  const chartGridStyle = { '--chart-columns': gridColumns }

  const showCompactValues = isDaily && totalSeries.length >= 16

  const dailyLabelStep = isDaily

    ? (totalSeries.length >= 26 ? 3 : totalSeries.length >= 16 ? 2 : 1)

    : 1

  const formatDailyLabel = (key, index) => {

    if (!isDaily) return formatLabel(key)

    if (dailyLabelStep === 1) return formatLabel(key)

    if (index === 0 || index === totalSeries.length - 1 || index % dailyLabelStep === 0) {

      return formatLabel(key)

    }

    return ''

  }

  const handleBarEnter = (index, event) => {

    setActiveIndex(index)

    if (granularity !== 'daily') return

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

  const defaultIndex = hasChartData ? totalSeries.length - 1 : null

  const selectedIndex = activeIndex ?? defaultIndex

  const selectedValue = selectedIndex !== null ? totalSeries[selectedIndex] : null

  const selectedLabel = selectedIndex !== null ? formatLabel(windowedKeys[selectedIndex]) : ''

  const previousValue = selectedIndex !== null && selectedIndex > 0 ? totalSeries[selectedIndex - 1] : null

  const deltaValue = previousValue !== null && selectedValue !== null ? selectedValue - previousValue : null

  const deltaLabel = deltaValue !== null

    ? `${deltaValue >= 0 ? '+' : '-'}${formatCurrency(Math.abs(deltaValue))}`

    : ''

  const tooltipData = tooltip.index !== null ? series[tooltip.index] : null

  const tooltipTotal = tooltip.index !== null ? totalSeries[tooltip.index] : 0

  const tooltipLabel = tooltip.index !== null ? formatLabel(windowedKeys[tooltip.index]) : ''

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

                className={`page-number ${granularity === 'monthly' ? 'active' : ''}`}

                type="button"

                onClick={() => setGranularity('monthly')}

              >

                Mensal

              </button>

              <button

                className={`page-number ${granularity === 'daily' ? 'active' : ''}`}

                type="button"

                onClick={() => setGranularity('daily')}

                disabled={!dailyAllowed}

              >

                Diario

              </button>

            </div>

          </div>

                    <div className={`chart ${isDaily ? 'is-daily' : ''}`} ref={chartRef}>

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

                <Sparkline data={totalScaled} tone="rgba(255,255,255,0.6)" />

                <Sparkline data={bovespaScaled} tone="rgba(40,242,230,0.85)" />

                <Sparkline data={bmfScaled} tone="rgba(166,107,255,0.85)" />

                {!isDaily || originFilter !== 'estruturadas' ? (

                  <Sparkline data={estrutScaled} tone="rgba(255,180,84,0.85)" />

                ) : null}

                <div className="chart-grid" style={chartGridStyle}>

                  {totalSeries.map((value, index) => {

                    const key = windowedKeys[index] || `${value}-${index}`

                    const isActive = activeIndex === index

                    const height = totalScaled[index] || 0

                    const dayData = series[index] || { bovespa: 0, bmf: 0, estruturadas: 0 }

                    const columnStyle = isDaily ? { '--bar-height': `${height}%` } : undefined

                    const valueLabel = showCompactValues ? formatCurrencyCompact(value) : formatCurrency(value)

                    const dateLabel = formatDailyLabel(windowedKeys[index], index)

                    const ariaLabel = isDaily

                      ? `${formatLabel(windowedKeys[index])} - Receita ${formatCurrency(value)}; bovespa ${formatCurrency(dayData.bovespa)}; BMF ${formatCurrency(dayData.bmf)}; Estrutura ${formatCurrency(dayData.estruturadas)}`

                      : `${formatLabel(windowedKeys[index])}: ${formatCurrency(value)}`

                    return (

                      <div key={key} className={`chart-col ${isDaily ? 'is-daily' : ''}`} style={columnStyle}>

                        {isDaily ? <span className="chart-value-label">{valueLabel}</span> : null}

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

                        {isDaily ? <span className="chart-date-label">{dateLabel}</span> : null}

                      </div>

                    )

                  })}

                </div>

                {isDaily && tooltip.open && tooltip.index !== null ? (

                  <div className={`chart-tooltip ${tooltip.flip ? 'is-flipped' : ''}`} style={{ left: tooltip.x, top: tooltip.y }}>

                    <div className="chart-tooltip-title">{tooltipLabel || 'Periodo indisponivel'}</div>

                    <div className="chart-tooltip-row total">

                      <span>Receita</span>

                      <strong>{formatCurrency(tooltipTotal)}</strong>

                    </div>

                    <div className="chart-tooltip-row">

                      <span>Bovespa</span>

                      <strong>{formatCurrency(tooltipData?.bovespa ?? 0)}</strong>

                    </div>

                    <div className="chart-tooltip-row">

                      <span>BMF</span>

                      <strong>{formatCurrency(tooltipData?.bmf ?? 0)}</strong>

                    </div>

                    <div className="chart-tooltip-row">

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

            {!isDaily ? (

              <div className="chart-labels">

                {windowedKeys.map((key) => (

                  <span key={key} className="muted">{formatLabel(key)}</span>

                ))}

              </div>

            ) : null}

          </div>

          <div className="chart-selection">

            {hasChartData ? (

              <>

                <span className="chart-selection-label">Valor selecionado:</span>

                <strong>{formatCurrency(selectedValue)}</strong>

                <span className="chart-selection-meta">- {selectedLabel || 'Periodo indisponivel'}</span>

                {deltaValue !== null ? (

                  <span className={`chart-selection-delta ${deltaValue >= 0 ? 'text-positive' : 'text-negative'}`}>

                    Delta vs anterior: {deltaLabel}

                  </span>

                ) : null}

              </>

            ) : (

              <span className="muted">Sem dados para o periodo.</span>

            )}

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

