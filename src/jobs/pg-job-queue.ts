import type { Database } from '~/db/database'

import type { EnqueueOptions, FailOptions, Job, JobQueue, JobStatus, QueueStats } from './job-queue'

interface JobRow {
  readonly id: string | number
  readonly kind: string
  readonly payload: Record<string, unknown>
  readonly attempts: number
  readonly max_attempts: number
  readonly queue_key: string
}

export interface PgJobQueueOptions {
  readonly now?: () => Date
}

/**
 * The queue in Postgres. Claiming uses `for update skip locked`, so several workers can share one
 * table without ever handing the same job to two of them, and without needing Redis.
 */
export class PgJobQueue implements JobQueue {
  private readonly now: () => Date

  constructor(
    private readonly database: Database,
    options: PgJobQueueOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async enqueue(kind: string, payload: Record<string, unknown>, options: EnqueueOptions): Promise<number> {
    const { rows } = await this.database.query<{ id: string | number }>(
      `insert into jobs (kind, payload, queue_key, run_after, max_attempts, created_at, updated_at)
       values ($1, $2, $3, $4, coalesce($5, 5), $6, $6)
       returning id`,
      [
        kind,
        JSON.stringify(payload),
        options.queueKey,
        this.at(options.runAfterMs ?? 0),
        options.maxAttempts ?? null,
        this.now().toISOString(),
      ],
    )

    return Number(rows[0]!.id)
  }

  async claim(kinds?: readonly string[]): Promise<Job | null> {
    const now = this.now().toISOString()
    const kindsParam = kinds ? [...kinds] : null

    return this.database.transaction(async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `with eligible_keys as (
           select distinct j.queue_key
             from jobs j
            where j.status = 'queued'
              and j.run_after <= $1
              and ($2::text[] is null or j.kind = any($2::text[]))
              and not exists (
                select 1 from jobs r
                 where r.queue_key = j.queue_key and r.status = 'running'
              )
         ),
         last_served as (
           select queue_key, max(updated_at) as served_at
             from jobs
            where queue_key in (select queue_key from eligible_keys)
              and status in ('done', 'failed')
            group by queue_key
         ),
         next_key as (
           select ek.queue_key
             from eligible_keys ek
             left join last_served ls on ek.queue_key = ls.queue_key
            order by coalesce(ls.served_at, '1970-01-01'::timestamptz), ek.queue_key
            limit 1
         )
         select id, kind, payload, attempts, max_attempts, queue_key
           from jobs
          where status = 'queued'
            and run_after <= $1
            and ($2::text[] is null or kind = any($2::text[]))
            and queue_key = (select queue_key from next_key)
          order by run_after, id
          limit 1
            for update skip locked`,
        [now, kindsParam],
      )

      const row = rows[0]
      if (!row) return null

      await tx.query(
        `update jobs set status = 'running', attempts = attempts + 1, updated_at = $2 where id = $1`,
        [row.id, now],
      )

      return {
        id: Number(row.id),
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
        queueKey: row.queue_key,
      }
    })
  }

  async succeed(jobId: number): Promise<void> {
    await this.database.query(`update jobs set status = 'done', updated_at = $2 where id = $1`, [
      jobId,
      this.now().toISOString(),
    ])
  }

  /** Requeues the job unless the failure is final, or its attempts have run out. */
  async fail(jobId: number, error: Error, options: FailOptions): Promise<void> {
    await this.database.query(
      `update jobs
          set status     = case
                             when $4 or attempts >= max_attempts then 'failed'
                             else 'queued'
                           end,
              run_after  = $2,
              last_error = $3,
              updated_at = $5
        where id = $1`,
      [jobId, this.at(options.retryInMs), error.message, options.permanent ?? false, this.now().toISOString()],
    )
  }

  async statusOf(jobId: number): Promise<JobStatus | null> {
    const { rows } = await this.database.query<{ status: JobStatus }>('select status from jobs where id = $1', [jobId])

    return rows[0]?.status ?? null
  }

  async stats(now: Date): Promise<QueueStats> {
    const { rows } = await this.database.query<{
      queued: string; running: string; failed: string; oldest_created: string | null
    }>(
      `select
         count(*) filter (where status = 'queued')  as queued,
         count(*) filter (where status = 'running') as running,
         count(*) filter (where status = 'failed')  as failed,
         min(created_at) filter (where status = 'queued') as oldest_created
       from jobs`,
    )

    const row = rows[0]!
    const oldestCreated = row.oldest_created ? new Date(row.oldest_created) : null

    return {
      queued: Number(row.queued),
      running: Number(row.running),
      failed: Number(row.failed),
      oldestQueuedMs: oldestCreated ? now.getTime() - oldestCreated.getTime() : null,
    }
  }

  private at(offsetMs: number): string {
    return new Date(this.now().getTime() + offsetMs).toISOString()
  }
}
