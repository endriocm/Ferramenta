const normalizeHex = (value, fallback = '#000000') => {
  const raw = String(value || '').trim().toUpperCase()
  if (/^#[0-9A-F]{6}$/.test(raw)) return raw
  if (/^#[0-9A-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
  }
  return fallback
}

const hexToRgb = (value) => {
  const hex = normalizeHex(value)
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

const rgbToHex = ({ r, g, b }) => {
  const toHex = (value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase()
}

const mixHex = (left, right, ratio = 0.5) => {
  const blend = Math.max(0, Math.min(1, Number(ratio)))
  const a = hexToRgb(left)
  const b = hexToRgb(right)
  return rgbToHex({
    r: a.r + ((b.r - a.r) * blend),
    g: a.g + ((b.g - a.g) * blend),
    b: a.b + ((b.b - a.b) * blend),
  })
}

const rgba = (value, alpha) => {
  const safe = Math.max(0, Math.min(1, Number(alpha)))
  const rgb = hexToRgb(value)
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${safe.toFixed(3)})`
}

const relativeLuminance = (value) => {
  const { r, g, b } = hexToRgb(value)
  const channel = (sample) => {
    const base = sample / 255
    return base <= 0.03928 ? base / 12.92 : ((base + 0.055) / 1.055) ** 2.4
  }
  return (0.2126 * channel(r)) + (0.7152 * channel(g)) + (0.0722 * channel(b))
}

const contrastRatio = (left, right) => {
  const l1 = relativeLuminance(left)
  const l2 = relativeLuminance(right)
  const max = Math.max(l1, l2)
  const min = Math.min(l1, l2)
  return (max + 0.05) / (min + 0.05)
}

const pickTextColor = (background, preferred = []) => {
  const candidates = [
    ...preferred,
    '#F7FAFF',
    '#EAF1FB',
    '#EDEDED',
    '#1B2430',
    '#10141B',
    '#FFFFFF',
    '#000000',
  ]
  let best = '#FFFFFF'
  let bestScore = 0
  candidates.forEach((candidate) => {
    const safe = normalizeHex(candidate, '#FFFFFF')
    const score = contrastRatio(background, safe)
    if (score > bestScore) {
      best = safe
      bestScore = score
    }
  })
  return best
}

const paletteCatalog = [
  { id: 'material_dark', label: 'Material Dark', colors: ['#121212', '#1F1F1F', '#BB86FC', '#03DAC6'], description: 'Padrao moderno Android, contraste suave.' },
  { id: 'dracula', label: 'Dracula', colors: ['#282A36', '#44475A', '#BD93F9', '#FF79C6'], description: 'Famoso tema para programadores.' },
  { id: 'night_owl', label: 'Night Owl', colors: ['#011627', '#82AAFF', '#C792EA', '#ADDB67'], description: 'Fundo azul profundo, texto neon.' },
  { id: 'carbon', label: 'Carbon', colors: ['#191919', '#2D2D2D', '#4B4B4B', '#AAAAAA'], description: 'Tons de cinza industriais.' },
  { id: 'deep_space', label: 'Deep Space', colors: ['#0B0C10', '#1F2833', '#C5C6C7', '#66FCF1'], description: 'Tecnologico com ciano eletrico.' },
  { id: 'void', label: 'Void', colors: ['#000000', '#151515', '#333333', '#EDEDED'], description: 'Preto absoluto e minimalista.' },
  { id: 'hacker_green', label: 'Hacker Green', colors: ['#0D0208', '#003B46', '#00FF00', '#32CD32'], description: 'Estilo terminal retro matrix.' },
  { id: 'slate_blue', label: 'Slate Blue', colors: ['#1A1A1D', '#4E4E50', '#6F2232', '#950740'], description: 'Sobrio com acento vinho.' },
  { id: 'midnight_app', label: 'Midnight App', colors: ['#101820', '#FEE715', '#F2AA4C', '#F2F2F2'], description: 'Fundo escuro com amarelo de alerta.' },
  { id: 'gunmetal', label: 'Gunmetal', colors: ['#2C3E50', '#34495E', '#ECF0F1', '#BDC3C7'], description: 'Azul acinzentado corporativo.' },
  { id: 'gold_standard', label: 'Gold Standard', colors: ['#000000', '#1C1C1C', '#D4AF37', '#F1C40F'], description: 'Preto elite com dourado puro.' },
  { id: 'royal_purple', label: 'Royal Purple', colors: ['#3B003B', '#5E005E', '#8F00FF', '#E0B0FF'], description: 'Realeza, misterio e riqueza.' },
  { id: 'champagne', label: 'Champagne', colors: ['#F7E7CE', '#E6D2B5', '#C0A080', '#8B5A2B'], description: 'Tons bege e nude chiques.' },
  { id: 'emerald_city', label: 'Emerald City', colors: ['#004028', '#006B42', '#00965E', '#50C878'], description: 'Verde joia profundo e serio.' },
  { id: 'platinum', label: 'Platinum', colors: ['#E5E4E2', '#C0C0C0', '#A9A9A9', '#808080'], description: 'Metalico, frio e valioso.' },
  { id: 'wine_roses', label: 'Wine & Roses', colors: ['#722F37', '#922B21', '#C0392B', '#E6B0AA'], description: 'Romantico, maduro e elegante.' },
  { id: 'marble_white', label: 'Marble White', colors: ['#FAFAFA', '#F5F5F5', '#E0E0E0', '#9E9E9E'], description: 'Estetica de arquitetura limpa.' },
  { id: 'copper_rust', label: 'Copper Rust', colors: ['#B87333', '#D2691E', '#8B4513', '#A0522D'], description: 'Metal envelhecido e quente.' },
  { id: 'velvet_night', label: 'Velvet Night', colors: ['#2C003E', '#512DA8', '#D1C4E9', '#B39DDB'], description: 'Roxo suave e noturno.' },
  { id: 'rich_mahogany', label: 'Rich Mahogany', colors: ['#420D09', '#800000', '#A52A2A', '#D2B48C'], description: 'Madeira classica e couro.' },
]

export const cardPalettes = paletteCatalog.map((palette) => ({
  ...palette,
  colors: palette.colors.map((color) => normalizeHex(color)),
}))

const cardPaletteMap = cardPalettes.reduce((acc, palette) => {
  acc[palette.id] = palette
  return acc
}, {})

export const getCardPaletteById = (paletteId) => cardPaletteMap[paletteId] || cardPaletteMap.gold_standard || cardPalettes[0]

export const buildCardPaletteStyles = (paletteInput) => {
  const palette = typeof paletteInput === 'string' ? getCardPaletteById(paletteInput) : (paletteInput || getCardPaletteById('gold_standard'))
  const [base, surface, accentA, accentB] = palette.colors
  const darkMode = relativeLuminance(base) < 0.42

  const textPrimary = pickTextColor(base, [accentB, accentA])
  const textSecondary = mixHex(textPrimary, base, darkMode ? 0.52 : 0.4)
  const border = darkMode ? mixHex(surface, textPrimary, 0.25) : mixHex(surface, '#B9C5D5', 0.45)
  const headerText = pickTextColor(surface, [textPrimary, accentB, accentA])

  const previewBackground = `radial-gradient(circle at 18% 16%, ${rgba(accentA, darkMode ? 0.22 : 0.26)}, transparent 38%), radial-gradient(circle at 80% 10%, ${rgba(accentB, darkMode ? 0.2 : 0.22)}, transparent 40%), linear-gradient(180deg, ${mixHex(base, surface, darkMode ? 0.25 : 0.55)}, ${mixHex(base, surface, darkMode ? 0.08 : 0.35)})`

  const xpVars = {
    '--xp-card-bg': `linear-gradient(180deg, ${darkMode ? mixHex(base, surface, 0.35) : mixHex('#FFFFFF', base, 0.1)} 0%, ${darkMode ? base : mixHex('#FFFFFF', surface, 0.14)} 100%)`,
    '--xp-card-text': textPrimary,
    '--xp-card-border': border,
    '--xp-card-shadow': darkMode ? '0 22px 44px rgba(0, 0, 0, 0.44)' : '0 22px 44px rgba(22, 31, 44, 0.24)',
    '--xp-head-bg': `linear-gradient(160deg, ${rgba(surface, darkMode ? 0.72 : 0.7)}, ${rgba(base, darkMode ? 0.66 : 0.26)})`,
    '--xp-head-border': rgba(textPrimary, darkMode ? 0.2 : 0.16),
    '--xp-subtitle': textSecondary,
    '--xp-metric-label': mixHex(textPrimary, surface, darkMode ? 0.46 : 0.54),
    '--xp-metric-value': textPrimary,
    '--xp-table-top': rgba(border, darkMode ? 0.82 : 0.9),
    '--xp-table-head-text': mixHex(headerText, surface, darkMode ? 0.25 : 0.45),
    '--xp-table-head-bg': darkMode ? mixHex(surface, '#000000', 0.2) : mixHex('#FFFFFF', surface, 0.15),
    '--xp-table-head-border': rgba(border, darkMode ? 0.75 : 0.8),
    '--xp-table-cell-text': textPrimary,
    '--xp-table-row-border': rgba(border, darkMode ? 0.62 : 0.68),
    '--xp-table-even-bg': darkMode ? rgba(surface, 0.42) : rgba(surface, 0.24),
    '--xp-dot-ring': darkMode ? rgba('#FFFFFF', 0.18) : rgba('#1C1F25', 0.16),
    '--xp-logo-bg': `linear-gradient(140deg, ${darkMode ? mixHex(base, '#FFFFFF', 0.08) : mixHex('#FFFFFF', base, 0.2)}, ${darkMode ? mixHex(surface, '#000000', 0.08) : mixHex('#FFFFFF', surface, 0.15)})`,
    '--xp-logo-border': rgba(border, darkMode ? 0.9 : 0.88),
    '--xp-logo-shadow': darkMode ? '0 5px 12px rgba(0, 0, 0, 0.34)' : '0 5px 12px rgba(23, 34, 46, 0.16)',
    '--xp-logo-img-bg': darkMode ? mixHex(base, surface, 0.3) : mixHex('#FFFFFF', surface, 0.22),
  }

  const offersVars = {
    '--offers-bg': `linear-gradient(180deg, ${darkMode ? mixHex(base, surface, 0.3) : mixHex('#FFFFFF', base, 0.08)} 0%, ${darkMode ? mixHex(base, '#000000', 0.06) : mixHex('#FFFFFF', surface, 0.1)} 100%)`,
    '--offers-text': textPrimary,
    '--offers-border': border,
    '--offers-shadow': darkMode ? '0 20px 42px rgba(0, 0, 0, 0.42)' : '0 20px 42px rgba(18, 28, 40, 0.22)',
    '--offers-header-bg': `linear-gradient(130deg, ${mixHex(base, accentA, 0.2)}, ${mixHex(surface, accentB, 0.2)})`,
    '--offers-header-text': pickTextColor(mixHex(base, surface, 0.2), [accentB, '#F5F8FF']),
    '--offers-card-bg': darkMode ? mixHex(surface, '#0C1016', 0.2) : mixHex('#FFFFFF', surface, 0.1),
    '--offers-card-border': rgba(border, darkMode ? 0.86 : 0.8),
    '--offers-subtitle': textSecondary,
    '--offers-time-label': mixHex(textSecondary, surface, darkMode ? 0.35 : 0.25),
    '--offers-item-bg': `linear-gradient(180deg, ${darkMode ? mixHex(surface, accentA, 0.16) : mixHex('#FFFFFF', accentA, 0.2)}, ${darkMode ? mixHex(surface, accentB, 0.12) : mixHex('#FFFFFF', accentB, 0.26)})`,
    '--offers-item-text': textPrimary,
    '--offers-footer-border': rgba(border, darkMode ? 0.8 : 0.72),
    '--offers-footer-label': mixHex(textSecondary, surface, darkMode ? 0.3 : 0.2),
    '--offers-footer-value': textPrimary,
    '--offers-time-bg': darkMode ? rgba(surface, 0.38) : rgba('#FFFFFF', 0.72),
    '--offers-time-border': rgba(border, darkMode ? 0.84 : 0.65),
    '--offers-item-border': rgba(border, darkMode ? 0.56 : 0.42),
    '--offers-logo-bg': `linear-gradient(145deg, ${darkMode ? mixHex(base, '#FFFFFF', 0.1) : mixHex('#FFFFFF', surface, 0.08)}, ${darkMode ? mixHex(surface, accentA, 0.14) : mixHex('#FFFFFF', accentA, 0.16)})`,
    '--offers-logo-border': rgba(border, darkMode ? 0.96 : 0.84),
    '--offers-logo-shadow': darkMode ? '0 12px 24px rgba(0, 0, 0, 0.4)' : '0 12px 24px rgba(14, 22, 34, 0.22)',
    '--offers-logo-img-bg': darkMode ? mixHex(base, surface, 0.28) : mixHex('#FFFFFF', surface, 0.24),
    '--offers-pill-bg': darkMode ? rgba(accentA, 0.24) : rgba(accentA, 0.2),
    '--offers-pill-text': pickTextColor(accentA, ['#FFFFFF', textPrimary, '#0F1720']),
  }

  return {
    preview: {
      background: previewBackground,
      borderColor: rgba(accentB, darkMode ? 0.44 : 0.26),
    },
    cardVars: {
      ...xpVars,
      ...offersVars,
    },
  }
}
