import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'

const TreeCheckbox = ({ label, count, checked, indeterminate, depth = 0, onToggle }) => {
  const inputRef = useRef(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate
    }
  }, [indeterminate])

  return (
    <label className="tree-node" style={{ paddingLeft: `${depth * 16}px` }}>
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
      />
      <span>{label}</span>
      {typeof count === 'number' ? <small className="muted">({count})</small> : null}
    </label>
  )
}

const TreeSelect = ({
  value = [],
  tree = [],
  allValues = [],
  onChange,
  placeholder = 'Selecionar',
  className = '',
}) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState(new Set(value))
  const wrapRef = useRef(null)

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

  const allValuesList = useMemo(() => {
    if (allValues.length) return allValues
    const collect = (nodes) => nodes.flatMap((node) => {
      if (node?.values?.length) return node.values
      if (node?.children?.length) return collect(node.children)
      if (node?.value) return [node.value]
      return []
    })
    return Array.from(new Set(collect(tree))).sort()
  }, [allValues, tree])

  const summaryLabel = value.length
    ? `${value.length} selecionado${value.length > 1 ? 's' : ''}`
    : placeholder

  const filteredTree = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return tree

    const filterNode = (node) => {
      const labelMatch = String(node.label || '').toLowerCase().includes(query)
      if (!node.children?.length) return labelMatch ? node : null
      const children = node.children.map(filterNode).filter(Boolean)
      if (labelMatch || children.length) return { ...node, children }
      return null
    }

    return tree.map(filterNode).filter(Boolean)
  }, [search, tree])

  const getState = (values) => {
    if (!values || !values.length) return { checked: false, indeterminate: false }
    let count = 0
    values.forEach((val) => {
      if (draft.has(val)) count += 1
    })
    return {
      checked: count === values.length,
      indeterminate: count > 0 && count < values.length,
    }
  }

  const toggleValues = (values, force) => {
    setDraft((prev) => {
      const next = new Set(prev)
      const shouldAdd = force ?? !values.every((val) => next.has(val))
      values.forEach((val) => {
        if (shouldAdd) next.add(val)
        else next.delete(val)
      })
      return next
    })
  }

  const handleApply = () => {
    const next = Array.from(draft).sort()
    onChange?.(next)
    setOpen(false)
  }

  const handleClear = () => setDraft(new Set())
  const handleSelectAll = () => setDraft(new Set(allValuesList))

  const renderNodes = (nodes, depth = 0) => {
    return nodes.map((node) => {
      const values = node.values || (node.value ? [node.value] : [])
      const state = getState(values)
      return (
        <div key={node.key} className="tree-group">
          <TreeCheckbox
            label={node.label}
            count={node.count}
            checked={state.checked}
            indeterminate={state.indeterminate}
            depth={depth}
            onToggle={() => toggleValues(values)}
          />
          {node.children?.length ? (
            <div className="tree-children">
              {renderNodes(node.children, depth + 1)}
            </div>
          ) : null}
        </div>
      )
    })
  }

  return (
    <div className={`select-wrap ${className}`} ref={wrapRef}>
      <button
        className={`select-trigger ${open ? 'open' : ''}`}
        type="button"
        onClick={() => {
          setOpen((prev) => {
            const next = !prev
            if (next) {
              setDraft(new Set(value))
              setSearch('')
            }
            return next
          })
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{summaryLabel}</span>
        <Icon name="arrow-down" size={14} />
      </button>
      {open ? (
        <div className="select-menu tree-menu" role="listbox">
          <div className="tree-search">
            <Icon name="search" size={14} />
            <input
              className="input"
              type="search"
              placeholder="Buscar ano, mes ou dia"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="tree-actions">
            <button className="btn btn-secondary" type="button" onClick={handleSelectAll}>Selecionar tudo</button>
            <button className="btn btn-secondary" type="button" onClick={handleClear}>Limpar</button>
          </div>
          <div className="tree-content">
            {filteredTree.length ? renderNodes(filteredTree) : <div className="select-empty">Sem resultados</div>}
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

export default TreeSelect
