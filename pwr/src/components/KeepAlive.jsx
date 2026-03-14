import { memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'

/**
 * KeepAlive — caches rendered page components so that revisiting a route
 * doesn't remount the component from scratch. Pages that have already been
 * visited remain in the DOM (hidden via CSS `display:none`) and are instantly
 * shown again when revisited — avoiding expensive re-initialization
 * (localStorage parses, data loads, useMemo recalculations, etc.).
 *
 * An LRU-style eviction ensures memory stays bounded (default: 6 cached pages).
 */

const DEFAULT_MAX_CACHED = 3

const PageSlot = memo(({ isActive, children }) => (
  <div
    className="keep-alive-slot"
    style={{ display: isActive ? 'contents' : 'none' }}
    aria-hidden={!isActive}
  >
    {children}
  </div>
))

PageSlot.displayName = 'PageSlot'

const KeepAlive = ({ currentPath, getComponent, maxCached = DEFAULT_MAX_CACHED, fallback }) => {
  const [cachedRoutes, setCachedRoutes] = useState(() => new Map())
  const accessOrderRef = useRef([])

  const touchRoute = useCallback((path) => {
    const order = accessOrderRef.current
    const idx = order.indexOf(path)
    if (idx !== -1) order.splice(idx, 1)
    order.push(path)
  }, [])

  useEffect(() => {
    setCachedRoutes((prev) => {
      if (prev.has(currentPath)) {
        touchRoute(currentPath)
        return prev
      }

      const Component = getComponent(currentPath)
      const next = new Map(prev)
      next.set(currentPath, Component)
      touchRoute(currentPath)

      // Evict oldest if over limit
      const order = accessOrderRef.current
      while (next.size > maxCached && order.length > maxCached) {
        const oldest = order.shift()
        if (oldest !== currentPath) {
          next.delete(oldest)
        }
      }

      return next
    })
  }, [currentPath, getComponent, maxCached, touchRoute])

  const entries = []
  cachedRoutes.forEach((Component, path) => {
    entries.push(
      <PageSlot key={path} isActive={path === currentPath}>
        <Suspense fallback={fallback}>
          <Component />
        </Suspense>
      </PageSlot>,
    )
  })

  return <>{entries}</>
}

export default memo(KeepAlive)
