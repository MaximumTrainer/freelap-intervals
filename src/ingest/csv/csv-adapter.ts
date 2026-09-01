import { createHash } from 'node:crypto'

import type { Rep, Split, Sport, SprintSession } from '~/domain/sprint-session'
import { summariseReps } from '~/domain/sprint-session'
import { kmhToMps, roundTo, speedFrom } from '~/domain/units'
import { toZonedIso } from '~/domain/zoned-time'

import { parseDurationSeconds, parseLocalDate, parseNumberCell, parseTimeOfDay, textOr } from './cells'
import type { DateOrder, LocalDate } from './cells'
import type { CanonicalField, ColumnMap, MappingOverrides, SpeedUnit, UnmappedColumn } from './column-mapping'
import { mapColumns } from './column-mapping'
import type { CsvDialect } from './dialect'
import { detectDialect, parseDelimited } from './dialect'

export interface CsvImportOptions {
  readonly timezone?: string
  readonly dateOrder?: DateOrder
  readonly sport?: Sport
  readonly columnOverrides?: MappingOverrides
  /** Used when the export carries no athlete column. */
  readonly athleteRef?: string
  /** Maximum gap between consecutive reps before they split into separate sessions (ms). */
  readonly sessionGapMs?: number
}

const THREE_HOURS_MS = 3 * 60 * 60 * 1000

interface Settings {
  readonly timezone: string
  readonly dateOrder: DateOrder
  readonly sport: Sport
  readonly athleteRef: string
  readonly sessionGapMs: number
}

interface RepRow {
  readonly date: LocalDate
  readonly athleteRef: string
  readonly exerciseName: string
  readonly order: number
  readonly rep: Rep
}

const SPEED_PRECISION = 3
const TIME_PRECISION = 3
const MPS_PER_MPH = 0.44704
const UNKNOWN_EXERCISE = 'Freelap session'

/**
 * Turns a MyFreelap CSV export into canonical sessions. The export mirrors whatever the
 * athlete had on screen, so every column beyond the rep time is optional.
 */
export function readSessions(text: string, options: CsvImportOptions = {}): SprintSession[] {
  const settings = withDefaults(options)
  const dialect = detectDialect(text)
  const [header, ...body] = parseDelimited(text, dialect.delimiter)

  if (!header) throw new Error('The export is empty')
  if (body.length === 0) throw new Error('The export has no rows')

  const columns = mapColumns(header, options.columnOverrides)
  const rows = body.map((cells, offset) => readRow(cells, offset + 2, columns, dialect, settings))

  return groupIntoSessions(rows, settings)
}

export interface CsvInspection {
  /** Identifies this export layout, so a mapping given once can be found again. */
  readonly fingerprint: string
  readonly headers: readonly string[]
  readonly unmapped: readonly UnmappedColumn[]
  readonly dialect: CsvDialect
}

/**
 * Looks at an export without importing it: which columns it holds, which of them we could not
 * place, and how to recognise this layout next time.
 */
export function inspectCsv(text: string, overrides: MappingOverrides = {}): CsvInspection {
  const dialect = detectDialect(text)
  const [headers = []] = parseDelimited(text, dialect.delimiter)
  const columns = mapColumns(headers, overrides)

  return { fingerprint: fingerprintOf(headers), headers, unmapped: columns.unmapped, dialect }
}

function fingerprintOf(headers: readonly string[]): string {
  return createHash('sha256').update(headers.join('\u0000')).digest('hex').slice(0, 16)
}

function withDefaults(options: CsvImportOptions): Settings {
  return {
    timezone: options.timezone ?? 'UTC',
    dateOrder: options.dateOrder ?? 'day-first',
    sport: options.sport ?? 'run',
    athleteRef: options.athleteRef ?? 'unknown',
    sessionGapMs: options.sessionGapMs ?? THREE_HOURS_MS,
  }
}

function readRow(
  cells: readonly string[],
  rowNumber: number,
  columns: ColumnMap,
  dialect: CsvDialect,
  settings: Settings,
): RepRow {
  const cellAt = (field: CanonicalField): string | undefined => {
    const column = columns.columnOf(field)
    return column === null ? undefined : cells[column]
  }

  try {
    const totalS = parseDurationSeconds(cellAt('totalS') ?? '', dialect.decimal)
    if (totalS === null) throw new Error('Missing total time')

    const date = parseLocalDate(cellAt('date'), settings.dateOrder)
    const timeOfDay = parseTimeOfDay(cellAt('timeOfDay'))
    const distanceM = parseNumberCell(cellAt('distanceM'), dialect.decimal)
    const avgSpeedMps = readSpeed(cellAt('avgSpeed'), columns.speedUnitOf('avgSpeed'), dialect)

    return {
      date,
      athleteRef: textOr(cellAt('athlete'), settings.athleteRef),
      exerciseName: textOr(cellAt('exercise'), UNKNOWN_EXERCISE),
      order: parseNumberCell(cellAt('repIndex'), dialect.decimal) ?? rowNumber,
      rep: {
        index: 0,
        wallClock: timeOfDay === null ? null : toZonedIso({ ...date, ...timeOfDay }, settings.timezone),
        totalS: roundTo(totalS, TIME_PRECISION),
        splits: readSplits(cells, columns, dialect),
        distanceM,
        avgSpeedMps: avgSpeedMps ?? derivedSpeed(distanceM, totalS),
        maxSpeedMps: readSpeed(cellAt('maxSpeed'), columns.speedUnitOf('maxSpeed'), dialect),
      },
    }
  } catch (cause) {
    throw new Error(`Row ${rowNumber}: ${(cause as Error).message}`, { cause })
  }
}

function readSplits(cells: readonly string[], columns: ColumnMap, dialect: CsvDialect): Split[] {
  return columns.splitColumns.flatMap(({ atM, column }) => {
    const elapsedS = parseDurationSeconds(cells[column] ?? '', dialect.decimal)
    return elapsedS === null ? [] : [{ atM, elapsedS: roundTo(elapsedS, TIME_PRECISION) }]
  })
}

function readSpeed(cell: string | undefined, unit: SpeedUnit, dialect: CsvDialect): number | null {
  const value = parseNumberCell(cell, dialect.decimal)
  return value === null ? null : roundTo(toMps(value, unit), SPEED_PRECISION)
}

function toMps(value: number, unit: SpeedUnit): number {
  if (unit === 'mps') return value
  return unit === 'mph' ? value * MPS_PER_MPH : kmhToMps(value)
}

function derivedSpeed(distanceM: number | null, totalS: number): number | null {
  return distanceM === null ? null : roundTo(speedFrom(distanceM, totalS), SPEED_PRECISION)
}

function groupIntoSessions(rows: readonly RepRow[], settings: Settings): SprintSession[] {
  const byKind = new Map<string, RepRow[]>()
  for (const row of rows) {
    const key = `${row.exerciseName}|${row.athleteRef}`
    byKind.set(key, [...(byKind.get(key) ?? []), row])
  }

  const sessions: SprintSession[] = []
  for (const kindGroup of byKind.values()) {
    sessions.push(...splitByGap(kindGroup, settings))
  }

  return sessions.sort(byStartTime)
}

function splitByGap(rows: readonly RepRow[], settings: Settings): SprintSession[] {
  const allHaveClocks = rows.every((row) => row.rep.wallClock !== null)
  if (!allHaveClocks) return splitByDate(rows, settings)

  const sorted = [...rows].sort(
    (left, right) => Date.parse(left.rep.wallClock!) - Date.parse(right.rep.wallClock!),
  )

  const groups: RepRow[][] = []
  let current: RepRow[] = [sorted[0]!]

  for (let index = 1; index < sorted.length; index++) {
    const gapMs = Date.parse(sorted[index]!.rep.wallClock!) - Date.parse(sorted[index - 1]!.rep.wallClock!)
    if (gapMs > settings.sessionGapMs) {
      groups.push(current)
      current = []
    }
    current.push(sorted[index]!)
  }
  groups.push(current)

  return groups.map((group) => toSession(group, settings))
}

function splitByDate(rows: readonly RepRow[], settings: Settings): SprintSession[] {
  const byDate = new Map<string, RepRow[]>()
  for (const row of rows) {
    const key = dateKey(row.date)
    byDate.set(key, [...(byDate.get(key) ?? []), row])
  }

  return [...byDate.values()].map((group) => toSession(group, settings))
}

function toSession(group: readonly RepRow[], settings: Settings): SprintSession {
  const sorted = [...group].sort((left, right) => left.order - right.order)
  const reps = sorted.map((row, offset): Rep => ({ ...row.rep, index: offset + 1 }))

  const earliest = earliestWallClock(sorted)
  const first = sorted[0]!
  const midnight = { ...first.date, hour: 0, minute: 0, second: 0 }
  const draft = {
    athleteRef: first.athleteRef,
    startedAt: earliest ?? toZonedIso(midnight, settings.timezone),
    sport: settings.sport,
    exerciseName: first.exerciseName,
    distanceM: sharedDistance(reps),
    reps,
  }

  return { ...draft, sourceId: sourceIdOf(draft), summary: summariseReps(reps) }
}

function earliestWallClock(rows: readonly RepRow[]): string | null {
  let earliest: string | null = null
  for (const row of rows) {
    if (row.rep.wallClock === null) continue
    if (earliest === null || Date.parse(row.rep.wallClock) < Date.parse(earliest)) {
      earliest = row.rep.wallClock
    }
  }

  return earliest
}

function sharedDistance(reps: readonly Rep[]): number | null {
  const distances = new Set(reps.map((rep) => rep.distanceM))
  return distances.size === 1 ? (reps[0]?.distanceM ?? null) : null
}

/** Content-addressed, so the same session re-exported with different settings keeps its identity. */
function sourceIdOf(draft: Omit<SprintSession, 'sourceId' | 'summary'>): string {
  const digest = createHash('sha256').update(JSON.stringify(draft)).digest('hex')
  return `csv-${digest.slice(0, 12)}`
}

function dateKey(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

function byStartTime(left: SprintSession, right: SprintSession): number {
  return Date.parse(left.startedAt) - Date.parse(right.startedAt)
}
