import { describe, expect, it } from 'vitest'

import { RateLimiter } from '~/web/rate-limiter'

describe('RateLimiter', () => {
  it('allows requests up to the configured maximum', () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 })

    expect(limiter.allow('client-a')).toBe(true)
    expect(limiter.allow('client-a')).toBe(true)
    expect(limiter.allow('client-a')).toBe(true)
    expect(limiter.allow('client-a')).toBe(false)
  })

  it('tracks different keys independently', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 })

    expect(limiter.allow('client-a')).toBe(true)
    expect(limiter.allow('client-b')).toBe(true)
    expect(limiter.allow('client-a')).toBe(false)
  })

  it('resets after the window expires', () => {
    let nowMs = 1000
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: () => nowMs,
    })

    expect(limiter.allow('client-a')).toBe(true)
    expect(limiter.allow('client-a')).toBe(false)

    nowMs += 60_001
    expect(limiter.allow('client-a')).toBe(true)
  })

  it('reports the number of seconds until retry is possible', () => {
    let nowMs = 0
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: () => nowMs,
    })

    limiter.allow('client-a')
    nowMs += 10_000

    expect(limiter.retryAfterS('client-a')).toBe(50)
  })
})
