const TEMPLATE_PATTERNS = [
  { id: 'rubi_black', patterns: ['RUBI BLACK'] },
  { id: 'rubi', patterns: ['RUBI', 'CUPOM PRE-FIXADO', 'CUPOM PRE FIXADO', 'CUPOM PREFIXADO'] },
  { id: 'smart_coupon', patterns: ['CUPOM RECORRENTE EUROPEIA', 'SMART COUPON'] },
  { id: 'cupom_recorrente', patterns: ['CUPOM RECORRENTE'] },
  { id: 'collar_ui_bidirecional', patterns: ['COLLAR UI BIDIRECIONAL', 'COLLAR BIDIRECIONAL'] },
  { id: 'doc_bidirecional', patterns: ['DOC BIDIRECIONAL'] },
  { id: 'collar_ui', patterns: ['COLLAR UI'] },
  { id: 'fence_ui', patterns: ['FENCE UI'] },
  { id: 'booster_ko', patterns: ['BOOSTER KO'] },
  { id: 'call_spread', patterns: ['CALL SPREAD'] },
  { id: 'put_spread', patterns: ['PUT SPREAD'] },
  { id: 'alocacao_protegida_sob_custodia', patterns: ['ALOCACAO PROTEGIDA SOB CUSTODIA'] },
  { id: 'alocacao_protegida', patterns: ['ALOCACAO PROTEGIDA'] },
  { id: 'financiamento_sob_custodia', patterns: ['FINANCIAMENTO SOB CUSTODIA'] },
  { id: 'financiamento', patterns: ['FINANCIAMENTO'] },
  { id: 'collar', patterns: ['COLLAR'] },
  { id: 'pop', patterns: ['POP'] },
  { id: 'call', patterns: [' CALL '] },
  { id: 'put', patterns: [' PUT '] },
]
const RUBI_LIKE_TEMPLATE_IDS = new Set(['rubi', 'rubi_black', 'smart_coupon'])

const FIELD_LABELS = {
  ticker: ['ATIVO', 'TICKER', 'UNDERLYING', 'PAPEL', 'BRASIL'],
  stockQuantity: ['QUANTIDADE BASE', 'QTDE BASE', 'QTD BASE', 'QUANTIDADE', 'QTDE', 'QTD', 'QUANTITY'],
  maturityDate: ['VENCIMENTO', 'MATURITY', 'DATA FINAL', 'ENCERRAMENTO', 'DATA DE ENCERRAMENTO'],
  termMonths: ['PRAZO', 'PRAZO TOTAL', 'TERM'],
  ticketMin: ['TICKET MINIMO', 'APLICACAO MINIMA', 'INVESTIMENTO MINIMO', 'VALOR MINIMO'],
  feeAai: ['FEE AAI', 'ROA AAI', 'ROA', 'FEE'],
  optionCostPct: ['PRECO DA OPERACAO', 'CUSTO DA OPCAO', 'CUSTO OPCAO', 'CUSTO'],
  startDownPct: ['INICIO DO GANHO NA QUEDA', 'START DOWN'],
  limitDownPct: ['LIMITE DA QUEDA', 'LIMIT DOWN'],
  maxGainPct: ['GANHO MAXIMO', 'RETORNO MAXIMO'],
  premiumPct: ['PREMIO PAGO', 'PREMIO'],
  protectionPct: ['PROTECAO DE CAPITAL', 'PROTECAO CAPITAL', 'CAPITAL PROTEGIDO'],
  barrierUpPct: ['BARREIRA DE ALTA', 'BARREIRA KO DE ALTA', 'BARREIRA UI DE ALTA', 'BARRIER UP'],
  capAfterPct: ['LIMITADOR APOS BARREIRA', 'LIMITADOR APOS KO', 'CAP APOS BARREIRA'],
  startUpPct: ['INICIO DO GANHO NA ALTA', 'START UP'],
  limitUpPct: ['LIMITE DA ALTA', 'LIMIT UP'],
  highCapPct: ['LIMITADOR DE ALTA', 'CAP DE ALTA'],
  partialProtectionPct: ['PROTECAO PARCIAL NA QUEDA'],
  downKoPct: ['BARREIRA KO DE BAIXA', 'KO BAIXA', 'BARREIRA DE BAIXA'],
  downGainPct: ['GANHO ADICIONAL NA QUEDA'],
  triggerUpPct: ['GATILHO PARA GANHO DOBRADO', 'TRIGGER DE ALTA'],
  highKoPct: ['BARREIRA UI DE ALTA', 'HIGH KO'],
  couponPct: ['CUPOM NOMINAL', 'CUPOM', 'COUPON'],
  downProtectionPct: ['COLCHAO DE PROTECAO NA QUEDA', 'PATAMAR DE PROTECAO NA QUEDA', 'PROTECAO NA QUEDA'],
  upTriggerPct: ['INICIO DA PARTICIPACAO NA ALTA'],
  upPartPct: ['PARTICIPACAO NA ALTA', 'PART ALTA'],
  downBarrierPct: ['BARREIRA KO DE BAIXA', 'BARREIRA DE BAIXA'],
}

const PERCENT_KEYS = new Set([
  'optionCostPct',
  'startDownPct',
  'limitDownPct',
  'maxGainPct',
  'premiumPct',
  'protectionPct',
  'barrierUpPct',
  'capAfterPct',
  'startUpPct',
  'limitUpPct',
  'highCapPct',
  'partialProtectionPct',
  'downKoPct',
  'downGainPct',
  'triggerUpPct',
  'highKoPct',
  'couponPct',
  'downProtectionPct',
  'upTriggerPct',
  'upPartPct',
  'downBarrierPct',
])

const normalizeText = (value) => {
  let base = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[•|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
  // Fix common OCR character confusions
  base = base
    .replace(/\bUL\b/g, 'UI')
    .replace(/\bU1\b/g, 'UI')
    .replace(/\bK0\b/g, 'KO')
    .replace(/\bKQ\b/g, 'KO')
  // Fix "CALL" misreads: OCR reads "ll" as "U", "11", "Il", "1l", etc.
  base = base
    .replace(/CA[U1I]{1,2}(?=\b|-|\s|$)/g, 'CALL')
    .replace(/CAIL\b/g, 'CALL')
    .replace(/CALI\b/g, 'CALL')
  // Fix OCR reading "0" as "O" before digits (e.g. "O,97" → "0,97")
  base = base.replace(/\bO([,.]\d)/g, '0$1')
  // Inject spaces between merged keywords (e.g. "VENDACALL" → "VENDA CALL")
  base = base
    .replace(/(COMPRA|VENDA|VENDIDA)(PUT|CALL)/g, '$1 $2')
    .replace(/(PUT|CALL)(STRIKE)/g, '$1 $2')
    .replace(/(STRIKE)(COMPRA|VENDA|VENDIDA)/g, '$1 $2')
  return base.replace(/\s+/g, ' ').trim()
}

const splitLines = (text, lines = []) => {
  const merged = [
    ...(Array.isArray(lines) ? lines : []),
    ...String(text || '').split(/\r?\n/),
  ]
  return merged
    .flatMap((line) => String(line || '').split(/[;|]/))
    .flatMap((line) => {
      // Split on circled numbers (①②③…) or numbered bullets like "1." "2."
      const stripped = line.replace(/[\u2460-\u2473\u24EA-\u24FF\u2776-\u2793]/g, '\n')
      return stripped.split(/\n/)
    })
    .flatMap((line) => {
      // Split when multiple Compra/Venda segments appear on the same line
      const parts = String(line || '').split(/(?=\b(?:COMPRA|VENDA|VENDIDA)\b)/i).filter(Boolean)
      return parts.length > 1 ? parts : [line]
    })
    .map((line) => normalizeText(line))
    .filter(Boolean)
}

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const parseLooseNumber = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const match = raw.match(/-?\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|-?\d+(?:[.,]\d+)?/)
  if (!match) return null
  let cleaned = match[0].replace(/\s+/g, '')
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    cleaned = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '')
  } else if (hasComma) {
    cleaned = cleaned.replace(',', '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const formatNumberInput = (value, digits = 2) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return ''
  const rounded = Number(parsed.toFixed(digits))
  const fixed = digits > 0 ? rounded.toFixed(digits) : String(Math.round(rounded))
  const normalized = fixed.replace('.', ',')
  return normalized.replace(/,00$/, '').replace(/(,\d)0$/, '$1')
}

const formatCurrencyInput = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return ''
  return `R$ ${parsed.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const formatDateInput = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const ddmmyyyy = raw.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/)
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  return ''
}

const extractAfterLabel = (line, labels = []) => {
  const normalizedLine = normalizeText(line)
  for (const label of labels) {
    const normalizedLabel = normalizeText(label)
    if (!normalizedLabel) continue
    const index = normalizedLine.indexOf(normalizedLabel)
    if (index < 0) continue
    return normalizedLine.slice(index + normalizedLabel.length).replace(/^[\s:=-]+/, '').trim()
  }
  return ''
}

const findLabelValue = (lines, labels = []) => {
  if (!labels.length) return ''
  const sortedLabels = [...labels].sort((left, right) => right.length - left.length)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const matchedLabel = sortedLabels.find((label) => normalizeText(line).includes(normalizeText(label)))
    if (!matchedLabel) continue
    const inlineValue = extractAfterLabel(line, [matchedLabel])
    if (inlineValue) return inlineValue
    const nextLine = normalizeText(lines[index + 1] || '')
    if (nextLine) return nextLine
  }
  return ''
}

const findTicker = (lines, fullText) => {
  const labeled = findLabelValue(lines, FIELD_LABELS.ticker)
  const labeledMatch = labeled.match(/\b[A-Z]{4}\d{1,2}\b/)
  if (labeledMatch) return labeledMatch[0]
  // Try parenthesized format like "Global X Copper Miners ETF (BCPX39)"
  const parenMatch = normalizeText(fullText).match(/\(([A-Z]{4}\d{1,2})\)/)
  if (parenMatch) return parenMatch[1]
  const fallback = normalizeText(fullText).match(/\b[A-Z]{4}\d{1,2}\b/)
  return fallback ? fallback[0] : ''
}

const findTemplateId = (fullText, currentTemplateId = '') => {
  const normalized = ` ${normalizeText(fullText)} `
  const matched = TEMPLATE_PATTERNS.find((entry) => (
    entry.patterns.some((pattern) => {
      const normalizedPattern = normalizeText(pattern)
      if (normalized.includes(` ${normalizedPattern} `)) return true
      const regex = new RegExp(`(?:^|[\\s-_/|()\\[\\]])${escapeRegex(normalizedPattern)}(?:$|[\\s-_/|()\\[\\]])`)
      return regex.test(normalized)
    })
  ))
  return matched?.id || currentTemplateId || ''
}

const extractFieldPatch = (lines) => {
  const patch = {}
  Object.entries(FIELD_LABELS).forEach(([key, labels]) => {
    const rawValue = findLabelValue(lines, labels)
    if (!rawValue) return
    if (key === 'ticker') {
      const tickerMatch = rawValue.match(/\b[A-Z]{4}\d{1,2}\b/)
      if (tickerMatch) patch[key] = tickerMatch[0]
      return
    }
    if (key === 'maturityDate') {
      const formatted = formatDateInput(rawValue)
      if (formatted) patch[key] = formatted
      return
    }
    if (key === 'ticketMin') {
      const parsed = parseLooseNumber(rawValue)
      if (parsed != null) patch[key] = formatCurrencyInput(parsed)
      return
    }
    if (key === 'feeAai') {
      const parsed = parseLooseNumber(rawValue)
      if (parsed != null) {
        // Preserve original precision — do not round
        const str = String(parsed).replace('.', ',')
        patch[key] = `${str}%`
      }
      return
    }
    if (key === 'stockQuantity') {
      const parsed = parseLooseNumber(rawValue)
      if (parsed != null) patch[key] = String(Math.round(parsed))
      return
    }
    if (key === 'termMonths') {
      const parsed = parseLooseNumber(rawValue)
      if (parsed != null) patch[key] = formatNumberInput(parsed, 1)
      return
    }
    if (PERCENT_KEYS.has(key)) {
      // Skip monetary values (R$) — percent fields should not contain currency amounts
      if (/R\s*\$/.test(rawValue)) return
      const parsed = parseLooseNumber(rawValue)
      if (parsed != null) patch[key] = formatNumberInput(parsed)
      return
    }
  })
  return patch
}

const extractReferencePrice = (lines, fullText) => {
  const labels = ['PRECO DE ENTRADA', 'PRECO ATUAL', 'PRECO', 'SPOT', 'REFERENCIA']
  const rawValue = findLabelValue(lines, labels)
  if (rawValue) {
    const parsed = parseLooseNumber(rawValue)
    if (parsed != null) return parsed
  }
  const fallbackMatch = normalizeText(fullText).match(/\b(?:SPOT|PRECO)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\b/)
  if (!fallbackMatch) return null
  return parseLooseNumber(fallbackMatch[1])
}

const extractOptionEntries = (lines) => {
  // First, ensure lines with both PUT and CALL are split into separate entries
  const expandedLines = lines.flatMap((rawLine) => {
    const line = normalizeText(rawLine)
    if (!line) return [rawLine]
    const hasPut = line.includes('PUT')
    const hasCall = line.includes('CALL')
    if (hasPut && hasCall) {
      // Split the line at each occurrence of COMPRA/VENDA followed by PUT/CALL
      const parts = line.split(/(?=(?:COMPRA|VENDA|VENDIDA)\s+(?:PUT|CALL))/i).filter(Boolean)
      if (parts.length > 1) return parts
    }
    return [rawLine]
  })

  const entries = expandedLines.reduce((acc, rawLine) => {
    const line = normalizeText(rawLine)
    if (!line) return acc
    if (!line.includes('CALL') && !line.includes('PUT')) return acc

    const optionType = line.includes('PUT') ? 'PUT' : 'CALL'
    const side = /\b(VENDA|VENDIDA|SHORT)\b/.test(line) ? 'short' : 'long'
    const barrierMatch = line.match(/\b(UI|UO|KI|KO|DI|DO)\b/)
    const barrierType = barrierMatch ? (barrierMatch[1] === 'DO' ? 'KO' : barrierMatch[1]) : ''

    const percentMatches = Array.from(line.matchAll(/(-?\d+(?:[.,]\d+)?)\s*%/g)).map((match) => ({
      value: parseLooseNumber(match[1]),
      index: match.index || 0,
    })).filter((match) => match.value != null)

    let strike = ''
    let barrierValue = ''
    let coupon = ''

    const strikeLabelMatch = line.match(/(?:STRIKE|EXERCICIO)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*%/)
    if (strikeLabelMatch) {
      strike = formatNumberInput(parseLooseNumber(strikeLabelMatch[1]))
    }

    if (!strike && percentMatches.length) {
      strike = formatNumberInput(percentMatches[0].value)
    }

    const barrierLabelMatch = line.match(/(?:BARREIRA|TRIGGER|GATILHO|UI|UO|KI|KO|DI|DO)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*%/)
    if (barrierLabelMatch) {
      barrierValue = formatNumberInput(parseLooseNumber(barrierLabelMatch[1]))
    } else if (barrierType && percentMatches.length > 1) {
      barrierValue = formatNumberInput(percentMatches[1].value)
    }

    const couponLabelMatch = line.match(/(?:CUPOM|COUPON|PREMIO)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*%/)
    if (couponLabelMatch) {
      coupon = formatNumberInput(parseLooseNumber(couponLabelMatch[1]))
    }

    const quantityMatch = line.match(/(?:QTD(?:E)?|QUANT(?:IDADE)?|X)\s*[:=]?\s*(\d{1,7})/)
    const quantity = quantityMatch ? String(Math.round(parseLooseNumber(quantityMatch[1]) || 0)) : ''

    acc.push({
      optionType,
      side,
      strike,
      barrierType,
      barrierValue,
      coupon,
      useCustomQuantity: Boolean(quantity),
      quantity,
    })
    return acc
  }, [])

  // Deduplicate options with the same type + side + strike + barrier
  const seen = new Set()
  return entries.filter((opt) => {
    const key = `${opt.optionType}-${opt.side}-${opt.strike}-${opt.barrierType}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Infer the strategy template purely from the option legs detected.
 * This is the PRIMARY template detection — the OCR text match is only a
 * fallback when no options are found.
 *
 * Mapping (ordered from most specific to least):
 *   PUT long (KO) + PUT long (UI) + CALL long (UO) + CALL short (UI) → doc_bidirecional
 *   PUT long + PUT long (KO) + CALL short (UI)                       → collar_ui_bidirecional
 *   CALL short (UI) + PUT short + PUT long                           → fence_ui
 *   PUT long (KO coupon)                                             → smart_coupon / cupom_recorrente
 *   PUT long (KO) + CALL short (KO)                                  → rubi
 *   PUT long + CALL short (UI)                                       → collar_ui
 *   PUT long + CALL short (KO)                                       → booster_ko (alt: call long + call short KO)
 *   CALL long + CALL short (KO)                                      → booster_ko
 *   CALL long + CALL short + PUT long                                → pop
 *   PUT long + CALL short (no barrier)                               → collar / alocacao_protegida
 *   PUT long + PUT short (no barrier)                                → put_spread
 *   CALL long + CALL short (no barrier)                              → call_spread
 *   single CALL short (no barrier)                                   → financiamento
 *   single CALL long                                                 → call
 *   single PUT long                                                  → put
 */
const refineTemplateFromOptions = (_rawTemplateId, options = []) => {
  if (!options.length) return _rawTemplateId
  const rawTemplateId = String(_rawTemplateId || '').trim().toLowerCase()

  const puts = options.filter((o) => o.optionType === 'PUT')
  const calls = options.filter((o) => o.optionType === 'CALL')
  const putsLong = puts.filter((o) => o.side === 'long')
  const putsShort = puts.filter((o) => o.side === 'short')
  const callsLong = calls.filter((o) => o.side === 'long')
  const callsShort = calls.filter((o) => o.side === 'short')

  const hasBarrier = (arr, type) => arr.some((o) => o.barrierType === type)
  const hasCoupon = (arr) => arr.some((o) => o.coupon)

  // 4-leg: doc_bidirecional
  if (options.length >= 4 && putsLong.length >= 2 && callsLong.length >= 1 && callsShort.length >= 1) {
    return 'doc_bidirecional'
  }

  // 3-leg patterns
  if (options.length >= 3) {
    // collar_ui_bidirecional: 2 puts long (one KO) + call short (UI)
    if (putsLong.length >= 2 && callsShort.length >= 1 && hasBarrier(callsShort, 'UI')) {
      return 'collar_ui_bidirecional'
    }
    // fence_ui: call short (UI) + put short + put long
    if (callsShort.length >= 1 && putsShort.length >= 1 && putsLong.length >= 1 && hasBarrier(callsShort, 'UI')) {
      return 'fence_ui'
    }
    // pop: call long + call short + put long (all no barrier)
    if (callsLong.length >= 1 && callsShort.length >= 1 && putsLong.length >= 1) {
      return 'pop'
    }
  }

  // 1-leg with coupon: smart_coupon / cupom_recorrente
  if (putsLong.length === 1 && calls.length === 0 && (hasBarrier(putsLong, 'KO') && hasCoupon(putsLong))) {
    return rawTemplateId === 'smart_coupon' ? 'smart_coupon' : 'cupom_recorrente'
  }

  // 2-leg: put long + call short
  if (putsLong.length >= 1 && callsShort.length >= 1) {
    const putKO = hasBarrier(putsLong, 'KO')
    const callKO = hasBarrier(callsShort, 'KO')
    const callUI = hasBarrier(callsShort, 'UI')
    // rubi / rubi_black: both KO
    if (putKO && callKO) return RUBI_LIKE_TEMPLATE_IDS.has(rawTemplateId) ? rawTemplateId : 'rubi'
    // collar_ui: call UI
    if (callUI) return 'collar_ui'
    // booster_ko: call KO (put no barrier)
    if (callKO && !putKO) return 'booster_ko'
    // collar / alocacao_protegida: no barriers
    return 'collar'
  }

  // 2-leg: call long + call short
  if (callsLong.length >= 1 && callsShort.length >= 1 && puts.length === 0) {
    if (hasBarrier(callsShort, 'KO')) return 'booster_ko'
    return 'call_spread'
  }

  // 2-leg: put long + put short
  if (putsLong.length >= 1 && putsShort.length >= 1 && calls.length === 0) {
    return 'put_spread'
  }

  // 1-leg: single call short (financiamento)
  if (callsShort.length === 1 && puts.length === 0 && callsLong.length === 0) {
    return 'financiamento'
  }

  // 1-leg: single call long
  if (callsLong.length === 1 && puts.length === 0 && callsShort.length === 0) {
    return 'call'
  }

  // 1-leg: single put long
  if (putsLong.length === 1 && calls.length === 0 && putsShort.length === 0) {
    if (hasBarrier(putsLong, 'KO')) return rawTemplateId === 'smart_coupon' ? 'smart_coupon' : 'cupom_recorrente'
    return 'put'
  }

  return _rawTemplateId
}

/**
 * Parse the "Objetivo" description text common in XP-style structured products.
 *
 * Business logic mapping:
 *  - "retorno pre-acordado de X%" or "cupom pre-acordado de X%"
 *    → couponPct = X (the call sell + put buy strike is at 100 + X%)
 *  - "barreira de desarme de Y%" (absolute, e.g. 82.47%)
 *    → downBarrierPct = 100 - Y (desvalorização, e.g. 17.53%)
 *  - "desvalorizacao de Z%" → downBarrierPct = Z (direct)
 *  - "protecao de P%" → protectionPct = P (put is at 100 - P%)
 *  - "barreira / em ate B%" (for upside) → barrierUpPct
 *  - "limitado a L%" → capAfterPct
 */
const extractObjectiveFields = (normalizedText) => {
  const patch = {}

  // Coupon / pre-agreed return: "retorno pre-acordado de 13.33%" or
  // "cupom pre-acordado/pre acordado de X%" or "cupom nominal de X%"
  const couponMatch = normalizedText.match(
    /(?:RETORNO|CUPOM)\s+(?:PRE[- ]?ACORDADO|PRE[- ]?FIXADO|NOMINAL)\s+(?:DE\s+)?(\d+(?:[.,]\d+)?)\s*%/
  )
  if (couponMatch) {
    const val = parseLooseNumber(couponMatch[1])
    if (val != null) patch.couponPct = formatNumberInput(val)
  }

  // Down barrier (absolute): "barreira de desarme de 82.47%"
  // Convert to desvalorização: downBarrierPct = 100 - absolute
  const barrierDesarmeMatch = normalizedText.match(
    /BARREIRA\s+(?:DE\s+)?DESARME\s+(?:DE\s+)?(\d+(?:[.,]\d+)?)\s*%/
  )
  if (barrierDesarmeMatch) {
    const absVal = parseLooseNumber(barrierDesarmeMatch[1])
    if (absVal != null && absVal > 0 && absVal < 100) {
      patch.downBarrierPct = formatNumberInput(100 - absVal)
    }
  }

  // Down barrier (direct desvalorização): "desvalorizacao de 17.53%"
  if (!patch.downBarrierPct) {
    const desvalMatch = normalizedText.match(
      /DESVALORIZACAO\s+(?:DE\s+)?(\d+(?:[.,]\d+)?)\s*%/
    )
    if (desvalMatch) {
      const val = parseLooseNumber(desvalMatch[1])
      if (val != null) patch.downBarrierPct = formatNumberInput(val)
    }
  }

  // Protection: "protecao de 10%" → put is at 90% (100 - 10)
  const protMatch = normalizedText.match(
    /PROTECAO\s+(?:DE\s+CAPITAL\s+(?:DE\s+)?|DE\s+)?(\d+(?:[.,]\d+)?)\s*%/
  )
  if (protMatch) {
    const val = parseLooseNumber(protMatch[1])
    if (val != null) patch.protectionPct = formatNumberInput(val)
  }

  // Upside barrier: "em ate XXX%" or "barreira de alta de XXX%"
  // If value > 100, convert from absolute to relative (e.g. 136.99% → 36.99%)
  const upBarrierMatch = normalizedText.match(
    /(?:EM\s+ATE|BARREIRA\s+(?:DE\s+)?(?:ALTA|UI)(?:\s+DE)?)\s+(\d+(?:[.,]\d+)?)\s*%/
  )
  if (upBarrierMatch) {
    const raw = parseLooseNumber(upBarrierMatch[1])
    if (raw != null) {
      patch.barrierUpPct = formatNumberInput(raw > 100 ? raw - 100 : raw)
    }
  }

  // Cap after barrier: "limitado a XX%"
  const capMatch = normalizedText.match(/LIMITADO\s+A\s+(\d+(?:[.,]\d+)?)\s*%/)
  if (capMatch) {
    const val = parseLooseNumber(capMatch[1])
    if (val != null) patch.capAfterPct = formatNumberInput(val)
  }

  return patch
}

/**
 * Extract additional fields from XP-style product cards.
 * Handles: standalone "Preco X%", objective description text with
 * couponPct, downBarrierPct, protectionPct, barrierUpPct, capAfterPct.
 */
const extractXpStyleFields = (lines, normalizedText, existingPatch) => {
  const patch = {}

  // Standalone "PRECO XX%" (operation cost, not reference price)
  if (!existingPatch.optionCostPct) {
    for (const rawLine of lines) {
      const line = normalizeText(rawLine)
      const m = line.match(/(?:^|\s)PRECO\s+(\d+(?:[.,]\d+)?)\s*%/)
      // Only match if the line does NOT look like a reference price label
      if (m && !/PRECO\s+(?:DE\s+ENTRADA|ATUAL|SPOT|DO\s+ATIVO)/i.test(line)) {
        patch.optionCostPct = formatNumberInput(parseLooseNumber(m[1]))
        break
      }
    }
  }

  // Parse Objetivo / descriptive text for structured product params
  const objectiveFields = extractObjectiveFields(normalizedText)
  Object.entries(objectiveFields).forEach(([key, value]) => {
    if (value && !existingPatch[key] && !patch[key]) {
      patch[key] = value
    }
  })

  return patch
}

/**
 * Synthesise option legs from the Objective text when no explicit
 * Compra/Venda option lines are found in the OCR text.
 *
 * For a "Cupom Pré-Fixado" / Rubi:
 *  - couponPct = 13.33 → strike = 113.33 → Venda Call 113.33% + Compra Put 113.33%
 *  - downBarrierPct = 17.53 → barrier at 82.47% → KO on the put
 *
 * For a protection structure:
 *  - protectionPct = 10 → put at 90% → Compra Put 90%
 */
const synthesizeOptionsFromObjective = (objectiveFields, templateId) => {
  const options = []
  const coupon = parseLooseNumber(objectiveFields.couponPct)
  const downBarrier = parseLooseNumber(objectiveFields.downBarrierPct)
  const protection = parseLooseNumber(objectiveFields.protectionPct)
  const normalizedTemplateId = String(templateId || '').trim().toLowerCase()

  if (coupon != null) {
    if (normalizedTemplateId === 'cupom_recorrente') {
      options.push({
        optionType: 'PUT',
        side: 'long',
        strike: '100',
        barrierType: downBarrier != null ? 'KO' : '',
        barrierValue: downBarrier != null ? formatNumberInput(100 - downBarrier) : '',
        coupon: formatNumberInput(coupon),
        useCustomQuantity: false,
        quantity: '',
      })
    } else {
      const strikePct = 100 + coupon
      const strikeStr = formatNumberInput(strikePct)
      const barrierValue = downBarrier != null ? formatNumberInput(100 - downBarrier) : ''
      const barrierType = downBarrier != null ? 'KO' : ''
      options.push({
        optionType: 'CALL',
        side: 'short',
        strike: strikeStr,
        barrierType,
        barrierValue,
        coupon: '',
        useCustomQuantity: false,
        quantity: '',
      })
      options.push({
        optionType: 'PUT',
        side: 'long',
        strike: strikeStr,
        barrierType,
        barrierValue,
        coupon: '',
        useCustomQuantity: false,
        quantity: '',
      })
    }
  } else if (protection != null) {
    // Protection structure: put at (100 - protection)
    const putStrike = formatNumberInput(100 - protection)
    options.push({
      optionType: 'PUT',
      side: 'long',
      strike: putStrike,
      barrierType: '',
      barrierValue: '',
      coupon: '',
      useCustomQuantity: false,
      quantity: '',
    })
  }

  return options
}

export const extractCardDataFromImageText = ({
  text = '',
  lines = [],
  currentTemplateId = '',
} = {}) => {
  const normalizedText = normalizeText(text)
  const preparedLines = splitLines(text, lines)
  const rawTemplateId = findTemplateId(normalizedText, currentTemplateId)
  const valuesPatch = extractFieldPatch(preparedLines)
  const ticker = findTicker(preparedLines, normalizedText)
  if (ticker) valuesPatch.ticker = ticker

  let options = extractOptionEntries(preparedLines)
  const referencePrice = extractReferencePrice(preparedLines, normalizedText)

  if (!valuesPatch.maturityDate) {
    const dateMatch = normalizedText.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/)
    if (dateMatch) {
      valuesPatch.maturityDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
    }
  }

  // Post-process: extract additional fields from XP-style card layouts
  const xpFields = extractXpStyleFields(preparedLines, normalizedText, valuesPatch)
  Object.entries(xpFields).forEach(([key, value]) => {
    if (value && !valuesPatch[key]) valuesPatch[key] = value
  })

  // If no explicit option legs were found but we have Objetivo-derived fields,
  // synthesise option legs so the card builds correctly.
  if (!options.length) {
    const allFields = { ...valuesPatch, ...xpFields }
    const synthetised = synthesizeOptionsFromObjective(allFields, rawTemplateId)
    if (synthetised.length) options = synthetised
  }

  const templateId = refineTemplateFromOptions(rawTemplateId, options)

  const filledKeys = Object.keys(valuesPatch)
  const warnings = []
  if (!normalizedText) warnings.push('Nenhum texto foi reconhecido na imagem.')
  if (!filledKeys.length && !options.length) warnings.push('Nao foi possivel identificar campos suficientes para preencher automaticamente.')

  return {
    templateId,
    valuesPatch,
    options,
    referencePrice,
    rawText: String(text || '').trim(),
    filledKeys,
    warnings,
  }
}
