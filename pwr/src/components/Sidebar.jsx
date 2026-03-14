import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import Icon from './Icons'
import DesktopControls from './DesktopControls'
import { navigation } from '../data/navigation'
import { exportXlsx } from '../services/exportXlsx'
import { useToast } from '../hooks/useToast'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { buildMonthlyConsolidatedExportPayload } from '../services/revenueConsolidated'
import { getCurrentUserKey } from '../services/currentUser'
import { clearLastImported } from '../services/vencimentoCache'
import { clearLink } from '../services/vencimentoLink'
import { clearGlobalFolderLink } from '../services/globalFolderLink'
import {
  clearImportBindings,
  clearImportCatalog,
} from '../services/importCatalog'
import { clearTags } from '../services/tags'
import { removeLocalStorage, setHydratedStorageValue } from '../services/nativeStorage'
import { preloadRoute } from '../routeRegistry'

const COLLAPSIBLE_SECTIONS = new Set(['Receita', 'Operacao', 'Dados', 'Ferramentas'])

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

const Sidebar = ({
  currentPath,
  onNavigate,
  isOpen,
  onClose,
  isDesktopCollapsed = false,
  onToggleDesktopCollapse,
}) => {
  const { notify } = useToast()
  const { tagsIndex } = useGlobalFilters()
  const [exportMonth, setExportMonth] = useState(() => getCurrentMonth())
  const [exporting, setExporting] = useState(false)
  const [resettingLinkedData, setResettingLinkedData] = useState(false)
  const [openSections, setOpenSections] = useState(() =>
    navigation.reduce((acc, section) => {
      if (!COLLAPSIBLE_SECTIONS.has(section.section)) return acc
      acc[section.section] = section.items.some((item) => item.path === currentPath)
      return acc
    }, {}),
  )
  const exportMonthLabel = useMemo(() => formatMonthLabel(exportMonth), [exportMonth])

  useEffect(() => {
    const activeSection = navigation.find((section) => section.items.some((item) => item.path === currentPath))
    if (!activeSection || !COLLAPSIBLE_SECTIONS.has(activeSection.section)) return

    setOpenSections((prev) => {
      if (prev[activeSection.section]) return prev
      return { ...prev, [activeSection.section]: true }
    })
  }, [currentPath])

  const toggleSection = useCallback((sectionName) => {
    if (!COLLAPSIBLE_SECTIONS.has(sectionName)) return
    setOpenSections((prev) => ({ ...prev, [sectionName]: !prev[sectionName] }))
  }, [])

  const handleRoutePrefetch = useCallback((path) => {
    preloadRoute(path)
  }, [])

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

  const handleResetLinkedData = useCallback(async () => {
    if (resettingLinkedData || typeof window === 'undefined') return

    const confirmed = window.confirm(
      'Isso vai apagar todos os dados importados/vinculados dos arquivos Excel (Receita, Comissao XP, Vencimento e Tags) e recarregar a tela. Deseja continuar?',
    )
    if (!confirmed) return

    setResettingLinkedData(true)
    try {
      const userKey = getCurrentUserKey()
      const localPrefixes = [
        'pwr.receita.',
        'pwr.vencimento.cache.',
        'pwr.vencimento.link.',
        'pwr.vencimento.reportDate.',
        'pwr.vencimento.overrides.',
        'pwr.global.folder.',
        'pwr.import.catalog.',
        'pwr.import.bindings.',
        'pwr.dashboard.goals.',
        'pwr.theme.palette.',
      ]

      const keys = Object.keys(localStorage || {})
      keys.forEach((key) => {
        if (localPrefixes.some((prefix) => key.startsWith(prefix))) {
          try {
            localStorage.removeItem(key)
          } catch {
            // noop
          }
        }
      })

      try {
        localStorage.removeItem('pwr.vencimento.broadcast')
      } catch {
        // noop
      }

      const nativeKeys = [
        'pwr.receita.bovespa',
        'pwr.receita.bmf',
        'pwr.receita.estruturadas',
        'pwr.receita.manual',
        'pwr.receita.xp',
        'pwr.receita.xp.override',
        'pwr.receita.xp.lastSyncAt',
        'pwr.market.cache',
      ]

      await Promise.all(nativeKeys.map(async (key) => {
        setHydratedStorageValue(key, null)
        await removeLocalStorage(key)
      }))

      clearLastImported(userKey)
      await Promise.all([
        clearLink(userKey),
        clearGlobalFolderLink(userKey),
        Promise.resolve().then(() => clearImportCatalog(userKey)),
        Promise.resolve().then(() => clearImportBindings(userKey)),
        clearTags(userKey),
      ])

      window.dispatchEvent(new CustomEvent('pwr:receita-updated'))
      window.dispatchEvent(new CustomEvent('pwr:repasse-updated', { detail: { config: {} } }))
      notify('Dados de arquivos vinculados apagados. Recarregando...', 'success')
      window.setTimeout(() => window.location.reload(), 350)
    } catch (error) {
      notify(error?.message ? `Falha ao zerar dados: ${error.message}` : 'Falha ao zerar dados vinculados.', 'warning')
    } finally {
      setResettingLinkedData(false)
    }
  }, [notify, resettingLinkedData])

  if (isDesktopCollapsed) {
    return (
      <aside className={`sidebar ${isOpen ? 'open' : ''} desktop-collapsed`.trim()} aria-label="Navegacao principal">
        <button
          type="button"
          className="sidebar-collapse-handle collapsed"
          onClick={onToggleDesktopCollapse}
          aria-label="Expandir menu lateral"
          title="Expandir menu lateral"
        >
          <Icon name="arrow-right" size={14} />
        </button>
        {isOpen ? <button className="sidebar-overlay" onClick={onClose} aria-label="Fechar menu" /> : null}
      </aside>
    )
  }

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`.trim()} aria-label="Navegacao principal">
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
        {navigation.map((section) => {
          const collapsible = COLLAPSIBLE_SECTIONS.has(section.section)
          const sectionOpen = collapsible ? Boolean(openSections[section.section]) : true
          const sectionId = `nav-section-${section.section.toLowerCase().replace(/\s+/g, '-')}`

          return (
            <div key={section.section} className={`nav-section ${collapsible ? 'is-collapsible' : ''}`}>
              {collapsible ? (
                <div className="nav-section-head">
                  <button
                    type="button"
                    className={`nav-section-toggle ${sectionOpen ? 'open' : ''}`}
                    onClick={() => toggleSection(section.section)}
                    aria-expanded={sectionOpen}
                    aria-controls={sectionId}
                  >
                    <span className="nav-section-title">{section.section}</span>
                    <span className="nav-section-toggle-icon" aria-hidden="true">
                      <Icon name={sectionOpen ? 'arrow-up' : 'arrow-down'} size={12} />
                    </span>
                  </button>
                </div>
              ) : (
                <span className="nav-section-title">{section.section}</span>
              )}

              {sectionOpen ? (
                <div className="nav-items" id={sectionId}>
                  {section.items.map((item) => {
                    const active = currentPath === item.path
                    const toneClass = item.tone ? `nav-tone-${item.tone}` : ''
                    return (
                      <a
                        key={item.path}
                        className={`nav-item ${active ? 'active' : ''} ${toneClass}`.trim()}
                        href={`#${item.path}`}
                        onClick={() => onNavigate?.(item.path)}
                        onMouseEnter={() => handleRoutePrefetch(item.path)}
                        onFocus={() => handleRoutePrefetch(item.path)}
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
              ) : null}
            </div>
          )
        })}

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
            disabled={exporting || resettingLinkedData}
          >
            <Icon name="download" size={16} />
            {exporting ? 'Exportando...' : 'Exportar receita'}
          </button>
          <button
            className="btn btn-danger sidebar-export-button"
            type="button"
            onClick={handleResetLinkedData}
            disabled={exporting || resettingLinkedData}
          >
            <Icon name="warning" size={16} />
            {resettingLinkedData ? 'Zerando dados...' : 'Zerar dados vinculados'}
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
      <button
        type="button"
        className={`sidebar-collapse-handle ${isDesktopCollapsed ? 'collapsed' : ''}`}
        onClick={onToggleDesktopCollapse}
        aria-label={isDesktopCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
        title={isDesktopCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
      >
        <Icon name={isDesktopCollapsed ? 'arrow-right' : 'arrow-left'} size={14} />
      </button>
      {isOpen ? <button className="sidebar-overlay" onClick={onClose} aria-label="Fechar menu" /> : null}
    </aside>
  )
}

export default memo(Sidebar)
