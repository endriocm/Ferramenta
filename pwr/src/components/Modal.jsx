import { useEffect } from 'react'
import { createPortal } from 'react-dom'
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

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null

  const content = (
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

  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}

export default Modal
