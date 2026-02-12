import { useCallback, useMemo, useRef, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Icon from '../components/Icons'
import { useToast } from '../hooks/useToast'
import { importConsolidatedRevenueComplement } from '../services/revenueConsolidated'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'

const joinMonths = (months) => {
  if (!Array.isArray(months) || !months.length) return '-'
  return months.join(', ')
}

const RevenueConsolidated = () => {
  const { notify } = useToast()
  const { tagsIndex } = useGlobalFilters()
  const fileInputRef = useRef(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)

  const summary = result?.summary || null
  const importedByLine = summary?.importedByLine || { bovespa: 0, bmf: 0, estruturadas: 0 }

  const headerMeta = useMemo(() => ([
    { label: 'Arquivo selecionado', value: selectedFile?.name || 'Nenhum' },
    { label: 'Linhas lidas', value: summary?.fileRows ?? 0 },
    { label: 'Linhas validas', value: summary?.parsedRows ?? 0 },
    { label: 'Linhas importadas', value: summary?.importedRows ?? 0 },
    { label: 'Meses importados', value: summary?.monthsToImport?.length ?? 0 },
    { label: 'Meses ignorados', value: summary?.monthsSkipped?.length ?? 0 },
  ]), [selectedFile?.name, summary])

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback((event) => {
    const file = event.target.files?.[0] || null
    setSelectedFile(file)
  }, [])

  const handleImport = useCallback(async () => {
    if (!selectedFile) {
      notify('Selecione um arquivo .xlsx para importar.', 'warning')
      return
    }

    setRunning(true)
    try {
      const response = await importConsolidatedRevenueComplement({
        input: selectedFile,
        tagsIndex,
      })
      setResult(response)
      if (!response?.ok) {
        notify(response?.error || 'Falha ao importar consolidado.', 'warning')
        return
      }
      const importedRows = response.summary?.importedRows || 0
      if (!importedRows) {
        notify('Nenhum mes novo para complementar. Base atual mantida.', 'warning')
        return
      }
      notify(`Importacao concluida. ${importedRows} linhas complementadas.`, 'success')
    } catch (error) {
      notify(error?.message ? `Falha ao importar: ${error.message}` : 'Falha ao importar consolidado.', 'warning')
    } finally {
      setRunning(false)
    }
  }, [notify, selectedFile, tagsIndex])

  return (
    <div className="page">
      <PageHeader
        title="Receita Consolidada"
        subtitle="Importe planilhas consolidadas para complementar apenas meses ausentes, sem substituir os relatorios atuais."
        meta={headerMeta}
        actions={[
          { label: 'Selecionar arquivo', icon: 'upload', variant: 'btn-secondary', onClick: handlePickFile },
          { label: running ? 'Importando...' : 'Importar consolidado', icon: 'sync', onClick: handleImport, disabled: running || !selectedFile },
        ]}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        onChange={handleFileChange}
        hidden
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Como funciona o complemento</h3>
            <p className="muted">O sistema valida os meses presentes na base atual e importa somente os meses que ainda nao possuem operacoes de receita.</p>
          </div>
        </div>
        <div className="mini-grid">
          <div className="card mini-card">
            <div className="mini-label">Importado Bovespa</div>
            <div className="mini-value">{importedByLine.bovespa}</div>
          </div>
          <div className="card mini-card">
            <div className="mini-label">Importado BMF</div>
            <div className="mini-value">{importedByLine.bmf}</div>
          </div>
          <div className="card mini-card">
            <div className="mini-label">Importado Estruturadas</div>
            <div className="mini-value">{importedByLine.estruturadas}</div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Resumo da ultima importacao</h3>
            <p className="muted">Use este painel para auditar os meses importados e ignorados.</p>
          </div>
        </div>
        <div className="mini-grid">
          <div className="card mini-card">
            <div className="mini-label">Meses no arquivo</div>
            <div className="mini-value" style={{ fontSize: '0.98rem' }}>{joinMonths(summary?.fileMonths)}</div>
          </div>
          <div className="card mini-card">
            <div className="mini-label">Meses importados</div>
            <div className="mini-value" style={{ fontSize: '0.98rem' }}>{joinMonths(summary?.monthsToImport)}</div>
          </div>
          <div className="card mini-card">
            <div className="mini-label">Meses ignorados</div>
            <div className="mini-value" style={{ fontSize: '0.98rem' }}>{joinMonths(summary?.monthsSkipped)}</div>
          </div>
        </div>
        {summary?.ignoredRows?.length ? (
          <div className="warning-panel">
            <div>
              <Icon name="warning" size={18} />
              <div>
                <strong>{summary.ignoredRows.length} linha(s) ignorada(s)</strong>
                <p className="muted">Exemplo: linha {summary.ignoredRows[0].index} - {summary.ignoredRows[0].reason}</p>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

export default RevenueConsolidated