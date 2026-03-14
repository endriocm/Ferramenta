import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Icon from '../components/Icons'
import { useToast } from '../hooks/useToast'
import { getMonthRange } from '../services/earningsCalendar'
import {
  fetchDividendsCalendar,
  getLastDividendsSnapshot,
  setLastDividendsSnapshot,
} from '../services/dividendsCalendar'

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab']
const CALENDAR_CHIP_LIMIT = 4
const VISIBLE_PAGE_SIZE = 30

const getCurrentMonthKey = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const getNextMonthKey = (monthKey) => {
  const [yearRaw, monthRaw] = String(monthKey || '').split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return getCurrentMonthKey()
  }
  const dt = new Date(year, month, 1)
  const nextYear = dt.getFullYear()
  const nextMonth = String(dt.getMonth() + 1).padStart(2, '0')
  return `${nextYear}-${nextMonth}`
}

const getAllowedMonthKeys = () => {
  const current = getCurrentMonthKey()
  const next = getNextMonthKey(current)
  return [current, next]
}

const isEventInMonth = (eventDate, monthKey) => {
  const safeDate = String(eventDate || '').trim()
  const safeMonth = String(monthKey || '').trim()
  if (!safeDate || !safeMonth) return false
  return safeDate.startsWith(`${safeMonth}-`)
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

const formatMoney = (value, currency = 'BRL') => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  try {
    return num.toLocaleString('pt-BR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })
  } catch {
    return num.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })
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
    className={`earnings-event-chip market-${String(item.market || 'US').toUpperCase()}`.trim()}
    title={`${item.displaySymbol} - ${item.type} - ${formatMoney(item.valueNet, item.currency || 'BRL')}`}
  >
    <div className="earnings-chip-ticker">
      <TickerLogo symbol={item.displaySymbol} size={14} />
      <strong>{item.displaySymbol}</strong>
    </div>
    <span>
      {item.type} {formatMoney(item.valueNet, item.currency || 'BRL')}
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
        {daily.length ? <small>{daily.length} provento(s)</small> : null}
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
          <span>{item.type === 'JCP' ? 'JCP líquido' : 'Dividendo / provento'}</span>
        </div>
      </div>
      <div className="earnings-event-date">
        <small>Data-com</small>
        <strong>{formatDateLabel(item.eventDate)}</strong>
      </div>
    </div>

    <div className="earnings-event-meta">
      <span className={`status-pill market-tag market-${String(item.market || 'US').toUpperCase()}`.trim()}>
        {item.market === 'BR' ? 'Brasil' : 'EUA'}
      </span>
      <span className="muted">Tipo: {item.type || '-'}</span>
      <span className="muted">Fonte: {item.source || '-'}</span>
      <span className="muted">Pagamento: {formatDateLabel(item.paymentDate)}</span>
    </div>

    <div className="earnings-event-metrics">
      <div>
        <small>Valor bruto por ativo</small>
        <strong>{formatMoney(item.amount, item.currency || 'BRL')}</strong>
        <span className="muted">Valor informado pelo provedor</span>
      </div>
      <div>
        <small>Valor liquido por ativo</small>
        <strong>{formatMoney(item.valueNet, item.currency || 'BRL')}</strong>
        <span className="muted">
          {item.type === 'JCP' ? 'JCP com liquido estimado de 85%' : 'Liquido igual ao valor bruto'}
        </span>
      </div>
      <div>
        <small>Referencia</small>
        <strong>{item.displaySymbol}</strong>
        <span className="muted">Calendario pela data-com</span>
      </div>
    </div>
  </article>
))
EventCard.displayName = 'EventCard'

const CalendarioProventos = () => {
  const { notify } = useToast()

  const [monthKey, setMonthKey] = useState(() => getCurrentMonthKey())
  const [marketFilter, setMarketFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [payload, setPayload] = useState(() => getLastDividendsSnapshot() || emptyPayload('', '', ''))
  const [visibleLimit, setVisibleLimit] = useState(VISIBLE_PAGE_SIZE)
  const requestSeqRef = useRef(0)

  const allowedMonthKeys = useMemo(() => getAllowedMonthKeys(), [])
  const monthRange = useMemo(() => getMonthRange(monthKey), [monthKey])
  const calendarWindowRange = useMemo(() => {
    const currentMonth = allowedMonthKeys[0] || getCurrentMonthKey()
    const nextMonth = allowedMonthKeys[1] || currentMonth
    const currentRange = getMonthRange(currentMonth)
    const nextRange = getMonthRange(nextMonth)
    return {
      from: currentRange.from,
      to: nextRange.to,
    }
  }, [allowedMonthKeys])

  useEffect(() => {
    if (allowedMonthKeys.includes(monthKey)) return
    setMonthKey(allowedMonthKeys[0] || getCurrentMonthKey())
  }, [allowedMonthKeys, monthKey])

  const loadCalendar = useCallback(async ({ force = false } = {}) => {
    const requestId = requestSeqRef.current + 1
    requestSeqRef.current = requestId

    setBusy(true)
    setErrorMessage('')
    try {
      const nextPayload = await fetchDividendsCalendar({
        from: calendarWindowRange.from,
        to: calendarWindowRange.to,
        force,
      })
      if (requestId !== requestSeqRef.current) return
      const resolved = {
        items: Array.isArray(nextPayload?.items) ? nextPayload.items : [],
        undated: Array.isArray(nextPayload?.undated) ? nextPayload.undated : [],
        errors: Array.isArray(nextPayload?.errors) ? nextPayload.errors : [],
        summary: nextPayload?.summary || emptyPayload(calendarWindowRange.from, calendarWindowRange.to).summary,
        generatedAt: String(nextPayload?.generatedAt || ''),
      }
      setPayload(resolved)
      setLastDividendsSnapshot(resolved)
    } catch (error) {
      if (requestId !== requestSeqRef.current) return
      const message = error?.message || 'Falha ao carregar calendario de proventos.'
      setErrorMessage(message)
      notify(message, 'warning')
    } finally {
      if (requestId === requestSeqRef.current) setBusy(false)
    }
  }, [calendarWindowRange.from, calendarWindowRange.to, notify])

  useEffect(() => {
    void loadCalendar()
  }, [loadCalendar])

  const events = useMemo(() => {
    const base = Array.isArray(payload.items) ? [...payload.items] : []
    base.sort(compareEvents)
    return base
  }, [payload.items])

  const eventsInSelectedMonth = useMemo(
    () => events.filter((item) => isEventInMonth(item?.eventDate, monthKey)),
    [events, monthKey],
  )

  const filteredEvents = useMemo(() => {
    const query = String(search || '').trim().toLowerCase()
    return eventsInSelectedMonth.filter((item) => {
      if (marketFilter !== 'ALL' && String(item.market || '').toUpperCase() !== marketFilter) return false
      if (!query) return true
      const haystack = `${item.displaySymbol || ''} ${item.type || ''} ${item.source || ''}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [eventsInSelectedMonth, marketFilter, search])

  const monthCells = useMemo(() => buildMonthCells(monthKey), [monthKey])

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

  const generatedLabel = useMemo(() => {
    if (!payload.generatedAt) return '-'
    const dt = new Date(payload.generatedAt)
    if (Number.isNaN(dt.getTime())) return payload.generatedAt
    return dt.toLocaleString('pt-BR')
  }, [payload.generatedAt])

  const currencySummary = useMemo(() => {
    return filteredEvents.reduce((acc, item) => {
      const currency = String(item?.currency || '').trim() || 'BRL'
      const nextValue = (acc[currency] || 0) + (Number(item?.valueNet) || 0)
      return {
        ...acc,
        [currency]: nextValue,
      }
    }, {})
  }, [filteredEvents])

  useEffect(() => {
    setVisibleLimit(VISIBLE_PAGE_SIZE)
  }, [filteredEvents])

  const visibleEvents = useMemo(
    () => filteredEvents.slice(0, visibleLimit),
    [filteredEvents, visibleLimit],
  )
  const hasMore = visibleLimit < filteredEvents.length

  return (
    <div className="page">
      <PageHeader
        title="Calendario de proventos"
        subtitle="Agenda global de dividendos e JCP por data-com, independente de planilhas vinculadas."
        meta={[
          { label: 'Janela coletada', value: `${formatMonthLabel(allowedMonthKeys[0])} + ${formatMonthLabel(allowedMonthKeys[1])}` },
          { label: 'Proventos no mes', value: filteredEvents.length },
          { label: 'Sem data', value: payload.undated.length },
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
              Coleta automatica no calendario global de proventos. Exibicao limitada ao mes atual e ao proximo.
            </p>
          </div>
        </div>

        <div className="earnings-toolbar-grid">
          <label>
            Mes de referencia
            <select
              className="input"
              value={monthKey}
              onChange={(event) => setMonthKey(event.target.value)}
            >
              {allowedMonthKeys.map((key) => (
                <option key={key} value={key}>
                  {formatMonthLabel(key)}
                </option>
              ))}
            </select>
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
              placeholder="Ticker, tipo, fonte..."
            />
          </label>
        </div>

        <div className="panel-actions earnings-toolbar-actions">
          <button className="btn btn-secondary" type="button" onClick={() => loadCalendar({ force: true })} disabled={busy}>
            <Icon name="calendar" size={16} />
            Recarregar calendario
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Resumo dos proventos</h3>
            <p className="muted">Somatorio liquido por moeda para os eventos filtrados no periodo.</p>
          </div>
        </div>

        <div className="earnings-event-metrics">
          <div>
            <small>Total BRL</small>
            <strong>{formatMoney(currencySummary.BRL || 0, 'BRL')}</strong>
            <span className="muted">Liquido somado dos ativos em real</span>
          </div>
          <div>
            <small>Total USD</small>
            <strong>{formatMoney(currencySummary.USD || 0, 'USD')}</strong>
            <span className="muted">Liquido somado dos ativos em dolar</span>
          </div>
          <div>
            <small>Janela</small>
            <strong>{formatMonthLabel(monthKey)}</strong>
            <span className="muted">Coleta: {calendarWindowRange.from} a {calendarWindowRange.to}</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Calendario mensal</h3>
            <p className="muted">
              {formatMonthLabel(monthKey)} ({monthRange.from} a {monthRange.to}) pela data-com.
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
            <h3>Proventos detalhados</h3>
            <p className="muted">Valor do provento por ativo, com tipo, data-com e data de pagamento.</p>
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
                onClick={() => setVisibleLimit((prev) => prev + VISIBLE_PAGE_SIZE)}
              >
                Mostrar mais ({filteredEvents.length - visibleLimit} restantes)
              </button>
            ) : null}
          </div>
        ) : (
          <div className="empty-state">
            <h4>Nenhum provento no periodo selecionado.</h4>
            <p className="muted">Ajuste mes, mercado ou busca para refinar a visualizacao.</p>
          </div>
        )}

        {payload.undated.length ? (
          <div className="sync-warnings" style={{ marginTop: 12 }}>
            <strong>SEM DATA-COM ({payload.undated.length})</strong>
            <div style={{ marginTop: 6 }}>
              {payload.undated.slice(0, 16).map((item) => (
                <div key={`${item.id}-undated`} className="muted">
                  {item.displaySymbol} - {item.type} - {formatMoney(item.valueNet, item.currency || 'BRL')}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {payload.errors.length ? (
          <div className="sync-warnings" style={{ marginTop: 12 }}>
            <strong>ATIVOS COM ERRO ({payload.errors.length})</strong>
            <div style={{ marginTop: 6 }}>
              {payload.errors.slice(0, 16).map((item) => (
                <div key={`${item.symbol}-error`} className="muted">
                  {item.displaySymbol} - {item.message}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

const emptyPayload = (from = '', to = '', generatedAt = '') => ({
  items: [],
  undated: [],
  errors: [],
  summary: {
    from,
    to,
    totalMonths: 0,
    totalTypes: 0,
    scheduledCount: 0,
    undatedCount: 0,
    errorCount: 0,
  },
  generatedAt,
})

export default CalendarioProventos
