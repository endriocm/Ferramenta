import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Icon from '../components/Icons'
import { useToast } from '../hooks/useToast'
import { useOutlook } from '../contexts/OutlookContext'
import { useHubxp } from '../contexts/HubxpContext'
import { resolveHubxpClients } from '../services/hubxpClientLookup'

const TEMPLATE_PLACEHOLDERS = [
  '[conta]',
  '[nome_cliente]',
  '[email_cliente]',
  '[cc]',
  '[data_envio]',
  '[usuario_logado]',
]

const parseLinesInput = (raw) => {
  const text = String(raw || '')
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line, index) => {
    const parts = line.split(/[;,|]/)
    const account = String(parts[0] || '').replace(/\D/g, '')
    const cc = parts.slice(1).join(';').trim()
    return {
      id: `row-${index + 1}`,
      account,
      cc,
      raw: line,
    }
  })
}

const serializeLinesInput = (rows = []) => rows
  .map((row) => {
    const account = String(row?.account || '').replace(/\D/g, '')
    const cc = String(row?.cc || '').trim()
    if (!account) return ''
    return cc ? `${account};${cc}` : account
  })
  .filter(Boolean)
  .join('\n')

const collectDuplicates = (rows = []) => {
  const counts = new Map()
  for (const row of rows) {
    counts.set(row.account, (counts.get(row.account) || 0) + 1)
  }
  return Array.from(counts.entries())
    .filter(([, total]) => total > 1)
    .map(([account]) => account)
}

const normalizeErrorMessage = (error, fallback) => {
  const message = String(error?.message || '').trim()
  return message || fallback
}

const formatDateTime = (value) => {
  if (!value) return '-'
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return String(value)
  return dt.toLocaleString('pt-BR')
}

const statusLabel = (status) => {
  if (!status) return 'Desconectado'
  if (status === 'CREATED') return 'Pronto'
  if (status === 'STARTING') return 'Autenticando'
  if (status === 'AUTHENTICATED') return 'Logado'
  if (status === 'MONITORING') return 'Monitorando'
  if (status === 'SENDING') return 'Enviando'
  if (status === 'FAILED') return 'Falha'
  if (status === 'CLEANED') return 'Encerrado'
  return status
}

const Outlook = () => {
  const { notify } = useToast()
  const hubxp = useHubxp()
  const outlook = useOutlook()
  const linesStorageKey = `pwr.outlook.send_lines.${outlook.userKey}`
  const [linesText, setLinesText] = useState(() => {
    if (typeof window === 'undefined') return ''
    try {
      return window.localStorage.getItem(linesStorageKey) || ''
    } catch {
      return ''
    }
  })
  const [lineDraft, setLineDraft] = useState(() => ({ account: '', cc: '' }))
  const [retryPerAccount, setRetryPerAccount] = useState(1)
  const [lastRun, setLastRun] = useState(null)
  const [sessionConfigOpen, setSessionConfigOpen] = useState(false)

  const parsedLines = useMemo(() => parseLinesInput(linesText), [linesText])
  const validLines = useMemo(() => parsedLines.filter((line) => line.account), [parsedLines])
  const duplicateAccounts = useMemo(() => collectDuplicates(validLines), [validLines])

  const logs = useMemo(() => {
    if (!Array.isArray(outlook.job?.logs)) return []
    return [...outlook.job.logs].slice(-8).reverse()
  }, [outlook.job?.logs])

  const monitorEvents = useMemo(() => {
    if (!Array.isArray(outlook.events)) return []
    return [...outlook.events].slice(-30).reverse()
  }, [outlook.events])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      setLinesText(window.localStorage.getItem(linesStorageKey) || '')
    } catch {
      setLinesText('')
    }
  }, [linesStorageKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(linesStorageKey, linesText)
    } catch {
      // ignore
    }
  }, [linesStorageKey, linesText])

  const handleLineDraftChange = (field, value) => {
    setLineDraft((prev) => ({
      ...prev,
      [field]: String(value || ''),
    }))
  }

  const handleAddLine = () => {
    const account = String(lineDraft.account || '').replace(/\D/g, '')
    const cc = String(lineDraft.cc || '').trim()
    if (!account) {
      notify('Informe o codigo da conta com numeros.', 'warning')
      return
    }
    if (validLines.length >= 50) {
      notify('Maximo de 50 contas por execucao.', 'warning')
      return
    }
    const next = [...validLines, { account, cc }]
    setLinesText(serializeLinesInput(next))
    setLineDraft({ account: '', cc: '' })
  }

  const handleRemoveLine = (index) => {
    const next = validLines.filter((_, currentIndex) => currentIndex !== index)
    setLinesText(serializeLinesInput(next))
  }

  const handleClearLines = () => {
    setLinesText('')
    setLineDraft({ account: '', cc: '' })
  }

  const handleStartSession = async () => {
    try {
      await outlook.startSession({ headless: false })
      notify('Sessao Outlook iniciada.', 'success')
    } catch (error) {
      notify(normalizeErrorMessage(error, 'Falha ao iniciar sessao Outlook.'), 'warning')
    }
  }

  const handleCleanupSession = async () => {
    try {
      await outlook.cleanupSession()
      notify('Sessao Outlook encerrada.', 'success')
    } catch (error) {
      notify(normalizeErrorMessage(error, 'Falha ao encerrar sessao Outlook.'), 'warning')
    }
  }

  const handleToggleMonitor = async () => {
    try {
      if (outlook.monitorEnabled) {
        await outlook.stopMonitor()
        notify('Monitoramento Outlook interrompido.', 'success')
      } else {
        await outlook.startMonitor({ intervalMs: outlook.monitorConfig.intervalMs })
        notify('Monitoramento Outlook iniciado.', 'success')
      }
    } catch (error) {
      notify(normalizeErrorMessage(error, 'Falha ao atualizar monitoramento Outlook.'), 'warning')
    }
  }

  const handleSend = async () => {
    if (!validLines.length) {
      notify('Adicione ao menos uma conta para envio.', 'warning')
      return
    }
    if (validLines.length > 50) {
      notify('Maximo de 50 contas por execucao.', 'warning')
      return
    }

    if (duplicateAccounts.length) {
      const confirmed = window.confirm(
        `Existem contas duplicadas (${duplicateAccounts.join(', ')}). Deseja manter as repeticoes?`,
      )
      if (!confirmed) return
    }

    const processConfirmed = window.confirm(
      'O processo vai abrir o HubXP para buscar o e-mail do cliente e, depois, preparar o envio no Outlook. Deseja continuar?',
    )
    if (!processConfirmed) return

    try {
      notify('Validando sessao HubXP para buscar e-mail do cliente...', 'success')
      let hubLookupJobId = String(hubxp.jobId || hubxp.job?.id || '').trim()
      let hubStatus = String(hubxp.job?.status || '').toUpperCase()
      let hubReady = hubStatus === 'AUTHENTICATED' || hubStatus === 'SUCCESS'

      if (hubLookupJobId && !hubReady) {
        const syncedJob = await hubxp.syncStatus(hubLookupJobId, { silent: true }).catch(() => null)
        if (syncedJob?.id) hubLookupJobId = String(syncedJob.id).trim()
        hubStatus = String(syncedJob?.status || hubStatus || '').toUpperCase()
        hubReady = hubStatus === 'AUTHENTICATED' || hubStatus === 'SUCCESS'
      }

      // Se a sessao ainda nao esta pronta, sincronizar novamente antes de abrir browser
      if (hubLookupJobId && !hubReady) {
        notify('Sessao HubXP nao pronta. Verificando status novamente...', 'warning')
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const retrySynced = await hubxp.syncStatus(hubLookupJobId, { silent: true }).catch(() => null)
        if (retrySynced?.id) hubLookupJobId = String(retrySynced.id).trim()
        hubStatus = String(retrySynced?.status || hubStatus || '').toUpperCase()
        hubReady = hubStatus === 'AUTHENTICATED' || hubStatus === 'SUCCESS'
      }

      if (!hubReady) {
        notify('Abrindo HubXP para validar login e iniciar lookup...', 'warning')
        const hubSession = await hubxp.startSession({ headless: false, keepVisible: true })
        hubLookupJobId = String(hubSession?.job?.id || hubLookupJobId || '').trim()
        hubStatus = String(hubSession?.job?.status || '').toUpperCase()
        hubReady = hubStatus === 'AUTHENTICATED' || hubStatus === 'SUCCESS'
      } else {
        notify('Sessao HubXP reutilizada. Iniciando busca da conta...', 'success')
      }

      if (!hubLookupJobId) {
        notify('Nao foi possivel iniciar sessao do HubXP para lookup.', 'warning')
        return
      }
      if (!hubReady) {
        notify('Conclua o login no HubXP (incluindo OTP, se houver) e clique em Enviar agora novamente.', 'warning')
        return
      }

      notify('Pesquisando conta(s) no HubXP para resolver e-mail do cliente. Aguarde...', 'success')
      let preLookup = null
      try {
        preLookup = await resolveHubxpClients({
          userKey: hubxp.userKey,
          mode: 'shared',
          jobId: hubLookupJobId,
          accounts: validLines.map((line) => line.account),
          minWaitMs: 2000,
          timeoutMs: 10000,
          retryPerAccount: 1,
        })
      } catch (lookupError) {
        const lookupCode = String(lookupError?.code || '')
        if (lookupCode === 'JOB_NOT_AUTHENTICATED' || lookupCode === 'JOB_NOT_READY' || lookupCode === 'JOB_NOT_FOUND') {
          notify('Sessao HubXP expirou. Abrindo HubXP para novo login...', 'warning')
          const hubSession = await hubxp.startSession({ headless: false, keepVisible: true })
          hubLookupJobId = String(hubSession?.job?.id || hubLookupJobId || '').trim()
          hubStatus = String(hubSession?.job?.status || '').toUpperCase()
          hubReady = hubStatus === 'AUTHENTICATED' || hubStatus === 'SUCCESS'
          if (!hubReady) {
            notify('Conclua o login no HubXP e clique em Enviar agora novamente.', 'warning')
            return
          }
          notify('HubXP reconectado. Buscando conta novamente...', 'success')
          preLookup = await resolveHubxpClients({
            userKey: hubxp.userKey,
            mode: 'shared',
            jobId: hubLookupJobId,
            accounts: validLines.map((line) => line.account),
            minWaitMs: 2000,
            timeoutMs: 10000,
            retryPerAccount: 1,
          })
        } else if (lookupCode === 'JOB_BUSY') {
          notify('HubXP esta ocupado com outra operacao. Aguarde e tente novamente.', 'warning')
          return
        } else {
          throw lookupError
        }
      }
      const preLookupRows = Array.isArray(preLookup?.rows) ? preLookup.rows : []
      const resolvedCount = preLookupRows.filter((row) => row?.status === 'RESOLVED' && row?.clientEmail).length
      const failedCount = preLookupRows.length - resolvedCount
      if (!resolvedCount) {
        const firstFailure = preLookupRows.find((row) => row?.status !== 'RESOLVED')
        const failureMessage = String(firstFailure?.error?.message || '').trim()
        notify(
          failureMessage
            ? `Nenhum e-mail foi resolvido no HubXP. Motivo: ${failureMessage}`
            : 'Nenhum e-mail foi resolvido no HubXP para as contas informadas.',
          'warning',
        )
        return
      }

      notify('Abrindo Outlook para preparar o envio...', 'warning')
      const outlookSession = await outlook.startSession({ headless: false })
      const outlookSessionStatus = String(outlookSession?.job?.status || '').toUpperCase()
      const readyAfterStart = outlookSessionStatus === 'AUTHENTICATED'
        || outlookSessionStatus === 'MONITORING'
        || outlookSessionStatus === 'SUCCESS'
      if (!readyAfterStart) {
        notify('Conclua o login no Outlook e clique em Enviar agora novamente.', 'warning')
        return
      }

      const sendConfirmed = window.confirm(
        `Lookup concluido no HubXP. Sucesso: ${resolvedCount} | Falha: ${failedCount}. Deseja enviar os e-mails agora pelo Outlook?`,
      )
      if (!sendConfirmed) {
        notify('Envio cancelado antes do disparo de e-mails.', 'warning')
        return
      }

      notify('Buscando e-mail no HubXP e enviando no Outlook...', 'success')
      const result = await outlook.executeSendFlow({
        lines: validLines,
        allowDuplicates: true,
        retryPerAccount,
        hubxpJobId: hubLookupJobId,
        preLookup,
      })
      setLastRun(result)

      const sendersFromLastSend = Array.from(new Set(
        (Array.isArray(result?.rows) ? result.rows : [])
          .filter((row) => row?.status === 'SENT')
          .map((row) => String(row?.to || row?.clientEmail || '').split(/[;,]/)[0].trim().toLowerCase())
          .filter(Boolean),
      ))
      const appliedSenders = outlook.setMonitorSenders(sendersFromLastSend)

      notify(`Envio finalizado. Sucesso: ${result.summary.sent} | Falha: ${result.summary.failed}`, result.summary.failed ? 'warning' : 'success')
      if (appliedSenders.length) {
        // Iniciar monitor automaticamente apos envio para capturar respostas
        if (!outlook.monitorEnabled) {
          try {
            await outlook.startMonitor({})
            notify(`Monitor iniciado automaticamente para ${appliedSenders.length} destinatario(s). Voce sera notificado quando responderem.`, 'success')
          } catch (monitorError) {
            notify(`Regras de monitor configuradas para ${appliedSenders.length} destinatario(s), mas falha ao iniciar monitor: ${monitorError?.message || 'erro desconhecido'}. Inicie manualmente.`, 'warning')
          }
        } else {
          notify(`Monitor ja ativo. Regras atualizadas para ${appliedSenders.length} destinatario(s) enviados.`, 'success')
        }
      }
    } catch (error) {
      if (error?.code === 'DUPLICATE_ACCOUNTS') {
        notify('Lote contem contas duplicadas. Confirme para manter repeticoes.', 'warning')
        return
      }
      notify(normalizeErrorMessage(error, 'Falha no fluxo de envio Outlook.'), 'warning')
    }
  }

  return (
    <div className="page outlook-page">
      <PageHeader
        title="Outlook"
        subtitle="Sessao web, monitoramento de inbox por regras e envio por conta via lookup HubXP."
        actions={(
          <>
            <button className="btn btn-secondary" type="button" onClick={handleToggleMonitor} disabled={outlook.busy || !outlook.jobId}>
              <Icon name="sync" size={16} />
              {outlook.monitorEnabled ? 'Parar monitor' : 'Iniciar monitor'}
            </button>
            <button className="btn btn-primary" type="button" onClick={handleSend} disabled={outlook.busy}>
              <Icon name="upload" size={16} />
              {outlook.busy ? 'Processando...' : 'Enviar agora'}
            </button>
          </>
        )}
      />

      <section className="panel outlook-panel">
        <div className="panel-head">
          <div>
            <h3>Sessao Outlook</h3>
            <p className="muted">Status: <span className="pill">{statusLabel(outlook.job?.status)}</span></p>
            {outlook.jobId ? <p className="muted">Job ID: <strong>{outlook.jobId}</strong></p> : null}
          </div>
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={() => setSessionConfigOpen((open) => !open)}>
              <Icon name={sessionConfigOpen ? 'arrow-up' : 'arrow-down'} size={16} />
              {sessionConfigOpen ? 'Ocultar login/senha' : 'Configurar login/senha'}
            </button>
            <button className="btn btn-secondary" type="button" onClick={handleStartSession} disabled={outlook.busy}>
              <Icon name="sync" size={16} />
              Login Outlook
            </button>
            <button className="btn btn-secondary" type="button" onClick={handleCleanupSession} disabled={outlook.busy || !outlook.jobId}>
              <Icon name="close" size={16} />
              Encerrar
            </button>
          </div>
        </div>
        {sessionConfigOpen ? (
          <div className="outlook-session-config">
            <div className="form-grid hubxp-form-grid outlook-form-grid">
              <label className="outlook-field">
                Usuario Outlook
                <input
                  className="input"
                  type="text"
                  autoComplete="username"
                  value={outlook.credentials.username}
                  onChange={(event) => outlook.updateCredential('username', event.target.value)}
                  placeholder="usuario@dominio.com"
                  disabled={outlook.busy}
                />
              </label>
              <label className="outlook-field">
                Senha Outlook
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={outlook.credentials.password}
                  onChange={(event) => outlook.updateCredential('password', event.target.value)}
                  placeholder="********"
                  disabled={outlook.busy}
                />
              </label>
            </div>

            <div className="form-grid hubxp-form-grid outlook-form-grid">
              <label className="outlook-field">
                Intervalo monitor (ms)
                <input
                  className="input"
                  type="number"
                  min={10000}
                  step={1000}
                  value={outlook.monitorConfig.intervalMs}
                  onChange={(event) => outlook.updateMonitorConfig({
                    intervalMs: Math.max(10000, Number(event.target.value || 30000)),
                  })}
                />
              </label>
              <label className="outlook-toggle-field">
                <input
                  type="checkbox"
                  checked={outlook.monitorConfig.autoStart}
                  onChange={(event) => outlook.updateMonitorConfig({ autoStart: event.target.checked })}
                />
                Auto iniciar monitor apos login
              </label>
            </div>

            {logs.length ? (
              <div className="hubxp-log-list outlook-session-logs">
                {logs.map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className="hubxp-log-item">
                    <small>{entry.at}</small>
                    <strong>{entry.stage}</strong>
                    <span>{entry.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="panel outlook-panel">
        <div className="panel-head">
          <div>
            <h3>Regras de monitoramento</h3>
            <p className="muted">Monitoramos respostas por remetente. Se nao houver regra ativa, monitora todos os novos e-mails.</p>
          </div>
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={outlook.addRule}>
              <Icon name="plus" size={16} />
              Adicionar regra
            </button>
          </div>
        </div>

        {outlook.rules.length ? (
          <div className="outlook-rule-list">
            {outlook.rules.map((rule) => (
              <article key={rule.id} className="outlook-rule-card">
                <div className="form-grid hubxp-form-grid outlook-rule-grid">
                  <label className="outlook-toggle-field">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => outlook.updateRule(rule.id, { enabled: event.target.checked })}
                    />
                    Ativa
                  </label>
                  <label className="outlook-field">
                    Remetente exato
                    <input
                      className="input"
                      type="text"
                      value={rule.senderExact}
                      onChange={(event) => outlook.updateRule(rule.id, { senderExact: event.target.value })}
                      placeholder="origem@empresa.com"
                    />
                  </label>
                  <label className="outlook-field">
                    Assunto contem
                    <input
                      className="input"
                      type="text"
                      value={rule.subjectContains}
                      onChange={(event) => outlook.updateRule(rule.id, { subjectContains: event.target.value })}
                      placeholder="assunto-chave"
                    />
                  </label>
                </div>
                <div className="panel-actions">
                  <button className="btn btn-secondary" type="button" onClick={() => outlook.removeRule(rule.id)}>
                    <Icon name="x" size={16} />
                    Remover
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">Nenhuma regra cadastrada.</p>
        )}

        {monitorEvents.length ? (
          <div className="hubxp-log-list outlook-monitor-events">
            {monitorEvents.map((event) => (
              <div key={`${event.seq}-${event.messageId || event.at}`} className="hubxp-log-item">
                <small>{event.at}</small>
                <strong>{event.type}</strong>
                <span>{event.sender} - {event.subject}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel outlook-panel outlook-send-panel">
        <div className="panel-head">
          <div>
            <h3>Template e envio</h3>
            <p className="muted">Corpo livre com placeholders + preenchimento de conta/e-mail no formato de campos.</p>
            <div className="outlook-placeholder-list">
              {TEMPLATE_PLACEHOLDERS.map((placeholder) => (
                <span key={placeholder} className="outlook-placeholder-chip">{placeholder}</span>
              ))}
            </div>
          </div>
        </div>

        <div className="outlook-compose-grid">
          <label className="outlook-field">
            Remetente (From opcional)
            <input
              className="input"
              type="text"
              value={outlook.template.from || ''}
              onChange={(event) => outlook.setTemplate({ from: event.target.value })}
              placeholder="email@dominio.com"
            />
          </label>
          <label className="outlook-field">
            Assunto
            <input
              className="input"
              type="text"
              value={outlook.template.subject}
              onChange={(event) => outlook.setTemplate({ subject: event.target.value })}
            />
          </label>
          <label className="outlook-field">
            Retry por conta
            <input
              className="input"
              type="number"
              min={0}
              max={1}
              value={retryPerAccount}
              onChange={(event) => setRetryPerAccount(Math.max(0, Math.min(1, Number(event.target.value || 0))))}
            />
          </label>
          <label className="outlook-field outlook-compose-body">
            Corpo
            <textarea
              className="input outlook-textarea-body"
              rows={6}
              value={outlook.template.body}
              onChange={(event) => outlook.setTemplate({ body: event.target.value })}
            />
          </label>
        </div>

        <div className="panel-head outlook-lines-head">
          <div>
            <h4>Linhas de envio (estilo Receita Manual)</h4>
            <p className="muted">Preencha conta e e-mail CC opcional. O e-mail principal (To) e resolvido automaticamente no HubXP.</p>
          </div>
          <div className="panel-actions">
            <button className="btn btn-secondary" type="button" onClick={handleClearLines}>
              Limpar linhas
            </button>
          </div>
        </div>

        <form className="filter-grid outlook-manual-line-form" onSubmit={(event) => {
          event.preventDefault()
          handleAddLine()
        }}>
          <label className="outlook-field">
            Codigo da conta
            <input
              className="input"
              type="text"
              inputMode="numeric"
              placeholder="8076352"
              value={lineDraft.account}
              onChange={(event) => handleLineDraftChange('account', event.target.value.replace(/\D/g, ''))}
            />
          </label>
          <label className="outlook-field">
            E-mail CC (opcional)
            <input
              className="input"
              type="text"
              placeholder="cc1@dominio.com;cc2@dominio.com"
              value={lineDraft.cc}
              onChange={(event) => handleLineDraftChange('cc', event.target.value)}
            />
          </label>
          <button className="btn btn-primary outlook-line-add-btn" type="submit" disabled={validLines.length >= 50}>
            <Icon name="plus" size={16} />
            Adicionar
          </button>
        </form>

        {validLines.length ? (
          <div className="outlook-lines-list">
            {validLines.map((line, index) => (
              <article key={`${line.account}-${line.cc}-${index}`} className="outlook-line-card">
                <div className="outlook-line-main">
                  <strong>Conta {line.account}</strong>
                  <span>{line.cc ? `CC: ${line.cc}` : 'Sem CC'}</span>
                </div>
                <button className="btn btn-secondary" type="button" onClick={() => handleRemoveLine(index)}>
                  <Icon name="x" size={16} />
                  Remover
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">Nenhuma linha adicionada.</p>
        )}

        <div className="outlook-send-meta">
          <span className="muted">Linhas validas: {validLines.length}</span>
          <span className="muted">Duplicadas: {duplicateAccounts.length}</span>
        </div>

        {outlook.lastError ? (
          <div className="sync-warnings">
            <strong>ERRO</strong>
            {normalizeErrorMessage(outlook.lastError, 'Falha no fluxo Outlook.')}
          </div>
        ) : null}
      </section>

      {lastRun ? (
        <section className="panel outlook-panel">
          <div className="panel-head">
            <div>
              <h3>Ultimo envio</h3>
              <p className="muted">Total: {lastRun.summary.total} | Sucesso: {lastRun.summary.sent} | Falha: {lastRun.summary.failed}</p>
            </div>
          </div>
          <div className="outlook-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Conta</th>
                  <th>Status</th>
                  <th>To</th>
                  <th>CC</th>
                  <th>Tentativas</th>
                  <th>Erro</th>
                </tr>
              </thead>
              <tbody>
                {lastRun.rows.map((row) => (
                  <tr key={`${row.rowId}-${row.account}`}>
                    <td>{row.index}</td>
                    <td>{row.account}</td>
                    <td>{row.status}</td>
                    <td>{row.to || row.clientEmail || '-'}</td>
                    <td>{row.cc || '-'}</td>
                    <td>{row.attempts || 0}</td>
                    <td>{row.error?.message || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel outlook-panel">
        <div className="panel-head">
          <div>
            <h3>Historico</h3>
            <p className="muted">Persistente por usuario.</p>
          </div>
        </div>
        {outlook.history.length ? (
          <div className="hubxp-log-list outlook-history-list">
            {outlook.history.map((item) => (
              <div key={item.id} className="hubxp-log-item">
                <small>{formatDateTime(item.at)}</small>
                <strong>{item.kind}</strong>
                <span>{item.status || '-'}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Sem historico.</p>
        )}
      </section>
    </div>
  )
}

export default Outlook
