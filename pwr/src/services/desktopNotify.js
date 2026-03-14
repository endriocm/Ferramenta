export const canUseDesktopNotification = () => (
  typeof window !== 'undefined'
  && typeof window.Notification !== 'undefined'
)

export const requestDesktopPermission = async () => {
  if (!canUseDesktopNotification()) return 'unsupported'
  if (window.Notification.permission === 'granted') return 'granted'
  if (window.Notification.permission === 'denied') return 'denied'
  try {
    return await window.Notification.requestPermission()
  } catch {
    return window.Notification.permission || 'default'
  }
}

export const notifyDesktop = async ({
  title,
  body,
  tag,
  fallback,
}) => {
  const safeTitle = String(title || '').trim() || 'Nova notificacao'
  const safeBody = String(body || '').trim()
  const fallbackFn = typeof fallback === 'function' ? fallback : null

  if (!canUseDesktopNotification()) {
    if (fallbackFn) fallbackFn(safeTitle, safeBody)
    return { ok: false, via: 'fallback' }
  }

  const permission = await requestDesktopPermission()
  if (permission !== 'granted') {
    if (fallbackFn) fallbackFn(safeTitle, safeBody)
    return { ok: false, via: 'fallback' }
  }

  try {
    const n = new window.Notification(safeTitle, {
      body: safeBody,
      tag: tag ? String(tag) : undefined,
      silent: false,
    })
    n.onclick = () => {
      // sem acao de clique por requisito
    }
    return { ok: true, via: 'desktop' }
  } catch {
    if (fallbackFn) fallbackFn(safeTitle, safeBody)
    return { ok: false, via: 'fallback' }
  }
}
