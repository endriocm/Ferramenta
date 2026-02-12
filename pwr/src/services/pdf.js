const buildRow = (label, value) => `
  <tr>
    <td style="padding:6px 8px;color:#6b7280;font-size:12px;">${label}</td>
    <td style="padding:6px 8px;font-weight:600;">${value}</td>
  </tr>
`

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const buildCell = (value) => `
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(value)}</td>
`

const buildHeaderCell = (value) => `
  <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#475569;">${escapeHtml(value)}</th>
`

const chunkArray = (items, size) => {
  const source = Array.isArray(items) ? items : []
  const chunkSize = Math.max(1, Number(size) || 1)
  const chunks = []
  for (let index = 0; index < source.length; index += chunkSize) {
    chunks.push(source.slice(index, index + chunkSize))
  }
  return chunks
}

const clampPercent = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.min(100, parsed))
}

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

const formatCurrencyValue = (value) => {
  const parsed = Number(value)
  const safe = Number.isFinite(parsed) ? parsed : 0
  return currencyFormatter.format(safe)
}

const formatSignedCurrencyValue = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '—'
  if (parsed > 0) return `+ ${formatCurrencyValue(parsed)}`
  if (parsed < 0) return `- ${formatCurrencyValue(Math.abs(parsed))}`
  return formatCurrencyValue(0)
}

const formatPercentValue = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '—'
  return `${(parsed * 100).toFixed(1).replace('.', ',')}%`
}

const sumTeamTotals = (rows) => {
  const list = Array.isArray(rows) ? rows : []
  const totals = {
    bovespa: 0,
    estruturadas: 0,
    total: 0,
    goal: 0,
    gap: 0,
  }
  list.forEach((row) => {
    const bovespa = Number(row?.bovespaValue)
    const estruturadas = Number(row?.estruturadasValue)
    const total = Number(row?.totalValue)
    const goal = Number(row?.goalValue)
    const gap = Number(row?.gapValue)
    if (Number.isFinite(bovespa)) totals.bovespa += bovespa
    if (Number.isFinite(estruturadas)) totals.estruturadas += estruturadas
    if (Number.isFinite(total)) totals.total += total
    if (Number.isFinite(goal)) totals.goal += goal
    if (Number.isFinite(gap)) totals.gap += gap
  })
  totals.attainment = totals.goal > 0 ? totals.total / totals.goal : null
  return totals
}

export const exportReportPdf = ({ title, header, summary, details, barriers, warnings }, filename) => {
  const popup = window.open('', '_blank')
  if (!popup) return false

  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${filename}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #0f172a; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    h2 { font-size: 16px; margin: 20px 0 8px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    tr { border-bottom: 1px solid #e2e8f0; }
    .badge { display:inline-block; padding:4px 8px; border-radius:999px; background:#e2e8f0; font-size:12px; }
    .summary { background:#f8fafc; padding:12px; border-radius:12px; }
    .warning { color:#b45309; font-size:12px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div>${header}</div>

  <h2>Resumo do Resultado</h2>
  <div class="summary">
    ${summary}
  </div>

  <h2>Detalhamento</h2>
  <table>
    ${details.map((item) => buildRow(item.label, item.value)).join('')}
  </table>

  <h2>Barreiras</h2>
  <table>
    ${barriers.map((item) => buildRow(item.label, item.value)).join('')}
  </table>

  ${warnings.length ? `<h2>Observacoes</h2><ul>${warnings.map((w) => `<li class="warning">${w}</li>`).join('')}</ul>` : ''}
</body>
</html>
`

  popup.document.write(html)
  popup.document.close()
  popup.focus()
  popup.print()
  return true
}

export const exportVencimentosReportPdf = ({
  title,
  generatedAt,
  filters = [],
  summary = [],
  columns = [],
  rows = [],
}, filename = 'relatorio_vencimentos') => {
  const popup = window.open('', '_blank')
  if (!popup) return false

  const filtersHtml = filters.length
    ? `
    <h2>Filtros aplicados</h2>
    <table>
      ${filters.map((item) => buildRow(escapeHtml(item.label), escapeHtml(item.value))).join('')}
    </table>
  `
    : ''

  const summaryHtml = summary.length
    ? `
    <h2>Resumo</h2>
    <table>
      ${summary.map((item) => buildRow(escapeHtml(item.label), escapeHtml(item.value))).join('')}
    </table>
  `
    : ''

  const tableHeader = columns.length
    ? `<tr>${columns.map((col) => buildHeaderCell(col)).join('')}</tr>`
    : ''

  const tableRows = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => buildCell(cell)).join('')}</tr>`).join('')
    : '<tr><td style="padding:12px;font-size:12px;color:#6b7280;">Sem dados para exibir.</td></tr>'

  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(filename)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #0f172a; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    h2 { font-size: 16px; margin: 20px 0 8px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title || 'Relatorio')}</h1>
  ${generatedAt ? `<div style="color:#475569;font-size:12px;">Gerado em ${escapeHtml(generatedAt)}</div>` : ''}

  ${filtersHtml}
  ${summaryHtml}

  <h2>Pagina atual</h2>
  <table>
    ${tableHeader}
    ${tableRows}
  </table>
</body>
</html>
`

  popup.document.write(html)
  popup.document.close()
  popup.focus()
  popup.print()
  return true
}

export const exportTimesReportPdf = ({
  title = 'Relatorio de Times',
  generatedAt,
  filters = [],
  kpis = [],
  topAssessors = [],
  teamPerformance = [],
  seniorityPerformance = [],
  gapRows = [],
  tableRows = [],
}, filename = 'relatorio_times') => {
  const popup = window.open('', '_blank')
  if (!popup) return false

  const toneClassByName = {
    cyan: 'tone-cyan',
    blue: 'tone-blue',
    amber: 'tone-amber',
    violet: 'tone-violet',
    emerald: 'tone-emerald',
  }

  const toneColorByName = {
    green: '#34f5a4',
    red: '#ff4d6d',
    blue: '#4da3ff',
    cyan: '#28f2e6',
    violet: '#a66bff',
    amber: '#ffb454',
    emerald: '#34d3ae',
  }

  const filtersHtml = filters.length
    ? filters
      .map((item) => `
        <span class="filter-pill">
          <b>${escapeHtml(item.label)}</b>
          <em>${escapeHtml(item.value)}</em>
        </span>
      `)
      .join('')
    : '<span class="filter-pill"><b>Filtros</b><em>Sem filtros aplicados</em></span>'

  const kpisHtml = kpis.length
    ? kpis.map((item) => {
      const toneClass = toneClassByName[item.tone] || 'tone-cyan'
      const details = Array.isArray(item.details) ? item.details : []
      const detailsHtml = details.length
        ? `
          <div class="kpi-details">
            ${details.map((detail) => `
              <span>
                <b>${escapeHtml(detail.label)}</b>
                <em>${escapeHtml(detail.value)}</em>
              </span>
            `).join('')}
          </div>
        `
        : ''

      return `
        <article class="kpi-card ${toneClass}">
          <small>${escapeHtml(item.label)}</small>
          <strong>${escapeHtml(item.value)}</strong>
          ${detailsHtml}
        </article>
      `
    }).join('')
    : `
      <article class="kpi-card tone-cyan">
        <small>Resumo</small>
        <strong>Sem dados</strong>
      </article>
    `

  const topAssessorsHtml = topAssessors.length
    ? topAssessors.map((row, index) => `
      <li class="row-item">
        <div class="left">
          <span class="badge-rank">${index + 1}</span>
          <div class="stack">
            <b>${escapeHtml(row.assessor)}</b>
            <small>${escapeHtml(row.meta)}</small>
          </div>
        </div>
        <strong>${escapeHtml(row.value)}</strong>
      </li>
    `).join('')
    : '<li class="row-item empty">Sem dados para Top Assessores.</li>'

  const teamPerformanceHtml = teamPerformance.length
    ? teamPerformance.map((row) => `
      <div class="bar-row">
        <div class="bar-head">
          <b>${escapeHtml(row.team)}</b>
          <span>${escapeHtml(row.attainmentLabel)}</span>
        </div>
        <div class="track"><span style="width:${clampPercent(row.attainmentPct)}%"></span></div>
        <div class="bar-meta">
          <small>Receita ${escapeHtml(row.revenue || row.value || '—')}</small>
          <small>Meta ${escapeHtml(row.goal || '—')}</small>
        </div>
      </div>
    `).join('')
    : '<div class="bar-empty">Sem dados por equipe.</div>'

  const seniorityHtml = seniorityPerformance.length
    ? seniorityPerformance.map((row) => `
      <div class="bar-row">
        <div class="bar-head">
          <b>${escapeHtml(row.level)}</b>
          <span>${escapeHtml(row.attainmentLabel)}</span>
        </div>
        <div class="track"><span style="width:${clampPercent(row.attainmentPct)}%"></span></div>
        <small>${escapeHtml(row.value)}</small>
      </div>
    `).join('')
    : '<div class="bar-empty">Sem dados de senioridade.</div>'

  const rawGapRows = Array.isArray(gapRows) ? gapRows : []
  const gapTotalShare = rawGapRows.reduce((sum, item) => sum + Math.max(0, Number(item.share) || 0), 0)
  const normalizedGapRows = rawGapRows.map((item) => {
    const share = Math.max(0, Number(item.share) || 0)
    const normalizedShare = gapTotalShare > 0 ? (share / gapTotalShare) * 100 : 0
    const tone = toneColorByName[item.tone] || '#4da3ff'
    return {
      label: item.label,
      value: item.value,
      share: normalizedShare,
      tone,
    }
  })

  let gapCursor = 0
  const gapGradient = normalizedGapRows.length
    ? normalizedGapRows.map((item) => {
      const start = gapCursor
      const end = start + item.share
      gapCursor = end
      return `${item.tone} ${start}% ${end}%`
    }).join(', ')
    : '#20324a'

  const gapListHtml = normalizedGapRows.length
    ? normalizedGapRows.map((item) => `
      <li class="row-item">
        <div class="left">
          <span class="dot" style="background:${item.tone};"></span>
          <div class="stack">
            <b>${escapeHtml(item.label)}</b>
            <small>${escapeHtml(item.value)}</small>
          </div>
        </div>
        <strong>${escapeHtml(`${item.share.toFixed(1).replace('.', ',')}%`)}</strong>
      </li>
    `).join('')
    : '<li class="row-item empty">Sem dados de GAP.</li>'

  const teamMap = new Map()
  ;(Array.isArray(tableRows) ? tableRows : []).forEach((row) => {
    const team = String(row.team || '(Sem time)').trim() || '(Sem time)'
    if (!teamMap.has(team)) teamMap.set(team, [])
    teamMap.get(team).push(row)
  })
  const teamGroups = Array.from(teamMap.entries()).map(([team, rows]) => ({
    team,
    rows,
    totals: sumTeamTotals(rows),
  }))
  const teamPages = chunkArray(teamGroups, 3)

  const tablePagesHtml = teamPages.length
    ? teamPages.map((groupPage, pageIndex) => `
      <section class="times-pdf-page table-page ${pageIndex < teamPages.length - 1 ? 'page-break' : ''}">
        <div class="table-page-head">
          <h2>Tabela por Equipe</h2>
          <span>Pagina ${pageIndex + 2}</span>
        </div>
        ${groupPage.map((group) => `
          <article class="team-block">
            <div class="team-head">
              <h3>${escapeHtml(group.team)}</h3>
              <span>${escapeHtml(`${group.rows.length} assessor(es)`)}</span>
            </div>
            <table class="team-table">
              <thead>
                <tr>
                  <th>Senioridade</th>
                  <th>Assessor</th>
                  <th>Receita Bovespa</th>
                  <th>Receita Estruturadas</th>
                  <th>Receita Liquida Total</th>
                  <th>Objetivo</th>
                  <th>% Ating.</th>
                  <th>Gap Objetivo</th>
                </tr>
              </thead>
              <tbody>
                ${group.rows.map((row) => `
                  <tr>
                    <td>${escapeHtml(row.seniority)}</td>
                    <td>${escapeHtml(row.assessor)}</td>
                    <td class="num">${escapeHtml(row.bovespa)}</td>
                    <td class="num">${escapeHtml(row.estruturadas)}</td>
                    <td class="num strong">${escapeHtml(row.total)}</td>
                    <td class="num">${escapeHtml(row.goal)}</td>
                    <td class="num ${row.attainmentPositive ? 'positive' : 'negative'}">${escapeHtml(row.attainment)}</td>
                    <td class="num ${row.gapPositive ? 'positive' : 'negative'}">${escapeHtml(row.gap)}</td>
                  </tr>
                `).join('')}
              </tbody>
              <tfoot>
                <tr class="team-total-row">
                  <td colspan="2">Total da equipe</td>
                  <td class="num">${escapeHtml(formatCurrencyValue(group.totals.bovespa))}</td>
                  <td class="num">${escapeHtml(formatCurrencyValue(group.totals.estruturadas))}</td>
                  <td class="num strong">${escapeHtml(formatCurrencyValue(group.totals.total))}</td>
                  <td class="num">${escapeHtml(group.totals.goal > 0 ? formatCurrencyValue(group.totals.goal) : '—')}</td>
                  <td class="num ${group.totals.attainment != null && group.totals.attainment >= 1 ? 'positive' : 'negative'}">${escapeHtml(formatPercentValue(group.totals.attainment))}</td>
                  <td class="num ${group.totals.gap >= 0 ? 'positive' : 'negative'}">${escapeHtml(formatSignedCurrencyValue(group.totals.gap))}</td>
                </tr>
              </tfoot>
            </table>
          </article>
        `).join('')}
      </section>
    `).join('')
    : `
      <section class="times-pdf-page table-page">
        <div class="table-empty">Sem dados de assessores para exportar.</div>
      </section>
    `

  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(filename)}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      color: #e8f2ff;
      background: #060c16;
    }
    h1, h2, h3, p { margin: 0; }
    .times-pdf-page {
      padding: 4mm;
      min-height: 185mm;
      background:
        radial-gradient(circle at 12% 18%, rgba(40, 242, 230, 0.1), transparent 35%),
        radial-gradient(circle at 84% 8%, rgba(166, 107, 255, 0.14), transparent 34%),
        #070f1e;
      border: 1px solid rgba(126, 167, 255, 0.24);
      border-radius: 12px;
      margin: 0 0 8mm;
    }
    .page-break { page-break-after: always; break-after: page; }
    .first-page { page-break-after: always; break-after: page; }
    .report-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .report-head h1 { font-size: 20px; }
    .report-head small { color: #9cb0cb; font-size: 12px; }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 10px 0 12px;
    }
    .filter-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border-radius: 999px;
      border: 1px solid rgba(145, 195, 255, 0.3);
      background: rgba(255, 255, 255, 0.04);
      font-size: 11px;
    }
    .filter-pill b { color: #d8ecff; }
    .filter-pill em { color: #9cb0cb; font-style: normal; }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .kpi-card {
      border-radius: 10px;
      padding: 9px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      min-height: 70px;
      display: grid;
      gap: 5px;
      align-content: start;
    }
    .kpi-card small {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: rgba(237, 246, 255, 0.95);
    }
    .kpi-card strong {
      font-size: 24px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: 0.01em;
      font-variant-numeric: tabular-nums lining-nums;
      font-family: "Consolas", "Courier New", monospace;
      color: #f8fbff;
    }
    .kpi-details {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 2px 8px;
    }
    .kpi-details span {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      font-size: 10px;
      color: #dff7ff;
    }
    .kpi-details b { font-weight: 700; }
    .kpi-details em {
      font-style: normal;
      font-family: "Consolas", "Courier New", monospace;
      font-variant-numeric: tabular-nums lining-nums;
    }
    .tone-cyan { background: linear-gradient(140deg, rgba(36, 62, 90, 0.95), rgba(43, 175, 232, 0.6)); }
    .tone-blue { background: linear-gradient(140deg, rgba(44, 54, 110, 0.95), rgba(88, 178, 255, 0.64)); }
    .tone-amber { background: linear-gradient(140deg, rgba(66, 54, 44, 0.95), rgba(255, 179, 84, 0.62)); }
    .tone-violet { background: linear-gradient(140deg, rgba(68, 30, 86, 0.95), rgba(140, 94, 255, 0.72)); }
    .tone-emerald { background: linear-gradient(140deg, rgba(22, 59, 58, 0.96), rgba(45, 186, 168, 0.65)); }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .chart-card {
      border-radius: 10px;
      border: 1px solid rgba(126, 167, 255, 0.2);
      background: rgba(7, 18, 32, 0.9);
      padding: 8px;
      min-height: 78mm;
      display: grid;
      align-content: start;
      gap: 8px;
    }
    .chart-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .chart-head h3 { font-size: 14px; }
    .chart-head span { font-size: 11px; color: #9cb0cb; }
    .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 6px;
    }
    .row-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 7px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
    }
    .row-item.empty { color: #9cb0cb; font-size: 11px; }
    .row-item .left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .badge-rank {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      font-size: 10px;
      font-weight: 700;
      color: #071525;
      background: linear-gradient(135deg, rgba(40, 242, 230, 0.9), rgba(166, 107, 255, 0.9));
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      box-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
      flex-shrink: 0;
    }
    .stack {
      display: grid;
      min-width: 0;
    }
    .stack b {
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .stack small {
      font-size: 10px;
      color: #99aecd;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row-item > strong {
      font-family: "Consolas", "Courier New", monospace;
      font-size: 11px;
      font-variant-numeric: tabular-nums lining-nums;
      color: #f4f8ff;
      white-space: nowrap;
    }
    .bar-row {
      display: grid;
      gap: 4px;
      padding: 6px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
    }
    .bar-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-size: 11px;
    }
    .bar-head span { color: #c2d8f3; }
    .track {
      height: 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.1);
      overflow: hidden;
    }
    .track span {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(40, 242, 230, 0.95), rgba(166, 107, 255, 0.82));
    }
    .bar-row small {
      font-size: 10px;
      color: #9cb0cb;
    }
    .bar-meta {
      display: grid;
      gap: 1px;
    }
    .bar-empty {
      color: #9cb0cb;
      font-size: 11px;
      padding: 6px;
    }
    .gap-wrap {
      display: grid;
      grid-template-columns: 92px 1fr;
      align-items: center;
      gap: 8px;
    }
    .gap-pie {
      width: 82px;
      height: 82px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: conic-gradient(${gapGradient});
      box-shadow: 0 0 18px rgba(110, 140, 255, 0.22);
      justify-self: center;
    }
    .table-page-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .table-page-head h2 { font-size: 16px; }
    .table-page-head span { color: #a9bdd8; font-size: 12px; }
    .team-block {
      border: 1px solid rgba(126, 167, 255, 0.24);
      border-radius: 10px;
      margin-bottom: 8px;
      background: rgba(7, 17, 30, 0.92);
      page-break-inside: avoid;
      break-inside: avoid;
      overflow: hidden;
    }
    .team-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: linear-gradient(120deg, rgba(40, 242, 230, 0.14), rgba(166, 107, 255, 0.12));
      border-bottom: 1px solid rgba(126, 167, 255, 0.2);
    }
    .team-head h3 { font-size: 13px; }
    .team-head span { font-size: 11px; color: #abc2de; }
    .team-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10.4px;
    }
    .team-table th,
    .team-table td {
      padding: 6px 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      text-align: center;
      white-space: nowrap;
    }
    .team-table th {
      font-size: 9.4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #d4e8ff;
      background: rgba(14, 25, 43, 0.98);
    }
    .team-table td.num {
      font-family: "Consolas", "Courier New", monospace;
      font-variant-numeric: tabular-nums lining-nums;
    }
    .team-table td.strong { font-weight: 700; color: #eff8ff; }
    .team-table td.positive { color: #85ffba; font-weight: 700; }
    .team-table td.negative { color: #ff9bb0; font-weight: 700; }
    .team-table tfoot td {
      font-weight: 700;
      border-top: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(22, 34, 54, 0.95);
    }
    .team-table .team-total-row td:first-child {
      text-align: left;
      padding-left: 10px;
      color: #d8ecff;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 9.4px;
    }
    .table-empty {
      padding: 14px;
      border-radius: 10px;
      border: 1px dashed rgba(255, 255, 255, 0.2);
      color: #9cb0cb;
      text-align: center;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <section class="times-pdf-page first-page">
    <header class="report-head">
      <div>
        <h1>${escapeHtml(title)}</h1>
      </div>
      ${generatedAt ? `<small>Gerado em ${escapeHtml(generatedAt)}</small>` : ''}
    </header>
    <div class="filters">${filtersHtml}</div>
    <section class="kpi-grid">${kpisHtml}</section>
    <section class="charts-grid">
      <article class="chart-card">
        <div class="chart-head">
          <h3>Top Assessores</h3>
          <span>Receita liquida</span>
        </div>
        <ul class="rows">${topAssessorsHtml}</ul>
      </article>
      <article class="chart-card">
        <div class="chart-head">
          <h3>Receita por Equipe</h3>
          <span>Receita x objetivo</span>
        </div>
        ${teamPerformanceHtml}
      </article>
      <article class="chart-card">
        <div class="chart-head">
          <h3>Atingimento por Senioridade</h3>
          <span>Senior, Pleno e Junior</span>
        </div>
        ${seniorityHtml}
      </article>
      <article class="chart-card">
        <div class="chart-head">
          <h3>GAP Objetivo</h3>
          <span>Acima e abaixo da meta</span>
        </div>
        <div class="gap-wrap">
          <div class="gap-pie"></div>
          <ul class="rows">${gapListHtml}</ul>
        </div>
      </article>
    </section>
  </section>
  ${tablePagesHtml}
</body>
</html>
`

  popup.document.write(html)
  popup.document.close()
  popup.focus()
  popup.print()
  return true
}

