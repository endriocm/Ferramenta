import Modal from './Modal'
import { formatNumber } from '../utils/format'

const OverrideModal = ({ open, onClose, value, onChange, onApply, onReset, qtyBase, qtyAtual }) => {
  if (!value) return null

  const qtyBaseLabel = qtyBase != null ? formatNumber(qtyBase) : '-'
  const qtyAtualLabel = qtyAtual != null ? formatNumber(qtyAtual) : '-'

  return (
    <Modal open={open} onClose={onClose} title="Batimento manual" subtitle="Override altera o resultado do relatorio">
      <div className="override-grid">
        <label>
          Barreira de alta
          <select className="input" value={value.high} onChange={(event) => onChange({ ...value, high: event.target.value })}>
            <option value="auto">Automatico</option>
            <option value="hit">Forcar bateu</option>
            <option value="nohit">Forcar nao bateu</option>
          </select>
        </label>
        <label>
          Barreira de baixa
          <select className="input" value={value.low} onChange={(event) => onChange({ ...value, low: event.target.value })}>
            <option value="auto">Automatico</option>
            <option value="hit">Forcar bateu</option>
            <option value="nohit">Forcar nao bateu</option>
          </select>
        </label>
        <label>
          Cupom manual
          <input
            className="input"
            type="text"
            placeholder="Ex: 1.2%"
            value={value.cupomManual ?? ''}
            onChange={(event) => onChange({ ...value, cupomManual: event.target.value })}
          />
          <small className="muted">Deixa vazio para usar o cupom automatico.</small>
        </label>
      </div>
      <div className="override-grid">
        <label>
          Quantidade base
          <input className="input" type="text" value={qtyBaseLabel} readOnly />
        </label>
        <label>
          Bonificacao (qty bonus)
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            value={value.qtyBonus ?? 0}
            onChange={(event) => onChange({ ...value, qtyBonus: event.target.value })}
          />
        </label>
        <label>
          Quantidade atual
          <input className="input" type="text" value={qtyAtualLabel} readOnly />
        </label>
        <label>
          Data da bonificacao (opcional)
          <input
            className="input"
            type="date"
            value={value.bonusDate ?? ''}
            onChange={(event) => onChange({ ...value, bonusDate: event.target.value })}
          />
        </label>
        <label>
          Observacao (opcional)
          <input
            className="input"
            type="text"
            placeholder="Ex: ajuste por bonificacao"
            value={value.bonusNote ?? ''}
            onChange={(event) => onChange({ ...value, bonusNote: event.target.value })}
          />
        </label>
      </div>
      <p className="muted">Override manual altera o resultado imediatamente.</p>
      <div className="report-actions">
        <button className="btn btn-secondary" type="button" onClick={onReset}>Resetar automatico</button>
        <button className="btn btn-primary" type="button" onClick={onApply}>Aplicar batimento manual</button>
      </div>
    </Modal>
  )
}

export default OverrideModal
