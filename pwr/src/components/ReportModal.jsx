import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import Badge from './Badge'
import Icon from './Icons'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'
import { fetchCdiSnapshot } from '../services/cdi'
import { useToast } from '../hooks/useToast'

const getBarrierBadge = (status) => {
  if (!status) return { label: 'N/A', tone: 'cyan' }
  const high = status.high
  const low = status.low
  if (high && low) return { label: 'Alta + Baixa', tone: 'red' }
  if (high) return { label: 'Bateu alta', tone: 'amber' }
  if (low) return { label: 'Bateu baixa', tone: 'amber' }
  if (high === false || low === false) return { label: 'Nao bateu', tone: 'green' }
  return { label: 'N/A', tone: 'cyan' }
}

const fmt = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '-'
  return formatCurrency(value)
}

const fmtPct = (value, decimals = 2, showSign = true) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  const sign = showSign && n > 0 ? '+' : ''
  return `${sign}${(n * 100).toFixed(decimals)}%`
}

const hasStructureParamOverride = (override) => {
  if (!override || typeof override !== 'object') return false
  if (
    override?.optionQtyOverride != null
    || override?.strikeOverride != null
    || override?.barrierValueOverride != null
    || override?.barrierTypeOverride != null
  ) return true
  if (
    override?.structure?.optionQty != null
    || override?.structure?.strike != null
    || override?.structure?.barrierValue != null
    || (override?.structure?.barrierType && String(override.structure.barrierType).toLowerCase() !== 'auto')
  ) return true
  const legs = override?.legs && typeof override.legs === 'object' ? Object.values(override.legs) : []
  if (legs.some((entry) => (
    entry?.optionQtyOverride != null
    || entry?.strikeOverride != null
    || entry?.barrierValueOverride != null
    || entry?.barrierTypeOverride != null
  ))) return true
  const byLeg = override?.structureByLeg && typeof override.structureByLeg === 'object'
    ? Object.values(override.structureByLeg)
    : []
  return byLeg.some((entry) => (
    entry?.optionQty != null
    || entry?.strike != null
    || entry?.barrierValue != null
    || entry?.barrierType != null
  ))
}

const computeCdiComparison = (row, cdi) => {
  if (!cdi || !row?.dataRegistro || !row?.vencimento) return null
  const entradaDate = new Date(row.dataRegistro)
  const vencimentoDate = new Date(row.vencimento)
  const days = Math.round((vencimentoDate - entradaDate) / (1000 * 60 * 60 * 24))
  if (days <= 0) return null

  const cdiAnnualRate = (cdi.annualPct || 12) / 100
  const cdiPeriodRate = Math.pow(1 + cdiAnnualRate, days / 365) - 1
  const operationRate = row.result?.percent ?? 0
  const valorEntrada = row.result?.valorEntrada || row.result?.pagou || 0
  const cdiAbsolute = valorEntrada * cdiPeriodRate
  const cdiRatio = cdiPeriodRate > 0 ? operationRate / cdiPeriodRate : null

  return {
    cdiPeriodRate,
    cdiAbsolute,
    operationRate,
    cdiRatio,
    days,
    cdiAnnualPct: cdi.annualPct,
    beatsCdi: cdiRatio != null ? cdiRatio >= 1 : operationRate >= cdiPeriodRate,
  }
}

const ReportModal = ({ open, onClose, row, onExport, onCopy, onRefresh, extraContent = null }) => {
  const cardRef = useRef(null)
  const [cdi, setCdi] = useState(null)
  const [screenshotting, setScreenshotting] = useState(false)
  const { notify } = useToast()

  useEffect(() => {
    if (!open) return
    fetchCdiSnapshot().then(setCdi).catch(() => {})
  }, [open])

  if (!row) return null

  const clienteLabel = row.codigoCliente || row.conta || row.cliente || '-'
  const badge = getBarrierBadge(row.barrierStatus)
  const overrideManual = row.override?.high !== 'auto' || row.override?.low !== 'auto'
  const cupomManual = row.manualCouponBRL != null
  const ganhoOpcoesManual = row.override?.manualOptionsGainBRL != null
  const parametrosEstruturaManual = hasStructureParamOverride(row.override)
  const valorEntradaIncomplete = row.result?.valorEntradaIncomplete
  const valorEntrada = row.result?.valorEntrada
  const cupomTotal = row.result?.cupomTotal
  const hasDividendOverride = row.override?.manualDividendBRL != null && row.override.manualDividendBRL !== ''
  const hasCupom = cupomTotal != null && Number.isFinite(Number(cupomTotal)) && Number(cupomTotal) !== 0
  const cdiComparison = computeCdiComparison(row, cdi)

  const warnings = []
  if (row.market?.source !== 'yahoo') warnings.push('Cotacao em fallback (sem Yahoo Finance).')
  if (overrideManual) warnings.push('Override manual aplicado nas barreiras.')
  if (cupomManual) warnings.push('Cupom manual aplicado.')
  if (ganhoOpcoesManual) warnings.push('Ganho nas opcoes (manual) aplicado.')
  if (hasDividendOverride) warnings.push('Dividendos com valor manual aplicado.')
  if (row.bonusAutoApplied) warnings.push('Bonificacao automatica aplicada na quantidade.')
  if (row.override?.bonusAutoDisabled === true) warnings.push('Bonificacao automatica ignorada.')
  if (parametrosEstruturaManual) {
    const target = row.override?.optionSide ? ` (${row.override.optionSide})` : ''
    warnings.push(`Parametros manuais (strike/barreira/tipo) aplicados${target}.`)
  }

  const legs = Array.isArray(row.effectiveLegs) ? row.effectiveLegs : (row.pernas || [])
  const hasLegs = legs.length > 0
  const hasBarriers = (row.barrierStatus?.list || []).length > 0

  const dividendEvents = Array.isArray(row.dividendEvents) ? row.dividendEvents : []
  const bonusEvents = Array.isArray(row.bonusEvents) ? row.bonusEvents : []
  const vendaAtivo = Number(row.result?.vendaAtivo || 0)
  const dividendos = Number(row.result?.dividends || 0)
  const ganhosOpcoes = row.result?.optionsSuppressed ? 0 : Number(row.result?.ganhosOpcoes || 0)
  const saidaTotal = vendaAtivo + dividendos + Number(cupomTotal || 0) + ganhosOpcoes
  const ganho = row.result?.ganho
  const percent = row.result?.percent

  const handleScreenshot = async () => {
    if (!cardRef.current || screenshotting) return
    setScreenshotting(true)
    try {
      const { toPng } = await import('html-to-image')
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: '#0c1524',
        style: { borderRadius: '0' },
      })
      const response = await fetch(dataUrl)
      const blob = await response.blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      notify('Imagem copiada para a area de transferencia.', 'success')
    } catch {
      notify('Nao foi possivel copiar a imagem.', 'warning')
    } finally {
      setScreenshotting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Resumo da Operacao"
      subtitle={`${row.ativo || '-'} · ${row.estrutura || '-'}`}
    >
      <div ref={cardRef} className="op-card">
        <div className="op-card-header">
          <div className="op-card-header-main">
            <span className="op-card-ativo">{row.ativo || '-'}</span>
            <span className="op-card-estrutura">{row.estrutura || '-'}</span>
          </div>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>

        <div className="op-card-results">
          <div className={`op-card-result-item ${Number(saidaTotal) >= 0 ? 'op-card-positive' : 'op-card-negative'}`}>
            <span className="op-card-label">Saida Total</span>
            <div className="op-card-value">{fmt(saidaTotal)}</div>
          </div>
          <div className={`op-card-result-item ${Number(ganho) >= 0 ? 'op-card-positive' : 'op-card-negative'}`}>
            <span className="op-card-label">Resultado (Saida - Entrada)</span>
            <div className="op-card-value">{fmt(ganho)}</div>
          </div>
          <div className={`op-card-result-item ${Number(percent) >= 0 ? 'op-card-positive' : 'op-card-negative'}`}>
            <span className="op-card-label">Lucro %</span>
            <div className="op-card-value">{fmtPct(percent, 2, false)}</div>
          </div>
        </div>

        <div className="op-card-section">
          <div className="op-card-section-title">Identificacao</div>
          <div className="op-card-meta">
            <div className="op-card-meta-item">
              <span className="op-card-label">Assessor</span>
              <strong>{row.assessor || '-'}</strong>
            </div>
            <div className="op-card-meta-item">
              <span className="op-card-label">Broker</span>
              <strong>{row.broker || '-'}</strong>
            </div>
            <div className="op-card-meta-item">
              <span className="op-card-label">Codigo Cliente</span>
              <strong>{clienteLabel}</strong>
            </div>
            <div className="op-card-meta-item">
              <span className="op-card-label">Data de Entrada</span>
              <strong>{formatDate(row.dataRegistro) || '-'}</strong>
            </div>
            <div className="op-card-meta-item">
              <span className="op-card-label">Data de Vencimento</span>
              <strong>{formatDate(row.vencimento) || '-'}</strong>
            </div>
          </div>
        </div>

        <div className="op-card-section">
          <div className="op-card-section-title">Composicao do Resultado</div>
          <div className="op-card-comp">
            <div className="op-card-comp-item">
              <span className="op-card-label">Valor de Entrada</span>
              <strong>{valorEntradaIncomplete ? 'Dados incompletos' : fmt(valorEntrada)}</strong>
            </div>
            <div className="op-card-comp-item">
              <span className="op-card-label">Venda do ativo no vencimento</span>
              <strong>{fmt(vendaAtivo)}</strong>
            </div>
            <div className="op-card-comp-item">
              <span className="op-card-label">Ganhos nas opcoes</span>
              <strong>{row.result?.optionsSuppressed ? 'N/A' : fmt(ganhosOpcoes)}</strong>
            </div>
            <div className="op-card-comp-item">
              <span className="op-card-label">{hasDividendOverride ? 'Dividendos (Manual)' : 'Dividendos'}</span>
              <strong>{fmt(dividendos)}</strong>
            </div>
            {hasCupom ? (
              <div className="op-card-comp-item">
                <span className="op-card-label">{cupomManual ? 'Cupom (Manual)' : 'Cupom'}</span>
                <strong>{fmt(cupomTotal)}</strong>
              </div>
            ) : null}
            <div className="op-card-comp-item">
              <span className="op-card-label">Saida total no vencimento</span>
              <strong>{fmt(saidaTotal)}</strong>
            </div>
          </div>
        </div>

        <div className="op-card-section">
          <div className="op-card-section-title">
            Vs CDI
            {cdiComparison ? ` · ${cdiComparison.cdiAnnualPct?.toFixed(2)}% a.a.` : ''}
          </div>
          {cdiComparison ? (
            <div className="op-card-comp">
              <div className="op-card-comp-item">
                <span className="op-card-label">CDI no periodo ({cdiComparison.days}d)</span>
                <strong>{fmtPct(cdiComparison.cdiPeriodRate, 2, false)}</strong>
              </div>
              <div className="op-card-comp-item">
                <span className="op-card-label">Resultado da operacao</span>
                <strong>{fmtPct(cdiComparison.operationRate, 2, false)}</strong>
              </div>
              <div className="op-card-comp-item">
                <span className="op-card-label">Relacao com CDI</span>
                <strong className={cdiComparison.beatsCdi ? 'op-card-text-positive' : 'op-card-text-negative'}>
                  {cdiComparison.cdiRatio != null
                    ? `${fmtPct(cdiComparison.cdiRatio, 0, false)} do CDI`
                    : 'Sem base'}
                </strong>
              </div>
            </div>
          ) : (
            <span className="op-card-label" style={{ opacity: 0.6 }}>
              {cdi ? 'Sem datas suficientes para calcular.' : 'Carregando...'}
            </span>
          )}
        </div>
      </div>

      {(hasLegs || hasBarriers) ? (
        <div className="report-grid" style={{ marginTop: 16 }}>
          {hasBarriers ? (
            <div className="report-card">
              <h4>Barreiras</h4>
              <div className="report-list">
                {(row.barrierStatus?.list || []).map((barrier) => {
                  const direction = barrier.direction === 'high' ? 'Alta' : 'Baixa'
                  const hit = barrier.direction === 'high' ? row.barrierStatus?.high : row.barrierStatus?.low
                  return (
                    <div key={`${barrier.id}-${barrier.barreiraValor}`}>
                      <span>{direction} ({barrier.barreiraTipo || 'N/A'})</span>
                      <strong>{barrier.barreiraValor} - {hit == null ? 'N/A' : hit ? 'Bateu' : 'Nao bateu'}</strong>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
          {hasLegs ? (
            <div className="report-card">
              <h4>Pernas</h4>
              <div className="report-list">
                {legs.map((leg, index) => {
                  const tipo = String(leg?.tipo || 'N/A').toUpperCase()
                  const isShort = String(leg?.side || '').toLowerCase() === 'short' || Number(leg?.quantidade || 0) < 0
                  const sideLabel = isShort ? 'Vendida' : 'Comprada'
                  const strikeOriginal = leg?.strikeOriginal ?? leg?.strike ?? leg?.precoStrike ?? null
                  const strikeAdjusted = leg?.strikeAjustado ?? leg?.strikeAdjusted ?? strikeOriginal
                  const strikeAdjustedLabel = Number.isFinite(Number(strikeAdjusted)) ? formatNumber(strikeAdjusted) : '-'
                  const strikeOriginalLabel = Number.isFinite(Number(strikeOriginal)) ? formatNumber(strikeOriginal) : '-'
                  const showOriginal = Number.isFinite(Number(strikeAdjusted))
                    && Number.isFinite(Number(strikeOriginal))
                    && Number(strikeAdjusted) !== Number(strikeOriginal)
                  const rawQty = leg?.quantidadeEfetiva ?? leg?.quantidade ?? 0
                  const qtyLabel = formatNumber(Math.abs(Number(rawQty) || 0))
                  const optionExpiryDate = leg?.optionExpiryDateOverride ?? leg?.optionExpiryDate ?? null
                  const settlementSpotLabel = Number.isFinite(Number(leg?.settlementSpotOverride))
                    ? formatNumber(leg.settlementSpotOverride)
                    : null
                  return (
                    <div key={`${leg?.id || index}-${strikeOriginal}`}>
                      <span>{tipo} {sideLabel}</span>
                      <strong>Strike {strikeAdjustedLabel}</strong>
                      <span>Qtd {qtyLabel}</span>
                      {optionExpiryDate ? <small className="muted">Venc {formatDate(optionExpiryDate)}</small> : null}
                      {settlementSpotLabel ? <small className="muted">Spot travado {settlementSpotLabel}</small> : null}
                      {showOriginal ? <small className="muted">Orig {strikeOriginalLabel}</small> : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {dividendEvents.length > 0 ? (
        <div className="report-card" style={{ marginTop: 16 }}>
          <h4>Proventos no periodo{hasDividendOverride ? ' (valor manual aplicado)' : ''}</h4>
          <div className="report-list">
            {dividendEvents.map((event, index) => {
              const tipo = String(event?.type || event?.typeRaw || 'DIV').toUpperCase()
              const dataCom = event?.dataCom ? formatDate(event.dataCom) : '-'
              const paymentDate = event?.paymentDate ? formatDate(event.paymentDate) : '-'
              const amount = Number.isFinite(Number(event?.amount)) ? Number(event.amount).toFixed(4) : '-'
              const valueNet = Number.isFinite(Number(event?.valueNet)) ? Number(event.valueNet).toFixed(4) : null
              return (
                <div key={`${event?.dataCom}-${event?.amount}-${index}`}>
                  <span>{tipo}</span>
                  <strong>R$ {valueNet ?? amount}</strong>
                  <small className="muted">Com {dataCom}</small>
                  {paymentDate !== '-' ? <small className="muted">Pgto {paymentDate}</small> : null}
                  {valueNet && valueNet !== amount ? <small className="muted">Bruto {amount}</small> : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {bonusEvents.length > 0 ? (
        <div className="report-card" style={{ marginTop: 16 }}>
          <h4>Bonificacao no periodo</h4>
          <div className="report-list">
            {bonusEvents.map((event, index) => {
              const dataCom = event?.dataCom ? formatDate(event.dataCom) : '-'
              const exDate = event?.exDate ? formatDate(event.exDate) : '-'
              const incorporationDate = event?.incorporationDate ? formatDate(event.incorporationDate) : '-'
              const proportionPct = Number.isFinite(Number(event?.proportionPct))
                ? `${Number(event.proportionPct).toFixed(2).replace('.', ',')}%`
                : '-'
              return (
                <div key={`${event?.dataCom}-${event?.factor}-${index}`}>
                  <span>BONUS</span>
                  <strong>{proportionPct}</strong>
                  <small className="muted">Com {dataCom}</small>
                  {exDate !== '-' ? <small className="muted">Ex {exDate}</small> : null}
                  {incorporationDate !== '-' ? <small className="muted">Incorp {incorporationDate}</small> : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {extraContent}

      {warnings.length > 0 ? (
        <div className="report-warnings">
          {warnings.map((warning) => (
            <span key={warning}><Icon name="warning" size={14} /> {warning}</span>
          ))}
        </div>
      ) : null}

      <div className="report-actions">
        {typeof onRefresh === 'function' ? (
          <button className="btn btn-secondary" type="button" onClick={onRefresh}>
            Atualizar dados
          </button>
        ) : null}
        {typeof onCopy === 'function' ? (
          <button className="btn btn-secondary" type="button" onClick={onCopy}>
            <Icon name="copy" size={14} /> Copiar texto
          </button>
        ) : null}
        <button
          className="btn btn-secondary"
          type="button"
          onClick={handleScreenshot}
          disabled={screenshotting}
        >
          <Icon name="camera" size={14} /> {screenshotting ? 'Copiando...' : 'Copiar imagem'}
        </button>
        {typeof onExport === 'function' ? (
          <button className="btn btn-primary" type="button" onClick={onExport}>
            Exportar PDF
          </button>
        ) : null}
      </div>
    </Modal>
  )
}

export default ReportModal
