const Icon = ({ name, size = 20 }) => {
  const props = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }

  switch (name) {
    case 'grid':
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      )
    case 'layers':
      return (
        <svg {...props}>
          <path d="M12 3 3 8l9 5 9-5-9-5Z" />
          <path d="M3 12l9 5 9-5" />
          <path d="M3 16l9 5 9-5" />
        </svg>
      )
    case 'trend':
      return (
        <svg {...props}>
          <path d="M3 17l6-6 4 4 7-7" />
          <path d="M14 8h7v7" />
        </svg>
      )
    case 'pulse':
      return (
        <svg {...props}>
          <path d="M3 12h4l2-5 4 10 2-5h5" />
        </svg>
      )
    case 'pen':
      return (
        <svg {...props}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      )
    case 'clock':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      )
    case 'link':
      return (
        <svg {...props}>
          <path d="M10 13a5 5 0 0 1 0-7l2-2a5 5 0 1 1 7 7l-1 1" />
          <path d="M14 11a5 5 0 0 1 0 7l-2 2a5 5 0 1 1-7-7l1-1" />
        </svg>
      )
    case 'user':
      return (
        <svg {...props}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      )
    case 'search':
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      )
    case 'eye':
      return (
        <svg {...props}>
          <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )
    case 'sliders':
      return (
        <svg {...props}>
          <path d="M4 6h10" />
          <path d="M4 18h10" />
          <path d="M14 6h6" />
          <path d="M14 18h6" />
          <circle cx="10" cy="6" r="2" />
          <circle cx="10" cy="18" r="2" />
        </svg>
      )
    case 'filter':
      return (
        <svg {...props}>
          <path d="M3 5h18" />
          <path d="M7 12h10" />
          <path d="M10 19h4" />
        </svg>
      )
    case 'sync':
      return (
        <svg {...props}>
          <path d="M21 12a9 9 0 0 1-15 6" />
          <path d="M3 12a9 9 0 0 1 15-6" />
          <path d="M3 4v5h5" />
          <path d="M21 20v-5h-5" />
        </svg>
      )
    case 'download':
      return (
        <svg {...props}>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      )
    case 'upload':
      return (
        <svg {...props}>
          <path d="M12 21V9" />
          <path d="m7 14 5-5 5 5" />
          <path d="M5 3h14" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...props}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      )
    case 'doc':
      return (
        <svg {...props}>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
          <path d="M14 3v6h6" />
        </svg>
      )
    case 'spark':
      return (
        <svg {...props}>
          <path d="m12 2 2.2 5.8L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-2.2L12 2Z" />
        </svg>
      )
    case 'menu':
      return (
        <svg {...props}>
          <path d="M3 6h18" />
          <path d="M3 12h18" />
          <path d="M3 18h18" />
        </svg>
      )
    case 'close':
      return (
        <svg {...props}>
          <path d="M6 6l12 12" />
          <path d="M6 18L18 6" />
        </svg>
      )
    case 'arrow-up':
      return (
        <svg {...props}>
          <path d="m12 5 6 6" />
          <path d="m12 5-6 6" />
          <path d="M12 5v14" />
        </svg>
      )
    case 'arrow-down':
      return (
        <svg {...props}>
          <path d="m12 19 6-6" />
          <path d="m12 19-6-6" />
          <path d="M12 5v14" />
        </svg>
      )
    case 'info':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 7h.01" />
        </svg>
      )
    case 'warning':
      return (
        <svg {...props}>
          <path d="M12 3 2 21h20L12 3Z" />
          <path d="M12 9v5" />
          <path d="M12 17h.01" />
        </svg>
      )
    case 'check':
      return (
        <svg {...props}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )
    case 'x':
      return (
        <svg {...props}>
          <path d="M18 6 6 18" />
          <path d="M6 6l12 12" />
        </svg>
      )
    default:
      return null
  }
}

export default Icon
