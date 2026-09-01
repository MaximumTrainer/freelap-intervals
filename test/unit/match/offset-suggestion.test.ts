import { describe, expect, it } from 'vitest'

import { suggestOffset } from '~/match/offset-suggestion'

describe('suggestOffset', () => {
  it('finds a positive offset when speed peaks are shifted later than the rep starts', () => {
    const streamTimes = Array.from({ length: 600 }, (_, i) => i)
    const speeds = streamTimes.map((t) => {
      if (t >= 107 && t <= 110) return 8
      if (t >= 257 && t <= 260) return 8
      if (t >= 407 && t <= 410) return 8
      return 1
    })

    const repWindows = [
      { startS: 100, endS: 103 },
      { startS: 250, endS: 253 },
      { startS: 400, endS: 403 },
    ]

    const result = suggestOffset({ streamTimes, speeds, repWindows, searchRangeS: 120 })

    expect(result).not.toBeNull()
    expect(result!.offsetS).toBeGreaterThanOrEqual(6)
    expect(result!.offsetS).toBeLessThanOrEqual(8)
  })

  it('finds a negative offset when speed peaks are shifted earlier', () => {
    const streamTimes = Array.from({ length: 600 }, (_, i) => i)
    const speeds = streamTimes.map((t) => {
      if (t >= 75 && t <= 78) return 8
      if (t >= 225 && t <= 228) return 8
      if (t >= 375 && t <= 378) return 8
      return 1
    })

    const repWindows = [
      { startS: 100, endS: 103 },
      { startS: 250, endS: 253 },
      { startS: 400, endS: 403 },
    ]

    const result = suggestOffset({ streamTimes, speeds, repWindows, searchRangeS: 120 })

    expect(result).not.toBeNull()
    expect(result!.offsetS).toBeGreaterThanOrEqual(-26)
    expect(result!.offsetS).toBeLessThanOrEqual(-24)
  })

  it('returns null for a flat speed stream', () => {
    const streamTimes = Array.from({ length: 600 }, (_, i) => i)
    const speeds = streamTimes.map(() => 3)

    const result = suggestOffset({
      streamTimes,
      speeds,
      repWindows: [{ startS: 100, endS: 103 }, { startS: 200, endS: 203 }],
      searchRangeS: 120,
    })

    expect(result).toBeNull()
  })

  it('returns null for an all-zero speed stream', () => {
    const streamTimes = Array.from({ length: 600 }, (_, i) => i)
    const speeds = streamTimes.map(() => 0)

    const result = suggestOffset({
      streamTimes,
      speeds,
      repWindows: [{ startS: 100, endS: 103 }],
      searchRangeS: 120,
    })

    expect(result).toBeNull()
  })

  it('returns null when fewer than two reps', () => {
    const streamTimes = Array.from({ length: 600 }, (_, i) => i)
    const speeds = streamTimes.map((t) => (t >= 100 && t <= 103 ? 8 : 1))

    const result = suggestOffset({
      streamTimes,
      speeds,
      repWindows: [{ startS: 100, endS: 103 }],
      searchRangeS: 120,
    })

    expect(result).toBeNull()
  })

  it('returns null when no lag stands out above the confidence gate', () => {
    const streamTimes = Array.from({ length: 600 }, (_, i) => i)
    const speeds = streamTimes.map((t) => (t % 10 < 3 ? 8 : 1))

    const result = suggestOffset({
      streamTimes,
      speeds,
      repWindows: [{ startS: 100, endS: 103 }, { startS: 200, endS: 203 }],
      searchRangeS: 120,
    })

    expect(result).toBeNull()
  })

  it('returns null for empty streams', () => {
    expect(suggestOffset({ streamTimes: [], speeds: [], repWindows: [], searchRangeS: 120 })).toBeNull()
  })

  it('completes within 200 ms for a 10,000-sample stream', () => {
    const streamTimes = Array.from({ length: 10000 }, (_, i) => i)
    const speeds = streamTimes.map((t) => {
      if (t >= 507 && t <= 510) return 8
      if (t >= 1007 && t <= 1010) return 8
      if (t >= 1507 && t <= 1510) return 8
      return 1
    })

    const repWindows = [
      { startS: 500, endS: 503 },
      { startS: 1000, endS: 1003 },
      { startS: 1500, endS: 1503 },
    ]

    const start = performance.now()
    suggestOffset({ streamTimes, speeds, repWindows, searchRangeS: 120 })
    const elapsedMs = performance.now() - start

    expect(elapsedMs).toBeLessThan(200)
  })
})
