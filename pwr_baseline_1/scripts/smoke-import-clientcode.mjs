import * as XLSX from 'xlsx'

const buildWorkbook = () => {
  const data = [
    ['X', 'Ativo', 'Data Registro', 'Vencimento', 'Quantidade'],
    ['00123', 'WEGE3', '28/02/2025', '19/12/2025', '200'],
  ]
  const ws = XLSX.utils.aoa_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Planilha')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

const main = async () => {
  const buffer = buildWorkbook()
  const form = new FormData()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  form.append('file', blob, 'smoke-clientcode.xlsx')

  const res = await fetch('http://localhost:4170/api/vencimentos/parse', {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    console.error('Falha na API', res.status)
    process.exit(1)
  }
  const data = await res.json()
  const first = data?.rows?.[0]
  console.log(JSON.stringify({
    codigoCliente: first?.codigoCliente,
    cliente: first?.cliente,
    ativo: first?.ativo,
    quantidade: first?.quantidade,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
