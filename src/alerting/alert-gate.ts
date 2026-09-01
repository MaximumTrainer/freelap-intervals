import type { Alert, AlertSink } from './alert-sink'

export interface AlertGateOptions {
  readonly now: () => Date
  readonly cooldownMs?: number
  readonly rollingWindowMs?: number
  readonly rollingThreshold?: number
}

const ONE_HOUR_MS = 3_600_000
const FIFTEEN_MINUTES_MS = 900_000

/**
 * Edge-triggered alerting: deduplicates by a stable key with a configurable cooldown, and sends a
 * single recovery alert when a previously-fired condition clears. Transport errors are swallowed
 * so alerting never breaks the job that raised the alert.
 */
export class AlertGate {
  private readonly sink: AlertSink
  private readonly now: () => Date
  private readonly cooldownMs: number
  private readonly rollingWindowMs: number
  private readonly rollingThreshold: number

  private readonly lastFired = new Map<string, number>()
  private readonly active = new Set<string>()
  private readonly failureTimestamps = new Map<string, number[]>()

  constructor(sink: AlertSink, options: AlertGateOptions) {
    this.sink = sink
    this.now = options.now
    this.cooldownMs = options.cooldownMs ?? ONE_HOUR_MS
    this.rollingWindowMs = options.rollingWindowMs ?? FIFTEEN_MINUTES_MS
    this.rollingThreshold = options.rollingThreshold ?? 5
  }

  async fire(key: string, alert: Alert): Promise<void> {
    const nowMs = this.now().getTime()
    const last = this.lastFired.get(key)
    if (last !== undefined && nowMs - last < this.cooldownMs) return

    this.lastFired.set(key, nowMs)
    this.active.add(key)

    try {
      await this.sink.notify(alert)
    } catch {
      // R6: alerting never breaks the job
    }
  }

  async recover(key: string): Promise<void> {
    if (!this.active.has(key)) return

    this.active.delete(key)
    this.lastFired.delete(key)

    try {
      await this.sink.notify({ severity: 'recovery', title: `Recovered: ${key}`, detail: {} })
    } catch {
      // R6: alerting never breaks the job
    }
  }

  async trackFailure(kind: string): Promise<void> {
    const nowMs = this.now().getTime()
    const cutoff = nowMs - this.rollingWindowMs
    const existing = this.failureTimestamps.get(kind) ?? []
    const recent = existing.filter((t) => t > cutoff)
    recent.push(nowMs)
    this.failureTimestamps.set(kind, recent)

    if (recent.length >= this.rollingThreshold) {
      await this.fire(`rolling:${kind}`, {
        severity: 'critical',
        title: `High failure rate: ${kind}`,
        detail: { kind, count: recent.length, windowMs: this.rollingWindowMs },
      })
    }
  }
}
