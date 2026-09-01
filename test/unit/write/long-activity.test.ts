import { describe, expect, it } from 'vitest'

import type { IcuStreams } from '~/icu/intervals-icu-client'
import { planIntervals, toIcuIntervals } from '~/write/interval-plan'
import { buildTimeline, nearestIndex } from '~/write/session-timeline'

import { aRep, aSession } from '../../support/builders'

/**
 * A deterministic ~10k-sample stream simulating a 3-hour track session at 1 Hz.
 * Sprint peaks of ~9 m/s sit at known offsets so correctness can be asserted.
 */
function longStream(samples: number): IcuStreams {
  const time: number[] = []
  const velocity: number[] = []
  const distance: number[] = []
  let accumulatedM = 0

  for (let second = 0; second < samples; second++) {
    time.push(second)
    const speed = second % 600 < 5 ? 9 : 2
    velocity.push(speed)
    accumulatedM += speed
    distance.push(accumulatedM)
  }

  return { time, distance, velocity_smooth: velocity }
}

const TEN_K = 10_000

function twentyRepSession(originEpochMs: number) {
  const reps = Array.from({ length: 20 }, (_, index) => aRep({
    index: index + 1,
    totalS: 3.42,
    distanceM: 30,
    wallClock: new Date(originEpochMs + (index * 500 + 200) * 1000).toISOString(),
  }))

  return aSession({
    startedAt: new Date(originEpochMs + 200_000).toISOString(),
    reps,
  })
}

describe('nearestIndex on a long stream (T4)', () => {
  const times = Array.from({ length: TEN_K }, (_, second) => second)

  it('finds the correct index at the start of the stream', () => {
    expect(nearestIndex(times, 0)).toBe(0)
    expect(nearestIndex(times, 0.4)).toBe(0)
    expect(nearestIndex(times, 0.6)).toBe(1)
  })

  it('finds the correct index in the middle', () => {
    expect(nearestIndex(times, 5000)).toBe(5000)
    expect(nearestIndex(times, 5000.3)).toBe(5000)
    expect(nearestIndex(times, 5000.7)).toBe(5001)
  })

  it('finds the correct index at the very end', () => {
    expect(nearestIndex(times, 9999)).toBe(9999)
    expect(nearestIndex(times, 9998.6)).toBe(9999)
    expect(nearestIndex(times, 9998.4)).toBe(9998)
  })

  it('resolves an exact midpoint to the lower index', () => {
    expect(nearestIndex(times, 100.5)).toBe(100)
  })

  it('clamps beyond the stream boundaries', () => {
    expect(nearestIndex(times, -100)).toBe(0)
    expect(nearestIndex(times, 20_000)).toBe(9999)
  })
})

describe('toIcuIntervals with a long stream (T4)', () => {
  const streams = longStream(TEN_K)
  const originEpochMs = Date.parse('2026-08-29T10:00:00Z')

  it('maps intervals correctly at start, middle and end of a long activity', () => {
    const session = twentyRepSession(originEpochMs)
    const timeline = buildTimeline(session)
    const planned = planIntervals(session, timeline, { originEpochMs })
    const intervals = toIcuIntervals(planned, streams.time)

    expect(intervals[0]).toMatchObject({ start_index: 200, end_index: 203 })

    const mid = intervals[10]!
    expect(mid.start_index).toBe(5200)
    expect(mid.end_index).toBe(5203)

    const last = intervals[19]!
    expect(last.start_index).toBe(9700)
    expect(last.end_index).toBe(9703)
  })

  it('places a rep whose end falls on the final sample', () => {
    const session = aSession({
      startedAt: new Date(originEpochMs).toISOString(),
      reps: [aRep({
        index: 1,
        totalS: 4,
        distanceM: 30,
        wallClock: new Date(originEpochMs + 9995 * 1000).toISOString(),
      })],
    })
    const timeline = buildTimeline(session)
    const planned = planIntervals(session, timeline, { originEpochMs })
    const intervals = toIcuIntervals(planned, streams.time)

    expect(intervals[0]).toMatchObject({ start_index: 9995, end_index: 9999 })
  })

  it('completes planning and index mapping for 20 reps over 10k samples under 50 ms', () => {
    const session = twentyRepSession(originEpochMs)
    const timeline = buildTimeline(session)
    const planned = planIntervals(session, timeline, { originEpochMs })

    const start = performance.now()
    toIcuIntervals(planned, streams.time)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(50)
  })

  it('does not regress to quadratic: doubling samples costs at most roughly 3x', () => {
    const session = twentyRepSession(originEpochMs)
    const timeline = buildTimeline(session)
    const planned = planIntervals(session, timeline, { originEpochMs })

    const small = longStream(5_000)
    const large = longStream(10_000)

    const runs = 5
    let smallTotal = 0
    let largeTotal = 0

    for (let run = 0; run < runs; run++) {
      const s1 = performance.now()
      toIcuIntervals(planned, small.time)
      smallTotal += performance.now() - s1

      const s2 = performance.now()
      toIcuIntervals(planned, large.time)
      largeTotal += performance.now() - s2
    }

    const ratio = largeTotal / Math.max(smallTotal, 0.01)
    expect(ratio).toBeLessThan(3)
  })
})
