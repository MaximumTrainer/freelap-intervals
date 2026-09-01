import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AlertGate } from '~/alerting/alert-gate'
import type { Alert, AlertSink } from '~/alerting/alert-sink'
import type { JobQueue } from '~/jobs/job-queue'
import { PermanentJobFailure } from '~/jobs/job-queue'
import { PgJobQueue } from '~/jobs/pg-job-queue'
import { Worker } from '~/jobs/worker'

import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

describe('PgJobQueue', () => {
  let database: TestDatabase
  let queue: PgJobQueue
  let now: Date

  beforeEach(async () => {
    database = await aTestDatabase()
    now = new Date('2026-08-29T12:00:00Z')
    queue = new PgJobQueue(database, { now: () => now })
  })

  afterEach(async () => {
    await database.close()
  })

  it('hands out queued work oldest first within a key', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })
    await queue.enqueue('sync-session', { sourceId: 'csv-two' }, { queueKey: 'athlete-a' })

    const first = (await queue.claim())!
    expect(first.payload).toEqual({ sourceId: 'csv-one' })
    await queue.succeed(first.id)

    expect((await queue.claim())?.payload).toEqual({ sourceId: 'csv-two' })
    expect(await queue.claim()).toBeNull()
  })

  it('never hands the same job to two workers', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })

    const [first, second] = await Promise.all([queue.claim(), queue.claim()])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('holds back work that is not due yet', async () => {
    await queue.enqueue('sync-session', { sourceId: 'later' }, { queueKey: 'athlete-a', runAfterMs: 60_000 })

    expect(await queue.claim()).toBeNull()

    now = new Date('2026-08-29T12:01:00Z')
    expect((await queue.claim())?.payload).toEqual({ sourceId: 'later' })
  })

  it('claims only the kinds a worker knows how to run', async () => {
    await queue.enqueue('send-email', {}, { queueKey: 'system' })
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })

    expect((await queue.claim(['sync-session']))?.kind).toBe('sync-session')
  })

  it('reports queue stats for metrics', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })
    await queue.enqueue('sync-session', { sourceId: 'csv-two' }, { queueKey: 'athlete-b' })
    const job = (await queue.claim())!
    await queue.fail(job.id, new Error('broken'), { retryInMs: 0, permanent: true })

    const later = new Date('2026-08-29T12:10:00Z')
    const stats = await queue.stats(later)

    expect(stats.queued).toBe(1)
    expect(stats.running).toBe(0)
    expect(stats.failed).toBe(1)
    expect(stats.oldestQueuedMs).toBe(600_000)
  })

  it('reports null oldest-queued age when no jobs are queued', async () => {
    const stats = await queue.stats(now)

    expect(stats.queued).toBe(0)
    expect(stats.oldestQueuedMs).toBeNull()
  })

  it('finishes a job so it is never run again', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })
    const job = (await queue.claim())!

    await queue.succeed(job.id)

    expect(await queue.claim()).toBeNull()
    expect(await queue.statusOf(job.id)).toBe('done')
  })

  it('puts a failed job back with a delay, counting the attempt', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })
    const job = (await queue.claim())!

    await queue.fail(job.id, new Error('intervals.icu was busy'), { retryInMs: 30_000 })

    expect(await queue.claim()).toBeNull()

    now = new Date('2026-08-29T12:00:31Z')
    const retried = await queue.claim()
    expect(retried).toMatchObject({ id: job.id, attempts: 2 })
  })

  it('gives up on a job that has used all its attempts', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a', maxAttempts: 2 })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const job = (await queue.claim())!
      await queue.fail(job.id, new Error('still broken'), { retryInMs: 0 })
    }

    expect(await queue.claim()).toBeNull()
    const { rows } = await database.query<{ status: string; last_error: string }>(
      'select status, last_error from jobs',
    )
    expect(rows[0]).toMatchObject({ status: 'failed', last_error: 'still broken' })
  })

  it('includes the queue key on claimed jobs', async () => {
    await queue.enqueue('sync-session', {}, { queueKey: 'athlete-x' })

    const job = await queue.claim()

    expect(job?.queueKey).toBe('athlete-x')
  })
})

describe('per-athlete queue fairness (C4)', () => {
  let database: TestDatabase
  let queue: PgJobQueue
  let now: Date

  beforeEach(async () => {
    database = await aTestDatabase()
    now = new Date('2026-08-29T12:00:00Z')
    queue = new PgJobQueue(database, { now: () => now })
  })

  afterEach(async () => {
    await database.close()
  })

  it('serves athlete B within the first two claims even if A has 100 jobs', async () => {
    for (let i = 0; i < 100; i += 1) {
      await queue.enqueue('sync-session', { n: i }, { queueKey: 'athlete-a' })
    }
    await queue.enqueue('sync-session', { n: 'b' }, { queueKey: 'athlete-b' })

    const first = (await queue.claim())!
    await queue.succeed(first.id)
    const second = (await queue.claim())!

    const keys = [first.queueKey, second.queueKey]
    expect(keys).toContain('athlete-b')
  })

  it('gives different keys to two concurrent workers', async () => {
    await queue.enqueue('sync-session', { n: 1 }, { queueKey: 'athlete-a' })
    await queue.enqueue('sync-session', { n: 2 }, { queueKey: 'athlete-b' })

    const [first, second] = await Promise.all([queue.claim(), queue.claim()])

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.queueKey).not.toBe(second!.queueKey)
  })

  it('runs at most one job per key at a time', async () => {
    await queue.enqueue('sync-session', { n: 1 }, { queueKey: 'athlete-a' })
    await queue.enqueue('sync-session', { n: 2 }, { queueKey: 'athlete-a' })

    const first = await queue.claim()
    const second = await queue.claim()

    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('serves other athletes during one athlete s backoff', async () => {
    await queue.enqueue('sync-session', {}, { queueKey: 'athlete-a' })
    await queue.enqueue('sync-session', {}, { queueKey: 'athlete-b' })

    const jobA = (await queue.claim())!
    expect(jobA.queueKey).toBe('athlete-a')
    await queue.fail(jobA.id, new Error('rate limited'), { retryInMs: 300_000 })

    const jobB = await queue.claim()
    expect(jobB).not.toBeNull()
    expect(jobB!.queueKey).toBe('athlete-b')
  })
})

describe('Worker', () => {
  let database: TestDatabase
  let queue: PgJobQueue

  beforeEach(async () => {
    database = await aTestDatabase()
    queue = new PgJobQueue(database)
  })

  afterEach(async () => {
    await database.close()
  })

  it('runs the handler registered for the job kind', async () => {
    const handled: unknown[] = []
    const worker = new Worker(queue, { 'sync-session': async (job) => void handled.push(job.payload) })
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })

    expect(await worker.runOnce()).toBe(true)
    expect(handled).toEqual([{ sourceId: 'csv-one' }])
    expect(await worker.runOnce()).toBe(false)
  })

  it('drains everything it can reach', async () => {
    const worker = new Worker(queue, { 'sync-session': async () => {} })
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })
    await queue.enqueue('sync-session', { sourceId: 'csv-two' }, { queueKey: 'athlete-a' })

    expect(await worker.runUntilIdle()).toBe(2)
  })

  it('backs off exponentially when a handler throws', async () => {
    const delays: number[] = []
    const worker = new Worker(
      queue,
      { 'sync-session': async () => { throw new Error('intervals.icu was busy') } },
      { baseRetryMs: 1000, onRetry: (_, delay) => delays.push(delay) },
    )
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { queueKey: 'athlete-a' })

    await worker.runOnce()

    expect(delays[0]).toBeGreaterThanOrEqual(1000)
    expect(delays[0]).toBeLessThan(1100) // plus a little jitter, so retries do not stampede
    expect(await queue.statusOf(1)).toBe('queued')
  })

  it('leaves work it does not handle for a worker that does', async () => {
    const worker = new Worker(queue, { 'sync-session': async () => {} })
    await queue.enqueue('send-email', {}, { queueKey: 'system' })

    expect(await worker.runOnce()).toBe(false)
    expect(await queue.statusOf(1)).toBe('queued')
  })

  it('fails work it cannot run, rather than cycling on it forever', async () => {
    await queue.enqueue('unknown-kind', {}, { queueKey: 'system' })
    // A queue implementation that ignores the kinds a worker asked for.
    const inattentiveQueue: JobQueue = {
      enqueue: (kind, payload, options) => queue.enqueue(kind, payload, options),
      claim: () => queue.claim(),
      succeed: (jobId) => queue.succeed(jobId),
      fail: (jobId, error, options) => queue.fail(jobId, error, options),
      statusOf: (jobId) => queue.statusOf(jobId),
      stats: (now) => queue.stats(now),
    }
    const worker = new Worker(inattentiveQueue, { 'sync-session': async () => {} })

    await worker.runOnce()

    expect(await queue.statusOf(1)).toBe('failed')
  })
})

describe('Worker, faced with a failure nobody can retry away', () => {
  it('stops trying and says so', async () => {
    const database = await aTestDatabase()
    const queue = new PgJobQueue(database)
    const failures: string[] = []
    const worker = new Worker(
      queue,
      {
        'sync-session': async () => {
          throw new PermanentJobFailure(new Error('intervals.icu must be connected again'))
        },
      },
      { onFailure: (_, error) => failures.push(error.message) },
    )
    await queue.enqueue('sync-session', {}, { queueKey: 'athlete-a' })

    await worker.runOnce()

    expect(await queue.statusOf(1)).toBe('failed')
    expect(failures).toEqual(['intervals.icu must be connected again'])

    await database.close()
  })
})

describe('Worker alerting (S7)', () => {
  const collectingSink = (): AlertSink & { readonly sent: Alert[] } => {
    const sent: Alert[] = []

    return { sent, notify: async (alert) => { sent.push(alert) } }
  }

  it('sends a warning alert when a job exhausts its attempts', async () => {
    const database = await aTestDatabase()
    const queue = new PgJobQueue(database)
    const sink = collectingSink()
    const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })
    const worker = new Worker(
      queue,
      { 'sync-session': async () => { throw new Error('bad') } },
      {
        baseRetryMs: 0,
        onFailure: (job, error) => {
          void gate.fire(`job-failed:${job.kind}:${job.id}`, {
            severity: 'warning',
            title: `Job failed: ${job.kind}`,
            detail: { jobId: job.id, kind: job.kind, error: error.message },
          })
          void gate.trackFailure(job.kind)
        },
      },
    )
    await queue.enqueue('sync-session', { sourceId: 'x' }, { queueKey: 'athlete-a', maxAttempts: 1 })

    await worker.runOnce()

    expect(sink.sent).toEqual([
      expect.objectContaining({ severity: 'warning', title: 'Job failed: sync-session' }),
    ])

    await database.close()
  })

  it('sends a critical alert when the rolling failure threshold is crossed', async () => {
    const database = await aTestDatabase()
    const queue = new PgJobQueue(database)
    const sink = collectingSink()
    const gate = new AlertGate(sink, {
      now: () => new Date('2026-08-29T12:00:00Z'),
      rollingThreshold: 2,
      rollingWindowMs: 900_000,
    })
    const worker = new Worker(
      queue,
      { 'sync-session': async () => { throw new Error('bad') } },
      {
        baseRetryMs: 0,
        onFailure: (job, error) => {
          void gate.fire(`job-failed:${job.kind}:${job.id}`, {
            severity: 'warning',
            title: `Job failed: ${job.kind}`,
            detail: { jobId: job.id, kind: job.kind, error: error.message },
          })
          void gate.trackFailure(job.kind)
        },
      },
    )
    await queue.enqueue('sync-session', { sourceId: 'a' }, { queueKey: 'athlete-a', maxAttempts: 1 })
    await queue.enqueue('sync-session', { sourceId: 'b' }, { queueKey: 'athlete-b', maxAttempts: 1 })

    await worker.runUntilIdle()

    const criticals = sink.sent.filter((a) => a.severity === 'critical')
    expect(criticals).toEqual([
      expect.objectContaining({ title: 'High failure rate: sync-session' }),
    ])

    await database.close()
  })
})
