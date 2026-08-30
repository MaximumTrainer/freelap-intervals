import { describe, expect, it } from 'vitest'

import { epochMsOfLocal, toLocalIso, toZonedIso } from '~/domain/zoned-time'

const tenFourteen = { year: 2026, month: 8, day: 29, hour: 10, minute: 14, second: 3 }

describe('toZonedIso', () => {
  it('applies the summer offset of the athlete timezone', () => {
    expect(toZonedIso(tenFourteen, 'Europe/London')).toBe('2026-08-29T10:14:03+01:00')
  })

  it('applies the winter offset for the same zone', () => {
    expect(toZonedIso({ ...tenFourteen, month: 1 }, 'Europe/London')).toBe('2026-01-29T10:14:03+00:00')
  })

  it('handles zones behind UTC', () => {
    expect(toZonedIso(tenFourteen, 'America/New_York')).toBe('2026-08-29T10:14:03-04:00')
  })

  it('handles half-hour offsets', () => {
    expect(toZonedIso(tenFourteen, 'Australia/Adelaide')).toBe('2026-08-29T10:14:03+09:30')
  })

  it('handles UTC itself', () => {
    expect(toZonedIso(tenFourteen, 'UTC')).toBe('2026-08-29T10:14:03+00:00')
  })

  it('rejects an unknown timezone', () => {
    expect(() => toZonedIso(tenFourteen, 'Mars/Olympus')).toThrow(/timezone/i)
  })
})

describe('local times as intervals.icu stores them', () => {
  it('renders an instant in the athlete timezone without an offset suffix', () => {
    expect(toLocalIso(Date.parse('2026-08-29T09:14:03Z'), 'Europe/London')).toBe('2026-08-29T10:14:03')
  })

  it('reads a stored local time back to the instant it names', () => {
    expect(epochMsOfLocal('2026-08-29T10:14:03', 'Europe/London')).toBe(Date.parse('2026-08-29T09:14:03Z'))
  })

  it('round-trips an instant through the athlete timezone', () => {
    const instant = Date.parse('2026-01-15T23:45:00Z')

    expect(epochMsOfLocal(toLocalIso(instant, 'America/New_York'), 'America/New_York')).toBe(instant)
  })

  it('tolerates a stored local time with no seconds', () => {
    expect(epochMsOfLocal('2026-08-29T10:14', 'UTC')).toBe(Date.parse('2026-08-29T10:14:00Z'))
  })
})
