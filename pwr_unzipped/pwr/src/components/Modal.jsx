import { useEffect } from 'react'
import Icon from './Icons'

const Modal = ({ open, title, subtitle, onClose, children }) => {
  useEffect(() => {
    if (!open) return
    const handler = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          <button className="icon-btn ghost" onClick={onClose} aria-label="Fechar modal">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
      <button className="modal-backdrop" onClick={onClose} aria-label="Fechar modal" />
    </div>
  )
}

export default Modal
