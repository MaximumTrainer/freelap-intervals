import { describe, expect, it } from 'vitest'

import { AdapterDegradedError } from '~/ingest/freelap-source'
import {
  readSessionDetail,
  readSessionList,
} from '~/ingest/myfreelap/myfreelap-payloads'

import {
  aPayloadListEntry,
  aPayloadRun,
  aPayloadSessionDetail,
  aPayloadSessionList,
  without,
} from '../../support/myfreelap-fixtures'

const SOURCE = 'test'

interface DetailThrowCase {
  readonly name: string
  readonly payload: Record<string, unknown>
  readonly errorContains: string
}

interface DetailSuccessCase {
  readonly name: string
  readonly payload: Record<string, unknown>
  readonly runCount: number
  readonly skippedCount: number
}

interface ListThrowCase {
  readonly name: string
  readonly payload: Record<string, unknown>
  readonly errorContains: string
}

interface ListSuccessCase {
  readonly name: string
  readonly payload: Record<string, unknown>
  readonly entryCount: number
}

const DETAIL_THROW_CASES: readonly DetailThrowCase[] = [
  {
    name: 'runs field missing',
    payload: without(aPayloadSessionDetail(), 'runs'),
    errorContains: 'no runs',
  },
  {
    name: 'runs not an array',
    payload: aPayloadSessionDetail({ runs: 'none' }),
    errorContains: 'no runs',
  },
  {
    name: 'runs as null',
    payload: aPayloadSessionDetail({ runs: null }),
    errorContains: 'no runs',
  },
  {
    name: 'zero runs',
    payload: aPayloadSessionDetail({ runs: [] }),
    errorContains: 'no runs',
  },
  {
    name: 'session id null',
    payload: aPayloadSessionDetail({ id: null }),
    errorContains: 'session id',
  },
  {
    name: 'session id missing',
    payload: without(aPayloadSessionDetail(), 'id'),
    errorContains: 'session id',
  },
  {
    name: 'all reps malformed',
    payload: aPayloadSessionDetail({
      runs: [
        aPayloadRun({ time_s: null }),
        aPayloadRun({ time_s: 'not-a-number', timestamp: '2026-08-29T10:16:31' }),
      ],
    }),
    errorContains: 'every run',
  },
]

const DETAIL_SUCCESS_CASES: readonly DetailSuccessCase[] = [
  {
    name: 'valid payload',
    payload: aPayloadSessionDetail(),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'number as string (time_s: "3.42")',
    payload: aPayloadSessionDetail({ runs: [aPayloadRun({ time_s: '3.42' })] }),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'string as number (id: 77123)',
    payload: aPayloadSessionDetail({ id: 77123 }),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'extra unknown field on run',
    payload: aPayloadSessionDetail({
      runs: [aPayloadRun({ reaction_time: 0.15 })],
    }),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'extra unknown field on session',
    payload: aPayloadSessionDetail({ tracking_id: 'abc123' }),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'splits as non-array string',
    payload: aPayloadSessionDetail({
      runs: [aPayloadRun({ splits: 'none' })],
    }),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'splits as object instead of array (nested type mismatch)',
    payload: aPayloadSessionDetail({
      runs: [aPayloadRun({ splits: { distance_m: 10, time_s: 1.21 } })],
    }),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'null optional speed fields',
    payload: aPayloadSessionDetail({
      runs: [aPayloadRun({ avg_speed_kmh: null, max_speed_kmh: null })],
    }),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'missing optional distance',
    payload: without(aPayloadSessionDetail(), 'distance_m'),
    runCount: 1,
    skippedCount: 0,
  },
  {
    name: 'one malformed rep among three (R3)',
    payload: aPayloadSessionDetail({
      runs: [
        aPayloadRun({ timestamp: '2026-08-29T10:14:03' }),
        aPayloadRun({ time_s: null, timestamp: '2026-08-29T10:16:31' }),
        aPayloadRun({ timestamp: '2026-08-29T10:19:02' }),
      ],
    }),
    runCount: 2,
    skippedCount: 1,
  },
  {
    name: 'field renamed on one rep (time_s → duration)',
    payload: aPayloadSessionDetail({
      runs: [
        aPayloadRun({ timestamp: '2026-08-29T10:14:03' }),
        {
          ...without(aPayloadRun({ timestamp: '2026-08-29T10:16:31' }), 'time_s'),
          duration: 3.42,
        },
        aPayloadRun({ timestamp: '2026-08-29T10:19:02' }),
      ],
    }),
    runCount: 2,
    skippedCount: 1,
  },
]

const LIST_THROW_CASES: readonly ListThrowCase[] = [
  {
    name: 'sessions field missing',
    payload: {},
    errorContains: 'no sessions array',
  },
  {
    name: 'sessions not an array',
    payload: { sessions: 'oops' },
    errorContains: 'no sessions array',
  },
  {
    name: 'sessions as null',
    payload: { sessions: null },
    errorContains: 'no sessions array',
  },
]

const LIST_SUCCESS_CASES: readonly ListSuccessCase[] = [
  {
    name: 'empty sessions array',
    payload: aPayloadSessionList([]),
    entryCount: 0,
  },
  {
    name: 'valid payload',
    payload: aPayloadSessionList(),
    entryCount: 1,
  },
  {
    name: 'extra field on entry',
    payload: aPayloadSessionList([aPayloadListEntry({ tracking_id: 'xyz' })]),
    entryCount: 1,
  },
  {
    name: 'number as string (run_count: "6")',
    payload: aPayloadSessionList([aPayloadListEntry({ run_count: '6' })]),
    entryCount: 1,
  },
  {
    name: 'string as number (id: 77123)',
    payload: aPayloadSessionList([aPayloadListEntry({ id: 77123 })]),
    entryCount: 1,
  },
  {
    name: 'one bad entry among three (R3)',
    payload: aPayloadSessionList([
      aPayloadListEntry(),
      aPayloadListEntry({ id: null }),
      aPayloadListEntry({ id: '77125' }),
    ]),
    entryCount: 2,
  },
]

describe('malformed MyFreelap payloads (T3)', () => {
  describe('readSessionDetail — structural failures', () => {
    it.each(DETAIL_THROW_CASES)(
      '$name → throws AdapterDegradedError',
      ({ payload, errorContains }) => {
        const act = () =>
          readSessionDetail(payload, SOURCE)

        expect(act).toThrow(AdapterDegradedError)
        expect(act).toThrow(errorContains)
      },
    )
  })

  describe('readSessionDetail — graceful handling', () => {
    it.each(DETAIL_SUCCESS_CASES)(
      '$name → $runCount runs, $skippedCount skipped',
      ({ payload, runCount, skippedCount }) => {
        const result = readSessionDetail(
          payload,
          SOURCE,
        )

        expect(result.runs).toHaveLength(runCount)
        expect(result.skippedRuns).toHaveLength(skippedCount)
      },
    )
  })

  describe('readSessionList — structural failures', () => {
    it.each(LIST_THROW_CASES)(
      '$name → throws AdapterDegradedError',
      ({ payload, errorContains }) => {
        const act = () =>
          readSessionList(payload, SOURCE)

        expect(act).toThrow(AdapterDegradedError)
        expect(act).toThrow(errorContains)
      },
    )
  })

  describe('readSessionList — graceful handling', () => {
    it.each(LIST_SUCCESS_CASES)(
      '$name → $entryCount entries',
      ({ payload, entryCount }) => {
        const result = readSessionList(
          payload,
          SOURCE,
        )

        expect(result).toHaveLength(entryCount)
      },
    )
  })

  describe('no fabricated zeros (R4)', () => {
    it('null distance stays null, not zero', () => {
      const result = readSessionDetail(
        aPayloadSessionDetail({ distance_m: null }),
        SOURCE,
      )

      expect(result.distanceM).toBeNull()
    })

    it('null optional speeds stay null, not zero', () => {
      const result = readSessionDetail(
        aPayloadSessionDetail({
          runs: [aPayloadRun({ avg_speed_kmh: null, max_speed_kmh: null })],
        }),
        SOURCE,
      )

      expect(result.runs[0]!.avgSpeedKmh).toBeNull()
      expect(result.runs[0]!.maxSpeedKmh).toBeNull()
    })

    it('missing distance stays null, not zero', () => {
      const result = readSessionDetail(
        without(
          aPayloadSessionDetail(),
          'distance_m',
        ),
        SOURCE,
      )

      expect(result.distanceM).toBeNull()
    })
  })

  describe('degradation reasons contain no athlete data (R5)', () => {
    it('error messages name the field, not the athlete', () => {
      const act = () =>
        readSessionDetail(
          aPayloadSessionDetail({
            id: null,
            athlete: 'Jane Doe',
          }),
          SOURCE,
        )

      expect(act).toThrow('session id')
      expect(act).not.toThrow('Jane Doe')
    })

    it('skipped-run reasons name the field, not the athlete', () => {
      const result = readSessionDetail(
        aPayloadSessionDetail({
          athlete: 'Jane Doe',
          runs: [
            aPayloadRun({ timestamp: '2026-08-29T10:14:03' }),
            aPayloadRun({
              time_s: null,
              timestamp: '2026-08-29T10:16:31',
            }),
          ],
        }),
        SOURCE,
      )

      expect(result.skippedRuns[0]!.reason).toContain('time')
      expect(result.skippedRuns[0]!.reason).not.toContain('Jane Doe')
    })

    it('session-list skip does not leak athlete data', () => {
      const result = readSessionList(
        aPayloadSessionList([
          aPayloadListEntry(),
          aPayloadListEntry({ id: null, athlete: 'Jane Doe' }),
        ]),
        SOURCE,
      )

      expect(result).toHaveLength(1)
    })
  })
})
