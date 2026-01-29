import Icon from './Icons'

const PageHeader = ({ title, subtitle, meta = [], actions = [] }) => {
  return (
    <div className="page-header">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        {meta.length ? (
          <div className="meta-row">
            {meta.map((item) => (
              <span key={item.label} className="meta-item">
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="page-actions">
        {actions.map((action) => (
          <button key={action.label} className={`btn ${action.variant || 'btn-primary'}`} type="button">
            {action.icon ? <Icon name={action.icon} size={16} /> : null}
            {action.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default PageHeader
