import Icon from './Icons'
import MultiSelect from './MultiSelect'
import { quickActions } from '../data/navigation'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'

const Topbar = ({ title, breadcrumbs, onToggleSidebar, currentPath }) => {
  const actions = quickActions[currentPath] || []
  const {
    selectedBroker,
    setSelectedBroker,
    brokerOptions,
    selectedAssessor,
    setSelectedAssessor,
    assessorOptions,
    apuracaoMonths,
    setApuracaoMonths,
    apuracaoOptions,
  } = useGlobalFilters()

  const APURACAO_ALL = '__ALL__'
  const apuracaoValue = apuracaoMonths.all ? [APURACAO_ALL] : apuracaoMonths.months
  const apuracaoItems = [{ value: APURACAO_ALL, label: 'Todos' }, ...apuracaoOptions]

  const handleApuracaoChange = (values) => {
    if (!values || !values.length || values.includes(APURACAO_ALL)) {
      setApuracaoMonths({ all: true, months: [] })
      return
    }
    setApuracaoMonths({ all: false, months: values })
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn ghost mobile-only" onClick={onToggleSidebar} aria-label="Abrir menu">
          <Icon name="menu" size={18} />
        </button>
        <div>
          <div className="breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`}>
                {crumb}
                {index < breadcrumbs.length - 1 ? <span className="crumb-sep">/</span> : null}
              </span>
            ))}
          </div>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="topbar-actions">
        {currentPath === '/' ? (
          <MultiSelect
            value={apuracaoValue}
            options={apuracaoItems}
            onChange={handleApuracaoChange}
            placeholder="Mes de apuracao"
            className="topbar-filter"
            menuClassName="topbar-filter-menu"
            searchable={false}
          />
        ) : null}
        <MultiSelect
          value={selectedBroker}
          options={brokerOptions}
          onChange={setSelectedBroker}
          placeholder="Broker global"
          className="topbar-filter"
          menuClassName="topbar-filter-menu"
        />
        <MultiSelect
          value={selectedAssessor}
          options={assessorOptions}
          onChange={setSelectedAssessor}
          placeholder="Assessor global"
          className="topbar-filter"
          menuClassName="topbar-filter-menu"
        />
        {actions.length ? (
          <div className="action-group">
            {actions.map((action) => (
              <button key={action.label} className="btn btn-secondary" type="button">
                <Icon name={action.icon} size={16} />
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="user-chip" role="button" tabIndex={0}>
          <span className="avatar">EA</span>
          <div>
            <div className="user-name">Endrio Admin</div>
            <div className="user-role">Acesso administrativo</div>
          </div>
        </div>
      </div>
    </header>
  )
}

export default Topbar
