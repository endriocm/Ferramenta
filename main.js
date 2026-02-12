const DOWNLOAD_URL = 'https://xeo22it86oecxkxw.public.blob.vercel-storage.com/updates/win/Ferramenta%20Setup%20Latest.exe'
const LATEST_YML_URL = 'https://xeo22it86oecxkxw.public.blob.vercel-storage.com/updates/win/latest.yml'

const setDownloadLinks = () => {
  document.querySelectorAll('[data-download-link]').forEach((link) => {
    if (!(link instanceof HTMLAnchorElement)) return
    link.href = DOWNLOAD_URL
  })
}

const parseLatestVersion = (rawText) => {
  const text = String(rawText || '')
  const version = text.match(/^\s*version:\s*["']?([^\r\n"']+)["']?/m)?.[1]?.trim()
  if (!version) return null
  return version
}

const setLatestVersionLabel = async () => {
  const versionNode = document.getElementById('latest-version')
  if (!versionNode) return
  try {
    const response = await fetch(LATEST_YML_URL, { cache: 'no-store' })
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

setDownloadLinks()
setupReveal()
void setLatestVersionLabel()
