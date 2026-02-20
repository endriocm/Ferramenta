const FALLBACK_DOWNLOAD_URL = 'https://ferramenta-updates-937506434821.s3.sa-east-1.amazonaws.com/win/Ferramenta%20Setup%20Latest.exe'
const FALLBACK_LATEST_YML_URL = 'https://ferramenta-updates-937506434821.s3.sa-east-1.amazonaws.com/win/latest.yml'

const parseLatestVersion = (rawText) => {
  const text = String(rawText || '')
  const version = text.match(/^\s*version:\s*["']?([^\r\n"']+)["']?/m)?.[1]?.trim()
  if (!version) return null
  return version
}

const resolveInitialDownloadUrl = () => {
  const firstLink = document.querySelector('[data-download-link]')
  if (firstLink instanceof HTMLAnchorElement && firstLink.href) {
    return firstLink.href
  }
  return FALLBACK_DOWNLOAD_URL
}

const normalizeDownloadUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return FALLBACK_DOWNLOAD_URL
  return raw
}

const resolveLatestYmlUrl = (downloadUrl) => {
  try {
    const parsed = new URL(downloadUrl)
    parsed.search = ''
    parsed.hash = ''
    parsed.pathname = parsed.pathname
      .replace(/\/Ferramenta%20Setup%20Latest\.exe$/i, '/latest.yml')
      .replace(/\/Ferramenta Setup Latest\.exe$/i, '/latest.yml')
    if (!/\/latest\.yml$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/[^/]*$/, '/latest.yml')
    }
    return parsed.toString()
  } catch {
    return FALLBACK_LATEST_YML_URL
  }
}

const setDownloadLinks = (downloadUrl) => {
  document.querySelectorAll('[data-download-link]').forEach((link) => {
    if (!(link instanceof HTMLAnchorElement)) return
    link.href = downloadUrl
  })
}

const setLatestVersionLabel = async (latestYmlUrl) => {
  const versionNode = document.getElementById('latest-version')
  if (!versionNode) return
  try {
    const response = await fetch(latestYmlUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error('latest-yml-unavailable')
    const text = await response.text()
    const version = parseLatestVersion(text)
    if (!version) throw new Error('latest-version-not-found')
    versionNode.textContent = `Versao disponivel: ${version}`
  } catch {
    versionNode.textContent = 'Versao disponivel: consultar instalador Latest'
  }
}

const setupReveal = () => {
  const nodes = Array.from(document.querySelectorAll('[data-reveal]'))
  if (!nodes.length) return

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    nodes.forEach((node) => node.classList.add('is-visible'))
    return
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return
      entry.target.classList.add('is-visible')
      observer.unobserve(entry.target)
    })
  }, {
    rootMargin: '0px 0px -80px 0px',
    threshold: 0.14,
  })

  nodes.forEach((node) => observer.observe(node))
}

const setupActiveNav = () => {
  const navLinks = Array.from(document.querySelectorAll('.site-nav a[href^="#"]'))
  if (!navLinks.length) return

  const sectionPairs = navLinks
    .map((link) => {
      const href = link.getAttribute('href') || ''
      const id = href.startsWith('#') ? href.slice(1) : ''
      const section = id ? document.getElementById(id) : null
      return section ? { id, section, link } : null
    })
    .filter(Boolean)

  if (!sectionPairs.length) return

  const setActiveById = (id) => {
    sectionPairs.forEach(({ id: sectionId, link }) => {
      const isActive = sectionId === id
      link.classList.toggle('is-active', isActive)
      if (isActive) {
        link.setAttribute('aria-current', 'location')
      } else {
        link.removeAttribute('aria-current')
      }
    })
  }

  let ticking = false
  const updateActiveOnScroll = () => {
    ticking = false
    const headerHeight = document.querySelector('.site-header')?.offsetHeight || 72
    const referenceY = window.scrollY + headerHeight + 30

    let activeId = sectionPairs[0].id
    for (const { id, section } of sectionPairs) {
      if (section.offsetTop <= referenceY) {
        activeId = id
      } else {
        break
      }
    }

    setActiveById(activeId)
  }

  const queueUpdate = () => {
    if (ticking) return
    ticking = true
    window.requestAnimationFrame(updateActiveOnScroll)
  }

  window.addEventListener('scroll', queueUpdate, { passive: true })
  window.addEventListener('resize', queueUpdate)

  navLinks.forEach((link) => {
    link.addEventListener('click', () => {
      const href = link.getAttribute('href') || ''
      if (!href.startsWith('#')) return
      const id = href.slice(1)
      if (!id) return
      setActiveById(id)
    })
  })

  queueUpdate()
}

const downloadUrl = normalizeDownloadUrl(resolveInitialDownloadUrl())
const latestYmlUrl = resolveLatestYmlUrl(downloadUrl)

setDownloadLinks(downloadUrl)
setupReveal()
setupActiveNav()
void setLatestVersionLabel(latestYmlUrl)
