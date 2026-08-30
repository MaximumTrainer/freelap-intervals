import type { Database } from '~/db/database'

import type { EnqueueOptions, FailOptions, Job, JobQueue, JobStatus } from './job-queue'

interface JobRow {
  readonly id: string | number
  readonly kind: string
  readonly payload: Record<string, unknown>
  readonly attempts: number
  readonly max_attempts: number
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

  async enqueue(kind: string, payload: Record<string, unknown>, options: EnqueueOptions = {}): Promise<number> {
    const { rows } = await this.database.query<{ id: string | number }>(
      `insert into jobs (kind, payload, run_after, max_attempts, created_at, updated_at)
       values ($1, $2, $3, coalesce($4, 5), $5, $5)
       returning id`,
      [
        kind,
        JSON.stringify(payload),
        this.at(options.runAfterMs ?? 0),
        options.maxAttempts ?? null,
        this.now().toISOString(),
      ],
    )

    return Number(rows[0]!.id)
  }

  async claim(kinds?: readonly string[]): Promise<Job | null> {
    return this.database.transaction(async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `select id, kind, payload, attempts, max_attempts
           from jobs
          where status = 'queued'
            and run_after <= $1
            and ($2::text[] is null or kind = any($2::text[]))
          order by run_after, id
          limit 1
            for update skip locked`,
        [this.now().toISOString(), kinds ? [...kinds] : null],
      )

      const row = rows[0]
      if (!row) return null

      await tx.query(
        `update jobs set status = 'running', attempts = attempts + 1, updated_at = $2 where id = $1`,
        [row.id, this.now().toISOString()],
      )

      return {
        id: Number(row.id),
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
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

  private at(offsetMs: number): string {
    return new Date(this.now().getTime() + offsetMs).toISOString()
  }
}
