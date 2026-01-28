import Modal from './Modal'

const OverrideModal = ({ open, onClose, value, onChange, onApply, onReset }) => {
  if (!value) return null

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
      <p className="muted">Override manual altera o resultado imediatamente.</p>
      <div className="report-actions">
        <button className="btn btn-secondary" type="button" onClick={onReset}>Resetar automatico</button>
        <button className="btn btn-primary" type="button" onClick={onApply}>Aplicar batimento manual</button>
      </div>
    </Modal>
  )
}

export default OverrideModal
