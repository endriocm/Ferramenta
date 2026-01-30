import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'

const buildLabel = (values, options, placeholder) => {
  if (!values?.length) return placeholder
  const labels = values
    .map((value) => options.find((opt) => opt.value === value)?.label || value)
    .filter(Boolean)
  if (labels.length <= 2) return labels.join(', ')
  return `${labels.length} selecionados`
}

const MultiSelect = ({
  value = [],
  options = [],
  onChange,
  placeholder = 'Selecionar',
  className = '',
  menuClassName = '',
  searchPlaceholder = 'Buscar',
}) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState(new Set(value))
  const wrapRef = useRef(null)
  const label = useMemo(() => buildLabel(value, options, placeholder), [value, options, placeholder])

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

  const toggleValue = (next) => {
    setDraft((prev) => {
      const updated = new Set(prev)
      if (updated.has(next)) updated.delete(next)
      else updated.add(next)
      return updated
    })
  }

  const handleSelectAll = () => setDraft(new Set(options.map((option) => option.value)))
  const handleClear = () => setDraft(new Set())
  const handleApply = () => {
    onChange?.(Array.from(draft).sort())
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
            setDraft(new Set(value))
            setSearch('')
          }
          return next
        })}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
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
          <div className="tree-actions">
            <button className="btn btn-secondary" type="button" onClick={handleSelectAll}>Selecionar tudo</button>
            <button className="btn btn-secondary" type="button" onClick={handleClear}>Limpar</button>
          </div>
          <div className="tree-content">
            {filteredOptions.length ? (
              filteredOptions.map((option) => {
                const checked = draft.has(option.value)
                return (
                  <label key={`${option.value}`} className={`select-option ${checked ? 'active' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleValue(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                )
              })
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

export default MultiSelect
