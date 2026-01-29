import { useEffect, useRef, useState } from 'react'
import Icon from './Icons'

const SelectMenu = ({
  value,
  options = [],
  onChange,
  placeholder = 'Selecionar',
  className = '',
  menuClassName = '',
}) => {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const selected = options.find((option) => option.value === value)
  const displayLabel = selected?.label || placeholder

  useEffect(() => {
    const handleOutside = (event) => {
      if (!wrapRef.current || wrapRef.current.contains(event.target)) return
      setOpen(false)
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [])

  return (
    <div className={`select-wrap ${className}`} ref={wrapRef}>
      <button
        className={`select-trigger ${open ? 'open' : ''}`}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{displayLabel}</span>
        <Icon name="arrow-down" size={14} />
      </button>
      {open ? (
        <div className={`select-menu ${menuClassName}`} role="listbox">
          {options.length ? (
            options.map((option) => (
              <button
                key={`${option.value}`}
                type="button"
                role="option"
                className={`select-option ${option.value === value ? 'active' : ''}`}
                onClick={() => {
                  onChange?.(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            ))
          ) : (
            <div className="select-empty">Sem opcoes</div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default SelectMenu
