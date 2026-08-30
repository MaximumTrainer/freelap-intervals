import type { Job, JobQueue } from './job-queue'
import { PermanentJobFailure } from './job-queue'

export type JobHandler = (job: Job) => Promise<void>

export interface WorkerOptions {
  readonly baseRetryMs?: number
  readonly maxRetryMs?: number
  readonly onRetry?: (job: Job, delayMs: number, error: Error) => void
  readonly onFailure?: (job: Job, error: Error) => void
}

const DEFAULT_BASE_RETRY_MS = 30_000
const DEFAULT_MAX_RETRY_MS = 15 * 60_000

/**
 * Runs queued work. A handler that throws sends its job back to the queue with an exponential
 * delay, until the job runs out of attempts; work nobody can handle fails immediately rather than
 * cycling forever.
 */
export class Worker {
  private readonly options: Required<Pick<WorkerOptions, 'baseRetryMs' | 'maxRetryMs'>> & WorkerOptions

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    options: WorkerOptions = {},
  ) {
    this.options = {
      ...options,
      baseRetryMs: options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS,
      maxRetryMs: options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS,
    }
  }

  /** Runs at most one job. Returns false when there was nothing to do. */
  async runOnce(): Promise<boolean> {
    const job = await this.queue.claim(Object.keys(this.handlers))
    if (!job) return false

    await this.run(job)
    return true
  }

  async runUntilIdle(limit = 100): Promise<number> {
    let done = 0
    while (done < limit && (await this.runOnce())) done += 1

    return done
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers[job.kind]

    if (!handler) {
      const error = new Error(`No handler is registered for ${job.kind} work`)
      await this.queue.fail(job.id, error, { retryInMs: 0, permanent: true })
      this.options.onFailure?.(job, error)
      return
    }

    try {
      await handler(job)
      await this.queue.succeed(job.id)
    } catch (cause) {
      const error = cause as Error

      if (error instanceof PermanentJobFailure) {
        await this.queue.fail(job.id, error, { retryInMs: 0, permanent: true })
        this.options.onFailure?.(job, error)
        return
      }

      const delayMs = this.retryDelayFor(job)
      await this.queue.fail(job.id, error, { retryInMs: delayMs })

      if (job.attempts >= job.maxAttempts) this.options.onFailure?.(job, error)
      else this.options.onRetry?.(job, delayMs, error)
    }
  }

  private retryDelayFor(job: Job): number {
    const backoff = this.options.baseRetryMs * 2 ** (job.attempts - 1)
    const jitter = Math.floor(Math.random() * this.options.baseRetryMs * 0.1)

    return Math.min(backoff, this.options.maxRetryMs) + jitter
  }
}
