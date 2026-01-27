import { memo } from 'react'

const DataTable = ({ columns, rows, onRowClick, emptyMessage = 'Sem dados para exibir.' }) => {
  if (!rows.length) {
    return (
      <div className="empty-state">
        <h4>{emptyMessage}</h4>
        <p className="muted">Tente ajustar os filtros ou sincronizar novos dados.</p>
        <button className="btn btn-primary" type="button">Sincronizar agora</button>
      </div>
    )
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ width: col.width }}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} onClick={() => onRowClick?.(row)}>
              {columns.map((col) => (
                <td key={`${row.id}-${col.key}`}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default memo(DataTable)
