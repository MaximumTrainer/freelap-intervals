import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PgJobQueue } from '~/jobs/pg-job-queue'
import { Scheduler } from '~/jobs/scheduler'

import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

describe('Scheduler', () => {
  let database: TestDatabase
  let queue: PgJobQueue
  let now: Date
  let scheduler: Scheduler

  beforeEach(async () => {
    database = await aTestDatabase()
    now = new Date('2026-08-29T12:00:00Z')
    queue = new PgJobQueue(database, { now: () => now })
    scheduler = new Scheduler(database, queue, { now: () => now })
  })

  afterEach(async () => {
    await database.close()
  })

  it('enqueues a due schedule and advances next_run_at', async () => {
    await scheduler.register({
      kind: 'freelap-canary',
      payload: {},
      intervalMs: 86_400_000,
      nextRunAt: new Date('2026-08-29T11:00:00Z'),
      queueKey: 'system',
    })

    const enqueued = await scheduler.tick()

    expect(enqueued).toBe(1)
    const job = await queue.claim()
    expect(job).toMatchObject({ kind: 'freelap-canary' })
  })

  it('does not enqueue a schedule that is not yet due', async () => {
    await scheduler.register({
      kind: 'freelap-canary',
      payload: {},
      intervalMs: 86_400_000,
      nextRunAt: new Date('2026-08-30T02:00:00Z'),
      queueKey: 'system',
    })

    const enqueued = await scheduler.tick()

    expect(enqueued).toBe(0)
    expect(await queue.claim()).toBeNull()
  })

  it('does not enqueue a disabled schedule', async () => {
    await scheduler.register({
      kind: 'freelap-canary',
      payload: {},
      intervalMs: 86_400_000,
      nextRunAt: new Date('2026-08-29T11:00:00Z'),
      queueKey: 'system',
      enabled: false,
    })

    const enqueued = await scheduler.tick()

    expect(enqueued).toBe(0)
  })

  it('enqueues exactly once even with three concurrent ticks', async () => {
    await scheduler.register({
      kind: 'freelap-canary',
      payload: {},
      intervalMs: 86_400_000,
      nextRunAt: new Date('2026-08-29T11:00:00Z'),
      queueKey: 'system',
    })

    const results = await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()])

    expect(results.reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('advances next_run_at by the interval after enqueuing', async () => {
    await scheduler.register({
      kind: 'freelap-canary',
      payload: {},
      intervalMs: 86_400_000,
      nextRunAt: new Date('2026-08-29T11:00:00Z'),
      queueKey: 'system',
    })

    await scheduler.tick()
    const enqueued = await scheduler.tick()

    expect(enqueued).toBe(0)

    now = new Date('2026-08-30T11:00:01Z')
    expect(await scheduler.tick()).toBe(1)
  })

  it('passes the payload through to the enqueued job', async () => {
    await scheduler.register({
      kind: 'freelap-canary',
      payload: { source: 'test-account' },
      intervalMs: 86_400_000,
      nextRunAt: new Date('2026-08-29T11:00:00Z'),
      queueKey: 'system',
    })

    await scheduler.tick()

    const job = await queue.claim()
    expect(job?.payload).toEqual({ source: 'test-account' })
  })

  it('uses the configured queue key for enqueued jobs', async () => {
    await scheduler.register({
      kind: 'freelap-canary',
      payload: {},
      intervalMs: 86_400_000,
      nextRunAt: new Date('2026-08-29T11:00:00Z'),
      queueKey: 'system',
    })

    await scheduler.tick()

    const job = await queue.claim()
    expect(job?.queueKey).toBe('system')
  })
})
