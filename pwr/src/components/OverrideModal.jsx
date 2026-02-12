import Modal from './Modal'
import { formatNumber } from '../utils/format'

const describeBarrierType = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return 'Sem alteracao'
  if (raw === 'NONE') return 'Sem barreira'
  if (raw === 'UI') return 'Alta • Ativacao'
  if (raw === 'UO') return 'Alta • Desativacao'
  if (raw === 'KI') return 'Queda • Ativacao'
  if (raw === 'KO') return 'Queda • Desativacao'
  return 'Sem alteracao'
}

const isExplicitBarrierType = (value) => {
  const raw = String(value || '').trim().toUpperCase()
  return raw === 'UI' || raw === 'UO' || raw === 'KI' || raw === 'KO'
}

const getEntryError = (errors, entryId, field) => errors?.[`structureEntries.${entryId}.${field}`] || null

const resolveEntryContext = (entry, structureMeta) => {
  const rawLegKey = String(entry?.legKey || '').trim()
  const requiresLegSelection = Boolean(structureMeta?.requiresLegSelection)
  const defaultLegKey = structureMeta?.defaultLegKey || ''
  const legKey = rawLegKey || (!requiresLegSelection ? defaultLegKey : '')
  const legMetaByKey = structureMeta?.legMetaByKey && typeof structureMeta.legMetaByKey === 'object'
    ? structureMeta.legMetaByKey
    : {}
  const legMeta = legKey ? legMetaByKey[legKey] || null : null
  return { legKey, legMeta }
}

const OverrideModal = ({
  open,
  onClose,
  value,
  onChange,
  onApply,
  onReset,
  onClearStructureOverrides,
  onUseQtyBase,
  onAddStructureEntry,
  onRemoveStructureEntry,
  onStructureEntryChange,
  qtyBase,
  qtyAtual,
  structureMeta,
  errors,
}) => {
  if (!value) return null

  const qtyBaseLabel = qtyBase != null ? formatNumber(qtyBase) : '-'
  const qtyAtualLabel = qtyAtual != null ? formatNumber(qtyAtual) : '-'
  const hasOptionQty = Boolean(structureMeta?.hasOptionQty)
  const hasStrike = Boolean(structureMeta?.hasStrike)
  const hasBarrierValue = Boolean(structureMeta?.hasBarrierValue)
  const hasBarrierType = Boolean(structureMeta?.hasBarrierType)
  const hasStructureFields = hasOptionQty || hasStrike || hasBarrierValue || hasBarrierType
  const legOptions = Array.isArray(structureMeta?.legOptions) ? structureMeta.legOptions : []
  const requiresLegSelection = Boolean(structureMeta?.requiresLegSelection)
  const structureEntries = Array.isArray(value?.structureEntries) ? value.structureEntries : []
  const canManageEntries = hasStructureFields && structureEntries.length > 0
  const canAddEntry = hasStructureFields && typeof onAddStructureEntry === 'function'
  const showLegSelector = legOptions.length > 0
  const qtyBaseHint = qtyBase != null && Number.isFinite(Number(qtyBase)) ? formatNumber(qtyBase) : null

  return (
    <Modal open={open} onClose={onClose} title="Batimento manual e ajustes" subtitle="Ajuste local com recalc imediato">
      <section className="override-block">
        <h4 className="override-block-title">A) Status</h4>
        <p className="muted override-help">Auto usa high/low.</p>
        <div className="override-grid">
          <label>
            Alta
            <select className="input" value={value.high} onChange={(event) => onChange({ ...value, high: event.target.value })}>
              <option value="auto">Automatico</option>
              <option value="hit">Bateu</option>
              <option value="nohit">Nao bateu</option>
            </select>
          </label>
          <label>
            Queda
            <select className="input" value={value.low} onChange={(event) => onChange({ ...value, low: event.target.value })}>
              <option value="auto">Automatico</option>
              <option value="hit">Bateu</option>
              <option value="nohit">Nao bateu</option>
            </select>
          </label>
        </div>
      </section>

      <section className="override-block">
        <h4 className="override-block-title">B) Financeiro</h4>
        <div className="override-grid">
          <label>
            Cupom (R$)
            <input
              className="input"
              type="number"
              step="0.01"
              placeholder="Ex: 1250"
              value={value.manualCouponBRL ?? ''}
              onChange={(event) => onChange({ ...value, manualCouponBRL: event.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="override-block override-structure-block">
        <div className="override-section-head">
          <h4 className="override-block-title">C) Estrutura</h4>
          {canAddEntry ? (
            <button className="btn btn-secondary btn-inline" type="button" onClick={onAddStructureEntry}>
              + Opcao
            </button>
          ) : null}
        </div>
        {!hasStructureFields ? (
          <p className="muted">Sem parametros editaveis.</p>
        ) : null}
        {canManageEntries ? (
          <div className="structure-row-list">
            {structureEntries.map((entry, index) => {
              const { legMeta } = resolveEntryContext(entry, structureMeta)
              const optionQtyCurrentLabel = legMeta?.optionQtyCurrent != null ? formatNumber(legMeta.optionQtyCurrent) : null
              const optionQtySuggestionLabel = legMeta?.optionQtySuggestion != null
                ? formatNumber(legMeta.optionQtySuggestion)
                : (qtyBaseHint || null)
              const strikeCurrentLabel = legMeta?.strikeCurrent != null ? formatNumber(legMeta.strikeCurrent) : null
              const optionExpiryCurrentLabel = legMeta?.optionExpiryDateCurrent || null
              const barrierCurrentLabel = legMeta?.barrierValueCurrent != null ? formatNumber(legMeta.barrierValueCurrent) : null
              const barrierTypeCurrentLabel = legMeta?.barrierTypeCurrentLabel || 'Sem alteracao'
              const barrierTypeHint = describeBarrierType(entry?.barrierTypeOverride)
              const showBarrierValueField = isExplicitBarrierType(entry?.barrierTypeOverride)
              const canEditQty = legMeta?.hasOptionQty ?? hasOptionQty
              const canEditStrike = legMeta?.hasStrike ?? hasStrike
              const canEditBarrierValue = legMeta?.hasBarrierValue ?? hasBarrierValue
              const canEditBarrierType = legMeta?.hasBarrierType ?? hasBarrierType
              return (
                <article className="structure-row" key={entry.id || `entry-${index}`}>
                  <div className="structure-row-top">
                    <span className="structure-row-tag">Opcao {index + 1}</span>
                    {structureEntries.length > 1 ? (
                      <button
                        className="btn btn-secondary btn-inline"
                        type="button"
                        onClick={() => onRemoveStructureEntry?.(entry.id)}
                      >
                        Remover
                      </button>
                    ) : null}
                  </div>
                  <div className="structure-row-grid">
                    {showLegSelector ? (
                      <label>
                        Perna
                        <select
                          className="input"
                          value={entry.legKey ?? ''}
                          onChange={(event) => onStructureEntryChange?.(entry.id, { legKey: event.target.value })}
                          disabled={!requiresLegSelection && legOptions.length <= 1}
                        >
                          <option value="">Selecionar</option>
                          {legOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                        {requiresLegSelection ? (
                          <small className="muted">Obrigatorio</small>
                        ) : null}
                        {getEntryError(errors, entry.id, 'legKey') ? (
                          <small className="text-negative">{getEntryError(errors, entry.id, 'legKey')}</small>
                        ) : null}
                      </label>
                    ) : null}

                    <label>
                      Qtd
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        placeholder="1000"
                        value={entry.optionQtyOverride ?? ''}
                        onChange={(event) => onStructureEntryChange?.(entry.id, { optionQtyOverride: event.target.value })}
                        disabled={!canEditQty}
                      />
                      {canEditQty ? (
                        <small className="muted">
                          {optionQtyCurrentLabel ? `Atual ${optionQtyCurrentLabel}` : 'Manual'}
                        </small>
                      ) : <small className="muted">N/A</small>}
                      {canEditQty && optionQtySuggestionLabel ? (
                        <button className="btn btn-secondary btn-inline" type="button" onClick={() => onUseQtyBase?.(entry.id)}>
                          Usar base
                        </button>
                      ) : null}
                      {getEntryError(errors, entry.id, 'optionQtyOverride') ? (
                        <small className="text-negative">{getEntryError(errors, entry.id, 'optionQtyOverride')}</small>
                      ) : null}
                    </label>

                    <label>
                      Strike
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        placeholder="28,50"
                        value={entry.strikeOverride ?? ''}
                        onChange={(event) => onStructureEntryChange?.(entry.id, { strikeOverride: event.target.value })}
                        disabled={!canEditStrike}
                      />
                      {canEditStrike ? (
                        <small className="muted">{strikeCurrentLabel ? `Atual ${strikeCurrentLabel}` : 'Manual'}</small>
                      ) : <small className="muted">N/A</small>}
                      {getEntryError(errors, entry.id, 'strikeOverride') ? (
                        <small className="text-negative">{getEntryError(errors, entry.id, 'strikeOverride')}</small>
                      ) : null}
                    </label>

                    <label>
                      Venc.
                      <input
                        className="input"
                        type="date"
                        value={entry.optionExpiryDateOverride ?? ''}
                        onChange={(event) => onStructureEntryChange?.(entry.id, { optionExpiryDateOverride: event.target.value })}
                      />
                      <small className="muted">{optionExpiryCurrentLabel ? `Atual ${optionExpiryCurrentLabel}` : 'Trava preço no dia'}</small>
                      {getEntryError(errors, entry.id, 'optionExpiryDateOverride') ? (
                        <small className="text-negative">{getEntryError(errors, entry.id, 'optionExpiryDateOverride')}</small>
                      ) : null}
                    </label>

                    <label>
                      Tipo
                      <select
                        className="input"
                        value={entry.barrierTypeOverride ?? ''}
                        onChange={(event) => {
                          const nextType = event.target.value
                          onStructureEntryChange?.(entry.id, {
                            barrierTypeOverride: nextType,
                            barrierValueOverride: isExplicitBarrierType(nextType) ? entry.barrierValueOverride : '',
                          })
                        }}
                        disabled={!canEditBarrierType}
                      >
                        <option value="">Selecionar</option>
                        <option value="NONE">Sem barreira</option>
                        <option value="UI">UI</option>
                        <option value="UO">UO</option>
                        <option value="KI">KI</option>
                        <option value="KO">KO</option>
                      </select>
                      {canEditBarrierType ? (
                        <small className="muted">{barrierTypeHint}. Atual {barrierTypeCurrentLabel}</small>
                      ) : <small className="muted">N/A</small>}
                      {getEntryError(errors, entry.id, 'barrierTypeOverride') ? (
                        <small className="text-negative">{getEntryError(errors, entry.id, 'barrierTypeOverride')}</small>
                      ) : null}
                    </label>

                    {showBarrierValueField ? (
                      <label>
                        Barreira
                        <input
                          className="input"
                          type="text"
                          inputMode="decimal"
                          placeholder="29,50"
                          value={entry.barrierValueOverride ?? ''}
                          onChange={(event) => onStructureEntryChange?.(entry.id, { barrierValueOverride: event.target.value })}
                          disabled={!canEditBarrierValue}
                        />
                        {canEditBarrierValue ? (
                          <small className="muted">{barrierCurrentLabel ? `Atual ${barrierCurrentLabel}` : 'Manual'}</small>
                        ) : <small className="muted">N/A</small>}
                        {getEntryError(errors, entry.id, 'barrierValueOverride') ? (
                          <small className="text-negative">{getEntryError(errors, entry.id, 'barrierValueOverride')}</small>
                        ) : null}
                      </label>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        ) : null}
      </section>

      <div className="override-grid">
        <label>
          Qtd base
          <input className="input" type="text" value={qtyBaseLabel} readOnly />
        </label>
        <label>
          Bonus
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
          Qtd atual
          <input className="input" type="text" value={qtyAtualLabel} readOnly />
        </label>
        <label>
          Data bonus
          <input
            className="input"
            type="date"
            value={value.bonusDate ?? ''}
            onChange={(event) => onChange({ ...value, bonusDate: event.target.value })}
          />
        </label>
        <label>
          Nota
          <input
            className="input"
            type="text"
            placeholder="Opcional"
            value={value.bonusNote ?? ''}
            onChange={(event) => onChange({ ...value, bonusNote: event.target.value })}
          />
        </label>
      </div>

      <div className="report-actions">
        <button
          className="btn btn-secondary"
          type="button"
          onClick={onClearStructureOverrides}
          disabled={!onClearStructureOverrides || !hasStructureFields}
        >
          Limpar parametros da estrutura
        </button>
        <button className="btn btn-secondary" type="button" onClick={onReset}>Resetar batimento para automatico</button>
        <button className="btn btn-primary" type="button" onClick={onApply}>Salvar ajustes</button>
      </div>
    </Modal>
  )
}

export default OverrideModal
