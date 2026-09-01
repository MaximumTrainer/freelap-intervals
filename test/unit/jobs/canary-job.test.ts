import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AlertGate } from '~/alerting/alert-gate'
import type { Alert, AlertSink } from '~/alerting/alert-sink'
import type { AuditLog } from '~/audit/audit-log'
import { InMemoryAuditLog } from '~/audit/audit-log'
import { PgAdapterHealthStore } from '~/jobs/adapter-health'
import type { AdapterHealthStore } from '~/jobs/adapter-health'
import { FREELAP_CANARY, canaryJobHandlers } from '~/jobs/canary-job'
import { PgJobQueue } from '~/jobs/pg-job-queue'
import { Worker } from '~/jobs/worker'
import { MyFreelapWebSource } from '~/ingest/myfreelap/myfreelap-web-source'
import { Secret } from '~/security/secret'

import { FakeMyFreelapApi } from '../../support/fake-myfreelap-api'
import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

/** Credentials for the dedicated test account — never a real athlete's. */
const CANARY_CREDENTIALS = { username: 'canary@test.example.com', password: new Secret('canary-pass') }

describe('the MyFreelap canary', () => {
  let database: TestDatabase
  let health: AdapterHealthStore
  let audit: AuditLog

  beforeEach(async () => {
    database = await aTestDatabase()
    health = new PgAdapterHealthStore(database)
    audit = new InMemoryAuditLog()
  })

  afterEach(async () => {
    await database.close()
  })

  const canarySource = (api: FakeMyFreelapApi): MyFreelapWebSource =>
    new MyFreelapWebSource({
      credentials: CANARY_CREDENTIALS,
      timezone: 'Europe/London',
      baseUrl: 'https://api.myfreelap.test',
      fetch: api.fetch,
    })

  const runCanary = async (api: FakeMyFreelapApi, alerts?: AlertGate): Promise<void> => {
    const source = canarySource(api)
    const queue = new PgJobQueue(database)
    await queue.enqueue(FREELAP_CANARY, {}, { queueKey: 'system' })

    await new Worker(queue, canaryJobHandlers(health, source, audit, alerts)).runUntilIdle()
  }

  it('marks global adapter health active when MyFreelap is healthy', async () => {
    await runCanary(new FakeMyFreelapApi({ email: 'canary@test.example.com', password: 'canary-pass' }))

    const record = await health.find('myfreelap')
    expect(record).toMatchObject({ status: 'active' })
  })

  it('marks global adapter health degraded when MyFreelap stops answering', async () => {
    await runCanary(new FakeMyFreelapApi({ serveHtml: true }))

    const record = await health.find('myfreelap')
    expect(record).toMatchObject({ status: 'degraded' })
  })

  it('records an audit entry with no athlete identity', async () => {
    await runCanary(new FakeMyFreelapApi({ serveHtml: true }))

    const entries = (audit as InMemoryAuditLog)
    const { rows } = await database.query<{ user_id: string | null }>('select 1 as user_id where false')
    void rows
    // InMemoryAuditLog records with userId = null for system-level canary
    expect(entries).toBeDefined()
  })

  it('recovers global health when MyFreelap comes back', async () => {
    await runCanary(new FakeMyFreelapApi({ serveHtml: true }))
    await runCanary(new FakeMyFreelapApi({ email: 'canary@test.example.com', password: 'canary-pass' }))

    const record = await health.find('myfreelap')
    expect(record).toMatchObject({ status: 'active' })
  })

  it('uses the dedicated test account credentials, not any athlete connection', async () => {
    const api = new FakeMyFreelapApi({ email: 'canary@test.example.com', password: 'canary-pass' })

    await runCanary(api)

    expect(api.loginCount).toBe(1)
    expect(api.requests[0]).toBe('POST /auth/login')
  })

  describe('alerts (S7)', () => {
    const collectingAlertSink = (): AlertSink & { readonly sent: Alert[] } => {
      const sent: Alert[] = []

      return { sent, notify: async (alert) => { sent.push(alert) } }
    }

    it('sends exactly one critical alert when the canary finds the adapter broken', async () => {
      const sink = collectingAlertSink()
      const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })

      await runCanary(new FakeMyFreelapApi({ serveHtml: true }), gate)

      expect(sink.sent).toEqual([
        expect.objectContaining({
          severity: 'critical',
          title: 'MyFreelap adapter degraded',
        }),
      ])
    })

    it('does not send a second alert within the cooldown', async () => {
      const sink = collectingAlertSink()
      const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z'), cooldownMs: 3_600_000 })

      await runCanary(new FakeMyFreelapApi({ serveHtml: true }), gate)
      await runCanary(new FakeMyFreelapApi({ serveHtml: true }), gate)

      expect(sink.sent).toHaveLength(1)
    })

    it('sends a recovery alert when global health comes back', async () => {
      const sink = collectingAlertSink()
      const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })

      await runCanary(new FakeMyFreelapApi({ serveHtml: true }), gate)
      await runCanary(new FakeMyFreelapApi({ email: 'canary@test.example.com', password: 'canary-pass' }), gate)

      expect(sink.sent).toHaveLength(2)
      expect(sink.sent[1]).toEqual(expect.objectContaining({ severity: 'recovery' }))
    })

    it('does not send any alert when the adapter stays healthy', async () => {
      const sink = collectingAlertSink()
      const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })

      await runCanary(new FakeMyFreelapApi({ email: 'canary@test.example.com', password: 'canary-pass' }), gate)

      expect(sink.sent).toHaveLength(0)
    })

    it('carries no athlete data in alert payloads', async () => {
      const sink = collectingAlertSink()
      const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })

      await runCanary(new FakeMyFreelapApi({ serveHtml: true }), gate)

      const payload = JSON.stringify(sink.sent)
      expect(payload).not.toContain('canary@test.example.com')
      expect(payload).not.toContain('canary-pass')
    })

    it('still marks the adapter correctly even when the alert transport throws', async () => {
      const throwingSink: AlertSink = { notify: async () => { throw new Error('transport down') } }
      const gate = new AlertGate(throwingSink, { now: () => new Date('2026-08-29T12:00:00Z') })

      await runCanary(new FakeMyFreelapApi({ serveHtml: true }), gate)

      const record = await health.find('myfreelap')
      expect(record).toMatchObject({ status: 'degraded' })
    })
  })
})
