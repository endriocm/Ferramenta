import { useCallback, useMemo, useState } from 'react'
import Icon from './Icons'
import DesktopControls from './DesktopControls'
import { navigation } from '../data/navigation'
import { exportXlsx } from '../services/exportXlsx'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { buildMonthlyConsolidatedExportPayload } from '../services/revenueConsolidated'

const getCurrentMonth = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const formatMonthLabel = (monthKey) => {
  const [year, month] = String(monthKey || '').split('-')
  if (!year || !month) return monthKey
  return `${month}/${year}`
}

const Sidebar = ({ currentPath, onNavigate, isOpen, onClose }) => {
  const { notify } = useToast()
  const { tagsIndex } = useGlobalFilters()
  const [exportMonth, setExportMonth] = useState(() => getCurrentMonth())
  const [exporting, setExporting] = useState(false)
  const exportMonthLabel = useMemo(() => formatMonthLabel(exportMonth), [exportMonth])

  const handleExportRevenue = useCallback(async () => {
    if (!exportMonth) {
      notify('Selecione o mes/ano para exportar.', 'warning')
      return
    }

    setExporting(true)
    try {
      const payload = buildMonthlyConsolidatedExportPayload({
        monthKey: exportMonth,
        tagsIndex,
      })

      if (!payload.rowCount) {
        notify(`Sem receitas para ${exportMonthLabel}.`, 'warning')
        return
      }

      const safeMonth = String(exportMonth).replace(/[^0-9-]/g, '')
      await exportXlsx({
        fileName: `receita_bruta_consolidada_${safeMonth}.xlsx`,
        sheetName: 'Receita Bruta',
        columns: payload.headers,
        rows: payload.rows,
      })

      notify(`Excel exportado com sucesso (${exportMonthLabel}).`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao exportar: ${error.message}` : 'Falha ao exportar receita.', 'warning')
    } finally {
      setExporting(false)
    }
  }, [exportMonth, exportMonthLabel, notify, tagsIndex])

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`} aria-label="Navegacao principal">
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-mark">PWR</span>
          <span className="brand-name">Endrio</span>
        </div>
        <button className="icon-btn ghost mobile-only" onClick={onClose} aria-label="Fechar menu">
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {navigation.map((section) => (
          <div key={section.section} className="nav-section">
            <span className="nav-section-title">{section.section}</span>
            <div className="nav-items">
              {section.items.map((item) => {
                const active = currentPath === item.path
                const toneClass = item.tone ? `nav-tone-${item.tone}` : ''
                return (
                  <a
                    key={item.path}
                    className={`nav-item ${active ? 'active' : ''} ${toneClass}`.trim()}
                    href={`#${item.path}`}
                    onClick={onNavigate}
                  >
                    <span className="nav-icon">
                      <Icon name={item.icon} size={18} />
                    </span>
                    <span className="nav-label">
                      {item.label}
                      {item.description ? <small>{item.description}</small> : null}
                    </span>
                  </a>
                )
              })}
            </div>
          </div>
        ))}

        <div className="sidebar-export-panel">
          <span className="nav-section-title">Exportacao</span>
          <label className="sidebar-export-label" htmlFor="sidebar-export-month">Mes/ano</label>
          <input
            id="sidebar-export-month"
            className="input sidebar-export-month"
            type="month"
            value={exportMonth}
            onChange={(event) => setExportMonth(event.target.value)}
          />
          <button
            className="btn btn-secondary sidebar-export-button"
            type="button"
            onClick={handleExportRevenue}
            disabled={exporting}
          >
            <Icon name="download" size={16} />
            {exporting ? 'Exportando...' : 'Exportar receita'}
          </button>
        </div>
      </div>
      <div className="sidebar-footer">
        <div className="status-pill">
          <span className="dot pulse" />
          Operacao sincronizada
        </div>
        <DesktopControls />
      </div>
      {isOpen ? <button className="sidebar-overlay" onClick={onClose} aria-label="Fechar menu" /> : null}
    </aside>
  )
}

export default Sidebar