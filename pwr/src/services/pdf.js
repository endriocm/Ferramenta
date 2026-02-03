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

