import { useEffect, useMemo, useState } from 'react'

const normalize = (value) => {
  if (!value) return '/'
  const cleaned = value.startsWith('#') ? value.slice(1) : value
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`
}

export const useHashRoute = (fallback = '/') => {
  const [path, setPath] = useState(() => normalize(window.location.hash) || fallback)

  useEffect(() => {
    const handleChange = () => setPath(normalize(window.location.hash) || fallback)
    window.addEventListener('hashchange', handleChange)
    return () => window.removeEventListener('hashchange', handleChange)
  }, [fallback])

  const navigate = (next) => {
    const target = normalize(next)
    if (target === path) return
    window.location.hash = target
  }

  return useMemo(() => ({ path, navigate }), [path])
}
