import type { LocalDateTime } from '~/domain/zoned-time'

import type { DecimalMark } from './dialect'

export type DateOrder = 'day-first' | 'month-first'

export type LocalDate = Pick<LocalDateTime, 'year' | 'month' | 'day'>
export type TimeOfDay = Pick<LocalDateTime, 'hour' | 'minute' | 'second'>

const BLANK = /^[\s-]*$/
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})/
const PARTED_DATE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})/
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?/
const CLOCK_PARTS = /^\d{1,3}(:\d{1,2}){0,2}$/

export function isBlank(cell: string | undefined): boolean {
  return cell === undefined || BLANK.test(cell)
}

export function textOr(cell: string | undefined, fallback: string): string {
  return isBlank(cell) ? fallback : cell!.trim()
}

export function parseNumberCell(cell: string | undefined, decimal: DecimalMark): number | null {
  if (isBlank(cell)) return null

  const text = cell!.trim()
  const normalised = decimal === ',' ? text.replace(/[\s.]/g, '').replace(',', '.') : text.replace(/[\s,]/g, '')
  const value = Number(normalised)

  if (!Number.isFinite(value)) throw new Error(`Cannot read "${cell}" as a number`)
  return value
}

export function parseLocalDate(cell: string | undefined, order: DateOrder): LocalDate {
  if (isBlank(cell)) throw new Error('Missing date')

  const text = cell!.trim()
  const iso = ISO_DATE.exec(text)
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }

  const parts = PARTED_DATE.exec(text)
  if (!parts) throw new Error(`Cannot read "${cell}" as a date`)

  const first = Number(parts[1])
  const second = Number(parts[2])
  const year = fullYear(Number(parts[3]))
  // A first component above 12 can only be a day, whatever the athlete's locale says.
  const dayFirst = first > 12 || (second <= 12 && order === 'day-first')

  return dayFirst ? { year, month: second, day: first } : { year, month: first, day: second }
}

export function parseTimeOfDay(cell: string | undefined): TimeOfDay | null {
  if (isBlank(cell)) return null

  const clock = CLOCK.exec(cell!.trim())
  if (!clock) throw new Error(`Cannot read "${cell}" as a time of day`)

  return { hour: Number(clock[1]), minute: Number(clock[2]), second: Number(clock[3] ?? 0) }
}

function fullYear(year: number): number {
  if (year >= 100) return year
  return year < 70 ? 2000 + year : 1900 + year
}

/**
 * Reads a Freelap time cell. Sprint times are plain seconds ("3.42"), but longer efforts are
 * exported as clock time ("1:02.34"), and the decimal mark follows the athlete's app settings.
 */
export function parseDurationSeconds(cell: string, decimal: DecimalMark): number | null {
  const text = cell.trim()
  if (isBlank(text)) return null

  const normalised = decimal === ',' ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')
  const [clock = '', fraction] = normalised.split('.')

  if (!CLOCK_PARTS.test(clock) || (fraction !== undefined && !/^\d+$/.test(fraction))) {
    throw new Error(`Cannot read "${cell}" as a duration`)
  }

  const seconds = clock
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0)

  return fraction === undefined ? seconds : seconds + Number(`0.${fraction}`)
}
