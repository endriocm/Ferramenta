const normalizeString = (value) => {
  if (value == null) return ''
  return String(value).trim().replace(/\s+/g, ' ')
}

export const normalizeAssessorName = (value, fallback = '') => {
  const raw = normalizeString(value)
  if (!raw || raw === '0') return fallback

  // Regras solicitadas: qualquer assessor com "f/F" no final deve desconsiderar esse sufixo.
  const withoutTrailingF = raw.replace(/\s*[fF]\s*$/, '').trim()
  if (!withoutTrailingF || withoutTrailingF === '0') return fallback

  return withoutTrailingF
}

