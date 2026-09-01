import type { Applications } from '~/app/applications'
import { ReconnectRequiredError } from '~/auth/oauth-client'
import type { SyncChoice } from '~/domain/sync-choice'
import { AdapterDegradedError } from '~/ingest/freelap-source'
import type { MetricsRegistry } from '~/logging/metrics-registry'
import { NoStreamsError, WriteStepError } from '~/write/activity-writer'

import type { Job, JobQueue } from './job-queue'
import { PermanentJobFailure } from './job-queue'
import type { JobHandler } from './worker'

export const SYNC_SESSION = 'sync-session'
export const VERIFY_SESSION = 'verify-session'

export interface SyncSessionPayload extends Record<string, unknown> {
  readonly userId: string
  readonly sourceId: string
  readonly choice: SyncChoice
  readonly offsetS?: number
  readonly force?: boolean
  readonly requestId?: string
}

export interface VerifySessionPayload extends Record<string, unknown> {
  readonly userId: string
  readonly sourceId: string
  readonly requestId?: string
}

export function enqueueSync(queue: JobQueue, payload: SyncSessionPayload): Promise<number> {
  return queue.enqueue(SYNC_SESSION, payload, { queueKey: payload.userId })
}

export function enqueueVerify(queue: JobQueue, payload: VerifySessionPayload): Promise<number> {
  return queue.enqueue(VERIFY_SESSION, payload, { queueKey: payload.userId })
}

/**
 * The background half of a sync. Writing can be slow and can fail for reasons that pass — rate
 * limits, an intervals.icu outage — so it happens here, out of the athlete's browser, where the
 * queue can retry it. Failures only the athlete can fix are not retried.
 */
export function syncJobHandlers(applications: Applications, metrics?: MetricsRegistry): Record<string, JobHandler> {
  return {
    [SYNC_SESSION]: async (job: Job) => {
      const { userId, sourceId, choice, offsetS, force } = job.payload as unknown as SyncSessionPayload
      const application = await applications.forUser(userId)
      const startMs = performance.now()

      try {
        const outcome = await refuseToRetryUnfixable(() =>
          application.sync(sourceId, choice, {
            ...(offsetS === undefined ? {} : { offsetS }),
            ...(force ? { force: true } : {}),
          }),
        )

        const durationS = (performance.now() - startMs) / 1000
        const result = outcome.skipped ? 'skipped' : 'success'
        metrics?.increment('sync_outcomes_total', { result, mode: outcome.mode })
        metrics?.observe('sync_duration_seconds', durationS, { mode: outcome.mode })
        metrics?.increment('verification_results_total', { status: outcome.verification.status })
      } catch (error) {
        const durationS = (performance.now() - startMs) / 1000
        metrics?.increment('sync_outcomes_total', { result: 'failed', mode: choice.mode })
        metrics?.observe('sync_duration_seconds', durationS, { mode: choice.mode })
        throw error
      }
    },

    [VERIFY_SESSION]: async (job: Job) => {
      const { userId, sourceId } = job.payload as unknown as VerifySessionPayload
      const application = await applications.forUser(userId)

      const report = await refuseToRetryUnfixable(() => application.verify(sourceId))
      metrics?.increment('verification_results_total', { status: report.status })
    },
  }
}

/** Snapshots queue depth into the metrics registry. Called on-demand before scraping. */
export async function refreshQueueMetrics(
  metrics: MetricsRegistry,
  queue: JobQueue,
  now: Date,
): Promise<void> {
  const stats = await queue.stats(now)
  metrics.set('jobs_queued', stats.queued)
  metrics.set('jobs_running', stats.running)
  metrics.set('jobs_failed', stats.failed)
  if (stats.oldestQueuedMs !== null) {
    metrics.set('jobs_oldest_queued_ms', stats.oldestQueuedMs)
  }
}

/** Failures only the athlete can fix are not worth retrying; everything else may pass. */
async function refuseToRetryUnfixable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const hopeless = error instanceof ReconnectRequiredError
      || error instanceof AdapterDegradedError
      || (error instanceof WriteStepError && error.cause instanceof NoStreamsError)
    throw hopeless ? new PermanentJobFailure(error) : error
  }
}
