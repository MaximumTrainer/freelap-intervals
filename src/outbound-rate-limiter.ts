/**
 * Port for pre-emptive outbound rate limiting (S6). Each provider gets its own limiter instance;
 * buckets within it are keyed per athlete so one athlete's burst cannot consume another's, with a
 * shared global key as an outer bound.
 */
export interface OutboundRateLimiter {
  /** Wait until a token is available for `key`, then consume it. */
  acquire(key: string, options?: AcquireOptions): Promise<void>
  /** Drain the bucket for `key` so no tokens refill for `durationMs` — the Retry-After cooperator. */
  drainUntil(key: string, durationMs: number): void
  /** Accumulated wait statistics for observability (O3). */
  readonly stats: RateLimiterStats
}

export interface AcquireOptions {
  readonly cost?: number
  readonly signal?: AbortSignal
}

export interface RateLimiterStats {
  readonly waits: number
  readonly totalWaitMs: number
}

/** Imposes no limit — for the CLI path and tests that do not need pacing. */
export class NoopRateLimiter implements OutboundRateLimiter {
  readonly stats: RateLimiterStats = { waits: 0, totalWaitMs: 0 }

  async acquire(_key: string, _options?: AcquireOptions): Promise<void> {
    // no-op: permits every request immediately
  }

  drainUntil(_key: string, _durationMs: number): void {
    // no-op: no drain to apply
  }
}

export interface TokenBucketOptions {
  readonly ratePerSecond: number
  readonly burst: number
  readonly now?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Token-bucket rate limiter, one bucket per key, driven by an injectable clock. */
export class InMemoryRateLimiter implements OutboundRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly ratePerMs: number
  private readonly burst: number
  private readonly now: () => number
  private readonly doSleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private _waits = 0
  private _totalWaitMs = 0

  constructor(options: TokenBucketOptions) {
    this.ratePerMs = options.ratePerSecond / 1000
    this.burst = options.burst
    this.now = options.now ?? (() => Date.now())
    this.doSleep = options.sleep ?? abortableSleep
  }

  get stats(): RateLimiterStats {
    return { waits: this._waits, totalWaitMs: this._totalWaitMs }
  }

  async acquire(key: string, options?: AcquireOptions): Promise<void> {
    const cost = options?.cost ?? 1
    const signal = options?.signal
    const bucket = this.bucketFor(key)

    while (true) {
      signal?.throwIfAborted()

      const now = this.now()
      if (now < bucket.drainedUntil) {
        const waitMs = bucket.drainedUntil - now
        this._waits += 1
        this._totalWaitMs += waitMs
        await this.doSleep(waitMs, signal)
        continue
      }

      this.refill(bucket)

      if (bucket.tokens >= cost) {
        bucket.tokens -= cost
        return
      }

      const deficit = cost - bucket.tokens
      const waitMs = Math.ceil(deficit / this.ratePerMs)
      this._waits += 1
      this._totalWaitMs += waitMs
      await this.doSleep(waitMs, signal)
    }
  }

  drainUntil(key: string, durationMs: number): void {
    const bucket = this.bucketFor(key)
    bucket.tokens = 0
    bucket.drainedUntil = this.now() + durationMs
  }

  private bucketFor(key: string): Bucket {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { tokens: this.burst, lastRefill: this.now(), drainedUntil: 0 }
      this.buckets.set(key, bucket)
    }

    return bucket
  }

  private refill(bucket: Bucket): void {
    const now = this.now()
    const refillStart = Math.max(bucket.lastRefill, bucket.drainedUntil)
    const elapsedMs = now - refillStart
    if (elapsedMs <= 0) return

    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedMs * this.ratePerMs)
    bucket.lastRefill = now
  }
}

interface Bucket {
  tokens: number
  lastRefill: number
  drainedUntil: number
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(asError(signal.reason))

      return
    }

    const onDone = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(asError(signal.reason))
    }

    const timer = setTimeout(onDone, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}
