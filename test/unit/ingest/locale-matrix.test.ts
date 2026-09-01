import { describe, expect, it } from 'vitest'

import type { CsvImportOptions } from '~/ingest/csv/csv-adapter'
import { inspectCsv, readSessions } from '~/ingest/csv/csv-adapter'
import type { Delimiter, DecimalMark } from '~/ingest/csv/dialect'

import { csvFixture } from '../../support/fixtures'

/**
 * The locale and separator matrix required by issue #28 / T1.
 *
 * Axes enumerated (R1):
 *   Separator:      ; , tab
 *   Decimal mark:   . ,
 *   Thousands sep:  none, . (European)
 *   Date order:     day-first, month-first, ISO
 *   Time format:    ss.d (plain seconds), mm:ss (clock)
 *   Speed columns:  present, absent, m/s unit
 *   Header lang:    English, French
 *
 * Excluded combinations and reasons (R2):
 *   - comma delimiter + decimal comma: impossible, the delimiter is the comma
 *   - tab + decimal dot + thousands comma: MyFreelap does not produce this
 *   - thousands separator with comma delimiter: commas inside numbers break
 *     comma-delimited CSV regardless of quoting
 *   - month-first + semicolon: real MyFreelap semicolon exports are European
 *     (day-first); the code handles it but no real export combines them
 */

interface MatrixCase {
  readonly name: string
  readonly fixture: string
  readonly options: CsvImportOptions
  readonly dialect: { delimiter: Delimiter; decimal: DecimalMark }
  readonly sessionCount: number
  readonly repCount: number
  readonly repTimes: readonly number[]
  readonly startedAt: string
  readonly distanceM: number
  readonly exerciseName: string
  readonly speedPresent: boolean
}

const inLondon = { timezone: 'Europe/London' }

const MATRIX: readonly MatrixCase[] = [
  {
    // European semicolon with decimal comma and day-first dates
    name: 'European semicolon (;, decimal comma, day-first)',
    fixture: 'flying-30m-semicolon.csv',
    options: inLondon,
    dialect: { delimiter: ';', decimal: ',' },
    sessionCount: 1,
    repCount: 6,
    repTimes: [3.42, 3.38, 3.51, 3.35, 3.44, 3.61],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: true,
  },
  {
    // US comma with decimal dot and month-first dates
    name: 'US comma (,, decimal dot, month-first)',
    fixture: 'flying-30m-us.csv',
    options: { ...inLondon, dateOrder: 'month-first' },
    dialect: { delimiter: ',', decimal: '.' },
    sessionCount: 1,
    repCount: 6,
    repTimes: [3.42, 3.38, 3.51, 3.35, 3.44, 3.61],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: true,
  },
  {
    // Tab-separated with decimal dot and day-first dates
    name: 'tab-separated (tab, decimal dot, day-first)',
    fixture: 'tab-separated.csv',
    options: inLondon,
    dialect: { delimiter: '\t', decimal: '.' },
    sessionCount: 1,
    repCount: 6,
    repTimes: [3.42, 3.38, 3.51, 3.35, 3.44, 3.61],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: true,
  },
  {
    // French headers with semicolon delimiter
    name: 'French headers (;, decimal comma, day-first)',
    fixture: 'french-semicolon.csv',
    options: inLondon,
    dialect: { delimiter: ';', decimal: ',' },
    sessionCount: 1,
    repCount: 6,
    repTimes: [3.42, 3.38, 3.51, 3.35, 3.44, 3.61],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: true,
  },
  {
    // Clock-style mm:ss durations with decimal comma; speed column provides the decimal-comma signal
    name: 'mm:ss durations (;, decimal comma, day-first)',
    fixture: 'mmss-times.csv',
    options: inLondon,
    dialect: { delimiter: ';', decimal: ',' },
    sessionCount: 1,
    repCount: 3,
    repTimes: [62.34, 64.50, 61.12],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 400,
    exerciseName: '400m',
    speedPresent: true,
  },
  {
    // ISO dates with semicolon delimiter
    name: 'ISO dates (;, decimal comma)',
    fixture: 'iso-dates.csv',
    options: inLondon,
    dialect: { delimiter: ';', decimal: ',' },
    sessionCount: 1,
    repCount: 2,
    repTimes: [3.42, 3.38],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: false,
  },
  {
    // No speed columns — speed derived from distance/time
    name: 'no speed columns (;, decimal comma, day-first)',
    fixture: 'no-speed-columns.csv',
    options: inLondon,
    dialect: { delimiter: ';', decimal: ',' },
    sessionCount: 1,
    repCount: 1,
    repTimes: [3.00],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: false,
  },
  {
    // Speed in m/s units
    name: 'speed in m/s (;, decimal comma, day-first)',
    fixture: 'speed-mps.csv',
    options: inLondon,
    dialect: { delimiter: ';', decimal: ',' },
    sessionCount: 1,
    repCount: 2,
    repTimes: [3.42, 3.38],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: true,
  },
  {
    // European thousands separator (dot as thousands, comma as decimal)
    name: 'thousands separator (;, decimal comma, dot thousands)',
    fixture: 'thousands-separator.csv',
    options: inLondon,
    dialect: { delimiter: ';', decimal: ',' },
    sessionCount: 2,
    repCount: 1,
    repTimes: [3.42],
    startedAt: '2026-08-29T10:14:03+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: true,
  },
  {
    // Cross-midnight session
    name: 'crosses midnight (;, decimal comma, day-first)',
    fixture: 'crosses-midnight.csv',
    options: inLondon,
    dialect: { delimiter: ';', decimal: ',' },
    sessionCount: 1,
    repCount: 6,
    repTimes: [3.42, 3.38, 3.51, 3.35, 3.44, 3.61],
    startedAt: '2026-08-29T23:10:00+01:00',
    distanceM: 30,
    exerciseName: 'Flying 30m',
    speedPresent: false,
  },
]

describe('locale and separator matrix (T1)', () => {
  describe.each(MATRIX)('$name', (testCase) => {
    const csv = csvFixture(testCase.fixture)

    it('detects the expected dialect', () => {
      const inspection = inspectCsv(csv)

      expect(inspection.dialect).toEqual(testCase.dialect)
    })

    it('reads the expected number of sessions and reps', () => {
      const sessions = readSessions(csv, testCase.options)

      expect(sessions).toHaveLength(testCase.sessionCount)
      const first = sessions[0]!
      expect(first.reps).toHaveLength(testCase.repCount)
    })

    it('parses rep times to the millisecond', () => {
      const sessions = readSessions(csv, testCase.options)
      const first = sessions[0]!
      const times = first.reps.map((rep) => rep.totalS)

      expect(times).toEqual(testCase.repTimes)
    })

    it('resolves the session start instant', () => {
      const sessions = readSessions(csv, testCase.options)

      expect(sessions[0]!.startedAt).toBe(testCase.startedAt)
    })

    it('detects speed presence correctly', () => {
      const sessions = readSessions(csv, testCase.options)
      const first = sessions[0]!

      if (testCase.speedPresent) {
        expect(first.reps[0]!.avgSpeedMps).toBeGreaterThan(0)
      } else {
        expect(first.distanceM).not.toBeNull()
        const derived = first.distanceM! / first.reps[0]!.totalS
        expect(first.reps[0]!.avgSpeedMps).toBeCloseTo(derived, 2)
      }
    })

    it('identifies the exercise and distance', () => {
      const sessions = readSessions(csv, testCase.options)
      const first = sessions[0]!

      expect(first.exerciseName).toBe(testCase.exerciseName)
      expect(first.distanceM).toBe(testCase.distanceM)
    })
  })

  describe('ambiguous dates (R5)', () => {
    const ambiguousCsv = [
      'Date;Time;Exercise;Run;Total time (s)',
      '05/06/2026;10:00:00;Sprint;1;3,42',
    ].join('\n')

    it('resolves as day-first when dateOrder is day-first', () => {
      const [session] = readSessions(ambiguousCsv, {
        ...inLondon,
        dateOrder: 'day-first',
      })

      expect(session!.startedAt).toBe('2026-06-05T10:00:00+01:00')
    })

    it('resolves as month-first when dateOrder is month-first', () => {
      const [session] = readSessions(ambiguousCsv, {
        ...inLondon,
        dateOrder: 'month-first',
      })

      expect(session!.startedAt).toBe('2026-05-06T10:00:00+01:00')
    })

    it('forces day-first when the day component exceeds 12', () => {
      const unambiguousCsv = [
        'Date;Time;Exercise;Run;Total time (s)',
        '29/08/2026;10:00:00;Sprint;1;3,42',
      ].join('\n')
      const [session] = readSessions(unambiguousCsv, {
        ...inLondon,
        dateOrder: 'month-first',
      })

      expect(session!.startedAt).toBe('2026-08-29T10:00:00+01:00')
    })
  })

  describe('unmapped columns (R5)', () => {
    it('surfaces unmapped columns in inspectCsv', () => {
      const csv = csvFixture('extra-column.csv')
      const inspection = inspectCsv(csv)

      expect(inspection.unmapped).toEqual([
        { column: 7, header: 'Heart Rate' },
      ])
    })
  })

  describe('fingerprint stability (R6)', () => {
    it('produces the same fingerprint for the same headers', () => {
      const a = inspectCsv(csvFixture('flying-30m-semicolon.csv'))
      const b = inspectCsv(csvFixture('flying-30m-semicolon.csv'))

      expect(a.fingerprint).toBe(b.fingerprint)
      expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    })

    it('produces different fingerprints for different header sets', () => {
      const eu = inspectCsv(csvFixture('flying-30m-semicolon.csv'))
      const minimal = inspectCsv(csvFixture('no-speed-columns.csv'))
      const french = inspectCsv(csvFixture('french-semicolon.csv'))

      expect(eu.fingerprint).not.toBe(minimal.fingerprint)
      expect(eu.fingerprint).not.toBe(french.fingerprint)
    })

    it('same headers in different delimiters produce the same fingerprint', () => {
      const semi = inspectCsv(csvFixture('flying-30m-semicolon.csv'))
      const comma = inspectCsv(csvFixture('flying-30m-us.csv'))
      const tab = inspectCsv(csvFixture('tab-separated.csv'))

      expect(semi.fingerprint).toBe(comma.fingerprint)
      expect(semi.fingerprint).toBe(tab.fingerprint)
    })
  })

  describe('speed unit extraction', () => {
    it('reads m/s speed columns without converting', () => {
      const [session] = readSessions(
        csvFixture('speed-mps.csv'),
        inLondon,
      )

      expect(session!.reps[0]).toMatchObject({
        avgSpeedMps: 8.772,
        maxSpeedMps: 9.278,
      })
    })
  })

  describe('thousands separator in distances', () => {
    it('reads 1.500 as 1500m when the decimal mark is comma', () => {
      const sessions = readSessions(
        csvFixture('thousands-separator.csv'),
        inLondon,
      )
      const long = sessions.find((s) => s.exerciseName === '1.500m')

      expect(long!.distanceM).toBe(1500)
      expect(long!.reps[0]!.totalS).toBe(312.50)
    })
  })
})
