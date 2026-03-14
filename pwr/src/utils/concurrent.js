export const mapWithConcurrency = async (items, concurrency, worker) => {
  const queue = Array.isArray(items) ? [...items] : []
  if (!queue.length) return []
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, queue.length))
  const out = []
  const runWorker = async () => {
    while (queue.length) {
      const next = queue.shift()
      out.push(await worker(next))
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runWorker()))
  return out
}
