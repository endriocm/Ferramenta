import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Icon from '../components/Icons'
import { useToast } from '../hooks/useToast'
import {
  DEFAULT_EARNINGS_SYMBOLS,
  fetchEarningsCalendar,
  getAutoEarningsSymbols,
  getLastEarningsSnapshot,
  getMonthRange,
  getSavedEarningsSymbols,
  getTrackedEarningsSymbols,
  parseSymbolsInput,
  setLastEarningsSnapshot,
  setTrackedEarningsSymbols,
  symbolsToInput,
} from '../services/earningsCalendar'

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab']

const getCurrentMonthKey = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const getNextMonthKey = () => {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const year = next.getFullYear()
  const month = String(next.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const ALLOWED_MIN_MONTH = getCurrentMonthKey()
const ALLOWED_MAX_MONTH = getNextMonthKey()

const clampMonthKey = (key) => {
  if (!key || key < ALLOWED_MIN_MONTH) return ALLOWED_MIN_MONTH
  if (key > ALLOWED_MAX_MONTH) return ALLOWED_MAX_MONTH
  return key
}

const toIsoDate = (value) => {
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return ''
  const year = dt.getFullYear()
  const month = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatDateLabel = (isoDate) => {
  if (!isoDate) return '-'
  const dt = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return isoDate
  return dt.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

const formatMonthLabel = (monthKey) => {
  const [yearRaw, monthRaw] = String(monthKey || '').split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return monthKey
  const dt = new Date(year, month - 1, 1)
  return dt.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
}

const formatCompactNumber = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  return num.toLocaleString('pt-BR', {
    notation: 'compact',
    maximumFractionDigits: 2,
  })
}

const formatMoney = (value, currency = 'USD', compact = false) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  try {
    return num.toLocaleString('pt-BR', {
      style: 'currency',
      currency,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 2 : 2,
    })
  } catch {
    return compact ? formatCompactNumber(num) : num.toLocaleString('pt-BR')
  }
}

const buildMonthCells = (monthKey) => {
  const [yearRaw, monthRaw] = String(monthKey || '').split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return []

  const firstDay = new Date(year, month - 1, 1)
  const lastDay = new Date(year, month, 0)
  const gridStart = new Date(firstDay)
  gridStart.setDate(firstDay.getDate() - firstDay.getDay())

  const gridEnd = new Date(lastDay)
  gridEnd.setDate(lastDay.getDate() + (6 - lastDay.getDay()))

  const cells = []
  const cursor = new Date(gridStart)
  while (cursor <= gridEnd) {
    cells.push({
      iso: toIsoDate(cursor),
      day: cursor.getDate(),
      inMonth: cursor.getMonth() === (month - 1),
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return cells
}

const compareEvents = (left, right) => {
  const leftDate = String(left?.eventDate || '')
  const rightDate = String(right?.eventDate || '')
  if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate)
  if (leftDate && !rightDate) return -1
  if (!leftDate && rightDate) return 1
  return String(left?.displaySymbol || '').localeCompare(String(right?.displaySymbol || ''))
}

const buildLogoUrl = (symbol) => {
  const clean = String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '')
  if (!clean) return ''
  return `https://icons.brapi.dev/icons/${encodeURIComponent(clean)}.svg`
}

const LOGO_PAGE_SIZE = 30
const CALENDAR_CHIP_LIMIT = 4

const TickerLogo = memo(({ symbol, size = 16 }) => {
  const url = buildLogoUrl(symbol)
  const [error, setError] = useState(false)
  if (!url || error) return null
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="ticker-logo"
      onError={() => setError(true)}
    />
  )
})
TickerLogo.displayName = 'TickerLogo'

const EventChip = memo(({ item }) => (
  <div
    className={`earnings-event-chip market-${String(item.market || 'US').toUpperCase()}${item.dateSource === 'scraped' ? ' source-scraped' : ''}`.trim()}
    title={`${item.displaySymbol} - ${item.companyName}${item.dateSources?.length ? ` (fonte: ${item.dateSources.join(', ')})` : ''}`}
  >
    <div className="earnings-chip-ticker">
      <TickerLogo symbol={item.displaySymbol} size={14} />
      <strong>{item.displaySymbol}</strong>
    </div>
    <span>
      Rec {item.expectations?.revenueAverage != null ? formatMoney(item.expectations.revenueAverage, item.currency || 'USD', true) : '-'}
    </span>
  </div>
))
EventChip.displayName = 'EventChip'

const DayCell = memo(({ cell, daily }) => {
  const visibleEvents = daily.length > CALENDAR_CHIP_LIMIT ? daily.slice(0, CALENDAR_CHIP_LIMIT) : daily
  return (
    <article className={`earnings-day-cell ${cell.inMonth ? '' : 'is-outside-month'}`.trim()}>
      <header>
        <span>{cell.day}</span>
        {daily.length ? <small>{daily.length} evento(s)</small> : null}
      </header>
      <div className="earnings-day-events">
        {visibleEvents.map((item) => (
          <EventChip key={`${item.id}-${item.eventDate}`} item={item} />
        ))}
        {daily.length > CALENDAR_CHIP_LIMIT ? (
          <div className="earnings-day-more">+{daily.length - CALENDAR_CHIP_LIMIT}</div>
        ) : null}
      </div>
    </article>
  )
})
DayCell.displayName = 'DayCell'

const EventCard = memo(({ item }) => (
  <article className="earnings-event-card">
    <div className="earnings-event-head">
      <div className="earnings-event-head-left">
        <TickerLogo symbol={item.displaySymbol} size={28} />
        <div>
          <strong>{item.displaySymbol}</strong>
          <span>{item.companyName}</span>
        </div>
      </div>
      <div className="earnings-event-date">
        <small>Data</small>
        <strong>{formatDateLabel(item.eventDate)}</strong>
      </div>
    </div>
    <div className="earnings-event-meta">
      <span className={`status-pill market-tag market-${String(item.market || 'US').toUpperCase()}`.trim()}>
        {item.market === 'BR' ? 'Brasil' : 'EUA'}
      </span>
      <span className="muted">{item.exchange || '-'}</span>
      <span className="muted">{item.profile?.sector || 'Sem setor'}</span>
      {item.dateSources?.length ? (
        <span className={`status-pill ${item.dateSource === 'scraped' ? 'source-scraped-pill' : 'source-yahoo-pill'}`}>
          {item.dateSources.join(' + ')}
        </span>
      ) : null}
      {item.alternateDate ? (
        <span className="muted" title={`Fontes: ${(item.alternateDateSources || []).join(', ')}`}>
          Data alternativa: {formatDateLabel(item.alternateDate)}
        </span>
      ) : null}
      {item.expectations?.recommendationKey ? (
        <span className="muted">Recomendacao: {item.expectations.recommendationKey}</span>
      ) : null}
    </div>
    <div className="earnings-event-metrics">
      <div>
        <small>Receita esperada</small>
        <strong>
          {item.expectations?.revenueAverage != null
            ? formatMoney(item.expectations.revenueAverage, item.currency || 'USD', true)
            : '-'}
        </strong>
        <span className="muted">
          Faixa: {item.expectations?.revenueLow != null
            ? formatMoney(item.expectations.revenueLow, item.currency || 'USD', true)
            : '-'}
          {' '}a{' '}
          {item.expectations?.revenueHigh != null
            ? formatMoney(item.expectations.revenueHigh, item.currency || 'USD', true)
            : '-'}
        </span>
      </div>
      <div>
        <small>Preco / Market cap</small>
        <strong>
          {item.metrics?.regularMarketPrice != null
            ? formatMoney(item.metrics.regularMarketPrice, item.currency || 'USD', false)
            : '-'}
        </strong>
        <span className="muted">
          Cap: {item.metrics?.marketCap != null
            ? formatMoney(item.metrics.marketCap, item.currency || 'USD', true)
            : '-'}
        </span>
      </div>
    </div>
  </article>
))
EventCard.displayName = 'EventCard'

const EMPTY_EARNINGS_PAYLOAD = {
  items: [],
  undated: [],
  errors: [],
  summary: { totalSymbols: 0, scheduledCount: 0, undatedCount: 0, errorCount: 0 },
  generatedAt: '',
  scrapeInfo: null,
}

const CalendarioResultados = () => {
  const { notify } = useToast()

  const [monthKey, setMonthKey] = useState(() => getCurrentMonthKey())
  const [marketFilter, setMarketFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [trackedSymbols, setTrackedSymbols] = useState(() => getTrackedEarningsSymbols())
  const [savedSymbols, setSavedSymbols] = useState(() => getSavedEarningsSymbols())
  const [symbolsDraft, setSymbolsDraft] = useState(() => symbolsToInput(getSavedEarningsSymbols()))
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [payload, setPayload] = useState(() => getLastEarningsSnapshot() || EMPTY_EARNINGS_PAYLOAD)
  const requestSeqRef = useRef(0)

  const monthRange = useMemo(() => getMonthRange(monthKey), [monthKey])
  const autoSymbolsCount = getAutoEarningsSymbols().length

  const trackedSymbolsRef = useRef(trackedSymbols)
  trackedSymbolsRef.current = trackedSymbols

  const loadCalendar = useCallback(async ({ force = false, symbolsOverride = null } = {}) => {
    const requestId = requestSeqRef.current + 1
    requestSeqRef.current = requestId

    const symbols = parseSymbolsInput(symbolsOverride || trackedSymbolsRef.current || getTrackedEarningsSymbols())
    if (!symbols.length) {
      setBusy(false)
      setErrorMessage('')
      const empty = EMPTY_EARNINGS_PAYLOAD
      setPayload(empty)
      setLastEarningsSnapshot(empty)
      return
    }

    setBusy(true)
    setErrorMessage('')
    try {
      const nextPayload = await fetchEarningsCalendar({
        symbols,
        from: monthRange.from,
        to: monthRange.to,
        force,
      })
      if (requestId !== requestSeqRef.current) return
      const resolved = {
        items: Array.isArray(nextPayload?.items) ? nextPayload.items : [],
        undated: Array.isArray(nextPayload?.undated) ? nextPayload.undated : [],
        errors: Array.isArray(nextPayload?.errors) ? nextPayload.errors : [],
        summary: nextPayload?.summary || { totalSymbols: symbols.length, scheduledCount: 0, undatedCount: 0, errorCount: 0 },
        generatedAt: String(nextPayload?.generatedAt || ''),
        scrapeInfo: nextPayload?.scrapeInfo || null,
      }
      setPayload(resolved)
      setLastEarningsSnapshot(resolved)
    } catch (error) {
      if (requestId !== requestSeqRef.current) return
      const message = error?.message || 'Falha ao carregar calendario de resultados.'
      setErrorMessage(message)
      notify(message, 'warning')
    } finally {
      if (requestId === requestSeqRef.current) {
        setBusy(false)
      }
    }
  }, [monthRange.from, monthRange.to, notify])

  useEffect(() => {
    void loadCalendar()
  }, [loadCalendar])

  const handleSaveSymbols = useCallback(() => {
    const symbols = parseSymbolsInput(symbolsDraft)
    if (!symbols.length) {
      notify('Informe ao menos um ticker valido.', 'warning')
      return
    }
    const saved = setTrackedEarningsSymbols(symbols)
    const effective = getTrackedEarningsSymbols()
    setSavedSymbols(saved)
    setTrackedSymbols(effective)
    setSymbolsDraft(symbolsToInput(saved))
    notify(`Lista base atualizada (${saved.length}). Monitorando ${effective.length} ativos com modo automatico.`, 'success')
  }, [notify, symbolsDraft])

  const handleResetSymbols = useCallback(() => {
    const defaults = setTrackedEarningsSymbols(DEFAULT_EARNINGS_SYMBOLS)
    const effective = getTrackedEarningsSymbols()
    setSavedSymbols(defaults)
    setTrackedSymbols(effective)
    setSymbolsDraft(symbolsToInput(defaults))
    notify(`Lista base restaurada. Monitorando ${effective.length} ativos com modo automatico.`, 'success')
  }, [notify])

  const events = useMemo(() => {
    const base = Array.isArray(payload.items) ? [...payload.items] : []
    base.sort(compareEvents)
    return base
  }, [payload.items])

  const filteredEvents = useMemo(() => {
    const query = String(search || '').trim().toLowerCase()
    return events.filter((item) => {
      if (marketFilter !== 'ALL' && String(item.market || '').toUpperCase() !== marketFilter) return false
      if (!query) return true
      const haystack = `${item.displaySymbol || ''} ${item.companyName || ''} ${item.profile?.sector || ''} ${item.profile?.industry || ''}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [events, marketFilter, search])

  const eventsByDate = useMemo(() => {
    const map = new Map()
    filteredEvents.forEach((item) => {
      const date = String(item?.eventDate || '')
      if (!date) return
      if (!map.has(date)) map.set(date, [])
      map.get(date).push(item)
    })
    map.forEach((list) => list.sort(compareEvents))
    return map
  }, [filteredEvents])

  const monthCells = useMemo(() => buildMonthCells(monthKey), [monthKey])
  const generatedLabel = useMemo(() => {
    if (!payload.generatedAt) return '-'
    const dt = new Date(payload.generatedAt)
    if (Number.isNaN(dt.getTime())) return payload.generatedAt
    return dt.toLocaleString('pt-BR')
  }, [payload.generatedAt])

  const undatedFiltered = useMemo(() => {
    return (Array.isArray(payload.undated) ? payload.undated : [])
      .filter((item) => (marketFilter === 'ALL' ? true : String(item.market || '').toUpperCase() === marketFilter))
      .sort(compareEvents)
  }, [marketFilter, payload.undated])

  const [visibleLimit, setVisibleLimit] = useState(LOGO_PAGE_SIZE)

  // Reset pagination when filters change
  useEffect(() => {
    setVisibleLimit(LOGO_PAGE_SIZE)
  }, [filteredEvents])

  const visibleEvents = useMemo(
    () => filteredEvents.slice(0, visibleLimit),
    [filteredEvents, visibleLimit],
  )
  const hasMore = visibleLimit < filteredEvents.length

  return (
    <div className="page">
      <PageHeader
        title="Calendario de resultados (BR + EUA)"
        subtitle="Agenda de resultados com expectativa do mercado (EPS/receita) e contexto por empresa. Fontes: Yahoo Finance + Investidor10, StatusInvest, EarningsHub, Investing.com."
        meta={[
          { label: 'Ativos monitorados', value: trackedSymbols.length },
          { label: 'Eventos no periodo', value: filteredEvents.length },
          { label: 'Sem data', value: undatedFiltered.length },
          { label: 'Atualizado em', value: generatedLabel },
        ]}
        actions={[
          {
            label: busy ? 'Atualizando...' : 'Atualizar',
            icon: 'sync',
            onClick: () => loadCalendar({ force: true }),
            disabled: busy,
          },
        ]}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Parametros do calendario</h3>
            <p className="muted">
              Modo automatico ativo: usa todos os ativos detectados nas bases importadas (Vencimento, Antecipacao e Receita) + lista base opcional.
            </p>
          </div>
        </div>

        <div className="earnings-toolbar-grid">
          <label>
            Mes de referencia (mes atual e proximo)
            <input
              className="input"
              type="month"
              value={monthKey}
              min={ALLOWED_MIN_MONTH}
              max={ALLOWED_MAX_MONTH}
              onChange={(event) => setMonthKey(clampMonthKey(event.target.value))}
            />
          </label>

          <label>
            Mercado
            <select
              className="input"
              value={marketFilter}
              onChange={(event) => setMarketFilter(event.target.value)}
            >
              <option value="ALL">Brasil + EUA</option>
              <option value="BR">Somente Brasil</option>
              <option value="US">Somente EUA</option>
            </select>
          </label>

          <label>
            Busca
            <input
              className="input"
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Ticker, empresa, setor..."
            />
          </label>
        </div>

        <label className="earnings-symbols-label">
          Lista base de tickers (opcional)
          <textarea
            className="input earnings-symbols-input"
            value={symbolsDraft}
            onChange={(event) => setSymbolsDraft(event.target.value)}
            placeholder="PETR4, VALE3, NVDC34, AAPL..."
            rows={3}
          />
        </label>
        <p className="muted">
          Base manual: {savedSymbols.length} | Detectados automaticamente: {autoSymbolsCount} | Total monitorado: {trackedSymbols.length}
        </p>

        <div className="panel-actions earnings-toolbar-actions">
          <button className="btn btn-primary" type="button" onClick={handleSaveSymbols}>
            <Icon name="check" size={16} />
            Salvar lista
          </button>
          <button className="btn btn-secondary" type="button" onClick={handleResetSymbols}>
            <Icon name="sync" size={16} />
            Restaurar padrao
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => loadCalendar({ force: true })} disabled={busy}>
            <Icon name="calendar" size={16} />
            Recarregar calendario
          </button>
        </div>
      </section>

      {payload.scrapeInfo ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Fontes externas (scraping)</h3>
              <p className="muted">Dados obtidos de sites de agenda de resultados para complementar o Yahoo Finance.</p>
            </div>
          </div>
          <div className="earnings-scrape-info">
            <span>Total scrapeado: <strong>{payload.scrapeInfo.totalEntries}</strong></span>
            <span className="source-count">Investidor10: {payload.scrapeInfo.sources?.investidor10 ?? 0}</span>
            <span className="source-count">StatusInvest: {payload.scrapeInfo.sources?.statusinvest ?? 0}</span>
            <span className="source-count">EarningsHub: {payload.scrapeInfo.sources?.earningshub ?? 0}</span>
            <span className="source-count">Investing.com: {payload.scrapeInfo.sources?.investing ?? 0}</span>
            {payload.scrapeInfo.errors > 0 ? (
              <span className="muted">({payload.scrapeInfo.errors} fonte(s) com erro)</span>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Calendario mensal</h3>
            <p className="muted">
              {formatMonthLabel(monthKey)} ({monthRange.from} a {monthRange.to})
            </p>
          </div>
        </div>

        <div className="earnings-calendar-wrap">
          <div className="earnings-calendar-weekdays">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="earnings-weekday">{label}</div>
            ))}
          </div>
          <div className="earnings-calendar-grid">
            {monthCells.map((cell) => {
              const daily = eventsByDate.get(cell.iso) || []
              return <DayCell key={cell.iso} cell={cell} daily={daily} />
            })}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Eventos detalhados</h3>
            <p className="muted">Expectativa de mercado e informacoes relevantes por ativo.</p>
          </div>
        </div>

        {errorMessage ? (
          <div className="sync-warnings">
            <strong>ERRO</strong>
            {errorMessage}
          </div>
        ) : null}

        {filteredEvents.length ? (
          <div className="earnings-event-list">
            {visibleEvents.map((item) => (
              <EventCard key={`${item.id}-${item.eventDate || 'nodate'}`} item={item} />
            ))}
            {hasMore ? (
              <button
                className="btn btn-secondary earnings-load-more"
                type="button"
                onClick={() => setVisibleLimit((prev) => prev + LOGO_PAGE_SIZE)}
              >
                Mostrar mais ({filteredEvents.length - visibleLimit} restantes)
              </button>
            ) : null}
          </div>
        ) : (
          <div className="empty-state">
            <h4>Nenhum evento no periodo selecionado.</h4>
            <p className="muted">Ajuste mes, mercado ou lista de ativos monitorados.</p>
          </div>
        )}

        {undatedFiltered.length ? (
          <div className="sync-warnings" style={{ marginTop: 12 }}>
            <strong>SEM DATA DE RESULTADO ({undatedFiltered.length})</strong>
            <div style={{ marginTop: 6 }}>
              {undatedFiltered.slice(0, 16).map((item) => (
                <div key={`${item.id}-undated`} className="muted">
                  {item.displaySymbol} - {item.companyName}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

export default CalendarioResultados
