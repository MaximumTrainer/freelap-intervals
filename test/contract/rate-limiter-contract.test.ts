import { describe, expect, it } from 'vitest'

import { PgRateLimiter } from '~/db/pg-rate-limiter'
import type { OutboundRateLimiter } from '~/outbound-rate-limiter'
import { InMemoryRateLimiter } from '~/outbound-rate-limiter'

import { aTestDatabase } from '../support/test-database'

interface LimiterFactory {
  create(options: { ratePerSecond: number; burst: number }): Promise<{
    limiter: OutboundRateLimiter
    close: () => Promise<void>
  }>
}

function describeLimiterContract(name: string, factory: LimiterFactory): void {
  describe(`${name}: rate limiter contract (S6)`, () => {
    it('allows burst requests without waiting', async () => {
      const { limiter, close } = await factory.create({ ratePerSecond: 10, burst: 3 })

      try {
        await limiter.acquire('key')
        await limiter.acquire('key')
        await limiter.acquire('key')

        expect(limiter.stats.waits).toBe(0)
      } finally {
        await close()
      }
    })

    it('throttles past the burst', async () => {
      const { limiter, close } = await factory.create({ ratePerSecond: 10, burst: 1 })

      try {
        await limiter.acquire('key')
        await limiter.acquire('key')

        expect(limiter.stats.waits).toBeGreaterThanOrEqual(1)
      } finally {
        await close()
      }
    })

    it('isolates keys', async () => {
      const { limiter, close } = await factory.create({ ratePerSecond: 10, burst: 1 })

      try {
        await limiter.acquire('a')
        await limiter.acquire('b')

        expect(limiter.stats.waits).toBe(0)
      } finally {
        await close()
      }
    })

    it('reports stats', async () => {
      const { limiter, close } = await factory.create({ ratePerSecond: 10, burst: 1 })

      try {
        await limiter.acquire('key')
        await limiter.acquire('key')

        expect(limiter.stats.waits).toBeGreaterThanOrEqual(1)
        expect(limiter.stats.totalWaitMs).toBeGreaterThanOrEqual(0)
      } finally {
        await close()
      }
    })
  })
}

describeLimiterContract('in-memory', {
  async create(options) {
    return {
      limiter: new InMemoryRateLimiter(options),
      close: async () => {},
    }
  },
})

describeLimiterContract('postgres', {
  async create(options) {
    const db = await aTestDatabase()

    return {
      limiter: new PgRateLimiter(db, options),
      close: () => db.close(),
    }
  },
})
