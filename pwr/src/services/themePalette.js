const STORAGE_PREFIX = 'pwr.theme.palette.'
const DEFAULT_PALETTE_ID = 'aurora'

const DEFAULT_SURFACE = {
  bg: '#070b0f',
  bgElev: '#0f1520',
  bgPanel: 'rgba(17, 23, 33, 0.9)',
  bgSoft: 'rgba(20, 29, 41, 0.85)',
  stroke: 'rgba(255, 255, 255, 0.08)',
  text: '#f5f7fb',
  muted: '#9da9bf',
}

const mono = (id, label, base, tones = {}) => ({
  id,
  label,
  colors: {
    cyan: tones.cyan || base,
    violet: tones.violet || base,
    amber: tones.amber || base,
    blue: tones.blue || base,
    green: tones.green || base,
    red: tones.red || base,
  },
})

const PALETTES = [
  {
    id: 'aurora',
    label: 'Mix - Aurora (Padrao)',
    colors: {
      cyan: '#28f2e6',
      violet: '#a66bff',
      amber: '#ffb454',
      blue: '#4da3ff',
      green: '#34f5a4',
      red: '#ff4d6d',
    },
  },
  {
    id: 'ocean',
    label: 'Mix - Ocean',
    colors: {
      cyan: '#5bf7ff',
      violet: '#5b8dff',
      amber: '#ffd166',
      blue: '#36c8ff',
      green: '#3cf2c8',
      red: '#ff6b8d',
    },
  },
  {
    id: 'sunset',
    label: 'Mix - Sunset',
    colors: {
      cyan: '#ff9f68',
      violet: '#ff6fcf',
      amber: '#ffd56f',
      blue: '#ff8b6b',
      green: '#7af2b8',
      red: '#ff4f5e',
    },
  },
  {
    id: 'forest',
    label: 'Mix - Forest',
    colors: {
      cyan: '#58f2b0',
      violet: '#6de08a',
      amber: '#e6c56a',
      blue: '#4ed3a2',
      green: '#78ffb0',
      red: '#ff7a7a',
    },
  },
  {
    id: 'ice',
    label: 'Mix - Ice',
    colors: {
      cyan: '#9be9ff',
      violet: '#9dc4ff',
      amber: '#ffe9a8',
      blue: '#7bd5ff',
      green: '#b7ffd2',
      red: '#ff99b0',
    },
  },
  {
    id: 'cyberpunk',
    label: 'Mix - Cyberpunk',
    colors: {
      cyan: '#00ffd5',
      violet: '#ff4df2',
      amber: '#ffd54f',
      blue: '#2b9dff',
      green: '#5dff9c',
      red: '#ff4d7a',
    },
  },
  {
    id: 'magma',
    label: 'Mix - Magma',
    colors: {
      cyan: '#ff8a5b',
      violet: '#ff5db1',
      amber: '#ffcb57',
      blue: '#ff6f61',
      green: '#f4d35e',
      red: '#ff3f54',
    },
  },
  {
    id: 'sapphire-coral',
    label: 'Mix - Sapphire Coral',
    colors: {
      cyan: '#53e6ff',
      violet: '#7a8dff',
      amber: '#ffcd7a',
      blue: '#2f7bff',
      green: '#61f2c8',
      red: '#ff7b7b',
    },
  },
  {
    id: 'mint-lilac',
    label: 'Mix - Mint Lilac',
    colors: {
      cyan: '#6effdf',
      violet: '#c08bff',
      amber: '#f9d976',
      blue: '#87b6ff',
      green: '#7dffb2',
      red: '#ff88b8',
    },
  },
  {
    id: 'tropic',
    label: 'Mix - Tropic',
    colors: {
      cyan: '#39f0d8',
      violet: '#6a78ff',
      amber: '#ffc857',
      blue: '#00b3ff',
      green: '#4dff95',
      red: '#ff6b6b',
    },
  },
  {
    id: 'storm',
    label: 'Mix - Storm',
    colors: {
      cyan: '#6de5ff',
      violet: '#8e8bff',
      amber: '#d3b97a',
      blue: '#56a9ff',
      green: '#82e4bf',
      red: '#ff8a95',
    },
  },
  {
    id: 'neon-city',
    label: 'Mix - Neon City',
    colors: {
      cyan: '#31f6ff',
      violet: '#aa6dff',
      amber: '#ffd447',
      blue: '#4f84ff',
      green: '#61ff9b',
      red: '#ff4d87',
    },
  },
  mono('mono-cyan', 'Mono - Cyan', '#35f2e7', {
    violet: '#54dbff',
    amber: '#83e7ff',
    blue: '#2fd1ff',
    green: '#62ffd9',
    red: '#64c5ff',
  }),
  mono('mono-violet', 'Mono - Violet', '#a66bff', {
    cyan: '#9f8bff',
    amber: '#c295ff',
    blue: '#8b7bff',
    green: '#b6a3ff',
    red: '#c06dff',
  }),
  mono('mono-amber', 'Mono - Amber', '#ffbf47', {
    cyan: '#ffcc66',
    violet: '#ffd37a',
    blue: '#ffb347',
    green: '#ffe08f',
    red: '#ffa85c',
  }),
  mono('mono-green', 'Mono - Green', '#4ef2a6', {
    cyan: '#6ff2bd',
    violet: '#7de6b8',
    amber: '#9af6cb',
    blue: '#5fd4a7',
    red: '#49d99d',
  }),
  mono('mono-red', 'Mono - Red', '#ff5d7a', {
    cyan: '#ff7690',
    violet: '#ff8ba2',
    amber: '#ff9db0',
    blue: '#ff6f88',
    green: '#ff8299',
  }),
  {
    id: 'gold-noir',
    label: 'Gold Noir (Dourado/Preto/Cinza)',
    colors: {
      cyan: '#d4b05e',
      violet: '#9d9279',
      amber: '#f0c14b',
      blue: '#bfb69e',
      green: '#e2c774',
      red: '#b98f4f',
    },
    surface: {
      bg: '#060606',
      bgElev: '#101114',
      bgPanel: 'rgba(24, 24, 26, 0.92)',
      bgSoft: 'rgba(30, 30, 34, 0.88)',
      stroke: 'rgba(212, 176, 94, 0.24)',
      text: '#f6f1e6',
      muted: '#b9ae95',
    },
  },
]

const buildKey = (userKey) => `${STORAGE_PREFIX}${userKey || 'guest'}`

const hexToRgb = (hex) => {
  const raw = String(hex || '').replace('#', '').trim()
  if (raw.length !== 6) return '255, 255, 255'
  const r = Number.parseInt(raw.slice(0, 2), 16)
  const g = Number.parseInt(raw.slice(2, 4), 16)
  const b = Number.parseInt(raw.slice(4, 6), 16)
  if (![r, g, b].every(Number.isFinite)) return '255, 255, 255'
  return `${r}, ${g}, ${b}`
}

const getPaletteById = (paletteId) => (
  PALETTES.find((item) => item.id === String(paletteId || '').trim()) || PALETTES[0]
)

export const listThemePalettes = () => PALETTES.map((item) => ({ ...item }))

export const resolveThemePalette = (paletteId) => getPaletteById(paletteId)

export const loadThemePalette = (userKey) => {
  if (typeof window === 'undefined') return DEFAULT_PALETTE_ID
  try {
    const raw = localStorage.getItem(buildKey(userKey))
    if (!raw) return DEFAULT_PALETTE_ID
    return getPaletteById(raw).id
  } catch {
    return DEFAULT_PALETTE_ID
  }
}

export const saveThemePalette = (userKey, paletteId) => {
  const resolved = getPaletteById(paletteId).id
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(buildKey(userKey), resolved)
    } catch {
      // noop
    }
  }
  return resolved
}

const applySurface = (root, surfaceInput = {}) => {
  const surface = { ...DEFAULT_SURFACE, ...surfaceInput }
  root.style.setProperty('--bg', surface.bg)
  root.style.setProperty('--bg-elev', surface.bgElev)
  root.style.setProperty('--bg-panel', surface.bgPanel)
  root.style.setProperty('--bg-soft', surface.bgSoft)
  root.style.setProperty('--stroke', surface.stroke)
  root.style.setProperty('--text', surface.text)
  root.style.setProperty('--muted', surface.muted)
}

export const applyThemePalette = (paletteId) => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const palette = getPaletteById(paletteId)
  const { colors } = palette

  root.style.setProperty('--cyan', colors.cyan)
  root.style.setProperty('--violet', colors.violet)
  root.style.setProperty('--amber', colors.amber)
  root.style.setProperty('--blue', colors.blue)
  root.style.setProperty('--green', colors.green)
  root.style.setProperty('--red', colors.red)

  root.style.setProperty('--cyan-rgb', hexToRgb(colors.cyan))
  root.style.setProperty('--violet-rgb', hexToRgb(colors.violet))
  root.style.setProperty('--amber-rgb', hexToRgb(colors.amber))
  root.style.setProperty('--blue-rgb', hexToRgb(colors.blue))
  root.style.setProperty('--green-rgb', hexToRgb(colors.green))
  root.style.setProperty('--red-rgb', hexToRgb(colors.red))

  applySurface(root, palette.surface)
  root.dataset.neonPalette = palette.id
}
