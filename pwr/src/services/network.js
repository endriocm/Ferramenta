const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const fetchWithRetry = async (url, options = {}, config = {}) => {
  const {
    retries = 2,
    backoffMs = 400,
    backoffFactor = 2,
    timeoutMs = 8000,
  } = config

  let attempt = 0
  let delay = backoffMs
  let lastError = null

  while (attempt <= retries) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      const response = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timeout)
      return response
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      await sleep(delay)
      delay *= backoffFactor
      attempt += 1
    }
  }
  throw lastError
}
