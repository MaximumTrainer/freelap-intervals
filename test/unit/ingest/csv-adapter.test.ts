import { describe, expect, it } from 'vitest'

import { readSessions } from '~/ingest/csv/csv-adapter'

import { csvFixture } from '../../support/fixtures'

const inLondon = { timezone: 'Europe/London' }

describe('readSessions', () => {
  it('normalises a European export into one canonical session', () => {
    const [session] = readSessions(csvFixture('flying-30m-semicolon.csv'), inLondon)

    expect(session).toMatchObject({
      athleteRef: 'Dan Wood',
      exerciseName: 'Flying 30m',
      sport: 'run',
      distanceM: 30,
      startedAt: '2026-08-29T10:14:03+01:00',
      summary: { count: 6, bestS: 3.35, worstS: 3.61, avgS: 3.452 },
    })
  })

  it('carries each rep with its splits, wall clock and speeds in canonical units', () => {
    const [session] = readSessions(csvFixture('flying-30m-semicolon.csv'), inLondon)

    expect(session?.reps[3]).toEqual({
      index: 4,
      wallClock: '2026-08-29T10:21:44+01:00',
      totalS: 3.35,
      distanceM: 30,
      splits: [
        { atM: 10, elapsedS: 1.18 },
        { atM: 30, elapsedS: 3.35 },
      ],
      avgSpeedMps: 8.944,
      maxSpeedMps: 9.472,
    })
  })

  it('reads a US export with commas, dots and month-first dates as the same session', () => {
    const [european] = readSessions(csvFixture('flying-30m-semicolon.csv'), inLondon)
    const [american] = readSessions(csvFixture('flying-30m-us.csv'), { ...inLondon, dateOrder: 'month-first' })

    expect(american).toEqual(european)
  })

  it('gives the same session the same source id whichever way it was exported', () => {
    const [european] = readSessions(csvFixture('flying-30m-semicolon.csv'), inLondon)
    const [american] = readSessions(csvFixture('flying-30m-us.csv'), { ...inLondon, dateOrder: 'month-first' })

    expect(american?.sourceId).toBe(european?.sourceId)
    expect(european?.sourceId).toMatch(/^csv-[0-9a-f]{12}$/)
  })

  it('splits a multi-session export by day and exercise, oldest first', () => {
    const sessions = readSessions(csvFixture('two-sessions.csv'), inLondon)

    expect(sessions.map((session) => [session.exerciseName, session.reps.length])).toEqual([
      ['Flying 30m', 2],
      ['60m from blocks', 1],
      ['Flying 30m', 1],
    ])
    expect(new Set(sessions.map((session) => session.sourceId)).size).toBe(3)
  })

  it('derives average speed from distance and time when the export omits speed columns', () => {
    const [session] = readSessions(csvFixture('no-speed-columns.csv'), inLondon)

    expect(session?.reps[0]).toMatchObject({ avgSpeedMps: 10, maxSpeedMps: null })
    expect(session?.athleteRef).toBe('unknown')
  })

  it('keeps a session that spans midnight as one session', () => {
    const sessions = readSessions(csvFixture('crosses-midnight.csv'), inLondon)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.reps).toHaveLength(6)
    expect(sessions[0]?.startedAt).toBe('2026-08-29T23:10:00+01:00')
  })

  it('still splits genuinely separate sessions on the same day', () => {
    const sessions = readSessions(csvFixture('two-sessions.csv'), inLondon)

    expect(sessions.map((session) => [session.exerciseName, session.reps.length])).toEqual([
      ['Flying 30m', 2],
      ['60m from blocks', 1],
      ['Flying 30m', 1],
    ])
  })

  it('groups reverse-ordered reps the same as forward-ordered', () => {
    const csv = [
      'Date;Time;Exercise;Run;Total time (s)',
      '29/08/2026;10:19:02;Flying 30m;3;3,51',
      '29/08/2026;10:14:03;Flying 30m;1;3,42',
      '29/08/2026;10:16:31;Flying 30m;2;3,38',
    ].join('\n')
    const sessions = readSessions(csv, inLondon)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.reps).toHaveLength(3)
  })

  it('falls back to date grouping when wall clocks are missing', () => {
    const csv = [
      'Date;Exercise;Run;Total time (s)',
      '29/08/2026;Flying 30m;1;3,42',
      '30/08/2026;Flying 30m;2;3,38',
    ].join('\n')
    const sessions = readSessions(csv, inLondon)

    expect(sessions).toHaveLength(2)
  })

  it('rejects an export with a header but no rows', () => {
    expect(() => readSessions('Date;Run;Total time (s)', inLondon)).toThrow(/no rows/i)
  })

  it('rejects an export whose time cells are unreadable', () => {
    const csv = 'Date;Run;Total time (s)\n29/08/2026;1;DNF'

    expect(() => readSessions(csv, inLondon)).toThrow(/row 2/i)
  })
})
