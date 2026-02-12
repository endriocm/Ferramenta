import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'

const TreeRow = ({
  label,
  count,
  checked,
  indeterminate,
  depth = 0,
  onToggle,
  canExpand = false,
  expanded = false,
  onToggleExpand,
}) => {
  const inputRef = useRef(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate
    }
  }, [indeterminate])

  return (
    <div className="tree-node" style={{ paddingLeft: `${depth * 16}px` }}>
      {canExpand ? (
        <button
          className={`tree-caret ${expanded ? 'expanded' : 'collapsed'}`}
          type="button"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onToggleExpand?.()
          }}
          aria-label={expanded ? 'Recolher' : 'Expandir'}
        >
          <Icon name="arrow-down" size={12} />
        </button>
      ) : (
        <span className="tree-caret-spacer" />
      )}
      <label className="tree-label">
        <input
          ref={inputRef}
          type="checkbox"
          checked={checked}
          onChange={onToggle}
        />
        <span>{label}</span>
        {typeof count === 'number' ? <small className="muted">({count})</small> : null}
      </label>
    </div>
  )
}

const TreeSelect = ({
  value = [],
  tree = [],
  allValues: _allValues = [],
  onChange,
  onDraftChange,
  onCancel,
  placeholder = 'Selecionar',
  searchable = true,
  searchPlaceholder = 'Buscar',
  className = '',
}) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState(new Set(value))
  const [expanded, setExpanded] = useState(new Set())
  const wrapRef = useRef(null)
  const selectAllRef = useRef(null)

  const closeDropdown = (reason) => {
    setOpen(false)
    if (reason === 'cancel') onCancel?.()
  }

  useEffect(() => {
    const handleOutside = (event) => {
      if (!wrapRef.current || wrapRef.current.contains(event.target)) return
      if (open) closeDropdown('cancel')
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape' && open) closeDropdown('cancel')
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const summaryLabel = value.length
    ? `${value.length} selecionado${value.length > 1 ? 's' : ''}`
    : placeholder

  const buildExpandedState = () => {
    const next = new Set()
    const selected = new Set(value)
    const walk = (nodes, depth = 0) => {
      nodes.forEach((node) => {
        const values = node.values || (node.value ? [node.value] : [])
        const hasSelected = values.some((val) => selected.has(val))
        if (depth === 0) next.add(node.key)
        if (depth > 0 && hasSelected) next.add(node.key)
        if (node.children?.length) walk(node.children, depth + 1)
      })
    }
    walk(tree)
    return next
  }

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

  const visibleValues = useMemo(() => {
    const collect = (nodes) => nodes.flatMap((node) => {
      if (node?.values?.length) return node.values
      if (node?.children?.length) return collect(node.children)
      if (node?.value) return [node.value]
      return []
    })
    const list = collect(filteredTree)
    return Array.from(new Set(list))
  }, [filteredTree])

  const selectedVisibleCount = useMemo(
    () => visibleValues.reduce((sum, value) => (draft.has(value) ? sum + 1 : sum), 0),
    [draft, visibleValues],
  )

  const allVisibleSelected = visibleValues.length > 0 && selectedVisibleCount === visibleValues.length
  const noneVisibleSelected = selectedVisibleCount === 0

  useEffect(() => {
    if (!selectAllRef.current) return
    selectAllRef.current.indeterminate = !allVisibleSelected && !noneVisibleSelected
  }, [allVisibleSelected, noneVisibleSelected])

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
      onDraftChange?.(Array.from(next).sort())
      return next
    })
  }

  const handleApply = () => {
    const next = Array.from(draft).sort()
    onChange?.(next)
    setOpen(false)
  }

  const handleSelectAllVisible = () => {
    if (!visibleValues.length) return
    toggleValues(visibleValues, !allVisibleSelected)
  }

  const renderNodes = (nodes, depth = 0) => {
    return nodes.map((node) => {
      const values = node.values || (node.value ? [node.value] : [])
      const state = getState(values)
      const hasChildren = Boolean(node.children?.length)
      const isExpanded = search ? true : expanded.has(node.key)
      return (
        <div key={node.key} className="tree-group">
          <TreeRow
            label={node.label}
            count={node.count}
            checked={state.checked}
            indeterminate={state.indeterminate}
            depth={depth}
            onToggle={() => toggleValues(values)}
            canExpand={hasChildren}
            expanded={isExpanded}
            onToggleExpand={() => {
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(node.key)) next.delete(node.key)
                else next.add(node.key)
                return next
              })
            }}
          />
          {hasChildren && isExpanded ? (
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
              setExpanded(buildExpandedState())
            } else {
              onCancel?.()
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
            <label className="tree-node tree-select-all">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleSelected && !noneVisibleSelected}
                onChange={handleSelectAllVisible}
              />
              <span>(Selecionar tudo)</span>
            </label>
            {filteredTree.length ? renderNodes(filteredTree) : <div className="select-empty">Sem resultados</div>}
          </div>
          <div className="tree-footer">
            <button className="btn btn-secondary" type="button" onClick={() => closeDropdown('cancel')}>Cancelar</button>
            <button className="btn btn-primary" type="button" onClick={handleApply}>Aplicar</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default TreeSelect
