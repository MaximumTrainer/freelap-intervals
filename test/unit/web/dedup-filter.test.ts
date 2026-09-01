import { describe, expect, it } from 'vitest'

import { DedupFilter } from '~/web/dedup-filter'

describe('DedupFilter', () => {
  it('passes the first occurrence and rejects duplicates within the window', () => {
    const filter = new DedupFilter({ windowMs: 60_000 })

    expect(filter.isDuplicate('event-1')).toBe(false)
    expect(filter.isDuplicate('event-1')).toBe(true)
    expect(filter.isDuplicate('event-1')).toBe(true)
  })

  it('tracks different keys independently', () => {
    const filter = new DedupFilter({ windowMs: 60_000 })

    expect(filter.isDuplicate('event-1')).toBe(false)
    expect(filter.isDuplicate('event-2')).toBe(false)
    expect(filter.isDuplicate('event-1')).toBe(true)
  })

  it('allows an event again after the window expires', () => {
    let nowMs = 1000
    const filter = new DedupFilter({
      windowMs: 60_000,
      now: () => nowMs,
    })

    expect(filter.isDuplicate('event-1')).toBe(false)

    nowMs += 60_001
    expect(filter.isDuplicate('event-1')).toBe(false)
  })

  it('sweeps expired entries on each check', () => {
    let nowMs = 1000
    const filter = new DedupFilter({
      windowMs: 10_000,
      now: () => nowMs,
    })

    filter.isDuplicate('event-1')
    filter.isDuplicate('event-2')

    nowMs += 10_001
    filter.isDuplicate('event-3')

    expect(filter.isDuplicate('event-1')).toBe(false)
    expect(filter.isDuplicate('event-2')).toBe(false)
  })
})
