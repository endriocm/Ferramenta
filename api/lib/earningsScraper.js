/**
 * earningsScraper.js
 * Scrapes earnings calendar data from multiple external sources using Playwright.
 *
 * Sources:
 *   1. Investidor10  — Brazilian stocks
 *   2. StatusInvest  — Brazilian stocks
 *   3. EarningsHub   — US stocks
 *   4. Investing.com — Global (BR + US)
 *
 * Each scraper returns an array of { symbol, eventDate, companyName?, source }.
 * The master function merges all results into a Map<symbol, eventDate[]>.
 */

const SCRAPE_TIMEOUT = 30_000
const NAV_TIMEOUT = 25_000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/* ────────────── Playwright loader (shared pattern) ────────────── */

let _pwLoader = null

const getPlaywright = async () => {
  if (!_pwLoader) {
    _pwLoader = import('playwright')
      .catch(() => import('playwright-core'))
      .then((mod) => {
        if (!mod?.chromium?._browserType && !process.env.EARNINGS_BROWSER_CHANNEL) {
          process.env.EARNINGS_BROWSER_CHANNEL = 'msedge'
        }
        return mod
      })
      .catch(() => null)
  }
  const mod = await _pwLoader
  const chromium = mod?.chromium || mod?.default?.chromium
  return chromium || null
}

const launchBrowser = async () => {
  const chromium = await getPlaywright()
  if (!chromium) return null
  const headless = process.env.EARNINGS_HEADLESS !== 'false'
  const browser = await chromium.launch({
    headless,
    channel: process.env.EARNINGS_BROWSER_CHANNEL || undefined,
    args: ['--disable-dev-shm-usage', '--disable-gpu'],
  })
  return browser
}

const makePage = async (context) => {
  const page = await context.newPage()
  page.setDefaultTimeout(SCRAPE_TIMEOUT)
  // Block heavy resources
  await page.route(/\.(woff2?|ttf|eot|otf|mp4|webm|ogg|png|jpg|jpeg|gif|svg|ico)$/i, (r) => r.abort()).catch(() => null)
  await page.route(
    /google-analytics|googletagmanager|hotjar|segment|amplitude|mixpanel|facebook.*pixel|doubleclick|datadog|datadoghq/i,
    (r) => r.abort(),
  ).catch(() => null)
  return page
}

/* ────────────── Date helpers ────────────── */

const MONTHS_PT = {
  jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06',
  jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
}

const MONTHS_EN = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

const parsePortugueseDate = (text) => {
  // "28/03/2025" or "28 mar 2025" or "28 de março de 2025"
  const raw = String(text || '').trim().toLowerCase()
  // DD/MM/YYYY
  const slashMatch = raw.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/)
  if (slashMatch) {
    const [, d, m, y] = slashMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // "28 mar 2025"
  const wordMatch = raw.match(/(\d{1,2})\s+(?:de\s+)?([a-zçã]+)\.?\s+(?:de\s+)?(\d{4})/)
  if (wordMatch) {
    const [, d, monthWord, y] = wordMatch
    const monthKey = monthWord.slice(0, 3)
    const month = MONTHS_PT[monthKey]
    if (month) return `${y}-${month}-${d.padStart(2, '0')}`
  }
  return ''
}

const parseEnglishDate = (text) => {
  // "Feb 24" / "Feb 24, 2025" / "2025-02-24"
  const raw = String(text || '').trim().toLowerCase()
  // ISO
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  // "Feb 24, 2025" / "Feb 24 2025"
  const mdy = raw.match(/([a-z]{3})\s+(\d{1,2}),?\s*(\d{4})/)
  if (mdy) {
    const month = MONTHS_EN[mdy[1]]
    if (month) return `${mdy[3]}-${month}-${mdy[2].padStart(2, '0')}`
  }
  // "Feb 24" — assume current year
  const md = raw.match(/([a-z]{3})\s+(\d{1,2})/)
  if (md) {
    const month = MONTHS_EN[md[1]]
    if (month) return `${new Date().getFullYear()}-${month}-${md[2].padStart(2, '0')}`
  }
  // MM/DD/YYYY
  const usDate = raw.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/)
  if (usDate) return `${usDate[3]}-${usDate[1].padStart(2, '0')}-${usDate[2].padStart(2, '0')}`
  return ''
}

const normalizeSymbol = (raw) => {
  const s = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s || ''
}

const isValidDate = (dateStr) => {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const dt = new Date(`${dateStr}T12:00:00Z`)
  return !Number.isNaN(dt.getTime())
}

/* ────────────── 1. Investidor10 ────────────── */

const scrapeInvestidor10 = async (page) => {
  const results = []
  try {
    await page.goto('https://investidor10.com.br/acoes/agenda-resultados/', {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    })
    // Wait for the dynamic table/content to render
    await page.waitForSelector('table, .card-body, .agenda-item, [class*=result], [class*=calendar]', {
      timeout: 12_000,
    }).catch(() => null)
    // Extra wait for JS-rendered content
    await page.waitForTimeout(3000)

    const data = await page.evaluate(() => {
      const items = []

      // Strategy 1: Look for table rows with ticker + date
      const rows = document.querySelectorAll('table tbody tr')
      for (const row of rows) {
        const cells = row.querySelectorAll('td')
        if (cells.length < 2) continue
        const text = row.textContent || ''
        // Look for a ticker pattern (4-6 uppercase letters + 1-2 digits)
        const tickerMatch = text.match(/\b([A-Z]{4,6}\d{1,2})\b/)
        // Look for a date pattern DD/MM/YYYY or similar
        const dateMatch = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/)
        if (tickerMatch && dateMatch) {
          items.push({ symbol: tickerMatch[1], dateRaw: dateMatch[1], companyName: '' })
        }
      }

      // Strategy 2: Look for card/list items with class hints
      if (!items.length) {
        const cards = document.querySelectorAll('.card-body, .agenda-item, [class*=resultado], [class*=agenda]')
        for (const card of cards) {
          const text = card.textContent || ''
          const tickerMatch = text.match(/\b([A-Z]{4,6}\d{1,2})\b/)
          const dateMatch = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/)
          if (tickerMatch && dateMatch) {
            items.push({ symbol: tickerMatch[1], dateRaw: dateMatch[1], companyName: '' })
          }
        }
      }

      // Strategy 3: Brute-force scan the whole page
      if (!items.length) {
        const fullText = document.body?.innerText || ''
        const lines = fullText.split('\n')
        for (const line of lines) {
          const tickerMatch = line.match(/\b([A-Z]{4,6}\d{1,2})\b/)
          const dateMatch = line.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/)
          if (tickerMatch && dateMatch) {
            items.push({ symbol: tickerMatch[1], dateRaw: dateMatch[1], companyName: '' })
          }
        }
      }

      return items
    })

    for (const item of data) {
      const eventDate = parsePortugueseDate(item.dateRaw)
      if (isValidDate(eventDate)) {
        results.push({
          symbol: normalizeSymbol(item.symbol),
          eventDate,
          companyName: item.companyName || '',
          source: 'investidor10',
        })
      }
    }
  } catch (error) {
    console.warn('[earningsScraper] Investidor10 failed:', error?.message)
  }
  return results
}

/* ────────────── 2. StatusInvest ────────────── */

const scrapeStatusInvest = async (page) => {
  const results = []
  try {
    await page.goto('https://statusinvest.com.br/acoes/agenda-de-resultados', {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    })
    await page.waitForSelector('table, .list-item, [class*=result], [class*=calendar], [class*=agenda]', {
      timeout: 12_000,
    }).catch(() => null)
    await page.waitForTimeout(3000)

    const data = await page.evaluate(() => {
      const items = []

      // Strategy 1: Table with ticker/date
      const rows = document.querySelectorAll('table tbody tr')
      for (const row of rows) {
        const text = row.textContent || ''
        const tickerMatch = text.match(/\b([A-Z]{4,6}\d{1,2})\b/)
        const dateMatch = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/)
        if (tickerMatch && dateMatch) {
          items.push({ symbol: tickerMatch[1], dateRaw: dateMatch[1], companyName: '' })
        }
      }

      // Strategy 2: Card items or unique selectors for StatusInvest
      if (!items.length) {
        const entries = document.querySelectorAll('[class*=result], .list-item, .card, .d-flex, [class*=agenda]')
        for (const entry of entries) {
          const text = entry.textContent || ''
          const tickerMatch = text.match(/\b([A-Z]{4,6}\d{1,2})\b/)
          const dateMatch = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/)
          if (tickerMatch && dateMatch) {
            items.push({ symbol: tickerMatch[1], dateRaw: dateMatch[1], companyName: '' })
          }
        }
      }

      // Strategy 3: Full page scan
      if (!items.length) {
        const fullText = document.body?.innerText || ''
        const lines = fullText.split('\n')
        for (const line of lines) {
          const tickerMatch = line.match(/\b([A-Z]{4,6}\d{1,2})\b/)
          const dateMatch = line.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/)
          if (tickerMatch && dateMatch) {
            items.push({ symbol: tickerMatch[1], dateRaw: dateMatch[1], companyName: '' })
          }
        }
      }

      return items
    })

    for (const item of data) {
      const eventDate = parsePortugueseDate(item.dateRaw)
      if (isValidDate(eventDate)) {
        results.push({
          symbol: normalizeSymbol(item.symbol),
          eventDate,
          companyName: item.companyName || '',
          source: 'statusinvest',
        })
      }
    }
  } catch (error) {
    console.warn('[earningsScraper] StatusInvest failed:', error?.message)
  }
  return results
}

/* ────────────── 3. EarningsHub (US) ────────────── */

const scrapeEarningsHub = async (page) => {
  const results = []
  try {
    await page.goto('https://earningshub.com/earnings-list/this-week', {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    })
    // Wait for main content to load
    await page.waitForSelector('[class*=earning], [class*=Earning], table, .stock-row', {
      timeout: 12_000,
    }).catch(() => null)
    await page.waitForTimeout(3000)

    const data = await page.evaluate(() => {
      const items = []
      const fullText = document.body?.innerText || ''

      // EarningsHub format is laid out by day: "MON\n23\n" then "Before Open\n" / "After Close\n"
      // Then each earnings entry: "TICKER TIME $PRICE CHANGE Revenue $AMT PCT EPS $AMT PCT"
      // We need to figure out the full date from the week header like "FEB 23 - 27"

      // 1. Parse the week header to get month + year context
      const weekHeaderMatch = fullText.match(/([A-Z]{3})\s+(\d{1,2})\s*-\s*(\d{1,2})/)
      let baseMonth = ''
      let baseYear = new Date().getFullYear()
      if (weekHeaderMatch) {
        baseMonth = weekHeaderMatch[1] // e.g. "FEB"
      }

      // Month map
      const MONTH_MAP = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
      }

      // 2. Parse day sections - look for lines like "MON\n23" / "TUE\n24"
      // Split by day abbreviations
      const dayPattern = /(?:MON|TUE|WED|THU|FRI|SAT|SUN)\s*\n?\s*(\d{1,2})/g
      let lastDayNum = 0
      let lastMonthIndex = MONTH_MAP[baseMonth] ?? new Date().getMonth()

      // Find all day markers with their positions
      const dayMarkers = []
      let match
      while ((match = dayPattern.exec(fullText)) !== null) {
        dayMarkers.push({ pos: match.index, day: parseInt(match[1], 10) })
      }

      // For each day section, extract tickers
      for (let i = 0; i < dayMarkers.length; i++) {
        const start = dayMarkers[i].pos
        const end = i + 1 < dayMarkers.length ? dayMarkers[i + 1].pos : fullText.length
        const section = fullText.slice(start, end)
        const dayNum = dayMarkers[i].day

        // Handle month rollover
        if (dayNum < lastDayNum) {
          lastMonthIndex = (lastMonthIndex + 1) % 12
          if (lastMonthIndex === 0) baseYear++
        }
        lastDayNum = dayNum

        const monthStr = String(lastMonthIndex + 1).padStart(2, '0')
        const dayStr = String(dayNum).padStart(2, '0')
        const dateStr = `${baseYear}-${monthStr}-${dayStr}`

        // Extract tickers: pattern like "TSLA 6:05 PM" or just "TSLA" followed by time
        const tickerMatches = section.matchAll(/\b([A-Z]{1,5})\s+\d{1,2}:\d{2}\s*(?:AM|PM)/g)
        for (const tm of tickerMatches) {
          items.push({ symbol: tm[1], dateStr, companyName: '' })
        }
      }

      return items
    })

    // Deduplicate
    const seen = new Set()
    for (const item of data) {
      if (!item.symbol || !item.dateStr) continue
      const key = `${item.symbol}|${item.dateStr}`
      if (seen.has(key)) continue
      seen.add(key)
      if (isValidDate(item.dateStr)) {
        results.push({
          symbol: normalizeSymbol(item.symbol),
          eventDate: item.dateStr,
          companyName: item.companyName || '',
          source: 'earningshub',
        })
      }
    }
  } catch (error) {
    console.warn('[earningsScraper] EarningsHub failed:', error?.message)
  }
  return results
}

/* ─────── 3b. EarningsHub via plain fetch (fallback, no Playwright) ─────── */

const scrapeEarningsHubFetch = async () => {
  const results = []
  try {
    const response = await fetch('https://earningshub.com/earnings-list/this-week', {
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!response.ok) return results
    const html = await response.text()

    // Try to extract data from the raw HTML (works if SSR)
    // EarningsHub renders most content client-side, but let's try
    const weekMatch = html.match(/([A-Z]{3})\s+(\d{1,2})\s*[-–]\s*(\d{1,2})/)
    if (!weekMatch) return results

    const MONTH_MAP = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    }

    const baseMonthIdx = MONTH_MAP[weekMatch[1]] ?? new Date().getMonth()
    const year = new Date().getFullYear()

    // Try to find data in script/json payloads
    const jsonMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (jsonMatch) {
      try {
        const nextData = JSON.parse(jsonMatch[1])
        const earnings = nextData?.props?.pageProps?.earnings ||
          nextData?.props?.pageProps?.data?.earnings || []
        for (const entry of (Array.isArray(earnings) ? earnings : [])) {
          const sym = String(entry?.ticker || entry?.symbol || '').trim().toUpperCase()
          const dateRaw = entry?.date || entry?.earningsDate || entry?.reportDate || ''
          const eventDate = parseEnglishDate(dateRaw)
          if (sym && isValidDate(eventDate)) {
            results.push({ symbol: sym, eventDate, companyName: entry?.name || '', source: 'earningshub' })
          }
        }
      } catch { /* ignore JSON parse errors */ }
    }

    // Fallback: regex heuristic on raw HTML
    if (!results.length) {
      const tickerDatePattern = /\b([A-Z]{1,5})\s+\d{1,2}:\d{2}\s*(?:AM|PM)/g
      let m
      while ((m = tickerDatePattern.exec(html)) !== null) {
        // We don't have reliable date context from HTML alone, skip this fallback
      }
    }
  } catch (error) {
    console.warn('[earningsScraper] EarningsHub fetch fallback failed:', error?.message)
  }
  return results
}

/* ────────────── 4. Investing.com ────────────── */

const scrapeInvesting = async (page) => {
  const results = []
  try {
    // Investing.com heavily blocks bots; attempt with headful context
    await page.goto('https://br.investing.com/earnings-calendar/', {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    })
    // Wait for the calendar table to appear
    await page.waitForSelector('#earningsCalendarData, table.genTbl, [class*=earnings], [data-test=earnings]', {
      timeout: 15_000,
    }).catch(() => null)
    await page.waitForTimeout(3000)

    const data = await page.evaluate(() => {
      const items = []

      // Strategy 1: Known table structure (#earningsCalendarData)
      const rows = document.querySelectorAll('#earningsCalendarData tr, table.genTbl tbody tr')
      let currentDate = ''
      for (const row of rows) {
        // Date header rows typically have a theDay class or span with the date
        const dateHeader = row.querySelector('.theDay, td[colspan]')
        if (dateHeader) {
          const text = (dateHeader.textContent || '').trim()
          // "Quinta-feira, 27 de Fevereiro de 2025" or "27/02/2025"
          currentDate = text
          continue
        }

        const cells = row.querySelectorAll('td')
        if (cells.length < 2) continue

        // Look for company name and ticker
        const nameCell = row.querySelector('td a, .earnCalCompany, [class*=company]')
        const companyName = nameCell ? (nameCell.textContent || '').trim() : ''

        // Find ticker (usually in the text or a specific cell)
        const fullText = row.textContent || ''
        // On Investing.com BR, tickers appear in links or as "PETR4" in text
        const brTickerMatch = fullText.match(/\b([A-Z]{4,6}\d{1,2})\b/)
        const usTickerMatch = fullText.match(/\b([A-Z]{1,5})\b/)

        const ticker = brTickerMatch ? brTickerMatch[1] : (usTickerMatch ? usTickerMatch[1] : '')
        if (ticker && currentDate) {
          items.push({ symbol: ticker, dateRaw: currentDate, companyName })
        }
      }

      // Strategy 2: Generic table fallback
      if (!items.length) {
        const allRows = document.querySelectorAll('table tbody tr')
        for (const row of allRows) {
          const text = row.textContent || ''
          const brMatch = text.match(/\b([A-Z]{4,6}\d{1,2})\b/)
          const dateMatch = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/)
          || text.match(/(\d{4}-\d{2}-\d{2})/)
          if (brMatch && dateMatch) {
            items.push({ symbol: brMatch[1], dateRaw: dateMatch[1], companyName: '' })
          }
        }
      }

      return items
    })

    for (const item of data) {
      const eventDate = parsePortugueseDate(item.dateRaw) || parseEnglishDate(item.dateRaw)
      if (isValidDate(eventDate)) {
        results.push({
          symbol: normalizeSymbol(item.symbol),
          eventDate,
          companyName: item.companyName || '',
          source: 'investing',
        })
      }
    }
  } catch (error) {
    console.warn('[earningsScraper] Investing.com failed:', error?.message)
  }
  return results
}

/* ────────────── Cache layer ────────────── */

let _scrapeCache = {
  data: null,
  expiresAt: 0,
}
const SCRAPE_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

/** Mutex – prevents multiple simultaneous scrape runs */
let _scrapeRunning = null

/**
 * Return the last cached scrape result (even if expired), or null if never scraped.
 * This is used by earningsCalendar.js to avoid awaiting a slow scrape.
 */
const getLastScrapeResult = () => _scrapeCache.data || null

/* ────────────── Master scraper ────────────── */

/**
 * Scrape all external sources and return a merged map of { symbol → { eventDate, source, companyName }[] }.
 * Uses Playwright headless browser. Results are cached for 10 minutes.
 * If a scrape is already running, returns the running promise (deduplication).
 *
 * @param {{ force?: boolean }} options
 */
const scrapeAllEarningsSources = async ({ force = false } = {}) => {
  const now = Date.now()
  if (!force && _scrapeCache.data && _scrapeCache.expiresAt > now) {
    return _scrapeCache.data
  }

  // Deduplicate: if already running, return the same promise
  if (_scrapeRunning) return _scrapeRunning

  _scrapeRunning = _doScrape()
    .finally(() => { _scrapeRunning = null })

  return _scrapeRunning
}

const _doScrape = async () => {
  const allResults = []
  const sourceErrors = []
  let browser = null

  try {
    browser = await launchBrowser()

    if (browser) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent: USER_AGENT,
        ignoreHTTPSErrors: true,
        locale: 'pt-BR',
      })

      // Run scrapers sequentially to avoid overwhelming the browser
      const scrapers = [
        { name: 'investidor10', fn: scrapeInvestidor10 },
        { name: 'statusinvest', fn: scrapeStatusInvest },
        { name: 'earningshub', fn: scrapeEarningsHub },
        { name: 'investing', fn: scrapeInvesting },
      ]

      for (const scraper of scrapers) {
        try {
          const page = await makePage(context)
          const results = await scraper.fn(page)
          allResults.push(...results)
          console.log(`[earningsScraper] ${scraper.name}: ${results.length} entries`)
          await page.close().catch(() => null)
        } catch (error) {
          sourceErrors.push({ source: scraper.name, error: error?.message })
          console.warn(`[earningsScraper] ${scraper.name} error:`, error?.message)
        }
      }

      await context.close().catch(() => null)
    } else {
      // Playwright not available — try fetch-based fallbacks
      console.log('[earningsScraper] Playwright unavailable, using fetch fallbacks')
      const ehResults = await scrapeEarningsHubFetch()
      allResults.push(...ehResults)
      console.log(`[earningsScraper] earningshub (fetch): ${ehResults.length} entries`)
    }
  } catch (error) {
    console.warn('[earningsScraper] Master scraper error:', error?.message)
  } finally {
    if (browser) await browser.close().catch(() => null)
  }

  // Build merged map: symbol → array of { eventDate, source, companyName }
  const merged = new Map()
  for (const item of allResults) {
    if (!item.symbol || !item.eventDate) continue
    const key = item.symbol.toUpperCase()
    if (!merged.has(key)) merged.set(key, [])
    const entries = merged.get(key)
    // Avoid duplicate source+date combos
    const exists = entries.some((e) => e.eventDate === item.eventDate && e.source === item.source)
    if (!exists) {
      entries.push({
        eventDate: item.eventDate,
        source: item.source,
        companyName: item.companyName || '',
      })
    }
  }

  const result = {
    data: merged,
    sourceErrors,
    scrapedAt: new Date().toISOString(),
    totalEntries: allResults.length,
    sources: {
      investidor10: allResults.filter((r) => r.source === 'investidor10').length,
      statusinvest: allResults.filter((r) => r.source === 'statusinvest').length,
      earningshub: allResults.filter((r) => r.source === 'earningshub').length,
      investing: allResults.filter((r) => r.source === 'investing').length,
    },
  }

  _scrapeCache = { data: result, expiresAt: Date.now() + SCRAPE_CACHE_TTL }
  return result
}

/**
 * Given a symbol (display format, e.g. "PETR4" or "AAPL"), look up scraped dates.
 * Returns the best eventDate (closest future date) or null.
 */
const findScrapedDate = (scrapeResult, displaySymbol) => {
  if (!scrapeResult?.data) return null
  const key = String(displaySymbol || '').toUpperCase().replace(/\.SA$/, '')
  const entries = scrapeResult.data.get(key)
  if (!entries || !entries.length) return null

  const now = new Date().toISOString().slice(0, 10)

  // Prefer the closest future date
  const futureDates = entries
    .map((e) => e.eventDate)
    .filter((d) => d >= now)
    .sort()

  if (futureDates.length) return futureDates[0]

  // Fall back to most recent past date
  const allDates = entries.map((e) => e.eventDate).sort().reverse()
  return allDates[0] || null
}

/**
 * Get source attribution for a symbol's scraped date.
 */
const getScrapedSources = (scrapeResult, displaySymbol) => {
  if (!scrapeResult?.data) return []
  const key = String(displaySymbol || '').toUpperCase().replace(/\.SA$/, '')
  const entries = scrapeResult.data.get(key)
  if (!entries) return []
  return entries.map((e) => e.source)
}

module.exports = {
  scrapeAllEarningsSources,
  findScrapedDate,
  getScrapedSources,
  getLastScrapeResult,
}
