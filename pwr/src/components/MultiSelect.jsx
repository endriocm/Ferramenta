import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'

const normalizeToken = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const isAllLikeToken = (value) => {
  const token = normalizeToken(value)
  return token === '__all__' || token === 'all' || token === 'todos' || token === 'todas' || token === 'todo'
}

const resolveAllLikeValues = (options) => {
  const set = new Set()
  ;(Array.isArray(options) ? options : []).forEach((option) => {
    if (!option) return
    if (isAllLikeToken(option.value) || isAllLikeToken(option.label)) {
      set.add(option.value)
    }
  })
  return set
}

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
  searchable = true,
  searchPlaceholder = 'Buscar',
}) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState(new Set(value))
  const wrapRef = useRef(null)
  const selectAllRef = useRef(null)
  const label = useMemo(() => buildLabel(value, options, placeholder), [value, options, placeholder])
  const allLikeValues = useMemo(() => resolveAllLikeValues(options), [options])

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

  const visibleCount = filteredOptions.length
  const selectedVisibleCount = useMemo(
    () => filteredOptions.reduce((sum, option) => (draft.has(option.value) ? sum + 1 : sum), 0),
    [draft, filteredOptions],
  )
  const allVisibleSelected = visibleCount > 0 && selectedVisibleCount === visibleCount
  const noneVisibleSelected = selectedVisibleCount === 0

  useEffect(() => {
    if (!selectAllRef.current) return
    selectAllRef.current.indeterminate = !allVisibleSelected && !noneVisibleSelected
  }, [allVisibleSelected, noneVisibleSelected])

  const toggleValue = (next) => {
    setDraft((prev) => {
      const updated = new Set(prev)
      const isAllLike = allLikeValues.has(next)
      if (updated.has(next)) {
        updated.delete(next)
      } else if (isAllLike) {
        updated.clear()
        updated.add(next)
      } else {
        allLikeValues.forEach((value) => updated.delete(value))
        updated.add(next)
      }
      return updated
    })
  }

  const handleSelectAllVisible = () => {
    setDraft((prev) => {
      const updated = new Set(prev)
      if (allVisibleSelected) {
        filteredOptions.forEach((option) => updated.delete(option.value))
      } else {
        filteredOptions.forEach((option) => updated.add(option.value))
      }
      return updated
    })
  }
  const handleApply = () => {
    const nextValues = Array.from(draft)
    const hasAllLike = nextValues.some((item) => allLikeValues.has(item))
    const normalized = hasAllLike && nextValues.length > 1
      ? nextValues.filter((item) => !allLikeValues.has(item))
      : nextValues
    onChange?.(normalized.sort())
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
          {searchable ? (
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
          ) : null}
          <div className="tree-content">
            <label className={`select-option ${allVisibleSelected ? 'active' : ''}`}>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleSelected && !noneVisibleSelected}
                onChange={handleSelectAllVisible}
              />
              <span>(Selecionar tudo)</span>
            </label>
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
