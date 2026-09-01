import { describe, expect, it } from 'vitest'

import { buildTimeline, nearestIndex } from '~/write/session-timeline'

import { aRep, aSession } from '../../support/builders'

const twoTimedReps = aSession({
  reps: [
    aRep({
      index: 1,
      totalS: 3.42,
      distanceM: 30,
      wallClock: '2026-08-29T10:14:03+01:00',
      splits: [
        { atM: 10, elapsedS: 1.21 },
        { atM: 30, elapsedS: 3.42 },
      ],
      avgSpeedMps: 8.772,
      maxSpeedMps: 9.278,
    }),
    aRep({
      index: 2,
      totalS: 3.38,
      distanceM: 30,
      wallClock: '2026-08-29T10:16:31+01:00',
      splits: [{ atM: 30, elapsedS: 3.38 }],
      avgSpeedMps: 8.876,
      maxSpeedMps: 9.389,
    }),
  ],
})

describe('buildTimeline', () => {
  it('places each rep at the offset its wall clock gives, measured from the first rep', () => {
    const timeline = buildTimeline(twoTimedReps)

    expect(timeline.laps.map((lap) => [lap.startS, lap.endS])).toEqual([
      [0, 3.42],
      [148, 151.38],
    ])
  })

  it('spaces reps by a nominal rest when the export carried no time of day', () => {
    const untimed = aSession({
      reps: [aRep({ index: 1, totalS: 3.4 }), aRep({ index: 2, totalS: 3.5 })],
    })

    const timeline = buildTimeline(untimed, { restS: 120 })

    expect(timeline.laps.map((lap) => lap.startS)).toEqual([0, 123.4])
  })

  it('samples the whole session at 1 Hz, ending on the last rep', () => {
    const timeline = buildTimeline(twoTimedReps)

    expect(timeline.records[0]).toEqual({ offsetS: 0, distanceM: 0, speedMps: 0 })
    expect(timeline.records.at(-1)?.offsetS).toBe(152)
    expect(timeline.records).toHaveLength(153)
  })

  it('advances distance only while a rep is running', () => {
    const timeline = buildTimeline(twoTimedReps)
    const distanceAt = (offsetS: number): number | undefined =>
      timeline.records.find((record) => record.offsetS === offsetS)?.distanceM

    expect(distanceAt(1)).toBeCloseTo(8.264, 2) // 10m in 1.21s → 8.26m/s over the first metre
    expect(distanceAt(4)).toBe(30)
    expect(distanceAt(100)).toBe(30) // resting
    expect(timeline.records.at(-1)?.distanceM).toBe(60)
  })

  it('rests at zero speed between reps', () => {
    const timeline = buildTimeline(twoTimedReps)

    expect(timeline.records.find((record) => record.offsetS === 60)?.speedMps).toBe(0)
    expect(timeline.records.find((record) => record.offsetS === 2)?.speedMps).toBeGreaterThan(9)
  })

  it('summarises each lap from the rep it came from', () => {
    expect(buildTimeline(twoTimedReps).laps[0]).toMatchObject({
      repIndex: 1,
      distanceM: 30,
      avgSpeedMps: 8.772,
      maxSpeedMps: 9.278,
    })
  })

  it('derives lap speeds when the export carried none', () => {
    const timeline = buildTimeline(aSession({ reps: [aRep({ index: 1, totalS: 3, distanceM: 30 })] }))

    expect(timeline.laps[0]).toMatchObject({ avgSpeedMps: 10, maxSpeedMps: 10 })
  })
})

describe('nearestIndex', () => {
  const times = [0, 1, 2, 3, 4, 5]

  it('finds the sample closest to a moment in time', () => {
    expect(nearestIndex(times, 3.42)).toBe(3)
    expect(nearestIndex(times, 3.51)).toBe(4)
  })

  it('clamps to the ends of the stream', () => {
    expect(nearestIndex(times, -10)).toBe(0)
    expect(nearestIndex(times, 99)).toBe(5)
  })

  it('throws on an empty array rather than returning a misleading zero', () => {
    expect(() => nearestIndex([], 3)).toThrow(/empty/)
  })
})
