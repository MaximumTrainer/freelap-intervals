import { describe, expect, it } from 'vitest'

import { formatSeconds } from '~/domain/duration'
import { parseDurationSeconds } from '~/ingest/csv/cells'

describe('parseDurationSeconds', () => {
  it('reads plain seconds', () => {
    expect(parseDurationSeconds('3.42', '.')).toBe(3.42)
  })

  it('reads seconds written with a decimal comma', () => {
    expect(parseDurationSeconds('3,42', ',')).toBe(3.42)
  })

  it('reads minutes and seconds', () => {
    expect(parseDurationSeconds('1:02.34', '.')).toBe(62.34)
  })

  it('reads hours, minutes and seconds', () => {
    expect(parseDurationSeconds('1:01:02,5', ',')).toBe(3662.5)
  })

  it('treats blank cells as absent', () => {
    expect(parseDurationSeconds('', '.')).toBeNull()
    expect(parseDurationSeconds('  -  ', '.')).toBeNull()
  })

  it('rejects text that is not a duration', () => {
    expect(() => parseDurationSeconds('DNF', '.')).toThrow(/duration/i)
  })
})

describe('formatSeconds', () => {
  it('renders sprint times to hundredths', () => {
    expect(formatSeconds(3.4)).toBe('3.40')
    expect(formatSeconds(3.456)).toBe('3.46')
  })
})
