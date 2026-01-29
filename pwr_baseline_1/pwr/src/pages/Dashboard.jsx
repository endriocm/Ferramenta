import Icon from '../components/Icons'
import { dashboardKpis, dashboardMini, dashboardSegments, dashboardSeries } from '../data/dashboard'
import { formatCurrency, formatNumber } from '../utils/format'

const Sparkline = ({ data }) => {
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
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

const Trend = ({ delta }) => {
  const up = delta >= 0
  return (
    <span className={`trend ${up ? 'up' : 'down'}`}>
      <Icon name={up ? 'arrow-up' : 'arrow-down'} size={14} />
      {Math.abs(delta * 100).toFixed(0)}%
    </span>
  )
}

const Dashboard = () => {
  return (
    <div className="dashboard">
      <section className="kpi-grid">
        {dashboardKpis.map((kpi) => (
          <div key={kpi.id} className="card kpi-card">
            <div className="kpi-label">{kpi.label}</div>
            <div className="kpi-value">{formatCurrency(kpi.value)}</div>
            <Trend delta={kpi.delta} />
          </div>
        ))}
      </section>

      <section className="mini-grid">
        {dashboardMini.map((item) => (
          <div key={item.id} className="card mini-card">
            <div className="mini-label">{item.label}</div>
            <div className="mini-value">{item.value}</div>
            <span className="mini-change">{item.change}</span>
          </div>
        ))}
      </section>

      <section className="dashboard-bottom">
        <div className="card chart-card">
          <div className="card-head">
            <div>
              <h3>Fluxo operacional</h3>
              <p className="muted">Movimento diario consolidado</p>
            </div>
            <div className="pill">Ultimos 21 dias</div>
          </div>
          <div className="chart">
            <Sparkline data={dashboardSeries} />
            <div className="chart-grid">
              {dashboardSeries.map((value, index) => (
                <div key={`${value}-${index}`} style={{ height: `${value}%` }} className="chart-bar" />
              ))}
            </div>
          </div>
          <div className="chart-footer">
            <div>
              <span className="muted">Media</span>
              <strong>{formatNumber(4020)}</strong>
            </div>
            <div>
              <span className="muted">Pico recente</span>
              <strong>{formatNumber(6820)}</strong>
            </div>
            <div>
              <span className="muted">Alertas</span>
              <strong>{formatNumber(7)}</strong>
            </div>
          </div>
        </div>

        <div className="card segment-card">
          <div className="card-head">
            <h3>Distribuicao por origem</h3>
            <span className="muted">Janeiro 2026</span>
          </div>
          <div className="segment-list">
            {dashboardSegments.map((segment) => (
              <div key={segment.label} className="segment-row">
                <div className={`segment-dot ${segment.tone}`} />
                <div className="segment-info">
                  <strong>{segment.label}</strong>
                  <span>{segment.value}% do volume</span>
                </div>
                <div className="segment-bar">
                  <span style={{ width: `${segment.value}%` }} className={segment.tone} />
                </div>
              </div>
            ))}
          </div>
          <div className="segment-total">
            <div>
              <span className="muted">Total consolidado</span>
              <strong>{formatCurrency(12845000)}</strong>
            </div>
            <button className="btn btn-secondary" type="button">
              <Icon name="doc" size={16} />
              Ver relatorio
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

export default Dashboard
