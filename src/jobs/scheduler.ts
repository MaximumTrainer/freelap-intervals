import type { Database } from '~/db/database'

import type { JobQueue } from './job-queue'

export interface ScheduleDefinition {
  readonly kind: string
  readonly payload: Record<string, unknown>
  readonly intervalMs: number
  readonly nextRunAt: Date
  readonly queueKey: string
  readonly enabled?: boolean
}

export interface SchedulerOptions {
  readonly now?: () => Date
}

interface DueSchedule {
  readonly kind: string
  readonly payload: Record<string, unknown>
  readonly queueKey: string
}

/**
 * Polls `scheduled_jobs` and enqueues due work into the job queue. Each schedule row is claimed
 * with `FOR UPDATE SKIP LOCKED`, so multiple workers can poll without double-enqueuing.
 */
export class Scheduler {
  private readonly now: () => Date

  constructor(
    private readonly database: Database,
    private readonly queue: JobQueue,
    options: SchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async register(schedule: ScheduleDefinition): Promise<void> {
    await this.database.query(
      `insert into scheduled_jobs (kind, payload, queue_key, interval_ms, next_run_at, enabled)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (kind) do update set
         payload     = excluded.payload,
         queue_key   = excluded.queue_key,
         interval_ms = excluded.interval_ms,
         next_run_at = excluded.next_run_at,
         enabled     = excluded.enabled`,
      [
        schedule.kind,
        JSON.stringify(schedule.payload),
        schedule.queueKey,
        schedule.intervalMs,
        schedule.nextRunAt.toISOString(),
        schedule.enabled ?? true,
      ],
    )
  }

  /** Enqueues all due schedules. Returns how many were enqueued. */
  async tick(): Promise<number> {
    const now = this.now().toISOString()

    const due = await this.database.transaction(async (tx) => {
      const { rows } = await tx.query<{
        kind: string
        payload: Record<string, unknown>
        queue_key: string
      }>(
        `select kind, payload, queue_key
           from scheduled_jobs
          where enabled = true and next_run_at <= $1
            for update skip locked`,
        [now],
      )

      if (rows.length === 0) return []

      for (const row of rows) {
        await tx.query(
          `update scheduled_jobs
              set next_run_at      = next_run_at + make_interval(secs => interval_ms / 1000.0),
                  last_enqueued_at = $2
            where kind = $1`,
          [row.kind, now],
        )
      }

      return rows.map((row): DueSchedule => ({
        kind: row.kind,
        payload: row.payload,
        queueKey: row.queue_key,
      }))
    })

    for (const schedule of due) {
      await this.queue.enqueue(schedule.kind, schedule.payload, { queueKey: schedule.queueKey })
    }

    return due.length
  }
}
