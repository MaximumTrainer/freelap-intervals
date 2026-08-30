import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

  it('hands out queued work oldest first', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' })
    await queue.enqueue('sync-session', { sourceId: 'csv-two' })

    expect((await queue.claim())?.payload).toEqual({ sourceId: 'csv-one' })
    expect((await queue.claim())?.payload).toEqual({ sourceId: 'csv-two' })
    expect(await queue.claim()).toBeNull()
  })

  it('never hands the same job to two workers', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' })

    const [first, second] = await Promise.all([queue.claim(), queue.claim()])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('holds back work that is not due yet', async () => {
    await queue.enqueue('sync-session', { sourceId: 'later' }, { runAfterMs: 60_000 })

    expect(await queue.claim()).toBeNull()

    now = new Date('2026-08-29T12:01:00Z')
    expect((await queue.claim())?.payload).toEqual({ sourceId: 'later' })
  })

  it('claims only the kinds a worker knows how to run', async () => {
    await queue.enqueue('send-email', {})
    await queue.enqueue('sync-session', { sourceId: 'csv-one' })

    expect((await queue.claim(['sync-session']))?.kind).toBe('sync-session')
  })

  it('finishes a job so it is never run again', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' })
    const job = (await queue.claim())!

    await queue.succeed(job.id)

    expect(await queue.claim()).toBeNull()
    expect(await queue.statusOf(job.id)).toBe('done')
  })

  it('puts a failed job back with a delay, counting the attempt', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' })
    const job = (await queue.claim())!

    await queue.fail(job.id, new Error('intervals.icu was busy'), { retryInMs: 30_000 })

    expect(await queue.claim()).toBeNull()

    now = new Date('2026-08-29T12:00:31Z')
    const retried = await queue.claim()
    expect(retried).toMatchObject({ id: job.id, attempts: 2 })
  })

  it('gives up on a job that has used all its attempts', async () => {
    await queue.enqueue('sync-session', { sourceId: 'csv-one' }, { maxAttempts: 2 })

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
    await queue.enqueue('sync-session', { sourceId: 'csv-one' })

    expect(await worker.runOnce()).toBe(true)
    expect(handled).toEqual([{ sourceId: 'csv-one' }])
    expect(await worker.runOnce()).toBe(false)
  })

  it('drains everything it can reach', async () => {
    const worker = new Worker(queue, { 'sync-session': async () => {} })
    await queue.enqueue('sync-session', { sourceId: 'csv-one' })
    await queue.enqueue('sync-session', { sourceId: 'csv-two' })

    expect(await worker.runUntilIdle()).toBe(2)
  })

  it('backs off exponentially when a handler throws', async () => {
    const delays: number[] = []
    const worker = new Worker(
      queue,
      { 'sync-session': async () => { throw new Error('intervals.icu was busy') } },
      { baseRetryMs: 1000, onRetry: (_, delay) => delays.push(delay) },
    )
    await queue.enqueue('sync-session', { sourceId: 'csv-one' })

    await worker.runOnce()

    expect(delays[0]).toBeGreaterThanOrEqual(1000)
    expect(delays[0]).toBeLessThan(1100) // plus a little jitter, so retries do not stampede
    expect(await queue.statusOf(1)).toBe('queued')
  })

  it('leaves work it does not handle for a worker that does', async () => {
    const worker = new Worker(queue, { 'sync-session': async () => {} })
    await queue.enqueue('send-email', {})

    expect(await worker.runOnce()).toBe(false)
    expect(await queue.statusOf(1)).toBe('queued')
  })

  it('fails work it cannot run, rather than cycling on it forever', async () => {
    await queue.enqueue('unknown-kind', {})
    // A queue implementation that ignores the kinds a worker asked for.
    const inattentiveQueue: JobQueue = {
      enqueue: (kind, payload, options) => queue.enqueue(kind, payload, options),
      claim: () => queue.claim(),
      succeed: (jobId) => queue.succeed(jobId),
      fail: (jobId, error, options) => queue.fail(jobId, error, options),
      statusOf: (jobId) => queue.statusOf(jobId),
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
    await queue.enqueue('sync-session', {})

    await worker.runOnce()

    expect(await queue.statusOf(1)).toBe('failed')
    expect(failures).toEqual(['intervals.icu must be connected again'])

    await database.close()
  })
})
