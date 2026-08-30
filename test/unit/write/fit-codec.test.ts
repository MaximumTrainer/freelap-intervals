import { describe, expect, it } from 'vitest'

import { decodeFitActivity, encodeFitActivity } from '~/write/fit'
import type { FitActivityInput } from '~/write/fit'

const startEpochMs = Date.parse('2026-08-29T09:14:03Z')

const anActivity = (): FitActivityInput => ({
  startEpochMs,
  sport: 'running',
  durationS: 151.38,
  totalDistanceM: 60,
  records: [
    { offsetS: 0, distanceM: 0, speedMps: 0 },
    { offsetS: 1, distanceM: 8.264, speedMps: 8.264 },
    { offsetS: 2, distanceM: 17.149, speedMps: 9.05 },
    { offsetS: 151, distanceM: 60, speedMps: 0 },
  ],
  laps: [
    { repIndex: 1, startS: 0, endS: 3.42, distanceM: 30, avgSpeedMps: 8.772, maxSpeedMps: 9.278 },
    { repIndex: 2, startS: 148, endS: 151.38, distanceM: 30, avgSpeedMps: 8.876, maxSpeedMps: 9.389 },
  ],
})

describe('encodeFitActivity', () => {
  it('writes a FIT header declaring its own size, the data size and the .FIT signature', () => {
    const bytes = encodeFitActivity(anActivity())
    const header = Buffer.from(bytes)

    expect(header[0]).toBe(14)
    expect(header.subarray(8, 12).toString('ascii')).toBe('.FIT')
    expect(header.readUInt32LE(4)).toBe(bytes.length - 14 - 2)
  })
})

describe('decodeFitActivity', () => {
  it('accepts a file this encoder produced', () => {
    expect(() => decodeFitActivity(encodeFitActivity(anActivity()))).not.toThrow()
  })

  it('rejects a file whose bytes were tampered with', () => {
    const bytes = encodeFitActivity(anActivity())
    bytes[40] = (bytes[40]! + 1) % 256

    expect(() => decodeFitActivity(bytes)).toThrow(/crc/i)
  })

  it('round-trips the record stream at FIT precision', () => {
    const decoded = decodeFitActivity(encodeFitActivity(anActivity()))

    expect(decoded.records).toHaveLength(4)
    expect(decoded.records[1]).toEqual({
      timestampEpochMs: startEpochMs + 1000,
      distanceM: 8.26, // FIT stores distance in centimetres
      speedMps: 8.264,
    })
    expect(decoded.records[0]?.timestampEpochMs).toBe(startEpochMs)
  })

  it('round-trips one lap per rep', () => {
    const decoded = decodeFitActivity(encodeFitActivity(anActivity()))

    expect(decoded.laps).toHaveLength(2)
    expect(decoded.laps[1]).toEqual({
      startEpochMs: startEpochMs + 148_000,
      totalElapsedS: 3.38,
      distanceM: 30,
      avgSpeedMps: 8.876,
      maxSpeedMps: 9.389,
    })
  })

  it('describes the session as track running', () => {
    const decoded = decodeFitActivity(encodeFitActivity(anActivity()))

    expect(decoded.session).toEqual({
      sport: 'running',
      subSport: 'track',
      startEpochMs,
      totalElapsedS: 151.38,
      totalDistanceM: 60,
      numLaps: 2,
    })
  })

  it('encodes cycling sessions as cycling', () => {
    const decoded = decodeFitActivity(encodeFitActivity({ ...anActivity(), sport: 'cycling' }))

    expect(decoded.session.sport).toBe('cycling')
  })
})
