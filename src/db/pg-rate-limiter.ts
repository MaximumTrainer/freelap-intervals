import type { Database } from '~/db/database'
import type { AcquireOptions, OutboundRateLimiter, RateLimiterStats, TokenBucketOptions } from '~/outbound-rate-limiter'

/**
 * Postgres-backed token-bucket rate limiter. Each key maps to a row in `rate_limiter_buckets`
 * so two processes sharing the same database stay within the combined budget.
 */
export class PgRateLimiter implements OutboundRateLimiter {
  private readonly ratePerMs: number
  private readonly burst: number
  private readonly db: Database
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private _waits = 0
  private _totalWaitMs = 0

  constructor(db: Database, options: TokenBucketOptions) {
    this.db = db
    this.ratePerMs = options.ratePerSecond / 1000
    this.burst = options.burst
    this.sleep = options.sleep ?? defaultSleep
  }

  get stats(): RateLimiterStats {
    return { waits: this._waits, totalWaitMs: this._totalWaitMs }
  }

  async acquire(key: string, options?: AcquireOptions): Promise<void> {
    const cost = options?.cost ?? 1
    const signal = options?.signal

    while (true) {
      signal?.throwIfAborted()

      const result = await this.tryConsume(key, cost)

      if (result.consumed) return

      this._waits += 1
      this._totalWaitMs += result.waitMs

      await this.sleep(result.waitMs, signal)
    }
  }

  drainUntil(key: string, durationMs: number): void {
    const drainedUntil = new Date(Date.now() + durationMs)

    void this.db.transaction(async (tx) => {
      await this.ensureBucket(tx, key)

      await tx.query(
        `UPDATE rate_limiter_buckets
            SET tokens = 0, drained_until = $1
          WHERE key = $2`,
        [drainedUntil, key],
      )
    })
  }

  private async tryConsume(
    key: string,
    cost: number,
  ): Promise<{ consumed: true } | { consumed: false; waitMs: number }> {
    return this.db.transaction(async (tx) => {
      await this.ensureBucket(tx, key)

      const { rows } = await tx.query<BucketRow>(
        `SELECT tokens, last_refill, drained_until
           FROM rate_limiter_buckets
          WHERE key = $1`,
        [key],
      )

      const bucket = rows[0]
      if (!bucket) return { consumed: false, waitMs: 100 }

      const now = Date.now()
      const drainedUntilMs = new Date(bucket.drained_until).getTime()

      if (now < drainedUntilMs) {
        return { consumed: false, waitMs: drainedUntilMs - now }
      }

      const refillStartMs = Math.max(new Date(bucket.last_refill).getTime(), drainedUntilMs)
      const elapsedMs = now - refillStartMs
      const tokens = Math.min(this.burst, bucket.tokens + Math.max(0, elapsedMs) * this.ratePerMs)

      if (tokens >= cost) {
        await tx.query(
          `UPDATE rate_limiter_buckets
              SET tokens = $1, last_refill = $2
            WHERE key = $3`,
          [tokens - cost, new Date(now), key],
        )

        return { consumed: true }
      }

      const deficit = cost - tokens
      const waitMs = Math.ceil(deficit / this.ratePerMs)

      return { consumed: false, waitMs }
    })
  }

  private async ensureBucket(tx: { query: Database['query'] }, key: string): Promise<void> {
    await tx.query(
      `INSERT INTO rate_limiter_buckets (key, tokens)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, this.burst],
    )
  }
}

interface BucketRow {
  readonly tokens: number
  readonly last_refill: Date
  readonly drained_until: Date
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))

      return
    }

    const onDone = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
    }

    const timer = setTimeout(onDone, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
