import { useEffect, useMemo, useState } from 'react'
import { formatCurrency, formatNumber } from '../utils/format'
import { normalizeDateKey } from '../utils/dateKey'
import { loadStructuredRevenue } from '../services/revenueStructured'
import { loadRevenueByType } from '../services/revenueStore'
import { enrichRow } from '../services/tags'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { filterByApuracaoMonths, formatMonthLabel } from '../services/apuracao'

const Sparkline = ({ data, tone = 'currentColor' }) => {
  if (!data.length) return null
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * 100
      const y = 100 - ((value - min) / range) * 100
      return `${x},${y}`
    })
    .join(' ')

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

  const keyFn = useMemo(() => {
    if (granularity === 'daily') return (entry) => getEntryDateKey(entry)
    return (entry) => String(getEntryDateKey(entry)).slice(0, 7)
  }, [granularity])

  const structuredMap = useMemo(() => aggregateByKey(structuredFiltered, keyFn), [structuredFiltered, keyFn])
  const bovespaMap = useMemo(() => aggregateByKey(bovespaFiltered, keyFn), [bovespaFiltered, keyFn])
  const bmfMap = useMemo(() => aggregateByKey(bmfFiltered, keyFn), [bmfFiltered, keyFn])

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

  const uniqueBovespa = useMemo(() => collectUniqueClients(bovespaFiltered), [bovespaFiltered])
  const uniqueEstruturadas = useMemo(() => collectUniqueClients(structuredFiltered), [structuredFiltered])

  const uniqueByBroker = useMemo(() => {
    const map = new Map()
    structuredFiltered.forEach((entry) => {
      const broker = String(entry?.broker || '').trim() || '—'
      const code = String(entry?.codigoCliente || '').trim()
      if (!code) return
      if (!map.has(broker)) map.set(broker, new Set())
      map.get(broker).add(code)
    })
    return Array.from(map.entries())
      .map(([broker, set]) => ({ broker, count: set.size }))
      .sort((a, b) => b.count - a.count)
  }, [structuredFiltered])

  const maxBrokerCount = uniqueByBroker.reduce((max, row) => Math.max(max, row.count), 1)

  const totalSeries = series.map((item) => item.estruturadas + item.bovespa + item.bmf)
  const estrutSeries = series.map((item) => item.estruturadas)
  const bovespaSeries = series.map((item) => item.bovespa)
  const bmfSeries = series.map((item) => item.bmf)
  const maxTotal = Math.max(...totalSeries, 1)

  const brokerRevenueRank = useMemo(() => {
    const map = new Map()
    const allEntries = [...structuredFiltered, ...bovespaFiltered, ...bmfFiltered]
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
  }, [structuredFiltered, bovespaFiltered, bmfFiltered])

  const dailyAllowed = !apuracaoMonths.all && apuracaoMonths.months.length === 1

  useEffect(() => {
    if (granularity === 'daily' && !dailyAllowed) setGranularity('monthly')
  }, [dailyAllowed, granularity])

  const formatLabel = (key) => {
    if (!key) return ''
    if (granularity === 'daily') {
      const [, month, day] = String(key).split('-')
      return `${day}/${month}`
    }
    return formatMonthLabel(String(key).slice(0, 7))
  }

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
          <div className="chart">
            <Sparkline data={totalSeries} tone="rgba(255,255,255,0.6)" />
            <Sparkline data={bovespaSeries} tone="rgba(40,242,230,0.85)" />
            <Sparkline data={bmfSeries} tone="rgba(166,107,255,0.85)" />
            <Sparkline data={estrutSeries} tone="rgba(255,180,84,0.85)" />
            <div className="chart-grid">
              {totalSeries.map((value, index) => (
                <div key={`${value}-${index}`} style={{ height: `${(value / maxTotal) * 100}%` }} className="chart-bar" />
              ))}
            </div>
          </div>
          <div className="chart-footer">
            <div>
              <span className="muted">Total</span>
              <strong>{formatCurrency(totalOverall)}</strong>
            </div>
            <div className="chart-labels">
              {windowedKeys.map((key) => (
                <span key={key} className="muted">{formatLabel(key)}</span>
              ))}
            </div>
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
