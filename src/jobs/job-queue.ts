export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface Job {
  readonly id: number
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly attempts: number
  readonly maxAttempts: number
}

export interface EnqueueOptions {
  readonly runAfterMs?: number
  readonly maxAttempts?: number
}

export interface FailOptions {
  readonly retryInMs: number
  /** Set when the failure will never fix itself, so the job should not be retried. */
  readonly permanent?: boolean
}

/**
 * Work handed to the background worker: one sync per job, so a slow or failing intervals.icu
 * never blocks the athlete's browser.
 */
export interface JobQueue {
  enqueue(kind: string, payload: Record<string, unknown>, options?: EnqueueOptions): Promise<number>
  /** Takes one due job, marking it running so no other worker takes it too. */
  claim(kinds?: readonly string[]): Promise<Job | null>
  succeed(jobId: number): Promise<void>
  fail(jobId: number, error: Error, options: FailOptions): Promise<void>
  statusOf(jobId: number): Promise<JobStatus | null>
}

/** A failure the queue must not retry: nothing will change until a person acts. */
export class PermanentJobFailure extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause })
    this.name = 'PermanentJobFailure'
  }
}
