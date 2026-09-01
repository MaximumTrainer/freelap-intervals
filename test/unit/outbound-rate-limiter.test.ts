import { describe, expect, it } from 'vitest'

import { InMemoryRateLimiter, NoopRateLimiter } from '~/outbound-rate-limiter'

function testClock(startMs = 0) {
  let now = startMs

  return {
    now: () => now,
    advance: (ms: number) => { now += ms },
    sleep: async (ms: number) => { now += ms },
  }
}

function aLimiter(
  options: { ratePerSecond: number; burst: number },
  clock = testClock(),
) {
  return {
    limiter: new InMemoryRateLimiter({
      ...options,
      now: clock.now,
      sleep: clock.sleep,
    }),
    clock,
  }
}

describe('InMemoryRateLimiter', () => {
  describe('burst', () => {
    it('allows burst requests immediately', async () => {
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 10 })

      for (let i = 0; i < 10; i++) {
        await limiter.acquire('key')
      }

      expect(limiter.stats.waits).toBe(0)
    })

    it('makes the request after the burst wait', async () => {
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 10 })

      for (let i = 0; i < 10; i++) {
        await limiter.acquire('key')
      }

      await limiter.acquire('key')

      expect(limiter.stats.waits).toBe(1)
      expect(limiter.stats.totalWaitMs).toBe(200)
    })
  })

  describe('steady state', () => {
    it('spaces requests at the configured rate', async () => {
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 1 })

      await limiter.acquire('key')
      await limiter.acquire('key')
      await limiter.acquire('key')

      expect(limiter.stats.waits).toBe(2)
      expect(limiter.stats.totalWaitMs).toBe(400)
    })
  })

  describe('refill', () => {
    it('refills tokens over time', async () => {
      const clock = testClock()
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 2 }, clock)

      await limiter.acquire('key')
      await limiter.acquire('key')

      clock.advance(400)

      await limiter.acquire('key')
      await limiter.acquire('key')

      expect(limiter.stats.waits).toBe(0)
    })

    it('does not exceed the burst cap on refill', async () => {
      const clock = testClock()
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 3 }, clock)

      clock.advance(10_000)

      await limiter.acquire('key')
      await limiter.acquire('key')
      await limiter.acquire('key')
      await limiter.acquire('key')

      expect(limiter.stats.waits).toBe(1)
    })
  })

  describe('per-key isolation (R3)', () => {
    it('isolates budgets per key', async () => {
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 2 })

      await limiter.acquire('athlete:a')
      await limiter.acquire('athlete:a')
      await limiter.acquire('athlete:b')
      await limiter.acquire('athlete:b')

      expect(limiter.stats.waits).toBe(0)
    })

    it('one throttled key does not affect another', async () => {
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 1 })

      await limiter.acquire('athlete:a')
      await limiter.acquire('athlete:a')

      expect(limiter.stats.waits).toBe(1)

      await limiter.acquire('athlete:b')

      expect(limiter.stats.waits).toBe(1)
    })
  })

  describe('Retry-After draining (R6)', () => {
    it('blocks requests for the drained duration', async () => {
      const clock = testClock()
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 10 }, clock)

      limiter.drainUntil('key', 30_000)

      const before = clock.now()
      await limiter.acquire('key')
      const after = clock.now()

      expect(after - before).toBeGreaterThanOrEqual(30_000)
    })

    it('resumes normally after the drain period', async () => {
      const clock = testClock()
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 10 }, clock)

      limiter.drainUntil('key', 1_000)
      clock.advance(1_000)

      await limiter.acquire('key')

      expect(limiter.stats.waits).toBe(1)
    })

    it('does not affect other keys', async () => {
      const clock = testClock()
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 10 }, clock)

      limiter.drainUntil('athlete:a', 30_000)

      await limiter.acquire('athlete:b')

      expect(limiter.stats.waits).toBe(0)
    })
  })

  describe('abort signal (R8)', () => {
    it('throws immediately when the signal is already aborted', async () => {
      const { limiter } = aLimiter({ ratePerSecond: 1, burst: 1 })

      await limiter.acquire('key')

      const controller = new AbortController()
      controller.abort(new Error('shutdown'))

      await expect(
        limiter.acquire('key', { signal: controller.signal }),
      ).rejects.toThrow('shutdown')
    })
  })

  describe('observability (R7)', () => {
    it('tracks waits and total wait time', async () => {
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 1 })

      await limiter.acquire('key')
      await limiter.acquire('key')
      await limiter.acquire('key')

      expect(limiter.stats).toEqual({ waits: 2, totalWaitMs: 400 })
    })

    it('starts at zero', () => {
      const { limiter } = aLimiter({ ratePerSecond: 5, burst: 10 })

      expect(limiter.stats).toEqual({ waits: 0, totalWaitMs: 0 })
    })
  })
})

describe('NoopRateLimiter', () => {
  it('never blocks', async () => {
    const limiter = new NoopRateLimiter()

    for (let i = 0; i < 100; i++) {
      await limiter.acquire('key')
    }

    expect(limiter.stats).toEqual({ waits: 0, totalWaitMs: 0 })
  })
})
