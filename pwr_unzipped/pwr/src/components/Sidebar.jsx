import Icon from './Icons'
import { navigation } from '../data/navigation'

const Sidebar = ({ currentPath, onNavigate, isOpen, onClose }) => {
  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`} aria-label="Navegacao principal">
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-mark">PWR</span>
          <span className="brand-name">Endrio</span>
        </div>
        <button className="icon-btn ghost mobile-only" onClick={onClose} aria-label="Fechar menu">
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {navigation.map((section) => (
          <div key={section.section} className="nav-section">
            <span className="nav-section-title">{section.section}</span>
            <div className="nav-items">
              {section.items.map((item) => {
                const active = currentPath === item.path
                return (
                  <a
                    key={item.path}
                    className={`nav-item ${active ? 'active' : ''}`}
                    href={`#${item.path}`}
                    onClick={onNavigate}
                  >
                    <span className="nav-icon">
                      <Icon name={item.icon} size={18} />
                    </span>
                    <span className="nav-label">
                      {item.label}
                      {item.description ? <small>{item.description}</small> : null}
                    </span>
                  </a>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="sidebar-footer">
        <div className="status-pill">
          <span className="dot pulse" />
          Operacao sincronizada
        </div>
      </div>
      {isOpen ? <button className="sidebar-overlay" onClick={onClose} aria-label="Fechar menu" /> : null}
    </aside>
  )
}

export default Sidebar
