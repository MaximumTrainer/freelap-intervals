import type { AuditLog } from '~/audit/audit-log'
import { ReconnectRequiredError } from '~/auth/oauth-client'
import type { FreelapSource } from '~/ingest/freelap-source'
import type { IntervalsIcuClient } from '~/icu/intervals-icu-client'
import { IntervalsIcuError } from '~/icu/intervals-icu-client'
import type { AdapterHealthStore } from '~/jobs/adapter-health'
import type { ConnectionStore, IntervalsIcuConnection } from '~/security/connection-store'

export type IcuConnectionStatus =
  | { readonly state: 'not_connected' }
  | { readonly state: 'connected' }
  | { readonly state: 'needs_reconnect'; readonly message: string }
  | { readonly state: 'unavailable'; readonly message: string }

export type FreelapConnectionStatus =
  | { readonly state: 'not_connected' }
  | { readonly state: 'connected' }
  | { readonly state: 'needs_attention'; readonly message: string }
  | { readonly state: 'adapter_degraded'; readonly message: string }
  | { readonly state: 'unavailable'; readonly message: string }

export interface ProbeResult {
  readonly intervalsIcu: IcuConnectionStatus
  readonly freelap: FreelapConnectionStatus
}

export interface ConnectionProbeOptions {
  readonly connections: ConnectionStore
  readonly adapterHealth: AdapterHealthStore
  readonly audit: AuditLog
  /** Builds an authenticated intervals.icu client for one probe call. */
  readonly icuClientFor: (userId: string, athleteId: string) => IntervalsIcuClient
  /** Returns the athlete's Freelap source, or null when the adapter is off or no credentials stored. */
  readonly freelapSourceFor: (userId: string) => Promise<FreelapSource | null>
  readonly timeoutMs?: number
  readonly cacheTtlMs?: number
  readonly now?: () => number
}

interface CachedEntry {
  readonly result: IcuConnectionStatus | FreelapConnectionStatus
  readonly at: number
}

interface AuditProbeEntry {
  readonly target: string
  readonly outcome: 'ok' | 'error'
  readonly statusCode: number | null
  readonly error?: unknown
}

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_CACHE_TTL_MS = 60_000

/**
 * Probes each connected source when the connections screen renders, so the athlete sees
 * live health rather than a stale stored status.
 */
export class ConnectionProbe {
  private readonly entries = new Map<string, CachedEntry>()
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly now: () => number

  constructor(private readonly options: ConnectionProbeOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** Evicts cached results for one athlete — call after connect or disconnect. */
  clearCache(userId: string): void {
    this.entries.delete(`${userId}:intervals_icu`)
    this.entries.delete(`${userId}:myfreelap`)
  }

  async probe(userId: string): Promise<ProbeResult> {
    const [intervalsIcu, freelap] = await Promise.all([
      this.probeIcu(userId),
      this.probeFreelap(userId),
    ])

    return { intervalsIcu, freelap }
  }

  private async probeIcu(userId: string): Promise<IcuConnectionStatus> {
    const cacheKey = `${userId}:intervals_icu`
    const cached = this.fromCache(cacheKey)
    if (cached) return cached as IcuConnectionStatus

    const connection = await this.options.connections.findIntervalsIcu(userId)
    if (!connection) return { state: 'not_connected' }
    if (connection.status === 'needs_reconnect') {
      return this.toCache(cacheKey, {
        state: 'needs_reconnect',
        message: 'intervals.icu must be connected again',
      })
    }

    return this.runIcuProbe(userId, connection, cacheKey)
  }

  private async runIcuProbe(
    userId: string,
    connection: IntervalsIcuConnection,
    cacheKey: string,
  ): Promise<IcuConnectionStatus> {
    try {
      const client = this.options.icuClientFor(userId, connection.athleteId)
      await withTimeout(client.athlete(connection.athleteId), this.timeoutMs)

      await this.options.connections.markStatus(userId, 'intervals_icu', 'active')
      await this.auditProbe(userId, { target: 'intervals.icu', outcome: 'ok', statusCode: 200 })

      return this.toCache(cacheKey, { state: 'connected' })
    } catch (error) {
      if (isAuthFailure(error)) {
        await this.options.connections.markStatus(userId, 'intervals_icu', 'needs_reconnect')
        await this.auditProbe(userId, {
          target: 'intervals.icu', outcome: 'error', statusCode: statusOf(error), error,
        })

        return this.toCache(cacheKey, {
          state: 'needs_reconnect',
          message: error instanceof ReconnectRequiredError
            ? error.message
            : 'intervals.icu must be connected again: token was rejected',
        })
      }

      await this.auditProbe(userId, {
        target: 'intervals.icu', outcome: 'error', statusCode: statusOf(error), error,
      })

      return this.toCache(cacheKey, { state: 'unavailable', message: 'Could not check just now' })
    }
  }

  private async probeFreelap(userId: string): Promise<FreelapConnectionStatus> {
    const cacheKey = `${userId}:myfreelap`
    const cached = this.fromCache(cacheKey)
    if (cached) return cached as FreelapConnectionStatus

    const health = await this.options.adapterHealth.find('myfreelap')
    if (health?.status === 'degraded') {
      return this.toCache(cacheKey, {
        state: 'adapter_degraded',
        message: health.reason ?? 'The MyFreelap adapter is degraded. Use CSV export instead.',
      })
    }

    const source = await this.options.freelapSourceFor(userId)
    if (!source) return { state: 'not_connected' }

    return this.runFreelapProbe(userId, source, cacheKey)
  }

  private async runFreelapProbe(
    userId: string,
    source: FreelapSource,
    cacheKey: string,
  ): Promise<FreelapConnectionStatus> {
    try {
      const result = await withTimeout(source.checkHealth(), this.timeoutMs)

      if (result.healthy) {
        await this.options.connections.markStatus(userId, 'myfreelap', 'active')
        await this.auditProbe(userId, { target: 'myfreelap', outcome: 'ok', statusCode: null })

        return this.toCache(cacheKey, { state: 'connected' })
      }

      await this.options.connections.markStatus(userId, 'myfreelap', 'degraded')
      await this.auditProbe(userId, {
        target: 'myfreelap', outcome: 'error', statusCode: null, error: result.reason,
      })

      return this.toCache(cacheKey, {
        state: 'needs_attention',
        message: result.reason ?? 'MyFreelap is not responding correctly',
      })
    } catch (error) {
      await this.auditProbe(userId, {
        target: 'myfreelap', outcome: 'error', statusCode: null, error,
      })

      return this.toCache(cacheKey, { state: 'unavailable', message: 'Could not check just now' })
    }
  }

  private async auditProbe(userId: string, entry: AuditProbeEntry): Promise<void> {
    await this.options.audit.record(userId, {
      action: 'connection probe',
      target: entry.target,
      outcome: entry.outcome,
      statusCode: entry.statusCode,
      detail: entry.error
        ? { reason: typeof entry.error === 'string' ? entry.error : (entry.error as Error).message }
        : {},
    })
  }

  private fromCache(key: string): IcuConnectionStatus | FreelapConnectionStatus | null {
    const entry = this.entries.get(key)
    if (!entry || this.now() - entry.at > this.cacheTtlMs) return null

    return entry.result
  }

  private toCache<T extends IcuConnectionStatus | FreelapConnectionStatus>(key: string, result: T): T {
    this.entries.set(key, { result, at: this.now() })

    return result
  }
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof ReconnectRequiredError
    || (error instanceof IntervalsIcuError && error.status === 401)
}

function statusOf(error: unknown): number | null {
  return error instanceof IntervalsIcuError ? error.status : null
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Probe timed out')), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
