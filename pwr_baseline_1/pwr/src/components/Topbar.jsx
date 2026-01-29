import Icon from './Icons'
import { quickActions } from '../data/navigation'

const Topbar = ({ title, breadcrumbs, onToggleSidebar, currentPath }) => {
  const actions = quickActions[currentPath] || []

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
        <div className="search-pill">
          <Icon name="search" size={16} />
          <input type="search" placeholder="Buscar no painel" aria-label="Buscar" />
        </div>
        <div className="action-group">
          {actions.map((action) => (
            <button key={action.label} className="btn btn-secondary" type="button">
              <Icon name={action.icon} size={16} />
              {action.label}
            </button>
          ))}
        </div>
        <div className="user-chip" role="button" tabIndex={0}>
          <span className="avatar">EA</span>
          <div>
            <div className="user-name">Endrio Admin</div>
            <div className="user-role">Mesa Principal</div>
          </div>
        </div>
      </div>
    </header>
  )
}

export default Topbar
