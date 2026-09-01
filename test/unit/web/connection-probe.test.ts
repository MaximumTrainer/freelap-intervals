import { describe, expect, it } from 'vitest'

import { InMemoryAuditLog } from '~/audit/audit-log'
import type { FreelapSource, HealthReport } from '~/ingest/freelap-source'
import type { IcuAthlete, IntervalsIcuClient } from '~/icu/intervals-icu-client'
import { IntervalsIcuError } from '~/icu/intervals-icu-client'
import type { AdapterHealthRecord, AdapterHealthStore } from '~/jobs/adapter-health'
import type { ConnectionStore, IntervalsIcuConnection } from '~/security/connection-store'
import { ConnectionProbe } from '~/web/connection-probe'

function aFakeIcuClient(
  override?: Partial<IntervalsIcuClient>,
): IntervalsIcuClient {
  return {
    athlete: async (id) => ({ id, name: 'Test', timezone: 'UTC' }),
    listActivities: async () => [],
    getActivity: async () => { throw new Error('not stubbed') },
    updateActivity: async () => { throw new Error('not stubbed') },
    deleteActivity: async () => { throw new Error('not stubbed') },
    getStreams: async () => ({ time: [] }),
    getIntervals: async () => [],
    putIntervals: async () => {},
    uploadActivity: async () => { throw new Error('not stubbed') },
    ensureCustomFields: async () => {},
    setCustomFields: async () => {},
    ...override,
  }
}

function aFakeConnectionStore(
  overrides: {
    icuConnection?: IntervalsIcuConnection | null
    freelapConnected?: boolean
    markStatus?: (userId: string, provider: string, status: string) => void
  } = {},
): ConnectionStore {
  const statusUpdates: Array<{ userId: string; provider: string; status: string }> = []

  return {
    findIntervalsIcu: async () => overrides.icuConnection ?? null,
    findFreelap: async () => overrides.freelapConnected
      ? { userId: 'u1', provider: 'myfreelap' as const, status: 'active' as const, credentials: {} } as never
      : null,
    markStatus: async (userId: string, provider: string, status: string) => {
      statusUpdates.push({ userId, provider, status })
      overrides.markStatus?.(userId, provider, status)
    },
    statusUpdates,
    saveIntervalsIcu: async () => {},
    saveFreelap: async () => {},
    disconnect: async () => {},
    resealAll: async () => ({ resealed: 0, skipped: 0, failed: [] }),
  } as never
}

function anIcuConnection(overrides: Partial<IntervalsIcuConnection> = {}): IntervalsIcuConnection {
  return {
    userId: 'u1',
    provider: 'intervals_icu',
    status: 'active',
    athleteId: 'i1234',
    scopes: ['ACTIVITY:READ', 'ACTIVITY:WRITE'],
    expiresAt: null,
    tokens: { accessToken: { reveal: () => 'token' }, refreshToken: { reveal: () => 'refresh' } },
    ...overrides,
  } as IntervalsIcuConnection
}

function aFakeAdapterHealth(status?: 'active' | 'degraded' | 'unknown'): AdapterHealthStore {
  const reason = status === 'degraded' ? 'login page changed' : null
  const record: AdapterHealthRecord | null = status
    ? { adapter: 'myfreelap', status, reason, checkedAt: '2026-08-30T00:00:00Z' }
    : null

  return {
    find: async () => record,
    update: async () => {},
  }
}

function aFreelapSource(healthy = true, reason?: string): FreelapSource {
  return {
    name: 'test-source',
    listSessions: async () => [],
    getSession: async () => { throw new Error('not stubbed') },
    checkHealth: async (): Promise<HealthReport> => ({ healthy, ...(reason ? { reason } : {}) }),
  }
}

function aSlowFreelapSource(delayMs: number): FreelapSource {
  return {
    name: 'slow-source',
    listSessions: async () => [],
    getSession: async () => { throw new Error('not stubbed') },
    checkHealth: () => new Promise((resolve) => setTimeout(() => resolve({ healthy: true }), delayMs)),
  }
}

function aSlowIcuClient(delayMs: number): IntervalsIcuClient {
  return aFakeIcuClient({
    athlete: () => new Promise((resolve) =>
      setTimeout(() => resolve({ id: 'i1234', name: 'Test', timezone: 'UTC' }), delayMs),
    ),
  })
}

describe('ConnectionProbe', () => {
  describe('intervals.icu', () => {
    it('returns connected when the athlete endpoint responds', async () => {
      const connections = aFakeConnectionStore({ icuConnection: anIcuConnection() })
      const probe = new ConnectionProbe({
        connections,
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => null,
      })

      const result = await probe.probe('u1')

      expect(result.intervalsIcu).toEqual({ state: 'connected' })
    })

    it('updates status to active on conclusive success', async () => {
      const connections = aFakeConnectionStore({ icuConnection: anIcuConnection() })
      const probe = new ConnectionProbe({
        connections,
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => null,
      })

      await probe.probe('u1')

      expect((connections as never as { statusUpdates: unknown[] }).statusUpdates).toContainEqual({
        userId: 'u1', provider: 'intervals_icu', status: 'active',
      })
    })

    it('returns not_connected when no ICU connection exists', async () => {
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore(),
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => null,
      })

      const result = await probe.probe('u1')

      expect(result.intervalsIcu).toEqual({ state: 'not_connected' })
    })

    it('returns needs_reconnect without probing when status is already needs_reconnect', async () => {
      let probeCalled = false
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore({
          icuConnection: anIcuConnection({ status: 'needs_reconnect' }),
        }),
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient({
          athlete: async (id: string): Promise<IcuAthlete> => {
            probeCalled = true
            return { id, name: 'Test', timezone: 'UTC' }
          },
        }),
        freelapSourceFor: async () => null,
      })

      const result = await probe.probe('u1')

      expect(result.intervalsIcu.state).toBe('needs_reconnect')
      expect(probeCalled).toBe(false)
    })

    it('returns needs_reconnect and updates status when the API returns 401', async () => {
      const connections = aFakeConnectionStore({ icuConnection: anIcuConnection() })
      const probe = new ConnectionProbe({
        connections,
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient({
          athlete: async () => { throw new IntervalsIcuError('unauthorized', 401, false) },
        }),
        freelapSourceFor: async () => null,
      })

      const result = await probe.probe('u1')

      expect(result.intervalsIcu.state).toBe('needs_reconnect')
      expect((connections as never as { statusUpdates: unknown[] }).statusUpdates).toContainEqual({
        userId: 'u1', provider: 'intervals_icu', status: 'needs_reconnect',
      })
    })

    it('returns unavailable without updating status when the probe times out', async () => {
      const connections = aFakeConnectionStore({ icuConnection: anIcuConnection() })
      const probe = new ConnectionProbe({
        connections,
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aSlowIcuClient(5000),
        freelapSourceFor: async () => null,
        timeoutMs: 10,
      })

      const result = await probe.probe('u1')

      expect(result.intervalsIcu).toEqual({ state: 'unavailable', message: 'Could not check just now' })
      expect((connections as never as { statusUpdates: unknown[] }).statusUpdates).not.toContainEqual(
        expect.objectContaining({ provider: 'intervals_icu' }),
      )
    })

    it('returns unavailable without updating status on a 5xx error', async () => {
      const connections = aFakeConnectionStore({ icuConnection: anIcuConnection() })
      const probe = new ConnectionProbe({
        connections,
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient({
          athlete: async () => { throw new IntervalsIcuError('server error', 500, true) },
        }),
        freelapSourceFor: async () => null,
      })

      const result = await probe.probe('u1')

      expect(result.intervalsIcu).toEqual({ state: 'unavailable', message: 'Could not check just now' })
    })

    it('audits a successful probe', async () => {
      const audit = new InMemoryAuditLog()
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore({ icuConnection: anIcuConnection() }),
        adapterHealth: aFakeAdapterHealth(),
        audit,
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => null,
      })

      await probe.probe('u1')

      const entries = await audit.recent('u1')
      expect(entries).toEqual([
        expect.objectContaining({ action: 'connection probe', target: 'intervals.icu', outcome: 'ok' }),
      ])
    })
  })

  describe('freelap', () => {
    it('returns connected when checkHealth reports healthy', async () => {
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore(),
        adapterHealth: aFakeAdapterHealth('active'),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => aFreelapSource(true),
      })

      const result = await probe.probe('u1')

      expect(result.freelap).toEqual({ state: 'connected' })
    })

    it('returns not_connected when the source factory returns null', async () => {
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore(),
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => null,
      })

      const result = await probe.probe('u1')

      expect(result.freelap).toEqual({ state: 'not_connected' })
    })

    it('returns adapter_degraded when the global adapter health is degraded', async () => {
      let probeCalled = false
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore(),
        adapterHealth: aFakeAdapterHealth('degraded'),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => {
          probeCalled = true
          return aFreelapSource(true)
        },
      })

      const result = await probe.probe('u1')

      expect(result.freelap.state).toBe('adapter_degraded')
      expect(probeCalled).toBe(false)
    })

    it('returns needs_attention and updates status when checkHealth reports unhealthy', async () => {
      const connections = aFakeConnectionStore()
      const probe = new ConnectionProbe({
        connections,
        adapterHealth: aFakeAdapterHealth('active'),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => aFreelapSource(false, 'login page changed'),
      })

      const result = await probe.probe('u1')

      expect(result.freelap).toEqual({ state: 'needs_attention', message: 'login page changed' })
      expect((connections as never as { statusUpdates: unknown[] }).statusUpdates).toContainEqual({
        userId: 'u1', provider: 'myfreelap', status: 'degraded',
      })
    })

    it('returns unavailable without updating status when the probe times out', async () => {
      const connections = aFakeConnectionStore()
      const probe = new ConnectionProbe({
        connections,
        adapterHealth: aFakeAdapterHealth('active'),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient(),
        freelapSourceFor: async () => aSlowFreelapSource(5000),
        timeoutMs: 10,
      })

      const result = await probe.probe('u1')

      expect(result.freelap).toEqual({ state: 'unavailable', message: 'Could not check just now' })
    })
  })

  describe('caching', () => {
    it('returns cached results within the TTL without re-probing', async () => {
      let probeCalls = 0
      let time = 1000
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore({ icuConnection: anIcuConnection() }),
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient({
          athlete: async (id) => { probeCalls++; return { id, name: 'Test', timezone: 'UTC' } },
        }),
        freelapSourceFor: async () => null,
        cacheTtlMs: 60_000,
        now: () => time,
      })

      await probe.probe('u1')
      time += 30_000
      await probe.probe('u1')
      time += 29_000
      await probe.probe('u1')

      expect(probeCalls).toBe(1)
    })

    it('re-probes after clearCache is called', async () => {
      let probeCalls = 0
      const time = 1000
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore({ icuConnection: anIcuConnection() }),
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient({
          athlete: async (id) => { probeCalls++; return { id, name: 'Test', timezone: 'UTC' } },
        }),
        freelapSourceFor: async () => null,
        cacheTtlMs: 60_000,
        now: () => time,
      })

      await probe.probe('u1')
      expect(probeCalls).toBe(1)

      probe.clearCache('u1')
      await probe.probe('u1')

      expect(probeCalls).toBe(2)
    })

    it('re-probes after the TTL has elapsed', async () => {
      let probeCalls = 0
      let time = 1000
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore({ icuConnection: anIcuConnection() }),
        adapterHealth: aFakeAdapterHealth(),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient({
          athlete: async (id) => { probeCalls++; return { id, name: 'Test', timezone: 'UTC' } },
        }),
        freelapSourceFor: async () => null,
        cacheTtlMs: 60_000,
        now: () => time,
      })

      await probe.probe('u1')
      time += 61_000
      await probe.probe('u1')

      expect(probeCalls).toBe(2)
    })
  })

  describe('concurrency', () => {
    it('runs both probes concurrently', async () => {
      const events: string[] = []
      const probe = new ConnectionProbe({
        connections: aFakeConnectionStore({ icuConnection: anIcuConnection() }),
        adapterHealth: aFakeAdapterHealth('active'),
        audit: new InMemoryAuditLog(),
        icuClientFor: () => aFakeIcuClient({
          athlete: async (id) => {
            events.push('icu-start')
            await new Promise((r) => setTimeout(r, 20))
            events.push('icu-end')
            return { id, name: 'Test', timezone: 'UTC' }
          },
        }),
        freelapSourceFor: async () => ({
          name: 'test',
          listSessions: async () => [],
          getSession: async () => { throw new Error('not stubbed') },
          checkHealth: async () => {
            events.push('freelap-start')
            await new Promise((r) => setTimeout(r, 20))
            events.push('freelap-end')
            return { healthy: true }
          },
        }),
        timeoutMs: 5000,
      })

      const result = await probe.probe('u1')

      expect(result.intervalsIcu.state).toBe('connected')
      expect(result.freelap.state).toBe('connected')
      expect(events[0]).toBe('icu-start')
      expect(events[1]).toBe('freelap-start')
    })
  })
})
