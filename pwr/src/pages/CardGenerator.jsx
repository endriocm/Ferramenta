import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import PayoffChart from '../components/cards/PayoffChart'
import PayoffTable from '../components/cards/PayoffTable'
import StrategyCardPreview from '../components/cards/StrategyCardPreview'
import { useToast } from '../hooks/useToast'
import {
  buildStrategyModel,
  createStrategyOptionEntry,
  getStrategyDefaults,
  getStrategyFields,
  getStrategyOptionForm,
  strategyTemplateOptions,
} from '../services/strategyTemplates'
import { exportCardAsPdf, exportCardAsPng } from '../services/cardExport'
import { buildCardPaletteStyles, cardPalettes, getCardPaletteById } from '../services/cardPalettes'
import { fetchCompanyProfile } from '../services/companyProfile'
import { fetchYahooMarketData, normalizeYahooSymbol } from '../services/marketData'
import { formatCurrency } from '../utils/format'

const sectionOrder = ['Identificacao', 'Comercial']
const layoutOptions = [
  { value: 'payoff', label: 'Card payoff (cliente)' },
  { value: 'destaque', label: 'Ofertas destaque' },
]

const buildGroupedFields = (fields) => {
  const groups = new Map()
  ;(Array.isArray(fields) ? fields : []).forEach((field) => {
    const section = field.section || 'Outros'
    if (!groups.has(section)) groups.set(section, [])
    groups.get(section).push(field)
  })
  return sectionOrder
    .filter((section) => groups.has(section))
    .map((section) => ({ section, fields: groups.get(section) }))
}

const templateOptions = strategyTemplateOptions
const isStockType = (value) => String(value || '').trim().toUpperCase() === 'STOCK'
const isExplicitBarrierType = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  return raw === 'UI' || raw === 'UO' || raw === 'KI' || raw === 'KO' || raw === 'DI' || raw === 'DO'
}

const toPositiveNumber = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  let cleaned = String(value).trim().replace(/[^\d,.-]/g, '')
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    cleaned = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(/,/g, '.')
      : cleaned.replace(/,/g, '')
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const formatCompactCurrency = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(number)
}

const formatOptionalNumber = (value, digits = 2) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return number.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

const formatOptionalPct = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return `${number.toFixed(2).replace('.', ',')}%`
}

const toFirstMeaningfulSentence = (text, maxLength = 280) => {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  const sentence = raw.match(/^(.+?[.!?])(\s|$)/)?.[1] || raw
  if (sentence.length <= maxLength) return sentence
  return `${sentence.slice(0, maxLength - 1).trim()}...`
}

const buildCompanyInsights = (profile) => {
  if (!profile) return { title: '', summary: '', points: [] }
  const title = String(profile?.name || '').trim()
  const summary = toFirstMeaningfulSentence(profile?.summary, 300)
  const points = []

  if (profile?.sector || profile?.industry) {
    const sectorLine = [profile.sector, profile.industry].filter(Boolean).join(' • ')
    if (sectorLine) points.push(`Setor: ${sectorLine}`)
  }

  const marketCap = formatCompactCurrency(profile?.marketCap)
  if (marketCap) points.push(`Valor de mercado: ${marketCap}`)

  const dayChange = formatOptionalPct(profile?.regularMarketChangePercent)
  if (dayChange) points.push(`Variação diária: ${dayChange}`)

  const pe = formatOptionalNumber(profile?.priceEarnings)
  if (pe) points.push(`P/L: ${pe}`)

  const eps = formatOptionalNumber(profile?.earningsPerShare)
  if (eps) points.push(`LPA: ${eps}`)

  const low52 = formatOptionalNumber(profile?.fiftyTwoWeekLow)
  const high52 = formatOptionalNumber(profile?.fiftyTwoWeekHigh)
  if (low52 && high52) points.push(`Faixa 52 semanas: ${low52} - ${high52}`)

  return {
    title,
    summary,
    points: points.slice(0, 4),
  }
}

const removeStockEntries = (entries) => (
  Array.isArray(entries)
    ? entries.filter((entry) => !isStockType(entry?.optionType)).map((entry) => ({ ...entry }))
    : []
)

const inferReferenceQtyFromStockEntries = (entries) => {
  const quantities = (Array.isArray(entries) ? entries : [])
    .filter((entry) => isStockType(entry?.optionType))
    .map((entry) => toPositiveNumber(entry?.quantity))
    .filter((value) => value != null)
  if (!quantities.length) return null
  return Math.max(...quantities)
}

const cloneOptionEntries = (entries) => (
  Array.isArray(entries)
    ? entries.map((entry) => ({ ...entry }))
    : []
)

const areOptionEntriesEquivalent = (leftEntries, rightEntries) => {
  const left = Array.isArray(leftEntries) ? leftEntries : []
  const right = Array.isArray(rightEntries) ? rightEntries : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] || {}
    const r = right[index] || {}
    if (String(l.label || '').trim() !== String(r.label || '').trim()) return false
    if (String(l.optionType || 'CALL') !== String(r.optionType || 'CALL')) return false
    if (String(l.side || 'long') !== String(r.side || 'long')) return false
    if (Boolean(l.useCustomQuantity) !== Boolean(r.useCustomQuantity)) return false
    if (String(l.quantity ?? '').trim() !== String(r.quantity ?? '').trim()) return false
    if (String(l.strike ?? '').trim() !== String(r.strike ?? '').trim()) return false
    if (String(l.barrierType ?? '').trim() !== String(r.barrierType ?? '').trim()) return false
    if (String(l.barrierValue ?? '').trim() !== String(r.barrierValue ?? '').trim()) return false
    if (String(l.coupon ?? '').trim() !== String(r.coupon ?? '').trim()) return false
  }
  return true
}

const CardGenerator = () => {
  const { notify } = useToast()
  const previewRef = useRef(null)
  const paletteMenuRef = useRef(null)
  const initialTemplateId = templateOptions[0]?.value || 'put_spread'
  const [templateId, setTemplateId] = useState(initialTemplateId)
  const [layoutMode, setLayoutMode] = useState('payoff')
  const [paletteId, setPaletteId] = useState('gold_standard')
  const [paletteMenuOpen, setPaletteMenuOpen] = useState(false)
  const [paletteFilter, setPaletteFilter] = useState('')
  const [showCompanyLogo, setShowCompanyLogo] = useState(true)
  const [liveTickerPrice, setLiveTickerPrice] = useState(null)
  const [isTickerPriceLoading, setIsTickerPriceLoading] = useState(false)
  const [companyProfile, setCompanyProfile] = useState(null)
  const [isCompanyProfileLoading, setIsCompanyProfileLoading] = useState(false)
  const [values, setValues] = useState(() => {
    const defaults = getStrategyDefaults(initialTemplateId)
    const inferredStockQty = inferReferenceQtyFromStockEntries(defaults.options)
    const stockQuantity = String(defaults?.stockQuantity ?? '').trim() || (inferredStockQty != null ? String(inferredStockQty) : '')
    return {
      ...defaults,
      stockQuantity,
      options: removeStockEntries(defaults.options),
    }
  })
  const [optionDraftEntries, setOptionDraftEntries] = useState(() => {
    const defaults = getStrategyDefaults(initialTemplateId)
    return removeStockEntries(defaults.options)
  })
  const [messageText, setMessageText] = useState('')
  const [messageDirty, setMessageDirty] = useState(false)
  const [runningExport, setRunningExport] = useState('')

  const fields = useMemo(() => getStrategyFields(templateId), [templateId])
  const optionForm = useMemo(() => getStrategyOptionForm(templateId), [templateId])
  const groupedFields = useMemo(() => buildGroupedFields(fields), [fields])
  const model = useMemo(() => buildStrategyModel(templateId, values), [templateId, values])
  const selectedPalette = useMemo(() => getCardPaletteById(paletteId), [paletteId])
  const filteredPalettes = useMemo(() => {
    const term = String(paletteFilter || '').trim().toLowerCase()
    if (!term) return cardPalettes
    return cardPalettes.filter((palette) => {
      return palette.label.toLowerCase().includes(term) || palette.description.toLowerCase().includes(term)
    })
  }, [paletteFilter])
  const paletteStyles = useMemo(() => buildCardPaletteStyles(selectedPalette), [selectedPalette])
  const visibleOptionDraftEntries = useMemo(() => removeStockEntries(optionDraftEntries), [optionDraftEntries])
  const hasPendingOptionChanges = useMemo(() => {
    const applied = removeStockEntries(values.options)
    return !areOptionEntriesEquivalent(applied, visibleOptionDraftEntries)
  }, [values.options, visibleOptionDraftEntries])
  const footerTicketMin = String(model?.footer?.ticketMin || '').trim()
  const normalizedTicker = useMemo(
    () => String(values?.ticker || '').trim().toUpperCase(),
    [values?.ticker],
  )
  const currentTickerPriceLabel = useMemo(() => {
    if (isTickerPriceLoading) return 'Carregando...'
    if (Number.isFinite(liveTickerPrice) && liveTickerPrice > 0) return formatCurrency(liveTickerPrice)
    return '--'
  }, [isTickerPriceLoading, liveTickerPrice])
  const minimumCardValue = useMemo(() => {
    if (Number.isFinite(liveTickerPrice) && liveTickerPrice > 0) {
      return formatCurrency(liveTickerPrice * 100)
    }
    return footerTicketMin || '--'
  }, [footerTicketMin, liveTickerPrice])
  const companyInsights = useMemo(() => buildCompanyInsights(companyProfile), [companyProfile])
  const hasCompanyInsights = Boolean(companyInsights.title || companyInsights.summary || companyInsights.points.length)

  useEffect(() => {
    if (!messageDirty) {
      setMessageText(model.generatedMessage || '')
    }
  }, [messageDirty, model.generatedMessage])

  useEffect(() => {
    if (!paletteMenuOpen) return undefined
    const handleOutsideClick = (event) => {
      if (paletteMenuRef.current?.contains(event.target)) return
      setPaletteMenuOpen(false)
      setPaletteFilter('')
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setPaletteMenuOpen(false)
        setPaletteFilter('')
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [paletteMenuOpen])

  useEffect(() => {
    const appliedEntries = Array.isArray(values?.options) ? values.options : []
    const draftEntries = Array.isArray(optionDraftEntries) ? optionDraftEntries : []
    const hasStockInApplied = appliedEntries.some((entry) => isStockType(entry?.optionType))
    const hasStockInDraft = draftEntries.some((entry) => isStockType(entry?.optionType))
    const inferredStockQty = inferReferenceQtyFromStockEntries([...appliedEntries, ...draftEntries])
    const hasStockQty = String(values?.stockQuantity ?? '').trim() !== ''
    const shouldSetStockQty = !hasStockQty && inferredStockQty != null
    if (!hasStockInApplied && !hasStockInDraft && !shouldSetStockQty) return

    if (hasStockInApplied || shouldSetStockQty) {
      setValues((current) => {
        const currentOptions = Array.isArray(current?.options) ? current.options : []
        const nextOptions = hasStockInApplied ? removeStockEntries(currentOptions) : currentOptions
        const nextStockQuantity = shouldSetStockQty ? String(inferredStockQty) : current.stockQuantity
        const optionsChanged = hasStockInApplied
        const stockChanged = String(current?.stockQuantity ?? '').trim() !== String(nextStockQuantity ?? '').trim()
        if (!optionsChanged && !stockChanged) return current
        return {
          ...current,
          stockQuantity: nextStockQuantity,
          options: optionsChanged ? nextOptions : currentOptions,
        }
      })
    }

    if (hasStockInDraft) {
      setOptionDraftEntries((current) => removeStockEntries(current))
    }
  }, [optionDraftEntries, values?.options, values?.stockQuantity])

  useEffect(() => {
    const rawTicker = normalizedTicker
    if (!rawTicker) {
      setLiveTickerPrice(null)
      setIsTickerPriceLoading(false)
      return undefined
    }

    let cancelled = false
    setIsTickerPriceLoading(true)
    const timerId = setTimeout(async () => {
      try {
        const symbol = normalizeYahooSymbol(rawTicker)
        const end = new Date()
        const start = new Date(end)
        start.setDate(start.getDate() - 14)
        const market = await fetchYahooMarketData({
          symbol,
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
        })
        const close = Number(market?.close)
        if (!cancelled) {
          setLiveTickerPrice(Number.isFinite(close) && close > 0 ? close : null)
          setIsTickerPriceLoading(false)
        }
      } catch {
        if (!cancelled) {
          setLiveTickerPrice(null)
          setIsTickerPriceLoading(false)
        }
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timerId)
    }
  }, [normalizedTicker])

  useEffect(() => {
    const rawTicker = normalizedTicker
    if (!rawTicker) {
      setCompanyProfile(null)
      setIsCompanyProfileLoading(false)
      return undefined
    }

    let cancelled = false
    setIsCompanyProfileLoading(true)
    const timerId = setTimeout(async () => {
      try {
        const profile = await fetchCompanyProfile(rawTicker)
        if (!cancelled) {
          setCompanyProfile(profile)
          setIsCompanyProfileLoading(false)
        }
      } catch {
        if (!cancelled) {
          setCompanyProfile(null)
          setIsCompanyProfileLoading(false)
        }
      }
    }, 320)

    return () => {
      cancelled = true
      clearTimeout(timerId)
    }
  }, [normalizedTicker])

  const handleTemplateChange = useCallback((event) => {
    const nextId = event.target.value
    const nextDefaults = getStrategyDefaults(nextId)
    const inferredStockQty = inferReferenceQtyFromStockEntries(nextDefaults.options)
    const stockQuantity = String(nextDefaults?.stockQuantity ?? '').trim() || (inferredStockQty != null ? String(inferredStockQty) : '')
    const sanitizedOptions = removeStockEntries(nextDefaults.options)
    setTemplateId(nextId)
    setValues({
      ...nextDefaults,
      stockQuantity,
      options: sanitizedOptions,
    })
    setOptionDraftEntries(cloneOptionEntries(sanitizedOptions))
    setMessageDirty(false)
  }, [])

  const handleValueChange = useCallback((key, nextValue) => {
    setValues((current) => ({
      ...current,
      [key]: nextValue,
    }))
  }, [])

  const handleOptionChange = useCallback((entryId, patch) => {
    setOptionDraftEntries((current) => {
      return (Array.isArray(current) ? current : []).map((entry) => {
        if (entry?.id !== entryId) return entry
        const nextEntry = { ...entry, ...patch }
        if (!optionForm.showBarrier || !isExplicitBarrierType(nextEntry.barrierType)) {
          nextEntry.barrierValue = ''
          nextEntry.barrierPercent = null
          nextEntry.barrierRelativePct = null
        }
        if (!optionForm.showStrike) {
          nextEntry.strike = ''
          nextEntry.strikePercent = null
          nextEntry.strikeRelativePct = null
        }
        if (!optionForm.showCoupon) {
          nextEntry.coupon = ''
          nextEntry.couponPct = null
        }
        return nextEntry
      })
    })
  }, [optionForm.showBarrier, optionForm.showCoupon, optionForm.showStrike])

  const handleAddOption = useCallback(() => {
    setOptionDraftEntries((current) => {
      const currentOptions = Array.isArray(current) ? current : []
      const nextOption = createStrategyOptionEntry(templateId)
      return [...currentOptions, nextOption]
    })
  }, [templateId])

  const handleRemoveOption = useCallback((entryId) => {
    setOptionDraftEntries((current) => {
      const currentOptions = Array.isArray(current) ? current : []
      const nextOptions = currentOptions.filter((entry) => entry?.id !== entryId)
      return nextOptions.length ? nextOptions : currentOptions
    })
  }, [])

  const handleApplyOptionChanges = useCallback(() => {
    const sanitizedDraft = removeStockEntries(optionDraftEntries)
    setValues((current) => ({
      ...current,
      options: cloneOptionEntries(sanitizedDraft),
    }))
    setOptionDraftEntries(cloneOptionEntries(sanitizedDraft))
    notify('Opcoes aplicadas no grafico e na tabela.', 'success')
  }, [notify, optionDraftEntries])

  const handleCopyText = useCallback(async () => {
    if (!messageText.trim()) {
      notify('Sem texto para copiar.', 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(messageText)
      notify('Texto copiado para a area de transferencia.', 'success')
    } catch {
      notify('Nao foi possivel copiar o texto.', 'warning')
    }
  }, [messageText, notify])

  const handleRestoreTemplate = useCallback(() => {
    setMessageText(model.generatedMessage || '')
    setMessageDirty(false)
  }, [model.generatedMessage])

  const handleExportPng = useCallback(async () => {
    if (!previewRef.current) {
      notify('Preview indisponivel para exportar.', 'warning')
      return
    }
    if (model.validations?.length) {
      notify('Corrija os campos invalidos antes de exportar.', 'warning')
      return
    }
    setRunningExport('png')
    try {
      const result = await exportCardAsPng({
        node: previewRef.current,
        templateLabel: model.templateLabel,
        ticker: values.ticker,
        maturityDate: values.maturityDate,
      })
      notify(`PNG gerado: ${result.fileName}`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha no PNG: ${error.message}` : 'Falha ao exportar PNG.', 'warning')
    } finally {
      setRunningExport('')
    }
  }, [model.templateLabel, model.validations, notify, values.maturityDate, values.ticker])

  const handleExportPdf = useCallback(async () => {
    if (!previewRef.current) {
      notify('Preview indisponivel para exportar.', 'warning')
      return
    }
    if (model.validations?.length) {
      notify('Corrija os campos invalidos antes de exportar.', 'warning')
      return
    }
    setRunningExport('pdf')
    try {
      const result = await exportCardAsPdf({
        node: previewRef.current,
        templateLabel: model.templateLabel,
        ticker: values.ticker,
        maturityDate: values.maturityDate,
      })
      notify(`PDF gerado: ${result.fileName}`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha no PDF: ${error.message}` : 'Falha ao exportar PDF.', 'warning')
    } finally {
      setRunningExport('')
    }
  }, [model.templateLabel, model.validations, notify, values.maturityDate, values.ticker])

  const meta = useMemo(() => ([
    { label: 'Estrutura', value: model.templateLabel },
    { label: 'Linhas payoff', value: model.payoffRows?.length || 0 },
    { label: 'Modo', value: layoutOptions.find((item) => item.value === layoutMode)?.label || layoutMode },
    { label: 'Paleta', value: selectedPalette.label },
  ]), [layoutMode, model.payoffRows?.length, model.templateLabel, selectedPalette.label])

  return (
    <div className="page card-generator-page">
      <PageHeader
        title="Gerador de Cards"
        meta={meta}
        actions={[
          { label: runningExport === 'png' ? 'Exportando PNG...' : 'Baixar PNG', icon: 'download', onClick: handleExportPng, disabled: runningExport === 'png' },
          { label: runningExport === 'pdf' ? 'Exportando PDF...' : 'Baixar PDF', icon: 'doc', variant: 'btn-secondary', onClick: handleExportPdf, disabled: runningExport === 'pdf' },
        ]}
      />

      <div className="cards-builder-layout">
        <section className="panel cards-builder-form">
          <div className="panel-head">
            <div>
              <h3>Configuracao do card</h3>
              <p className="muted">Escolha a estrutura, ajuste os parametros e revise a mensagem antes de exportar.</p>
            </div>
          </div>

          <div className="cards-builder-row">
            <div className="cards-field">
              <label htmlFor="cards-template">Tipo de estrutura</label>
              <select
                id="cards-template"
                className="input"
                value={templateId}
                onChange={handleTemplateChange}
              >
                {templateOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="cards-field">
              <label htmlFor="cards-layout">Layout do preview</label>
              <select
                id="cards-layout"
                className="input"
                value={layoutMode}
                onChange={(event) => setLayoutMode(event.target.value)}
              >
                {layoutOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="cards-builder-row">
            <div className="cards-field">
              <label htmlFor="cards-show-logo">Icone no card</label>
              <select
                id="cards-show-logo"
                className="input"
                value={showCompanyLogo ? 'logo' : 'texto'}
                onChange={(event) => setShowCompanyLogo(event.target.value === 'logo')}
              >
                <option value="logo">Logo da empresa</option>
                <option value="texto">Texto (como antes)</option>
              </select>
            </div>
          </div>

          {groupedFields.map((group) => (
            <div key={group.section} className="cards-form-group">
              <h4>{group.section}</h4>
              <div className="cards-grid">
                {group.fields.map((field) => (
                  <div key={field.key} className="cards-field">
                    <label htmlFor={`field-${field.key}`}>
                      {field.label}
                      {field.required ? <span className="cards-required">*</span> : null}
                    </label>
                    <input
                      id={`field-${field.key}`}
                      className="input"
                      type={field.type === 'date' ? 'date' : 'text'}
                      inputMode={field.type === 'number' ? 'decimal' : undefined}
                      value={values[field.key] ?? ''}
                      onChange={(event) => handleValueChange(field.key, event.target.value)}
                    />
                  </div>
                ))}
                {group.section === 'Identificacao' ? (
                  <div className="cards-field">
                    <label htmlFor="field-live-price">Preco atual do ativo</label>
                    <input
                      id="field-live-price"
                      className="input"
                      type="text"
                      value={currentTickerPriceLabel}
                      readOnly
                      disabled
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {optionForm.enabled ? (
            <div className="cards-form-group">
              <div className="cards-options-head">
                <h4>Opcoes da estrutura</h4>
                <div className="cards-options-actions">
                  <button className="btn btn-secondary btn-inline" type="button" onClick={handleAddOption}>
                    + Opcao
                  </button>
                  <button
                    className="btn btn-primary btn-inline"
                    type="button"
                    onClick={handleApplyOptionChanges}
                    disabled={!hasPendingOptionChanges}
                  >
                    Aplicar
                  </button>
                </div>
              </div>
              {hasPendingOptionChanges ? <small className="cards-options-note">Existem alteracoes pendentes nas opcoes.</small> : null}

              <div className="cards-options-list">
                {visibleOptionDraftEntries.map((entry, index) => {
                  const showBarrierValue = optionForm.showBarrier && isExplicitBarrierType(entry?.barrierType)
                  return (
                    <article key={entry?.id || `opt-${index}`} className="cards-option-row">
                      <div className="cards-option-row-head">
                        <strong>Opcao {index + 1}</strong>
                        {visibleOptionDraftEntries.length > 1 ? (
                          <button
                            className="btn btn-secondary btn-inline"
                            type="button"
                            onClick={() => handleRemoveOption(entry?.id)}
                          >
                            Remover
                          </button>
                        ) : null}
                      </div>

                      <div className="cards-option-grid">
                        <div className="cards-field">
                          <label>Tipo</label>
                          <select
                            className="input"
                            value={entry?.optionType || 'CALL'}
                            onChange={(event) => handleOptionChange(entry?.id, { optionType: event.target.value })}
                          >
                            <option value="CALL">CALL</option>
                            <option value="PUT">PUT</option>
                          </select>
                        </div>

                        <div className="cards-field">
                          <label>Lado</label>
                          <select
                            className="input"
                            value={entry?.side || 'long'}
                            onChange={(event) => handleOptionChange(entry?.id, { side: event.target.value })}
                          >
                            <option value="long">Comprada</option>
                            <option value="short">Vendida</option>
                          </select>
                        </div>

                        <div className="cards-field">
                          <label>Quantidade</label>
                          {!entry?.useCustomQuantity ? (
                            <button
                              className="btn btn-secondary btn-inline cards-option-qty-toggle"
                              type="button"
                              onClick={() => handleOptionChange(entry?.id, { useCustomQuantity: true })}
                            >
                              Escolher quantidade
                            </button>
                          ) : (
                            <div className="cards-option-qty-editor">
                              <input
                                className="input"
                                type="text"
                                inputMode="decimal"
                                value={entry?.quantity ?? ''}
                                onChange={(event) => handleOptionChange(entry?.id, { quantity: event.target.value })}
                                placeholder="1000"
                              />
                              <button
                                className="btn btn-secondary btn-inline"
                                type="button"
                                onClick={() => handleOptionChange(entry?.id, { useCustomQuantity: false, quantity: '' })}
                              >
                                Limpar
                              </button>
                            </div>
                          )}
                        </div>

                        {optionForm.showStrike ? (
                          <div className="cards-field">
                            <label>Strike (%)</label>
                            <input
                              className="input"
                              type="text"
                              inputMode="decimal"
                              value={entry?.strike ?? ''}
                              onChange={(event) => handleOptionChange(entry?.id, { strike: event.target.value })}
                              placeholder="100,00"
                            />
                            <small className="cards-field-help">100% = 0x0 (ATM). Ex.: 90% = 10% abaixo.</small>
                          </div>
                        ) : null}

                        {optionForm.showBarrier ? (
                          <div className="cards-field">
                            <label>Tipo de barreira</label>
                            <select
                              className="input"
                              value={entry?.barrierType ?? ''}
                              onChange={(event) => handleOptionChange(entry?.id, { barrierType: event.target.value })}
                            >
                              <option value="">Sem barreira</option>
                              <option value="UI">UI</option>
                              <option value="UO">UO</option>
                              <option value="KI">KI</option>
                              <option value="KO">KO / D.O</option>
                            </select>
                          </div>
                        ) : null}

                        {showBarrierValue ? (
                          <div className="cards-field">
                            <label>Barreira (%)</label>
                            <input
                              className="input"
                              type="text"
                              inputMode="decimal"
                              value={entry?.barrierValue ?? ''}
                              onChange={(event) => handleOptionChange(entry?.id, { barrierValue: event.target.value })}
                              placeholder="100,00"
                            />
                            <small className="cards-field-help">Referencia em percentual do 0x0.</small>
                          </div>
                        ) : null}

                        {optionForm.showCoupon ? (
                          <div className="cards-field">
                            <label>Cupom nominal (%)</label>
                            <input
                              className="input"
                              type="text"
                              inputMode="decimal"
                              value={entry?.coupon ?? ''}
                              onChange={(event) => handleOptionChange(entry?.id, { coupon: event.target.value })}
                              placeholder="1,50"
                            />
                            <small className="cards-field-help">Valor de cupom vinculado a esta opcao.</small>
                          </div>
                        ) : null}
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          ) : null}

          {model.validations?.length ? (
            <div className="warning-panel cards-warning">
              <div>
                <strong>Validacoes pendentes</strong>
                <ul>
                  {model.validations.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <div className="cards-message-block">
            <div className="cards-message-head">
              <h4>Mensagem pronta</h4>
              <div className="panel-actions">
                <button className="btn btn-secondary" type="button" onClick={handleRestoreTemplate}>Restaurar template</button>
                <button className="btn btn-primary" type="button" onClick={handleCopyText}>Copiar texto</button>
              </div>
            </div>
            <textarea
              className="input cards-message-input"
              value={messageText}
              onChange={(event) => {
                setMessageText(event.target.value)
                setMessageDirty(true)
              }}
            />
          </div>
        </section>

        <section className="panel cards-builder-preview-panel">
          <div className="panel-head">
            <div>
              <h3>Preview exportavel</h3>
              <p className="muted">A exportacao usa exatamente este bloco.</p>
            </div>
            <div className="cards-palette-filter" ref={paletteMenuRef}>
              <button
                type="button"
                className={`cards-palette-trigger ${paletteMenuOpen ? 'is-open' : ''}`}
                onClick={() => {
                  setPaletteMenuOpen((current) => {
                    const next = !current
                    if (!next) setPaletteFilter('')
                    return next
                  })
                }}
                aria-haspopup="dialog"
                aria-expanded={paletteMenuOpen}
              >
                <span className="cards-palette-trigger-text">{selectedPalette.label}</span>
                <span className="cards-palette-swatches" aria-hidden="true">
                  {selectedPalette.colors.map((color) => (
                    <span key={`${selectedPalette.id}-${color}`} className="cards-palette-swatch" style={{ backgroundColor: color }} />
                  ))}
                </span>
              </button>

              {paletteMenuOpen ? (
                <div className="cards-palette-menu" role="dialog" aria-label="Filtro de paletas">
                  <input
                    className="input cards-palette-search"
                    type="text"
                    value={paletteFilter}
                    placeholder="Filtrar paletas..."
                    onChange={(event) => setPaletteFilter(event.target.value)}
                    autoFocus
                  />
                  <div className="cards-palette-list">
                    {filteredPalettes.map((palette) => (
                      <button
                        key={palette.id}
                        type="button"
                        className={`cards-palette-option ${palette.id === selectedPalette.id ? 'is-active' : ''}`}
                        onClick={() => {
                          setPaletteId(palette.id)
                          setPaletteMenuOpen(false)
                          setPaletteFilter('')
                        }}
                      >
                        <span className="cards-palette-option-main">
                          <span className="cards-palette-option-title">{palette.label}</span>
                          <span className="cards-palette-option-description">{palette.description}</span>
                        </span>
                        <span className="cards-palette-swatches" aria-hidden="true">
                          {palette.colors.map((color) => (
                            <span key={`${palette.id}-${color}`} className="cards-palette-swatch" style={{ backgroundColor: color }} />
                          ))}
                        </span>
                      </button>
                    ))}
                    {!filteredPalettes.length ? <p className="cards-palette-empty">Nenhuma paleta encontrada.</p> : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="cards-preview-capture" style={paletteStyles.preview} ref={previewRef}>
            <StrategyCardPreview
              model={model}
              leftLabel={model.tableHeadLeft}
              rightLabel={model.tableHeadRight}
              layoutMode={layoutMode}
              showCompanyLogo={showCompanyLogo}
              paletteStyle={paletteStyles.cardVars}
              minimumValue={minimumCardValue}
              companyName={companyInsights.title}
            />
          </div>

          <div className="cards-payoff-grid">
            <div className="cards-payoff-panel">
              <h4>Grafico de payoff</h4>
              <PayoffChart rows={model.payoffRows} />
            </div>
            <div className="cards-payoff-panel">
              <h4>Tabela de payoff</h4>
              <PayoffTable
                leftLabel={model.tableHeadLeft}
                rightLabel={model.tableHeadRight}
                rows={model.payoffRows}
              />
            </div>
          </div>

          {isCompanyProfileLoading || hasCompanyInsights ? (
            <div className="cards-company-panel">
              <div className="cards-company-head">
                <h4>Resumo da empresa</h4>
                {companyInsights.title ? <strong>{companyInsights.title}</strong> : null}
              </div>
              {isCompanyProfileLoading ? (
                <p className="muted cards-company-summary">Carregando informacoes da empresa...</p>
              ) : (
                <>
                  {companyInsights.summary ? (
                    <p className="cards-company-summary">{companyInsights.summary}</p>
                  ) : null}
                  {companyInsights.points.length ? (
                    <ul className="cards-company-points">
                      {companyInsights.points.map((point) => (
                        <li key={point}>{point}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

export default CardGenerator
