import Modal from './Modal'
import Badge from './Badge'
import Icon from './Icons'
import { formatCurrency, formatDate, formatNumber } from '../utils/format'

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

const ReportModal = ({ open, onClose, row, onExport, onCopy, onRefresh }) => {
  if (!row) return null

  const clienteLabel = row.cliente || row.codigoCliente || '—'
  const spotLabel = row.spotBase ?? row.spotInicial
  const spotValue = spotLabel == null || Number.isNaN(Number(spotLabel)) ? '—' : formatNumber(spotLabel)

  const badge = getBarrierBadge(row.barrierStatus)
  const overrideManual = row.override?.high !== 'auto' || row.override?.low !== 'auto'
  const cupomManual = row.cupomManual != null && String(row.cupomManual).trim() !== ''
  const warnings = []

  if (row.market?.source !== 'yahoo') {
    warnings.push('Cotacao em fallback (sem Yahoo Finance).')
  }
  if (overrideManual) {
    warnings.push('Override manual aplicado nas barreiras.')
  }
  if (cupomManual) {
    warnings.push('Cupom manual aplicado.')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Relatorio - ${clienteLabel}`}
      subtitle={`${row.ativo} | ${row.estrutura}`}
    >
      <div className="report-header">
        <div>
          <strong>Cliente</strong>
          <p className="muted">{clienteLabel}</p>
        </div>
        <div>
          <strong>Codigo</strong>
          <p className="muted">{row.codigoOperacao || row.id}</p>
        </div>
        <div>
          <strong>Periodo</strong>
          <p className="muted">{formatDate(row.dataRegistro)} - {formatDate(row.vencimento)}</p>
        </div>
        <div>
          <strong>Fonte</strong>
          <p className="muted">Yahoo Finance {row.market?.cached ? '(cache)' : ''}</p>
        </div>
      </div>

      <div className="report-summary">
        <div>
          <span className="muted">Resultado final</span>
          <div className="report-highlight">{formatCurrency(row.result.financeiroFinal)}</div>
        </div>
        <div>
          <span className="muted">Ganho/Prejuizo</span>
          <div className="report-highlight">{formatCurrency(row.result.ganho)}</div>
        </div>
        <div>
          <span className="muted">%</span>
          <div className="report-highlight">{(row.result.percent * 100).toFixed(2)}%</div>
        </div>
        <div>
          <span className="muted">Barreira</span>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
      </div>

      <div className="report-grid">
        <div className="report-card">
          <h4>De onde veio o resultado</h4>
          <div className="report-list">
            <div>
              <span>Spot</span>
              <strong>{spotValue}</strong>
            </div>
            <div>
              <span>Quantidade base</span>
              <strong>{formatNumber(row.qtyBase ?? row.quantidade)}</strong>
            </div>
            <div>
              <span>Bonificacao</span>
              <strong>{formatNumber(row.qtyBonus ?? 0)}</strong>
            </div>
            <div>
              <span>Quantidade atual</span>
              <strong>{formatNumber(row.qtyAtual ?? row.quantidade)}</strong>
            </div>
            <div>
              <span>Custo total</span>
              <strong>{formatCurrency(row.result.custoTotal)}</strong>
            </div>
            <div>
              <span>Pagou</span>
              <strong>{formatCurrency(row.result.pagou)}</strong>
            </div>
            <div>
              <span>Venda do ativo</span>
              <strong>{formatCurrency(row.result.vendaAtivo)}</strong>
            </div>
            <div>
              <span>Ganho na Call</span>
              <strong>{formatCurrency(row.result.ganhoCall)}</strong>
            </div>
            <div>
              <span>Ganho na Put</span>
              <strong>{formatCurrency(row.result.ganhoPut)}</strong>
            </div>
            <div>
              <span>Ganhos nas opcoes</span>
              <strong>{formatCurrency(row.result.ganhosOpcoes)}</strong>
            </div>
            <div>
              <span>Dividendos</span>
              <strong>{formatCurrency(row.result.dividends)}</strong>
            </div>
            <div>
              <span>{cupomManual ? 'Cupom (manual)' : 'Cupom'}</span>
              <strong>{formatCurrency(row.result.cupomTotal)}</strong>
            </div>
            <div>
              <span>Rebates</span>
              <strong>{formatCurrency(row.result.rebateTotal)}</strong>
            </div>
          </div>
        </div>

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
      </div>

      {warnings.length ? (
        <div className="report-warnings">
          {warnings.map((warning) => (
            <span key={warning}><Icon name="warning" size={14} /> {warning}</span>
          ))}
        </div>
      ) : null}

      <div className="report-actions">
        <button className="btn btn-secondary" type="button" onClick={onRefresh}>Atualizar dados</button>
        <button className="btn btn-secondary" type="button" onClick={onCopy}>Copiar resumo</button>
        <button className="btn btn-primary" type="button" onClick={onExport}>Exportar PDF</button>
      </div>
    </Modal>
  )
}

export default ReportModal
