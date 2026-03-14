import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'

const SelectMenu = ({
  value,
  options = [],
  onChange,
  placeholder = 'Selecionar',
  className = '',
  menuClassName = '',
  searchPlaceholder = 'Buscar',
}) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState(value ?? '')
  const wrapRef = useRef(null)

  const selected = options.find((option) => option.value === value)
  const displayLabel = selected?.label || placeholder
  const selectedDotColor = selected?.dotColor || selected?.color || ''

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

  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return options
    return options.filter((option) => String(option.label || option.value || '').toLowerCase().includes(query))
  }, [options, search])

  const handleApply = () => {
    onChange?.(draft)
    setOpen(false)
  }

  return (
    <div className={`select-wrap ${className}`} ref={wrapRef}>
      <button
        className={`select-trigger ${open ? 'open' : ''}`}
        type="button"
        onClick={() => setOpen((prev) => {
          const next = !prev
          if (next) {
            setDraft(value ?? '')
            setSearch('')
          }
          return next
        })}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="select-trigger-value">
          {selectedDotColor ? <span className="select-option-dot" style={{ backgroundColor: selectedDotColor }} aria-hidden="true" /> : null}
          <span>{displayLabel}</span>
        </span>
        <Icon name="arrow-down" size={14} />
      </button>
      {open ? (
        <div className={`select-menu ${menuClassName}`} role="listbox">
          <div className="tree-search">
            <Icon name="search" size={14} />
            <input
              className="input"
              type="search"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="tree-content">
            {filteredOptions.length ? (
              filteredOptions.map((option) => (
                <button
                  key={`${option.value}`}
                  type="button"
                  role="option"
                  className={`select-option ${option.value === draft ? 'active' : ''}`}
                  onClick={() => setDraft(option.value)}
                >
                  {option?.dotColor || option?.color ? (
                    <span
                      className="select-option-dot"
                      style={{ backgroundColor: option.dotColor || option.color }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span>{option.label}</span>
                </button>
              ))
            ) : (
              <div className="select-empty">Sem opcoes</div>
            )}
          </div>
          <div className="tree-footer">
            <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="btn btn-primary" type="button" onClick={handleApply}>Aplicar</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default SelectMenu
