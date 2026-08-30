export interface LocalDateTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const MINUTE_MS = 60_000

/**
 * Renders a wall-clock reading from a Freelap export as a timezone-aware ISO 8601 instant.
 * Freelap stores local time only, so the athlete's timezone supplies the missing offset.
 */
export function toZonedIso(local: LocalDateTime, timeZone: string): string {
  const wallClockMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
  const firstGuess = offsetMinutesAt(wallClockMs, timeZone)
  // A second pass settles the offset when the naive guess landed on the far side of a DST change.
  const offsetMinutes = offsetMinutesAt(wallClockMs - firstGuess * MINUTE_MS, timeZone)

  return `${formatLocal(local)}${formatOffset(offsetMinutes)}`
}

export function offsetMinutesAt(instantMs: number, timeZone: string): number {
  const parts = partsInZone(instantMs, timeZone)
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asIfUtc - instantMs) / MINUTE_MS)
}

function partsInZone(instantMs: number, timeZone: string): LocalDateTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs))
  const valueOf = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN)

  return {
    year: valueOf('year'),
    month: valueOf('month'),
    day: valueOf('day'),
    hour: valueOf('hour') % 24,
    minute: valueOf('minute'),
    second: valueOf('second'),
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    throw new Error(`Unknown athlete timezone: ${timeZone}`)
  }

  formatters.set(timeZone, formatter)
  return formatter
}

function formatLocal(local: LocalDateTime): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`
}

export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

/** Renders an instant as intervals.icu writes local times: no zone suffix. */
export function toLocalIso(epochMs: number, timeZone: string): string {
  return formatLocal(partsInZone(epochMs, timeZone))
}

/** Reads a local time as intervals.icu stores it, in the athlete timezone, back to an instant. */
export function epochMsOfLocal(localIso: string, timeZone: string): number {
  return Date.parse(toZonedIso(parseLocalIso(localIso), timeZone))
}

function parseLocalIso(localIso: string): LocalDateTime {
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(localIso.trim())
  if (!parts) throw new Error(`Cannot read "${localIso}" as a local date and time`)

  return {
    year: Number(parts[1]),
    month: Number(parts[2]),
    day: Number(parts[3]),
    hour: Number(parts[4]),
    minute: Number(parts[5]),
    second: Number(parts[6] ?? 0),
  }
}
