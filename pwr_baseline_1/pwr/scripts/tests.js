import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { normalizeDateKey } from '../src/utils/dateKey.js'

const require = createRequire(import.meta.url)
const { sumDividendsInRange } = require('../../api/lib/dividends.js')

const dateKey = normalizeDateKey('2026-01-28')
assert.equal(dateKey, '2026-01-28')
assert.equal(normalizeDateKey('28/01/2026'), '2026-01-28')

const sampleDividends = [
  { dataCom: '2026-01-05', amount: 0.1, type: 'DIVIDEND' },
  { dataCom: '2026-01-28', amount: 0.2, type: 'JCP' },
  { dataCom: '2026-02-02', amount: 0.3, type: 'DIVIDEND' },
]
const total = sumDividendsInRange(sampleDividends, '2026-01-01', '2026-01-31')
assert.ok(Math.abs(total - (0.1 + 0.2 * 0.85)) < 1e-9)

console.log('tests ok')
