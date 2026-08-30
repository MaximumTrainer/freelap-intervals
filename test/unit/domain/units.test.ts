import { describe, expect, it } from 'vitest'

import { kmhToMps, mpsToKmh, roundTo } from '~/domain/units'

describe('units', () => {
  it('converts km/h to m/s', () => {
    expect(kmhToMps(36)).toBe(10)
    expect(kmhToMps(31.6)).toBeCloseTo(8.778, 3)
  })

  it('converts m/s back to km/h', () => {
    expect(mpsToKmh(10)).toBe(36)
  })

  it('round-trips a speed without drifting', () => {
    expect(roundTo(mpsToKmh(kmhToMps(33.4)), 1)).toBe(33.4)
  })

  it('rounds half away from zero at the requested precision', () => {
    expect(roundTo(3.4516666, 3)).toBe(3.452)
    expect(roundTo(1.005, 2)).toBe(1.01)
    expect(roundTo(-1.005, 2)).toBe(-1.01)
  })
})
