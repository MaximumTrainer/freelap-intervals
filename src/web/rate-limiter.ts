/** In-memory sliding-window rate limiter for high-frequency endpoints like webhooks. */
export class RateLimiter {
  private readonly windows = new Map<string, number[]>()
  private readonly maxRequests: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options?: {
    readonly maxRequests?: number
    readonly windowMs?: number
    readonly now?: () => number
  }) {
    this.maxRequests = options?.maxRequests ?? 60
    this.windowMs = options?.windowMs ?? 60_000
    this.now = options?.now ?? (() => Date.now())
  }

  /** Returns true if the request is allowed, false if the caller has exceeded the limit. */
  allow(key: string): boolean {
    const now = this.now()
    const cutoff = now - this.windowMs

    let timestamps = this.windows.get(key)
    if (!timestamps) {
      timestamps = []
      this.windows.set(key, timestamps)
    }

    while (timestamps.length > 0 && timestamps[0]! < cutoff) timestamps.shift()

    if (timestamps.length >= this.maxRequests) return false

    timestamps.push(now)

    return true
  }

  /** Seconds until the oldest entry in the current window expires. */
  retryAfterS(key: string): number {
    const timestamps = this.windows.get(key)
    if (!timestamps || timestamps.length === 0) return 0

    const oldest = timestamps[0]!
    const expiresAt = oldest + this.windowMs

    return Math.max(1, Math.ceil((expiresAt - this.now()) / 1000))
  }
}
