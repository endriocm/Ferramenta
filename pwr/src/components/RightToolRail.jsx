import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import Icon from './Icons'
import { useToast } from '../hooks/useToast'
import { notifyDesktop, requestDesktopPermission } from '../services/desktopNotify'
import { getCurrentUserKey, normalizeUserKey } from '../services/currentUser'
import {
  RIGHT_TOOL_ALARMS_ID,
  RIGHT_TOOL_OPEN_EVENT,
  pushAlarmNotification,
} from '../services/alarmNotifications'
import {
  fetchEarningsCalendar,
  filterItemsByRange,
  getTrackedEarningsSymbols,
  getWeekRanges,
} from '../services/earningsCalendar'

const buildEarningsLogoUrl = (symbol) => {
  const clean = String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '')
  if (!clean) return ''
  return `https://icons.brapi.dev/icons/${encodeURIComponent(clean)}.svg`
}

const EarningsLogo = memo(({ symbol, size = 16 }) => {
  const url = buildEarningsLogoUrl(symbol)
  const [error, setError] = useState(false)
  if (!url || error) return null
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="ticker-logo"
      onError={() => setError(true)}
    />
  )
})
EarningsLogo.displayName = 'EarningsLogo'

const TOOL_EARNINGS_WEEK = 'earnings_week'
const TOOL_ALARMS = RIGHT_TOOL_ALARMS_ID
const TOOL_CALCULATOR = 'calculator'
const TOOL_HP12C = 'calculator_hp12c'
const TOOL_FEE_LIQUID = 'fee_liquid'
const BACKSPACE_KEY = '\u232b'
const LEGACY_ALARM_STORAGE_KEY = 'pwr.right_tool_alarms'
const ALARM_STORAGE_KEY_PREFIX = 'pwr.right_tool_alarms.'
const ALARM_MODE_SOUND_NOTIFICATION = 'sound_notification'
const ALARM_MODE_NOTIFICATION_ONLY = 'notification_only'
const ALARM_MODE_OPTIONS = [
  { value: ALARM_MODE_SOUND_NOTIFICATION, label: 'Som + notificacao' },
  { value: ALARM_MODE_NOTIFICATION_ONLY, label: 'Somente notificacao' },
]
const ALARM_SCHEDULE_SPECIFIC = 'specific'
const ALARM_SCHEDULE_RECURRING = 'recurring'
const ALARM_SCHEDULE_OPTIONS = [
  { value: ALARM_SCHEDULE_SPECIFIC, label: 'Data especifica' },
  { value: ALARM_SCHEDULE_RECURRING, label: 'Recorrente' },
]
const ALARM_RECURRENCE_DAILY = 'daily'
const ALARM_RECURRENCE_WEEKDAYS = 'weekdays'
const ALARM_RECURRENCE_WEEKLY = 'weekly'
const ALARM_RECURRENCE_MONTHLY = 'monthly'
const ALARM_RECURRENCE_OPTIONS = [
  { value: ALARM_RECURRENCE_DAILY, label: 'Todo dia' },
  { value: ALARM_RECURRENCE_WEEKDAYS, label: 'Dias uteis' },
  { value: ALARM_RECURRENCE_WEEKLY, label: 'Semanal' },
  { value: ALARM_RECURRENCE_MONTHLY, label: 'Mensal' },
]
const ALARM_SOUND_CLASSIC = 'classic'
const ALARM_SOUND_DIGITAL = 'digital'
const ALARM_SOUND_SOFT = 'soft'
const ALARM_SOUND_OPTIONS = [
  { value: ALARM_SOUND_CLASSIC, label: 'Classico' },
  { value: ALARM_SOUND_DIGITAL, label: 'Digital' },
  { value: ALARM_SOUND_SOFT, label: 'Suave' },
]
const ALARM_WEEKDAY_OPTIONS = [
  { value: '0', label: 'Domingo' },
  { value: '1', label: 'Segunda' },
  { value: '2', label: 'Terca' },
  { value: '3', label: 'Quarta' },
  { value: '4', label: 'Quinta' },
  { value: '5', label: 'Sexta' },
  { value: '6', label: 'Sabado' },
]
const ACTIVE_ALARM_TRIGGERS = new Set()
const TOOL_ITEMS = [
  { id: TOOL_EARNINGS_WEEK, icon: 'calendar', label: 'Resultados da semana' },
  { id: TOOL_ALARMS, icon: 'clock', label: 'Alarmes' },
  { id: TOOL_CALCULATOR, icon: 'calculator', label: 'Calculadora' },
  { id: TOOL_HP12C, icon: 'calculator', label: 'HP12C' },
  { id: TOOL_FEE_LIQUID, icon: 'call-spread', label: 'Fee liquido' },
]

const OPERATORS = new Set(['+', '-', '*', '/'])

const HP12C_KEY_ROWS = [
  [
    { label: 'n', top: 'AMORT', bottom: '12x', action: 'N', topAction: 'AMORT', bottomAction: '12X' },
    { label: 'i', top: 'INT', bottom: '12D', action: 'I', topAction: 'INT', bottomAction: '12D' },
    { label: 'PV', top: 'NPV', bottom: 'CFo', action: 'PV', topAction: 'NPV', bottomAction: 'CF0' },
    { label: 'PMT', top: 'RND', bottom: 'CFj', action: 'PMT', topAction: 'RND', bottomAction: 'CFJ' },
    { label: 'FV', top: 'IRR', bottom: 'Nj', action: 'FV', topAction: 'IRR', bottomAction: 'NJ' },
    { label: 'CHS', top: 'RPN', bottom: 'DATE', action: 'CHS', topAction: 'RPN', bottomAction: 'DATE' },
    { label: '7', bottom: 'BEG', action: '7', bottomAction: 'BEG' },
    { label: '8', bottom: 'END', action: '8', bottomAction: 'END' },
    { label: '9', bottom: 'MEM', action: '9', bottomAction: 'MEM' },
    { label: '/', action: '/', tone: 'op' },
  ],
  [
    { label: 'y^x', top: 'PRICE', bottom: 'SQRT', action: 'Y^X', topAction: 'PRICE', bottomAction: 'SQRT' },
    { label: '1/x', top: 'YTM', bottom: 'e^x', action: '1/X', topAction: 'YTM', bottomAction: 'E^X' },
    { label: '%T', top: 'SL', bottom: 'LN', action: '%T', topAction: 'SL', bottomAction: 'LN' },
    { label: 'D%', top: 'SOYD', bottom: 'FRAC', action: 'D%', topAction: 'SOYD', bottomAction: 'FRAC' },
    { label: '%', top: 'DB', bottom: 'INTG', action: '%', topAction: 'DB', bottomAction: 'INTG' },
    { label: 'EEX', top: 'ALG', bottom: 'DDYS', action: 'EEX', topAction: 'ALG', bottomAction: 'DDYS' },
    { label: '4', bottom: 'D.MY', action: '4', bottomAction: 'D.MY' },
    { label: '5', bottom: 'M.DY', action: '5', bottomAction: 'M.DY' },
    { label: '6', bottom: 'x<>w', action: '6', bottomAction: 'X<>W' },
    { label: '*', bottom: 'x2', action: '*', bottomAction: 'X2', tone: 'op' },
  ],
  [
    { label: 'R/S', top: 'P/R', bottom: 'PSE', action: 'R/S', topAction: 'P/R', bottomAction: 'PSE' },
    { label: 'SST', top: 'S', bottom: 'BST', action: 'SST', topAction: 'S', bottomAction: 'BST' },
    { label: 'RDN', top: 'PRGM', bottom: 'GTO', action: 'RDN', topAction: 'PRGM', bottomAction: 'GTO' },
    { label: 'x<>y', top: 'FIN', bottom: 'x<=y', action: 'X<>Y', topAction: 'FIN', bottomAction: 'X<=Y' },
    { label: 'CLx', top: 'REG', bottom: 'x=0', action: 'CLX', topAction: 'REG', bottomAction: 'X=0' },
    { label: 'ENTER', top: 'PREFIX', action: 'ENTER', topAction: 'PREFIX', tone: 'enter', rowSpan: 2 },
    { label: '1', bottom: 'I,r', action: '1', bottomAction: 'I,R' },
    { label: '2', bottom: 'd,r', action: '2', bottomAction: 'D,R' },
    { label: '3', bottom: 'n!', action: '3', bottomAction: 'N!' },
    { label: '-', bottom: '<-', action: '-', bottomAction: 'BACK', tone: 'op' },
  ],
  [
    { label: 'ON', top: 'OFF', action: 'AC', topAction: 'OFF', tone: 'power' },
    { label: 'f', action: 'F', tone: 'fn-orange' },
    { label: 'g', action: 'G', tone: 'fn-blue' },
    { label: 'STO', bottom: '(', action: 'STO' },
    { label: 'RCL', bottom: ')', action: 'RCL' },
    { label: '0', bottom: 'x', action: '0', bottomAction: 'XBAR' },
    { label: '.', bottom: 's', action: '.', bottomAction: 'SDEV' },
    { label: 'S+', bottom: 'S-', action: 'S+', bottomAction: 'S-' },
    { label: '+', bottom: 'LST x', action: '+', bottomAction: 'LSTX', tone: 'op' },
  ],
]

const HP12C_KEYS = HP12C_KEY_ROWS.flat()
const HP_FINANCE_FIELDS = {
  N: 'n',
  I: 'i',
  PV: 'pv',
  PMT: 'pmt',
  FV: 'fv',
}
const HP_REGISTER_KEYS = new Set(Object.keys(HP_FINANCE_FIELDS))
const HP_MEMORY_DIGIT_KEYS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
const HP_SHIFT_LABELS = {
  f: 'f',
  g: 'g',
  STO: 'STO',
  RCL: 'RCL',
}

const canUseWindowNotification = () => (
  typeof window !== 'undefined'
  && typeof window.Notification !== 'undefined'
)

const buildAlarmStorageKey = (userKey) => `${ALARM_STORAGE_KEY_PREFIX}${normalizeUserKey(userKey, 'guest')}`

const safeParseAlarmJson = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const normalizeAlarmMode = (value) => (
  String(value || '').trim() === ALARM_MODE_NOTIFICATION_ONLY
    ? ALARM_MODE_NOTIFICATION_ONLY
    : ALARM_MODE_SOUND_NOTIFICATION
)

const normalizeAlarmScheduleType = (value) => (
  String(value || '').trim() === ALARM_SCHEDULE_RECURRING
    ? ALARM_SCHEDULE_RECURRING
    : ALARM_SCHEDULE_SPECIFIC
)

const normalizeAlarmRecurrence = (value) => {
  const normalized = String(value || '').trim()
  if (ALARM_RECURRENCE_OPTIONS.some((option) => option.value === normalized)) return normalized
  return ALARM_RECURRENCE_DAILY
}

const normalizeAlarmSound = (value) => {
  const normalized = String(value || '').trim()
  if (ALARM_SOUND_OPTIONS.some((option) => option.value === normalized)) return normalized
  return ALARM_SOUND_CLASSIC
}

const normalizeAlarmTime = (value) => {
  const raw = String(value || '').trim()
  return /^\d{2}:\d{2}$/.test(raw) ? raw : ''
}

const clampAlarmDayOfMonth = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '1'
  return String(Math.min(31, Math.max(1, Math.round(parsed))))
}

const normalizeAlarmWeekday = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '1'
  return String(Math.min(6, Math.max(0, Math.round(parsed))))
}

const parseAlarmTimeParts = (value) => {
  const raw = normalizeAlarmTime(value)
  if (!raw) return null
  const [hoursRaw, minutesRaw] = raw.split(':')
  const hours = Number(hoursRaw)
  const minutes = Number(minutesRaw)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return { hours, minutes }
}

const makeAlarmDate = (year, monthIndex, day, timeValue) => {
  const parts = parseAlarmTimeParts(timeValue)
  if (!parts) return null
  const date = new Date(year, monthIndex, day, parts.hours, parts.minutes, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

const resolveMonthDays = (year, monthIndex) => new Date(year, monthIndex + 1, 0).getDate()

const resolveNextRecurringOccurrenceAfter = (alarm, afterValue) => {
  const time = normalizeAlarmTime(alarm?.time)
  const recurrence = normalizeAlarmRecurrence(alarm?.recurrence)
  if (!time) return null

  const baseMs = Number.isFinite(Number(afterValue)) ? Number(afterValue) : Date.now()
  const base = new Date(baseMs)
  if (Number.isNaN(base.getTime())) return null
  const threshold = base.getTime() + 1000

  if (recurrence === ALARM_RECURRENCE_MONTHLY) {
    const preferredDay = Number(clampAlarmDayOfMonth(alarm?.dayOfMonth))
    for (let offset = 0; offset < 24; offset += 1) {
      const monthProbe = new Date(base.getFullYear(), base.getMonth() + offset, 1, 0, 0, 0, 0)
      const year = monthProbe.getFullYear()
      const monthIndex = monthProbe.getMonth()
      const day = Math.min(preferredDay, resolveMonthDays(year, monthIndex))
      const candidate = makeAlarmDate(year, monthIndex, day, time)
      if (candidate && candidate.getTime() > threshold) return candidate
    }
    return null
  }

  for (let offset = 0; offset < 370; offset += 1) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 0, 0, 0, 0)
    if (Number.isNaN(candidate.getTime())) continue
    const dayMatch = recurrence === ALARM_RECURRENCE_WEEKLY
      ? candidate.getDay() === Number(normalizeAlarmWeekday(alarm?.dayOfWeek))
      : true
    const isWeekday = candidate.getDay() !== 0 && candidate.getDay() !== 6
    if (!dayMatch) continue
    if (recurrence === ALARM_RECURRENCE_WEEKDAYS && !isWeekday) continue
    const resolved = makeAlarmDate(candidate.getFullYear(), candidate.getMonth(), candidate.getDate(), time)
    if (resolved && resolved.getTime() > threshold) return resolved
  }

  return null
}

const resolveNextAlarmDate = (alarm) => {
  if (!alarm?.enabled) return null
  if (normalizeAlarmScheduleType(alarm?.scheduleType) === ALARM_SCHEDULE_SPECIFIC) {
    const date = new Date(String(alarm?.datetime || '').trim())
    return Number.isNaN(date.getTime()) ? null : date
  }
  const lastTriggeredAt = new Date(String(alarm?.lastTriggeredAt || '').trim()).getTime()
  const createdAt = new Date(String(alarm?.createdAt || '').trim()).getTime()
  const reference = Number.isFinite(lastTriggeredAt)
    ? lastTriggeredAt
    : (Number.isFinite(createdAt) ? createdAt - 1000 : Date.now() - 1000)
  return resolveNextRecurringOccurrenceAfter(alarm, reference)
}

const resolveAlarmSortTime = (alarm) => {
  const nextDate = resolveNextAlarmDate(alarm)
  if (nextDate) return nextDate.getTime()
  const fallback = new Date(String(alarm?.triggeredAt || alarm?.datetime || alarm?.createdAt || '')).getTime()
  return Number.isFinite(fallback) ? fallback : Number.MAX_SAFE_INTEGER
}

const sortAlarms = (alarms = []) => (
  [...alarms].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
    return resolveAlarmSortTime(left) - resolveAlarmSortTime(right)
  })
)

const normalizeAlarm = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const scheduleType = normalizeAlarmScheduleType(raw.scheduleType)
  const datetime = String(raw?.datetime || '').trim()
  const base = {
    id: String(raw?.id || `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    message: String(raw?.message || '').trim(),
    mode: normalizeAlarmMode(raw?.mode),
    soundType: normalizeAlarmSound(raw?.soundType),
    enabled: raw?.enabled !== false,
    createdAt: String(raw?.createdAt || new Date().toISOString()).trim() || new Date().toISOString(),
    triggeredAt: raw?.triggeredAt ? String(raw.triggeredAt) : '',
    lastTriggeredAt: raw?.lastTriggeredAt ? String(raw.lastTriggeredAt) : '',
    scheduleType,
  }

  if (scheduleType === ALARM_SCHEDULE_RECURRING) {
    const time = normalizeAlarmTime(raw?.time || (datetime ? String(datetime).slice(11, 16) : ''))
    if (!time) return null
    return {
      ...base,
      datetime: '',
      recurrence: normalizeAlarmRecurrence(raw?.recurrence),
      time,
      dayOfWeek: normalizeAlarmWeekday(raw?.dayOfWeek),
      dayOfMonth: clampAlarmDayOfMonth(raw?.dayOfMonth),
    }
  }

  const targetTime = new Date(datetime).getTime()
  if (!datetime || !Number.isFinite(targetTime)) return null
  return {
    ...base,
    datetime,
    recurrence: ALARM_RECURRENCE_DAILY,
    time: normalizeAlarmTime(String(datetime).slice(11, 16)),
    dayOfWeek: normalizeAlarmWeekday(raw?.dayOfWeek),
    dayOfMonth: clampAlarmDayOfMonth(raw?.dayOfMonth),
  }
}

const readSavedAlarms = (userKey) => {
  if (typeof window === 'undefined') return []
  try {
    const storageKey = buildAlarmStorageKey(userKey)
    let raw = window.localStorage.getItem(storageKey)
    if (raw == null) {
      raw = window.localStorage.getItem(LEGACY_ALARM_STORAGE_KEY)
      if (raw != null) {
        window.localStorage.setItem(storageKey, raw)
      }
    }
    const parsed = safeParseAlarmJson(raw)
    if (!Array.isArray(parsed)) return []
    return sortAlarms(parsed.map((item) => normalizeAlarm(item)).filter(Boolean))
  } catch {
    return []
  }
}

const persistAlarms = (userKey, alarms) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(buildAlarmStorageKey(userKey), JSON.stringify(Array.isArray(alarms) ? alarms : []))
  } catch {
    // noop
  }
}

const formatAlarmDateTime = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value || '-')
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const resolveAlarmModeLabel = (mode) => {
  if (mode === ALARM_MODE_NOTIFICATION_ONLY) return 'Somente notificacao'
  return 'Som + notificacao'
}

const resolveAlarmSoundLabel = (soundType) => {
  const option = ALARM_SOUND_OPTIONS.find((item) => item.value === normalizeAlarmSound(soundType))
  return option?.label || 'Classico'
}

const resolveAlarmScheduleLabel = (alarm) => {
  if (!alarm) return '-'
  if (normalizeAlarmScheduleType(alarm.scheduleType) === ALARM_SCHEDULE_SPECIFIC) {
    return formatAlarmDateTime(alarm.datetime)
  }
  const time = normalizeAlarmTime(alarm.time) || '--:--'
  const recurrence = normalizeAlarmRecurrence(alarm.recurrence)
  if (recurrence === ALARM_RECURRENCE_WEEKDAYS) return `Dias uteis as ${time}`
  if (recurrence === ALARM_RECURRENCE_WEEKLY) {
    const weekday = ALARM_WEEKDAY_OPTIONS.find((item) => item.value === normalizeAlarmWeekday(alarm.dayOfWeek))?.label || 'Segunda'
    return `Toda ${weekday.toLowerCase()} as ${time}`
  }
  if (recurrence === ALARM_RECURRENCE_MONTHLY) {
    return `Todo dia ${clampAlarmDayOfMonth(alarm.dayOfMonth)} do mes as ${time}`
  }
  return `Todo dia as ${time}`
}

const buildAlarmTriggerToken = (alarmId, targetTime) => `${String(alarmId || '')}::${Number(targetTime) || 0}`

const clearAlarmTriggerTokens = (alarmId) => {
  const prefix = `${String(alarmId || '')}::`
  Array.from(ACTIVE_ALARM_TRIGGERS).forEach((token) => {
    if (token.startsWith(prefix)) ACTIVE_ALARM_TRIGGERS.delete(token)
  })
}

const playAlarmSound = async (soundType = ALARM_SOUND_CLASSIC) => {
  if (typeof window === 'undefined') return false
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) return false
  try {
    const context = new AudioContextClass()
    if (typeof context.resume === 'function') {
      await context.resume().catch(() => null)
    }
    const startAt = context.currentTime
    const normalizedSound = normalizeAlarmSound(soundType)
    const config = normalizedSound === ALARM_SOUND_DIGITAL
      ? { type: 'square', pattern: [0, 0.18, 0.36, 0.54], frequencies: [1240, 1040, 1240, 880], gain: 0.12, duration: 0.16 }
      : normalizedSound === ALARM_SOUND_SOFT
        ? { type: 'triangle', pattern: [0, 0.5, 1], frequencies: [523.25, 659.25, 783.99], gain: 0.1, duration: 0.34 }
        : { type: 'sine', pattern: [0, 0.42, 0.84], frequencies: [880, 660, 880], gain: 0.18, duration: 0.28 }
    config.pattern.forEach((offset, index) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = config.type
      oscillator.frequency.setValueAtTime(config.frequencies[index] || config.frequencies[0], startAt + offset)
      gain.gain.setValueAtTime(0.0001, startAt + offset)
      gain.gain.exponentialRampToValueAtTime(config.gain, startAt + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + config.duration)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(startAt + offset)
      oscillator.stop(startAt + offset + config.duration + 0.02)
    })
    window.setTimeout(() => {
      context.close().catch(() => null)
    }, 1800)
    return true
  } catch {
    return false
  }
}

const createHpMemoryRegisters = () => (
  Array.from({ length: 10 }).reduce((acc, _, index) => {
    acc[String(index)] = 0
    return acc
  }, {})
)

const nearZero = (value, epsilon = 1e-10) => Math.abs(Number(value) || 0) <= epsilon

const hpTvmEquation = ({ n, i, pv, pmt, fv }) => {
  if (!Number.isFinite(n) || !Number.isFinite(i) || !Number.isFinite(pv) || !Number.isFinite(pmt) || !Number.isFinite(fv)) {
    return NaN
  }
  const rate = i / 100
  if (rate <= -1) return NaN
  if (nearZero(rate)) return pv + (pmt * n) + fv
  const growth = (1 + rate) ** n
  if (!Number.isFinite(growth) || nearZero(growth)) return NaN
  const discount = 1 / growth
  const annuityFactor = (1 - discount) / rate
  return pv + (pmt * annuityFactor) + (fv * discount)
}

const solveHpBisection = (fn, low, high, iterations = 80) => {
  let left = Number(low)
  let right = Number(high)
  let leftValue = fn(left)
  let rightValue = fn(right)
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return null
  if (nearZero(leftValue)) return left
  if (nearZero(rightValue)) return right
  if (leftValue * rightValue > 0) return null

  for (let index = 0; index < iterations; index += 1) {
    const middle = (left + right) / 2
    const middleValue = fn(middle)
    if (!Number.isFinite(middleValue)) return null
    if (nearZero(middleValue)) return middle
    if (leftValue * middleValue <= 0) {
      right = middle
      rightValue = middleValue
    } else {
      left = middle
      leftValue = middleValue
    }
  }

  return (left + right) / 2
}

const solveHpRate = ({ n, pv, pmt, fv }) => {
  if (!Number.isFinite(n) || n <= 0) return null
  const equation = (ratePercent) => hpTvmEquation({
    n,
    i: ratePercent,
    pv,
    pmt,
    fv,
  })

  const samplePoints = [-99.99, -95, -90, -75, -50, -25, -10, -5, -2, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 2, 5, 10, 15, 25, 50, 75, 100, 150, 200, 300, 500]
  let previousPoint = samplePoints[0]
  let previousValue = equation(previousPoint)

  if (Number.isFinite(previousValue) && nearZero(previousValue)) return previousPoint

  for (let index = 1; index < samplePoints.length; index += 1) {
    const currentPoint = samplePoints[index]
    const currentValue = equation(currentPoint)
    if (!Number.isFinite(previousValue)) {
      previousPoint = currentPoint
      previousValue = currentValue
      continue
    }
    if (!Number.isFinite(currentValue)) {
      previousPoint = currentPoint
      previousValue = currentValue
      continue
    }
    if (nearZero(currentValue)) return currentPoint
    if (previousValue * currentValue < 0) {
      return solveHpBisection(equation, previousPoint, currentPoint)
    }
    previousPoint = currentPoint
    previousValue = currentValue
  }

  return null
}

const solveHpPeriods = ({ i, pv, pmt, fv }) => {
  if (!Number.isFinite(i)) return null
  const rate = i / 100
  if (rate <= -1) return null

  if (nearZero(rate)) {
    if (nearZero(pmt)) return null
    const result = -(pv + fv) / pmt
    return Number.isFinite(result) && result >= 0 ? result : null
  }

  if (nearZero(pmt)) {
    if (nearZero(pv)) return null
    const ratio = -fv / pv
    if (!(ratio > 0)) return null
    const growth = 1 + rate
    if (!(growth > 0) || nearZero(Math.log(growth))) return null
    const result = Math.log(ratio) / Math.log(growth)
    return Number.isFinite(result) && result >= 0 ? result : null
  }

  const equation = (periods) => hpTvmEquation({
    n: periods,
    i,
    pv,
    pmt,
    fv,
  })

  let low = 0
  let high = 1
  let lowValue = equation(low)
  let highValue = equation(high)

  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) return null
  if (nearZero(lowValue)) return 0
  if (nearZero(highValue)) return high

  while (lowValue * highValue > 0 && high < 12000) {
    low = high
    lowValue = highValue
    high *= 2
    highValue = equation(high)
    if (!Number.isFinite(highValue)) return null
    if (nearZero(highValue)) return high
  }

  if (lowValue * highValue > 0) return null
  return solveHpBisection(equation, low, high)
}

const solveHpFinancialValue = (registers, unknownKey) => {
  const normalizedKey = String(unknownKey || '').trim().toUpperCase()
  if (!HP_REGISTER_KEYS.has(normalizedKey)) return null

  const values = {
    n: Number(registers?.n),
    i: Number(registers?.i),
    pv: Number(registers?.pv),
    pmt: Number(registers?.pmt),
    fv: Number(registers?.fv),
  }

  const knownFields = Object.entries(HP_FINANCE_FIELDS)
    .filter(([key]) => key !== normalizedKey)
    .every(([, field]) => Number.isFinite(values[field]))

  if (!knownFields) return null

  if (normalizedKey === 'PV') {
    const rate = values.i / 100
    if (rate <= -1) return null
    if (nearZero(rate)) return -(values.pmt * values.n) - values.fv
    const growth = (1 + rate) ** values.n
    if (!Number.isFinite(growth) || nearZero(growth)) return null
    const discount = 1 / growth
    const annuityFactor = (1 - discount) / rate
    return -((values.pmt * annuityFactor) + (values.fv * discount))
  }

  if (normalizedKey === 'FV') {
    const rate = values.i / 100
    if (rate <= -1) return null
    if (nearZero(rate)) return -(values.pv + (values.pmt * values.n))
    const growth = (1 + rate) ** values.n
    if (!Number.isFinite(growth) || nearZero(growth)) return null
    const discount = 1 / growth
    const annuityFactor = (1 - discount) / rate
    return -((values.pv + (values.pmt * annuityFactor)) / discount)
  }

  if (normalizedKey === 'PMT') {
    const rate = values.i / 100
    if (rate <= -1) return null
    if (nearZero(rate)) {
      if (nearZero(values.n)) return null
      return -((values.pv + values.fv) / values.n)
    }
    const growth = (1 + rate) ** values.n
    if (!Number.isFinite(growth) || nearZero(growth)) return null
    const discount = 1 / growth
    const annuityFactor = (1 - discount) / rate
    if (nearZero(annuityFactor)) return null
    return -((values.pv + (values.fv * discount)) / annuityFactor)
  }

  if (normalizedKey === 'N') {
    return solveHpPeriods(values)
  }

  if (normalizedKey === 'I') {
    return solveHpRate(values)
  }

  return null
}

const calculate = (left, right, operator) => {
  const a = Number(left)
  const b = Number(right)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'Erro'

  if (operator === '+') return String(a + b)
  if (operator === '-') return String(a - b)
  if (operator === '*') return String(a * b)
  if (operator === '/') {
    if (b === 0) return 'Erro'
    return String(a / b)
  }
  return String(b)
}

const parseLocaleNumber = (value) => {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  let cleaned = raw.replace(/[\sR$]/g, '').replace(/%/g, '')
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.')
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const parsePercentFactor = (value) => {
  const parsed = parseLocaleNumber(value)
  if (parsed == null) return null
  if (Math.abs(parsed) > 1) return parsed / 100
  return parsed
}

const formatPercent = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  return num.toLocaleString('pt-BR', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

const formatDecimal = (value, digits = 6) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })
}

const formatDateLabel = (isoDate) => {
  if (!isoDate) return '-'
  const dt = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return isoDate
  return dt.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
  })
}

const formatCompactNumber = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  return num.toLocaleString('pt-BR', {
    notation: 'compact',
    maximumFractionDigits: 2,
  })
}

const formatHpValue = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return 'Erro'
  const abs = Math.abs(num)
  const useExp = (abs >= 1e11) || (abs > 0 && abs < 1e-9)
  if (useExp) return num.toExponential(6).replace('e+', 'e')
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  })
}

const normalizeHpEntry = (value) => {
  if (value == null) return ''
  let next = String(value).replace(',', '.').trim()
  if (next === '.') next = '0.'
  if (next === '-.') next = '-0.'
  return next
}

const createAlarmDraft = () => ({
  scheduleType: ALARM_SCHEDULE_SPECIFIC,
  datetime: '',
  recurrence: ALARM_RECURRENCE_DAILY,
  time: '09:00',
  dayOfWeek: '1',
  dayOfMonth: '1',
  message: '',
  mode: ALARM_MODE_SOUND_NOTIFICATION,
  soundType: ALARM_SOUND_CLASSIC,
})

const RightToolRail = () => {
  const { notify } = useToast()
  const currentUserKey = getCurrentUserKey()
  const [openTool, setOpenTool] = useState(null)
  const [display, setDisplay] = useState('0')
  const [pendingValue, setPendingValue] = useState(null)
  const [operator, setOperator] = useState(null)
  const [waitingForOperand, setWaitingForOperand] = useState(false)
  const [hpStack, setHpStack] = useState([0, 0, 0, 0]) // [x, y, z, t]
  const [hpEntry, setHpEntry] = useState('')
  const [hpError, setHpError] = useState('')
  const [hpShift, setHpShift] = useState('')
  const [hpMemoryMode, setHpMemoryMode] = useState('')
  const [hpFinance, setHpFinance] = useState({
    n: null,
    i: null,
    pv: null,
    pmt: null,
    fv: null,
  })
  const [hpMemory, setHpMemory] = useState(() => createHpMemoryRegisters())
  const [hpLastX, setHpLastX] = useState(0)
  const [feeInputs, setFeeInputs] = useState({
    spot: '',
    offer: '',
    paga: '',
  })
  const [earningsState, setEarningsState] = useState({
    loading: false,
    error: '',
    currentWeek: [],
    nextWeek: [],
    symbolsCount: 0,
    generatedAt: '',
  })
  const [alarmDraft, setAlarmDraft] = useState(() => createAlarmDraft())
  const [alarmState, setAlarmState] = useState(() => ({
    userKey: currentUserKey,
    items: readSavedAlarms(currentUserKey),
  }))
  const alarms = useMemo(() => {
    if (alarmState.userKey === currentUserKey) return alarmState.items
    return readSavedAlarms(currentUserKey)
  }, [alarmState.items, alarmState.userKey, currentUserKey])
  const setAlarms = useCallback((updater) => {
    setAlarmState((previous) => {
      const baseItems = previous.userKey === currentUserKey ? previous.items : readSavedAlarms(currentUserKey)
      const nextItems = typeof updater === 'function' ? updater(baseItems) : updater
      return {
        userKey: currentUserKey,
        items: Array.isArray(nextItems) ? nextItems : baseItems,
      }
    })
  }, [currentUserKey])
  const alarmPermission = canUseWindowNotification() ? (window.Notification.permission || 'default') : 'unsupported'

  const earningsToolOpen = openTool === TOOL_EARNINGS_WEEK
  const alarmsToolOpen = openTool === TOOL_ALARMS
  const calculatorOpen = openTool === TOOL_CALCULATOR
  const hp12cOpen = openTool === TOOL_HP12C
  const feeToolOpen = openTool === TOOL_FEE_LIQUID
  const anyToolOpen = Boolean(openTool)
  const weekRanges = useMemo(() => getWeekRanges(new Date()), [])
  const activeAlarmCount = useMemo(
    () => alarms.reduce((count, alarm) => (alarm.enabled ? count + 1 : count), 0),
    [alarms],
  )
  const nextAlarmLabel = useMemo(() => {
    const nextAlarm = alarms
      .filter((alarm) => alarm.enabled)
      .map((alarm) => ({ alarm, nextDate: resolveNextAlarmDate(alarm) }))
      .filter((item) => item.nextDate)
      .sort((left, right) => left.nextDate.getTime() - right.nextDate.getTime())[0]
    return nextAlarm?.nextDate ? formatAlarmDateTime(nextAlarm.nextDate.toISOString()) : '-'
  }, [alarms])
  const alarmPermissionLabel = useMemo(() => {
    if (alarmPermission === 'granted') return 'liberadas'
    if (alarmPermission === 'denied') return 'bloqueadas'
    if (alarmPermission === 'unsupported') return 'indisponiveis neste navegador'
    return 'pendentes'
  }, [alarmPermission])

  const expressionLabel = useMemo(() => {
    if (!operator || pendingValue == null) return ''
    return `${pendingValue} ${operator}`
  }, [operator, pendingValue])

  const hpDisplay = useMemo(() => {
    if (hpError) return hpError
    if (hpEntry) {
      const parsed = Number(normalizeHpEntry(hpEntry))
      if (Number.isFinite(parsed)) return formatHpValue(parsed)
      return hpEntry
    }
    return formatHpValue(hpStack[0])
  }, [hpEntry, hpError, hpStack])

  const hpStatusLabel = useMemo(
    () => HP_SHIFT_LABELS[hpMemoryMode] || HP_SHIFT_LABELS[hpShift] || 'C',
    [hpMemoryMode, hpShift],
  )

  const getCommittedHpStack = useCallback((baseStack) => {
    const safeBase = Array.isArray(baseStack) ? baseStack : [0, 0, 0, 0]
    if (!hpEntry) return [...safeBase]
    const parsed = Number(normalizeHpEntry(hpEntry))
    if (!Number.isFinite(parsed)) return null
    return [parsed, safeBase[1] || 0, safeBase[2] || 0, safeBase[3] || 0]
  }, [hpEntry])

  const setHpXValue = useCallback((value) => {
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue)) {
      setHpError('Erro')
      return
    }
    setHpStack((previous) => [numericValue, previous[1] || 0, previous[2] || 0, previous[3] || 0])
    setHpEntry('')
    setHpError('')
  }, [])

  const pushHpValue = useCallback((value) => {
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue)) {
      setHpError('Erro')
      return
    }
    setHpStack((previous) => [numericValue, previous[0] || 0, previous[1] || 0, previous[2] || 0])
    setHpEntry('')
    setHpError('')
  }, [])

  const resetHp = useCallback(() => {
    setHpStack([0, 0, 0, 0])
    setHpEntry('')
    setHpError('')
    setHpShift('')
    setHpMemoryMode('')
    setHpFinance({
      n: null,
      i: null,
      pv: null,
      pmt: null,
      fv: null,
    })
    setHpMemory(createHpMemoryRegisters())
    setHpLastX(0)
  }, [])

  const handleHpKey = useCallback((rawKey) => {
    const key = String(rawKey || '').trim().toUpperCase()
    if (!key) return

    const withCommittedStack = (transform) => {
      setHpError('')
      setHpStack((previous) => {
        const committed = getCommittedHpStack(previous)
        if (!committed) {
          setHpError('Erro')
          return previous
        }
        setHpLastX(committed[0] || 0)
        const next = transform(committed)
        if (!Array.isArray(next) || next.length !== 4 || next.some((value) => !Number.isFinite(value))) {
          setHpError('Erro')
          return previous
        }
        return next
      })
      setHpEntry('')
    }

    const applyUnary = (transform) => {
      setHpError('')
      const committed = getCommittedHpStack(hpStack)
      if (!committed) {
        setHpError('Erro')
        return
      }
      const nextValue = transform(committed[0] || 0, committed)
      if (!Number.isFinite(nextValue)) {
        setHpError('Erro')
        return
      }
      setHpLastX(committed[0] || 0)
      setHpStack((previous) => [nextValue, previous[1] || 0, previous[2] || 0, previous[3] || 0])
      setHpEntry('')
    }

    const storeHpFinanceValue = (financeKey) => {
      const field = HP_FINANCE_FIELDS[financeKey]
      if (!field) return
      const committed = getCommittedHpStack(hpStack)
      if (!committed) {
        setHpError('Erro')
        return
      }
      const nextValue = committed[0] || 0
      setHpLastX(nextValue)
      setHpFinance((previous) => ({ ...previous, [field]: nextValue }))
      setHpStack((previous) => [nextValue, previous[1] || 0, previous[2] || 0, previous[3] || 0])
      setHpEntry('')
      setHpError('')
    }

    const recallOrSolveHpFinanceValue = (financeKey) => {
      const field = HP_FINANCE_FIELDS[financeKey]
      if (!field) return

      if (hpEntry) {
        storeHpFinanceValue(financeKey)
        return
      }

      const solved = solveHpFinancialValue(hpFinance, financeKey)
      if (Number.isFinite(solved)) {
        setHpLastX(hpStack[0] || 0)
        setHpFinance((previous) => ({ ...previous, [field]: solved }))
        setHpStack((previous) => [solved, previous[1] || 0, previous[2] || 0, previous[3] || 0])
        setHpEntry('')
        setHpError('')
        return
      }

      const storedValue = Number(hpFinance[field])
      if (Number.isFinite(storedValue)) {
        setHpLastX(hpStack[0] || 0)
        setHpStack((previous) => [storedValue, previous[1] || 0, previous[2] || 0, previous[3] || 0])
        setHpEntry('')
        setHpError('')
        return
      }

      setHpError('Erro')
    }

    if (key === 'F') {
      setHpError('')
      setHpMemoryMode('')
      setHpShift('f')
      return
    }

    if (key === 'G') {
      setHpError('')
      setHpMemoryMode('')
      setHpShift('g')
      return
    }

    if (key === 'STO') {
      setHpError('')
      setHpShift('')
      setHpMemoryMode('STO')
      return
    }

    if (key === 'RCL') {
      setHpError('')
      setHpShift('')
      setHpMemoryMode('RCL')
      return
    }

    if ((hpMemoryMode === 'STO' || hpMemoryMode === 'RCL') && HP_MEMORY_DIGIT_KEYS.has(key)) {
      setHpError('')
      if (hpMemoryMode === 'STO') {
        const committed = getCommittedHpStack(hpStack)
        if (!committed) {
          setHpError('Erro')
          setHpMemoryMode('')
          return
        }
        setHpMemory((previous) => ({ ...previous, [key]: committed[0] || 0 }))
        setHpLastX(committed[0] || 0)
        setHpEntry('')
      } else {
        const recalled = Number(hpMemory[key])
        if (!Number.isFinite(recalled)) {
          setHpError('Erro')
          setHpMemoryMode('')
          return
        }
        setHpLastX(hpStack[0] || 0)
        pushHpValue(recalled)
      }
      setHpMemoryMode('')
      return
    }

    if (hpMemoryMode) setHpMemoryMode('')
    if (hpShift) setHpShift('')

    if (key === 'OFF') {
      setOpenTool(null)
      return
    }

    if (key === 'CLEAR') {
      resetHp()
      return
    }

    if (key === 'FIN') {
      setHpError('')
      setHpFinance({
        n: null,
        i: null,
        pv: null,
        pmt: null,
        fv: null,
      })
      return
    }

    if (key === 'REG') {
      setHpError('')
      setHpMemory(createHpMemoryRegisters())
      return
    }

    if (key === 'AC') {
      resetHp()
      return
    }

    if (key === 'CLX') {
      setHpError('')
      if (hpEntry) {
        setHpEntry('')
        return
      }
      setHpStack((previous) => [0, previous[1] || 0, previous[2] || 0, previous[3] || 0])
      return
    }

    if (HP_REGISTER_KEYS.has(key)) {
      recallOrSolveHpFinanceValue(key)
      return
    }

    if (key >= '0' && key <= '9') {
      setHpError('')
      setHpEntry((previous) => {
        const normalized = normalizeHpEntry(previous)
        if (!normalized) return key
        if (normalized === '0') return key
        if (normalized === '-0') return `-${key}`
        return `${normalized}${key}`
      })
      return
    }

    if (key === '.') {
      setHpError('')
      setHpEntry((previous) => {
        const normalized = normalizeHpEntry(previous)
        if (/[eE]/.test(normalized)) return normalized
        if (!normalized) return '0.'
        if (normalized.includes('.')) return normalized
        return `${normalized}.`
      })
      return
    }

    if (key === 'CHS') {
      setHpError('')
      if (hpEntry) {
        setHpEntry((previous) => {
          const normalized = normalizeHpEntry(previous)
          if (!normalized) return '-0'
          if (normalized.startsWith('-')) return normalized.slice(1)
          return `-${normalized}`
        })
        return
      }
      setHpStack((previous) => [-(previous[0] || 0), previous[1] || 0, previous[2] || 0, previous[3] || 0])
      return
    }

    if (key === 'EEX') {
      setHpError('')
      setHpEntry((previous) => {
        const normalized = normalizeHpEntry(previous)
        if (/[eE]/.test(normalized)) return normalized
        if (normalized) return `${normalized}e`
        const baseValue = Number(hpStack[0] || 0)
        return `${Number.isFinite(baseValue) ? String(baseValue) : '0'}e`
      })
      return
    }

    if (key === 'ENTER' || key === '=') {
      setHpError('')
      setHpStack((previous) => {
        const committed = getCommittedHpStack(previous)
        if (!committed) {
          setHpError('Erro')
          return previous
        }
        const x = committed[0] || 0
        return [x, x, committed[1] || 0, committed[2] || 0]
      })
      setHpEntry('')
      return
    }

    if (key === 'BACK') {
      setHpError('')
      setHpEntry((previous) => {
        const normalized = normalizeHpEntry(previous)
        if (!normalized) return ''
        if (normalized.length <= 1) return ''
        const nextValue = normalized.slice(0, -1)
        return nextValue === '-' ? '' : nextValue
      })
      return
    }

    if (key === '12X') {
      applyUnary((x) => x * 12)
      return
    }

    if (key === '12D') {
      applyUnary((x) => x / 12)
      return
    }

    if (key === 'RDN') {
      setHpError('')
      setHpEntry('')
      setHpStack((previous) => [previous[1] || 0, previous[2] || 0, previous[3] || 0, previous[0] || 0])
      return
    }

    if (key === 'X<>Y') {
      setHpError('')
      setHpEntry('')
      setHpStack((previous) => [previous[1] || 0, previous[0] || 0, previous[2] || 0, previous[3] || 0])
      return
    }

    if (key === '+') {
      withCommittedStack(([x, y, z, t]) => [y + x, z, t, t])
      return
    }

    if (key === '-') {
      withCommittedStack(([x, y, z, t]) => [y - x, z, t, t])
      return
    }

    if (key === '*') {
      withCommittedStack(([x, y, z, t]) => [y * x, z, t, t])
      return
    }

    if (key === '/') {
      withCommittedStack(([x, y, z, t]) => {
        if (x === 0) return null
        return [y / x, z, t, t]
      })
      return
    }

    if (key === 'Y^X') {
      withCommittedStack(([x, y, z, t]) => {
        const nextValue = y ** x
        if (!Number.isFinite(nextValue)) return null
        return [nextValue, z, t, t]
      })
      return
    }

    if (key === '1/X') {
      withCommittedStack(([x, y, z, t]) => {
        if (x === 0) return null
        return [1 / x, y, z, t]
      })
      return
    }

    if (key === 'SQRT') {
      withCommittedStack(([x, y, z, t]) => {
        if (x < 0) return null
        return [Math.sqrt(x), y, z, t]
      })
      return
    }

    if (key === 'X2') {
      applyUnary((x) => x * x)
      return
    }

    if (key === 'E^X') {
      applyUnary((x) => Math.exp(x))
      return
    }

    if (key === 'LN') {
      applyUnary((x) => (x > 0 ? Math.log(x) : NaN))
      return
    }

    if (key === 'FRAC') {
      applyUnary((x) => x - Math.trunc(x))
      return
    }

    if (key === 'INTG') {
      applyUnary((x) => Math.trunc(x))
      return
    }

    if (key === 'N!') {
      applyUnary((x) => {
        if (x < 0 || !Number.isInteger(x) || x > 170) return NaN
        let result = 1
        for (let value = 2; value <= x; value += 1) result *= value
        return result
      })
      return
    }

    if (key === '%') {
      withCommittedStack(([x, y, z, t]) => [y * (x / 100), y, z, t])
      return
    }

    if (key === '%T') {
      withCommittedStack(([x, y, z, t]) => {
        if (nearZero(y)) return null
        return [(x / y) * 100, y, z, t]
      })
      return
    }

    if (key === 'D%') {
      withCommittedStack(([x, y, z, t]) => {
        if (nearZero(y)) return null
        return [((x - y) / y) * 100, y, z, t]
      })
      return
    }

    if (key === 'RND') {
      applyUnary((x) => Number(x.toFixed(2)))
      return
    }

    if (key === 'INT') {
      const currentRegisters = {
        n: Number(hpFinance.n),
        i: Number(hpFinance.i),
        pv: Number(hpFinance.pv),
      }
      if (!Number.isFinite(currentRegisters.n) || !Number.isFinite(currentRegisters.i) || !Number.isFinite(currentRegisters.pv)) {
        setHpError('Erro')
        return
      }
      const interestValue = currentRegisters.pv * (currentRegisters.i / 100) * currentRegisters.n
      setHpLastX(hpStack[0] || 0)
      setHpXValue(interestValue)
      return
    }

    if (key === 'LSTX') {
      pushHpValue(hpLastX)
      return
    }

    if (key === 'S+' || key === 'S-' || key === 'R/S' || key === 'SST' || key === 'P/R' || key === 'PSE' || key === 'PREFIX' || key === 'RPN' || key === 'ALG' || key === 'DATE' || key === 'DDYS' || key === 'PRICE' || key === 'YTM' || key === 'SL' || key === 'SOYD' || key === 'DB' || key === 'AMORT' || key === 'NPV' || key === 'IRR' || key === 'CF0' || key === 'CFJ' || key === 'NJ' || key === 'MEM' || key === 'BEG' || key === 'END' || key === 'D.MY' || key === 'M.DY' || key === 'X<=Y' || key === 'X=0' || key === 'X<>W' || key === 'I,R' || key === 'D,R' || key === 'XBAR' || key === 'SDEV' || key === 'S' || key === 'BST' || key === 'GTO') {
      setHpError('')
      return
    }
  }, [getCommittedHpStack, hpEntry, hpFinance, hpLastX, hpMemory, hpMemoryMode, hpShift, hpStack, pushHpValue, resetHp, setHpXValue])

  const feeCalc = useMemo(() => {
    const spot = parseLocaleNumber(feeInputs.spot)
    const offer = parsePercentFactor(feeInputs.offer)
    const paga = parsePercentFactor(feeInputs.paga)

    if (spot == null || offer == null || paga == null) {
      return {
        ready: false,
        feeLiquido: null,
      }
    }

    if (spot <= 0 || paga === 0) {
      return {
        ready: false,
        feeLiquido: null,
      }
    }

    const offerValue = spot * offer
    const pagaValue = spot * paga
    const feeBruto = pagaValue - offerValue
    const feeBrutoRatio = feeBruto / pagaValue
    const feeLiquido = feeBrutoRatio / 2

    return {
      ready: Number.isFinite(feeLiquido),
      feeLiquido: Number.isFinite(feeLiquido) ? feeLiquido : null,
    }
  }, [feeInputs.offer, feeInputs.paga, feeInputs.spot])

  useEffect(() => {
    persistAlarms(currentUserKey, alarms)
  }, [alarms, currentUserKey])

  useEffect(() => {
    const handleOpenTool = (event) => {
      if (String(event?.detail?.tool || '').trim() !== TOOL_ALARMS) return
      setOpenTool(TOOL_ALARMS)
    }
    window.addEventListener(RIGHT_TOOL_OPEN_EVENT, handleOpenTool)
    return () => window.removeEventListener(RIGHT_TOOL_OPEN_EVENT, handleOpenTool)
  }, [])

  const triggerAlarm = useCallback(async (alarm) => {
    const message = String(alarm?.message || '').trim() || 'Horario do alarme atingido.'
    const title = normalizeAlarmScheduleType(alarm?.scheduleType) === ALARM_SCHEDULE_RECURRING ? 'Alarme recorrente' : 'Alarme'
    const tone = alarm?.mode === ALARM_MODE_SOUND_NOTIFICATION ? 'warning' : 'success'
    if (alarm?.mode === ALARM_MODE_SOUND_NOTIFICATION) {
      void playAlarmSound(alarm?.soundType)
    }
    notify(`Alarme: ${message}`, tone)
    pushAlarmNotification(currentUserKey, {
      id: `alarm-notification-${alarm?.id || Date.now()}-${Date.now()}`,
      alarmId: alarm?.id,
      sender: title,
      subject: message,
      at: new Date().toISOString(),
      seq: Date.now(),
      scheduleType: alarm?.scheduleType,
      soundType: alarm?.soundType,
      mode: alarm?.mode,
    })
    await notifyDesktop({
      title,
      body: message,
      tag: `pwr-alarm-${alarm?.id || Date.now()}`,
      fallback: null,
    }).catch(() => null)
  }, [currentUserKey, notify])

  useEffect(() => {
    if (!alarms.length) return undefined
    const checkAlarms = () => {
      const now = Date.now()
      const dueItems = alarms.flatMap((alarm) => {
        if (!alarm?.enabled) return []

        if (normalizeAlarmScheduleType(alarm.scheduleType) === ALARM_SCHEDULE_SPECIFIC) {
          if (!alarm?.datetime || alarm?.triggeredAt) return []
          const targetTime = new Date(alarm.datetime).getTime()
          const token = buildAlarmTriggerToken(alarm.id, targetTime)
          if (!Number.isFinite(targetTime) || ACTIVE_ALARM_TRIGGERS.has(token) || targetTime > now) return []
          return [{ alarm, targetTime, token }]
        }

        const lastTriggeredAt = new Date(String(alarm?.lastTriggeredAt || '').trim()).getTime()
        const createdAt = new Date(String(alarm?.createdAt || '').trim()).getTime()
        const reference = Number.isFinite(lastTriggeredAt)
          ? lastTriggeredAt
          : (Number.isFinite(createdAt) ? createdAt - 1000 : now - 1000)
        const nextOccurrence = resolveNextRecurringOccurrenceAfter(alarm, reference)
        if (!nextOccurrence) return []
        const targetTime = nextOccurrence.getTime()
        const token = buildAlarmTriggerToken(alarm.id, targetTime)
        if (!Number.isFinite(targetTime) || ACTIVE_ALARM_TRIGGERS.has(token) || targetTime > now) return []
        return [{ alarm, targetTime, token }]
      })

      if (!dueItems.length) return

      const triggeredAt = new Date().toISOString()
      dueItems.forEach((item) => ACTIVE_ALARM_TRIGGERS.add(item.token))
      setAlarms((previous) => sortAlarms(previous.map((alarm) => {
        const matched = dueItems.find((item) => item.alarm.id === alarm.id)
        if (!matched) return alarm
        if (normalizeAlarmScheduleType(alarm.scheduleType) === ALARM_SCHEDULE_RECURRING) {
          return {
            ...alarm,
            triggeredAt,
            lastTriggeredAt: triggeredAt,
          }
        }
        return {
          ...alarm,
          enabled: false,
          triggeredAt,
          lastTriggeredAt: triggeredAt,
        }
      })))
      dueItems.forEach((item) => {
        void triggerAlarm(item.alarm)
      })
    }

    checkAlarms()
    const timer = window.setInterval(checkAlarms, 1000)
    return () => window.clearInterval(timer)
  }, [alarms, setAlarms, triggerAlarm])

  const handleSaveAlarm = useCallback(async () => {
    const scheduleType = normalizeAlarmScheduleType(alarmDraft.scheduleType)
    const message = String(alarmDraft.message || '').trim()

    if (!message) {
      notify('Informe a mensagem que deve aparecer no alarme.', 'warning')
      return
    }

    if (scheduleType === ALARM_SCHEDULE_SPECIFIC) {
      const datetime = String(alarmDraft.datetime || '').trim()
      const targetTime = new Date(datetime).getTime()
      if (!datetime || !Number.isFinite(targetTime)) {
        notify('Informe uma data e hora validas para o alarme.', 'warning')
        return
      }
      if (targetTime <= Date.now()) {
        notify('Escolha um horario futuro para o alarme.', 'warning')
        return
      }
    } else {
      const time = normalizeAlarmTime(alarmDraft.time)
      if (!time) {
        notify('Informe um horario valido para o alarme recorrente.', 'warning')
        return
      }
      if (normalizeAlarmRecurrence(alarmDraft.recurrence) === ALARM_RECURRENCE_MONTHLY) {
        const dayOfMonth = Number(clampAlarmDayOfMonth(alarmDraft.dayOfMonth))
        if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
          notify('Informe um dia do mes entre 1 e 31.', 'warning')
          return
        }
      }
    }

    if (alarmDraft.mode === ALARM_MODE_SOUND_NOTIFICATION || alarmDraft.mode === ALARM_MODE_NOTIFICATION_ONLY) {
      const permission = await requestDesktopPermission().catch(() => 'default')
      if (permission === 'denied') {
        notify('As notificacoes do navegador estao bloqueadas. O alarme vai aparecer apenas dentro do app.', 'warning')
      }
    }

    const nextAlarm = normalizeAlarm({
      id: `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      scheduleType,
      datetime: scheduleType === ALARM_SCHEDULE_SPECIFIC ? String(alarmDraft.datetime || '').trim() : '',
      recurrence: normalizeAlarmRecurrence(alarmDraft.recurrence),
      time: normalizeAlarmTime(alarmDraft.time),
      dayOfWeek: normalizeAlarmWeekday(alarmDraft.dayOfWeek),
      dayOfMonth: clampAlarmDayOfMonth(alarmDraft.dayOfMonth),
      message,
      mode: normalizeAlarmMode(alarmDraft.mode),
      soundType: normalizeAlarmSound(alarmDraft.soundType),
      enabled: true,
      createdAt: new Date().toISOString(),
      triggeredAt: '',
      lastTriggeredAt: '',
    })

    if (!nextAlarm) {
      notify('Nao foi possivel criar o alarme com os dados informados.', 'warning')
      return
    }

    setAlarms((previous) => sortAlarms([...previous, nextAlarm]))
    setAlarmDraft(createAlarmDraft())
    notify('Alarme criado com sucesso.', 'success')
  }, [alarmDraft, notify, setAlarms])

  const handleTestAlarmSound = useCallback(async () => {
    const played = await playAlarmSound(alarmDraft.soundType)
    if (!played) {
      notify('Nao foi possivel reproduzir o som neste ambiente.', 'warning')
    }
  }, [alarmDraft.soundType, notify])

  const handleToggleAlarmEnabled = useCallback((alarmId) => {
    const currentAlarm = alarms.find((alarm) => alarm.id === alarmId)
    if (!currentAlarm) return
    if (!currentAlarm.enabled && normalizeAlarmScheduleType(currentAlarm.scheduleType) === ALARM_SCHEDULE_SPECIFIC) {
      const targetTime = new Date(String(currentAlarm.datetime || '').trim()).getTime()
      if (!Number.isFinite(targetTime) || targetTime <= Date.now()) {
        notify('Este alarme de data especifica ja passou. Crie um novo horario.', 'warning')
        return
      }
    }
    setAlarms((previous) => sortAlarms(previous.map((alarm) => {
      if (alarm.id !== alarmId) return alarm
      const nextEnabled = !alarm.enabled
      if (nextEnabled) {
        clearAlarmTriggerTokens(alarm.id)
      }
      return {
        ...alarm,
        enabled: nextEnabled,
        triggeredAt: nextEnabled ? '' : alarm.triggeredAt,
        lastTriggeredAt: nextEnabled && normalizeAlarmScheduleType(alarm.scheduleType) === ALARM_SCHEDULE_RECURRING
          ? new Date().toISOString()
          : alarm.lastTriggeredAt,
      }
    })))
  }, [alarms, notify, setAlarms])

  const handleRemoveAlarm = useCallback((alarmId) => {
    clearAlarmTriggerTokens(alarmId)
    setAlarms((previous) => previous.filter((alarm) => alarm.id !== alarmId))
  }, [setAlarms])

  const resetAll = useCallback(() => {
    setDisplay('0')
    setPendingValue(null)
    setOperator(null)
    setWaitingForOperand(false)
  }, [])

  const inputDigit = useCallback((digit) => {
    if (display === 'Erro') {
      setDisplay(digit)
      setWaitingForOperand(false)
      return
    }

    if (waitingForOperand) {
      setDisplay(digit)
      setWaitingForOperand(false)
      return
    }

    setDisplay((prev) => (prev === '0' ? digit : `${prev}${digit}`))
  }, [display, waitingForOperand])

  const inputDot = useCallback(() => {
    if (display === 'Erro') {
      setDisplay('0.')
      setWaitingForOperand(false)
      return
    }

    if (waitingForOperand) {
      setDisplay('0.')
      setWaitingForOperand(false)
      return
    }

    if (!display.includes('.')) setDisplay((prev) => `${prev}.`)
  }, [display, waitingForOperand])

  const setMathOperator = useCallback((nextOperator) => {
    if (display === 'Erro') return

    if (pendingValue == null) {
      setPendingValue(display)
      setOperator(nextOperator)
      setWaitingForOperand(true)
      return
    }

    if (operator && !waitingForOperand) {
      const nextValue = calculate(pendingValue, display, operator)
      setDisplay(nextValue)
      setPendingValue(nextValue === 'Erro' ? null : nextValue)
    }

    setOperator(nextOperator)
    setWaitingForOperand(true)
  }, [display, operator, pendingValue, waitingForOperand])

  const applyEquals = useCallback(() => {
    if (display === 'Erro') return
    if (pendingValue == null || !operator) return
    if (waitingForOperand) return

    const nextValue = calculate(pendingValue, display, operator)
    setDisplay(nextValue)
    setPendingValue(null)
    setOperator(null)
    setWaitingForOperand(false)
  }, [display, operator, pendingValue, waitingForOperand])

  const toggleSign = useCallback(() => {
    if (display === 'Erro' || display === '0') return
    setDisplay((prev) => (prev.startsWith('-') ? prev.slice(1) : `-${prev}`))
  }, [display])

  const applyPercent = useCallback(() => {
    if (display === 'Erro') return
    const value = Number(display)
    if (!Number.isFinite(value)) return
    setDisplay(String(value / 100))
  }, [display])

  const backspace = useCallback(() => {
    if (display === 'Erro') {
      setDisplay('0')
      return
    }
    if (waitingForOperand) return
    setDisplay((prev) => {
      if (prev.length <= 1) return '0'
      const next = prev.slice(0, -1)
      if (next === '-' || next === '') return '0'
      return next
    })
  }, [display, waitingForOperand])

  const handleCalculatorKey = useCallback((key) => {
    if (key >= '0' && key <= '9') {
      inputDigit(key)
      return
    }

    if (key === '.') {
      inputDot()
      return
    }

    if (OPERATORS.has(key)) {
      setMathOperator(key)
      return
    }

    if (key === '=') {
      applyEquals()
      return
    }

    if (key === 'AC') {
      resetAll()
      return
    }

    if (key === BACKSPACE_KEY) {
      backspace()
      return
    }

    if (key === '+/-') {
      toggleSign()
      return
    }

    if (key === '%') {
      applyPercent()
    }
  }, [applyEquals, applyPercent, backspace, inputDigit, inputDot, resetAll, setMathOperator, toggleSign])

  useEffect(() => {
    if (!calculatorOpen) return undefined

    const onKeyDown = (event) => {
      if (event.defaultPrevented) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const key = String(event.key || '')
      let mappedKey = null

      if (key >= '0' && key <= '9') {
        mappedKey = key
      } else if (key === '.' || key === ',') {
        mappedKey = '.'
      } else if (key === '/' || key === '\\') {
        mappedKey = '/'
      } else if (key === '*' || key === 'x' || key === 'X') {
        mappedKey = '*'
      } else if (key === '+' || key === '-' || key === '%' || key === '=') {
        mappedKey = key
      } else if (key === 'Enter') {
        mappedKey = '='
      } else if (key === 'Backspace') {
        mappedKey = BACKSPACE_KEY
      } else if (key === 'Delete') {
        mappedKey = 'AC'
      } else if (key === 'Escape') {
        mappedKey = '__CLOSE__'
      }

      if (!mappedKey) return

      event.preventDefault()
      event.stopPropagation()

      if (mappedKey === '__CLOSE__') {
        setOpenTool(null)
        return
      }

      handleCalculatorKey(mappedKey)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [calculatorOpen, handleCalculatorKey])

  useEffect(() => {
    if (!hp12cOpen) return undefined

    const onKeyDown = (event) => {
      if (event.defaultPrevented) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const key = String(event.key || '')
      let mappedKey = null

      if (key >= '0' && key <= '9') {
        mappedKey = key
      } else if (key === '.' || key === ',') {
        mappedKey = '.'
      } else if (key === '+' || key === '-' || key === '*' || key === '/') {
        mappedKey = key
      } else if (key === 'Enter') {
        mappedKey = 'ENTER'
      } else if (key === 'Backspace' || key === 'Delete') {
        mappedKey = 'CLX'
      } else if (key === 'Escape') {
        mappedKey = '__CLOSE__'
      }

      if (!mappedKey) return

      event.preventDefault()
      event.stopPropagation()

      if (mappedKey === '__CLOSE__') {
        setOpenTool(null)
        return
      }

      handleHpKey(mappedKey)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [handleHpKey, hp12cOpen])

  const loadWeeklyEarnings = useCallback(async ({ force = false } = {}) => {
    const symbols = getTrackedEarningsSymbols()
    if (!symbols.length) {
      setEarningsState({
        loading: false,
        error: 'Nenhum ticker monitorado.',
        currentWeek: [],
        nextWeek: [],
        symbolsCount: 0,
        generatedAt: '',
      })
      return
    }

    setEarningsState((prev) => ({
      ...prev,
      loading: true,
      error: '',
      symbolsCount: symbols.length,
    }))

    try {
      const payload = await fetchEarningsCalendar({
        symbols,
        from: weekRanges.current.from,
        to: weekRanges.next.to,
        force,
      })
      const items = Array.isArray(payload?.items) ? payload.items : []
      const currentWeek = filterItemsByRange(items, weekRanges.current.from, weekRanges.current.to)
      const nextWeek = filterItemsByRange(items, weekRanges.next.from, weekRanges.next.to)
      setEarningsState({
        loading: false,
        error: '',
        currentWeek,
        nextWeek,
        symbolsCount: currentWeek.length + nextWeek.length,
        generatedAt: String(payload?.generatedAt || ''),
      })
    } catch (error) {
      setEarningsState({
        loading: false,
        error: error?.message || 'Falha ao carregar resultados da semana.',
        currentWeek: [],
        nextWeek: [],
        symbolsCount: symbols.length,
        generatedAt: '',
      })
    }
  }, [weekRanges])

  const handleOpenCalendarPage = useCallback(() => {
    window.location.hash = '#/calendario-resultados'
    setOpenTool(null)
  }, [])

  const handleToggleTool = useCallback((toolId) => {
    setOpenTool((prev) => {
      const next = prev === toolId ? null : toolId
      if (next === TOOL_EARNINGS_WEEK) {
        void loadWeeklyEarnings()
      }
      return next
    })
  }, [loadWeeklyEarnings])

  return (
    <>
      <aside className="right-tools-rail" aria-label="Barra de ferramentas">
        <div className="right-tools-list">
          {TOOL_ITEMS.map((tool) => {
            const active = openTool === tool.id
            return (
              <button
                key={tool.id}
                type="button"
                className={`right-tool-button ${active ? 'active' : ''}`.trim()}
                onClick={() => handleToggleTool(tool.id)}
                aria-label={active ? `Fechar ${tool.label.toLowerCase()}` : `Abrir ${tool.label.toLowerCase()}`}
                title={tool.label}
              >
                <span className="right-tool-icon">
                  <Icon name={tool.icon} size={16} />
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      {anyToolOpen ? (
        <>
          <button
            type="button"
            className="right-tool-overlay"
            aria-label="Fechar ferramentas"
            onClick={() => setOpenTool(null)}
          />

          {earningsToolOpen ? (
            <section className="right-tool-panel earnings-week-panel" aria-label="Calendario de resultados da semana">
              <div className="calculator-head">
                <div>
                  <small>Resultados da semana</small>
                  <strong>{earningsState.loading ? 'Carregando...' : `${earningsState.symbolsCount} eventos`}</strong>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setOpenTool(null)}
                  aria-label="Fechar calendario semanal"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>

              <div className="earnings-week-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => loadWeeklyEarnings({ force: true })}
                  disabled={earningsState.loading}
                >
                  <Icon name="sync" size={14} />
                  Atualizar
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleOpenCalendarPage}
                >
                  <Icon name="calendar" size={14} />
                  Abrir painel
                </button>
              </div>

              {earningsState.error ? (
                <div className="sync-warnings">
                  <strong>ERRO</strong>
                  {earningsState.error}
                </div>
              ) : null}

              <div className="earnings-week-block">
                <strong>Semana atual ({formatDateLabel(weekRanges.current.from)} a {formatDateLabel(weekRanges.current.to)})</strong>
                {earningsState.currentWeek.length ? (
                  <div className="earnings-week-list">
                    {earningsState.currentWeek.map((item) => (
                      <article key={`${item.id}-${item.eventDate}`} className="earnings-week-item">
                        <div className="earnings-week-item-left">
                          <EarningsLogo symbol={item.displaySymbol} size={20} />
                          <div>
                            <small>{formatDateLabel(item.eventDate)}</small>
                            <strong>{item.displaySymbol}</strong>
                            <span>{item.companyName}</span>
                          </div>
                        </div>
                        <div>
                          <small>EPS</small>
                          <strong>{item.expectations?.epsAverage != null ? formatCompactNumber(item.expectations.epsAverage) : '-'}</strong>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">Nenhum resultado previsto na semana atual.</p>
                )}
              </div>

              <div className="earnings-week-block">
                <strong>Proxima semana ({formatDateLabel(weekRanges.next.from)} a {formatDateLabel(weekRanges.next.to)})</strong>
                {earningsState.nextWeek.length ? (
                  <div className="earnings-week-list">
                    {earningsState.nextWeek.map((item) => (
                      <article key={`${item.id}-${item.eventDate}`} className="earnings-week-item">
                        <div className="earnings-week-item-left">
                          <EarningsLogo symbol={item.displaySymbol} size={20} />
                          <div>
                            <small>{formatDateLabel(item.eventDate)}</small>
                            <strong>{item.displaySymbol}</strong>
                            <span>{item.companyName}</span>
                          </div>
                        </div>
                        <div>
                          <small>EPS</small>
                          <strong>{item.expectations?.epsAverage != null ? formatCompactNumber(item.expectations.epsAverage) : '-'}</strong>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">Nenhum resultado previsto na proxima semana.</p>
                )}
              </div>

              {earningsState.generatedAt ? (
                <p className="muted earnings-week-foot">
                  Atualizado em {new Date(earningsState.generatedAt).toLocaleString('pt-BR')}
                </p>
              ) : null}
            </section>
          ) : null}

          {alarmsToolOpen ? (
            <section className="right-tool-panel alarm-tool-panel" aria-label="Alarmes">
              <div className="calculator-head">
                <div>
                  <small>Alarmes</small>
                  <strong>{activeAlarmCount} ativo(s)</strong>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setOpenTool(null)}
                  aria-label="Fechar painel de alarmes"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>

              <div className="alarm-tool-summary">
                <div>
                  <small>Proximo alarme</small>
                  <strong>{nextAlarmLabel}</strong>
                </div>
                <div>
                  <small>Notificacoes desktop</small>
                  <span className="muted">{alarmPermissionLabel}</span>
                </div>
              </div>

              <div className="alarm-mode-group">
                <small>Agendamento</small>
                <div className="alarm-mode-options">
                  {ALARM_SCHEDULE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`alarm-mode-option ${alarmDraft.scheduleType === option.value ? 'selected' : ''}`.trim()}
                    >
                      <input
                        type="radio"
                        name="alarm-schedule-type"
                        value={option.value}
                        checked={alarmDraft.scheduleType === option.value}
                        onChange={() => setAlarmDraft((prev) => ({ ...prev, scheduleType: option.value }))}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="alarm-tool-grid">
                {alarmDraft.scheduleType === ALARM_SCHEDULE_SPECIFIC ? (
                  <label>
                    Data e hora
                    <input
                      className="input"
                      type="datetime-local"
                      value={alarmDraft.datetime}
                      onChange={(event) => setAlarmDraft((prev) => ({ ...prev, datetime: event.target.value }))}
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      Frequencia
                      <select
                        className="input"
                        value={alarmDraft.recurrence}
                        onChange={(event) => setAlarmDraft((prev) => ({ ...prev, recurrence: event.target.value }))}
                      >
                        {ALARM_RECURRENCE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>

                    <label>
                      Horario
                      <input
                        className="input"
                        type="time"
                        value={alarmDraft.time}
                        onChange={(event) => setAlarmDraft((prev) => ({ ...prev, time: event.target.value }))}
                      />
                    </label>

                    {alarmDraft.recurrence === ALARM_RECURRENCE_WEEKLY ? (
                      <label>
                        Dia da semana
                        <select
                          className="input"
                          value={alarmDraft.dayOfWeek}
                          onChange={(event) => setAlarmDraft((prev) => ({ ...prev, dayOfWeek: event.target.value }))}
                        >
                          {ALARM_WEEKDAY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {alarmDraft.recurrence === ALARM_RECURRENCE_MONTHLY ? (
                      <label>
                        Dia do mes
                        <input
                          className="input"
                          type="number"
                          min="1"
                          max="31"
                          value={alarmDraft.dayOfMonth}
                          onChange={(event) => setAlarmDraft((prev) => ({ ...prev, dayOfMonth: event.target.value }))}
                        />
                      </label>
                    ) : null}
                  </>
                )}

                <label>
                  Som do alarme
                  <select
                    className="input"
                    value={alarmDraft.soundType}
                    onChange={(event) => setAlarmDraft((prev) => ({ ...prev, soundType: event.target.value }))}
                  >
                    {ALARM_SOUND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <div className="alarm-inline-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleTestAlarmSound}
                  >
                    <Icon name="bell" size={14} />
                    Testar som
                  </button>
                </div>

                <label className="alarm-tool-message">
                  Mensagem
                  <textarea
                    className="input"
                    rows={3}
                    value={alarmDraft.message}
                    onChange={(event) => setAlarmDraft((prev) => ({ ...prev, message: event.target.value }))}
                    placeholder="Mensagem que vai aparecer quando o alarme disparar"
                  />
                </label>
              </div>

              <div className="alarm-mode-group">
                <small>Tipo do alarme</small>
                <div className="alarm-mode-options">
                  {ALARM_MODE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`alarm-mode-option ${alarmDraft.mode === option.value ? 'selected' : ''}`.trim()}
                    >
                      <input
                        type="radio"
                        name="alarm-mode"
                        value={option.value}
                        checked={alarmDraft.mode === option.value}
                        onChange={() => setAlarmDraft((prev) => ({ ...prev, mode: option.value }))}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="earnings-week-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveAlarm}
                >
                  <Icon name="clock" size={14} />
                  Adicionar alarme
                </button>
              </div>

              <div className="alarm-tool-list-wrap">
                <strong>Alarmes agendados</strong>
                {alarms.length ? (
                  <div className="alarm-tool-list">
                    {alarms.map((alarm) => {
                      const nextOccurrence = resolveNextAlarmDate(alarm)
                      return (
                        <article
                          key={alarm.id}
                          className={`alarm-tool-item ${alarm.enabled ? 'is-enabled' : 'is-disabled'}`.trim()}
                        >
                          <div className="alarm-tool-item-head">
                            <div>
                              <strong>{resolveAlarmScheduleLabel(alarm)}</strong>
                              <small>{resolveAlarmModeLabel(alarm.mode)} | Som: {resolveAlarmSoundLabel(alarm.soundType)}</small>
                            </div>
                            <span className={`pill ${alarm.enabled ? 'text-positive' : ''}`.trim()}>
                              {alarm.enabled ? 'Ativo' : (alarm.triggeredAt ? 'Disparado' : 'Pausado')}
                            </span>
                          </div>
                          <p>{alarm.message || 'Sem mensagem'}</p>
                          {nextOccurrence ? (
                            <small className="muted">Proximo disparo: {formatAlarmDateTime(nextOccurrence.toISOString())}</small>
                          ) : null}
                          {alarm.triggeredAt ? (
                            <small className="muted">Ultimo disparo: {formatAlarmDateTime(alarm.triggeredAt)}</small>
                          ) : null}
                          <div className="alarm-tool-item-actions">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => handleToggleAlarmEnabled(alarm.id)}
                            >
                              <Icon name={alarm.enabled ? 'close' : 'sync'} size={14} />
                              {alarm.enabled ? 'Pausar' : 'Ativar'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger"
                              onClick={() => handleRemoveAlarm(alarm.id)}
                            >
                              <Icon name="warning" size={14} />
                              Remover
                            </button>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                ) : (
                  <p className="muted">Nenhum alarme configurado ainda.</p>
                )}
              </div>
            </section>
          ) : null}

          {calculatorOpen ? (
            <section className="right-tool-panel calculator-panel" aria-label="Calculadora">
              <div className="calculator-head">
                <div>
                  <small>{expressionLabel || 'Calculadora'}</small>
                  <strong>{display}</strong>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setOpenTool(null)}
                  aria-label="Fechar calculadora"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="calculator-grid">
                {[
                  'AC', BACKSPACE_KEY, '%', '/',
                  '7', '8', '9', '*',
                  '4', '5', '6', '-',
                  '1', '2', '3', '+',
                  '+/-', '0', '.', '=',
                ].map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`calculator-key ${OPERATORS.has(key) || key === '=' ? 'op' : ''}`}
                    onClick={() => handleCalculatorKey(key)}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {hp12cOpen ? (
            <section className="right-tool-panel hp12c-panel" aria-label="Calculadora HP12C">
              <div className="hp12c-shell">
                <div className="hp12c-top">
                  <div className="hp12c-brand">
                    <strong>HP 12c</strong>
                    <small>Platinum</small>
                  </div>

                  <div className="hp12c-display-wrap">
                    <div className="hp12c-display">
                      <span className="hp12c-display-value">{hpDisplay}</span>
                      <span className="hp12c-display-foot hp12c-display-foot-left">RPN</span>
                      <span className="hp12c-display-foot hp12c-display-foot-right">{hpStatusLabel}</span>
                    </div>
                  </div>

                  <div className="hp12c-logo" aria-hidden="true">hp</div>

                  <button
                    type="button"
                    className="hp12c-close-btn"
                    onClick={() => setOpenTool(null)}
                    aria-label="Fechar HP12C"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>

                <div className="hp12c-body">
                  <div className="hp12c-grid">
                    {HP12C_KEYS.map((keyDef, index) => {
                      const action = keyDef.action ? String(keyDef.action).toUpperCase() : ''
                      const shiftedAction = hpShift === 'f'
                        ? String(keyDef.topAction || action).toUpperCase()
                        : hpShift === 'g'
                          ? String(keyDef.bottomAction || action).toUpperCase()
                          : action
                      const hasAction = Boolean(shiftedAction)
                      const tone = keyDef.tone ? `tone-${keyDef.tone}` : ''
                      return (
                        <button
                          key={`${keyDef.label}-${index}`}
                          type="button"
                          className={`hp12c-keycap ${hasAction ? 'is-action' : 'is-static'} ${tone}`.trim()}
                          style={keyDef.rowSpan ? { gridRow: `span ${keyDef.rowSpan}` } : undefined}
                          onClick={() => {
                            if (hasAction) handleHpKey(shiftedAction)
                          }}
                          disabled={!hasAction}
                          aria-label={hasAction ? `Tecla ${keyDef.label}` : `Tecla ${keyDef.label} sem acao`}
                        >
                          <span className={`hp12c-key-top ${keyDef.top ? '' : 'is-empty'}`.trim()}>{keyDef.top || '.'}</span>
                          <span className="hp12c-key-main">{keyDef.label}</span>
                          <span className={`hp12c-key-bottom ${keyDef.bottom ? '' : 'is-empty'}`.trim()}>{keyDef.bottom || '.'}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {feeToolOpen ? (
            <section className="right-tool-panel fee-tool-panel" aria-label="Calculadora de fee liquido">
              <div className="calculator-head">
                <div>
                  <small>Fee liquido estruturadas</small>
                  <strong>{feeCalc.ready ? formatPercent(feeCalc.feeLiquido) : '-'}</strong>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setOpenTool(null)}
                  aria-label="Fechar calculadora de fee"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>

              <div className="fee-tool-grid">
                <label>
                  Spot
                  <input
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={feeInputs.spot}
                    onChange={(event) => setFeeInputs((prev) => ({ ...prev, spot: event.target.value }))}
                    placeholder="Ex.: 27,12"
                  />
                </label>

                <label>
                  Offer
                  <input
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={feeInputs.offer}
                    onChange={(event) => setFeeInputs((prev) => ({ ...prev, offer: event.target.value }))}
                    placeholder="Ex.: 0,0722 ou 7,22%"
                  />
                </label>

                <label>
                  Paga
                  <input
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={feeInputs.paga}
                    onChange={(event) => setFeeInputs((prev) => ({ ...prev, paga: event.target.value }))}
                    placeholder="Ex.: 0,125 ou 12,5%"
                  />
                </label>
              </div>

              <div className="fee-tool-result">
                <small>Valor do fee liquido</small>
                <strong>{feeCalc.ready ? formatPercent(feeCalc.feeLiquido) : '-'}</strong>
                <span className="muted">Decimal: {feeCalc.ready ? formatDecimal(feeCalc.feeLiquido, 6) : '-'}</span>
              </div>

              <p className="fee-tool-hint muted">
                Formula da planilha: ((spot*paga - spot*offer) / (spot*paga)) / 2.
              </p>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  )
}

export default RightToolRail
