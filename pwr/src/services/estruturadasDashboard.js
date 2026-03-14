import { normalizeDateKey } from '../utils/dateKey'
import { toNumber as parseNumberSafe } from '../utils/number'

const normalizeText = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const normalizeEstrutura = (value) => normalizeText(value)
  .replace(/\s+/g, ' ')

const isOptionStructure = (estrutura) => {
  const normalized = normalizeEstrutura(estrutura)
  return normalized === 'call'
    || normalized === 'put'
    || normalized === 'call spread'
    || normalized === 'put spread'
}

const buildKey = ({ codigoCliente, ativo, estrutura, vencimento, quantidade }) => {
  const cliente = normalizeText(codigoCliente)
  const ativoKey = normalizeText(ativo)
  const estruturaKey = normalizeEstrutura(estrutura)
  const venc = normalizeDateKey(vencimento)
  if (!cliente || !ativoKey || !estruturaKey || !venc) return ''
  const qty = quantidade != null ? String(quantidade) : ''
  return [cliente, ativoKey, estruturaKey, venc, qty].join('|')
}

export const buildVencimentoIndex = (rows) => {
  const index = new Map()
  const list = Array.isArray(rows) ? rows : []
  list.forEach((row) => {
    const quantidade = parseNumberSafe(row.quantidade ?? row.qtyBase ?? row.quantidadeAtual)
    const base = buildKey({
      codigoCliente: row.codigoCliente || row.cliente,
      ativo: row.ativo,
      estrutura: row.estrutura,
      vencimento: row.vencimento,
      quantidade,
    })
    if (base) index.set(base, row)
    const withoutQty = buildKey({
      codigoCliente: row.codigoCliente || row.cliente,
      ativo: row.ativo,
      estrutura: row.estrutura,
      vencimento: row.vencimento,
      quantidade: '',
    })
    if (withoutQty && !index.has(withoutQty)) index.set(withoutQty, row)
  })
  return index
}

export const buildEstruturadasDashboard = ({ entries = [], vencimentoIndex }) => {
  const filtered = Array.isArray(entries) ? entries : []
  const _INDEX = vencimentoIndex instanceof Map ? vencimentoIndex : new Map()

  let totalRevenue = 0
  let totalVolume = 0
  let exceptionsCount = 0
  let exceptionsMatched = 0
  let exceptionsFallback = 0
  const uniqueClients = new Set()
  const invalidRows = []
  const byEstrutura = new Map()

  filtered.forEach((entry, idx) => {
    const cliente = String(entry.codigoCliente || '').trim()
    if (cliente) uniqueClients.add(cliente)

    const comissao = parseNumberSafe(entry.comissao)
    if (comissao != null) totalRevenue += comissao

    const qty = parseNumberSafe(entry.quantidade)
    const precoCompra = parseNumberSafe(entry.precoCompra)
    const volume = qty != null && precoCompra != null ? qty * precoCompra : 0

    if ((qty == null || precoCompra == null) && volume === 0) {
      invalidRows.push(idx)
    }

    const volumeAbs = Math.abs(volume)
    totalVolume += volumeAbs
    const estruturaLabel = entry.estrutura || '—'
    if (isOptionStructure(entry.estrutura)) {
      exceptionsCount += 1
    } else {
      const current = byEstrutura.get(estruturaLabel) || { receita: 0, volume: 0, count: 0 }
      byEstrutura.set(estruturaLabel, {
        receita: current.receita + (comissao || 0),
        volume: current.volume + volumeAbs,
        count: current.count + 1,
      })
    }
  })

  const top5 = Array.from(byEstrutura.entries())
    .map(([estrutura, data]) => ({ estrutura, ...data }))
    .sort((a, b) => b.receita - a.receita)
    .slice(0, 5)

  return {
    kpis: {
      uniqueClients: uniqueClients.size,
      totalRevenue,
      totalVolume,
      totalEntries: filtered.length,
      exceptionsCount,
      exceptionsMatched,
      exceptionsFallback,
      invalidRows: invalidRows.length,
    },
    top5,
  }
}
