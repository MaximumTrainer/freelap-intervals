/** Coalesces repeated events within a time window so only the first enqueues work. */
export class DedupFilter {
  private readonly seen = new Map<string, number>()
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options?: {
    readonly windowMs?: number
    readonly now?: () => number
  }) {
    this.windowMs = options?.windowMs ?? 60_000
    this.now = options?.now ?? (() => Date.now())
  }

  /** Returns true if this is a duplicate (already seen within the window). */
  isDuplicate(key: string): boolean {
    const now = this.now()
    this.sweep(now)

    const lastSeen = this.seen.get(key)
    if (lastSeen !== undefined && now - lastSeen < this.windowMs) return true

    this.seen.set(key, now)

    return false
  }

  private sweep(now: number): void {
    const cutoff = now - this.windowMs
    for (const [key, timestamp] of this.seen) {
      if (timestamp < cutoff) this.seen.delete(key)
    }
  }
}
