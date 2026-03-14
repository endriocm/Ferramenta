/* ---------------------------------------------------------------
 *  Performance instrumentation — pwr/src/services/perf.js
 *
 *  Activate:  localStorage.setItem('pwr:perf', '1')
 *  Deactivate: localStorage.removeItem('pwr:perf')
 *
 *  Usage:
 *    import { perf } from '../services/perf'
 *    const end = perf.start('venc:market:fetch')
 *    await doWork()
 *    end()                    // logs elapsed + returns ms
 *    end({ ops: 50 })         // logs with extras
 * --------------------------------------------------------------- */

const isEnabled = () => {
  try { return localStorage.getItem('pwr:perf') === '1' } catch { return false }
}

const fmt = (ms) => (ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`)

const history = new Map()

/**
 * Start a named timer. Returns a function to call when done.
 * @param {string} label  e.g. 'venc:compute:all'
 * @returns {(extras?: Record<string,any>) => number}  stop fn that returns elapsed ms
 */
const start = (label) => {
  const t0 = performance.now()
  return (extras) => {
    const elapsed = performance.now() - t0
    if (isEnabled()) {
      const parts = [`[perf] ${label}: ${fmt(elapsed)}`]
      if (extras) {
        for (const [k, v] of Object.entries(extras)) parts.push(`${k}=${v}`)
      }
      console.log(parts.join('  '))
    }
    // store in history for programmatic access
    if (!history.has(label)) history.set(label, [])
    const h = history.get(label)
    h.push({ elapsed, ts: Date.now(), extras })
    if (h.length > 50) h.shift()
    return elapsed
  }
}

/**
 * Wrap an async function with timing.
 */
const wrap = (label, fn) => async (...args) => {
  const end = start(label)
  try {
    const result = await fn(...args)
    end({ ok: true })
    return result
  } catch (err) {
    end({ ok: false, error: err?.message })
    throw err
  }
}

/**
 * Wrap a sync function with timing.
 */
const wrapSync = (label, fn) => (...args) => {
  const end = start(label)
  try {
    const result = fn(...args)
    end({ ok: true })
    return result
  } catch (err) {
    end({ ok: false, error: err?.message })
    throw err
  }
}

/**
 * Dump all recorded history to console.
 */
const dump = () => {
  const out = {}
  for (const [label, entries] of history) {
    const times = entries.map((e) => e.elapsed)
    out[label] = {
      count: times.length,
      avg: fmt(times.reduce((a, b) => a + b, 0) / times.length),
      min: fmt(Math.min(...times)),
      max: fmt(Math.max(...times)),
      last: fmt(times[times.length - 1]),
    }
  }
  console.table(out)
  return out
}

/**
 * Clear history.
 */
const clear = () => history.clear()

export const perf = { start, wrap, wrapSync, dump, clear, history }
