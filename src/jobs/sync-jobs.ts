import type { Applications } from '~/app/applications'
import { ReconnectRequiredError } from '~/auth/oauth-client'
import type { SyncChoice } from '~/domain/sync-choice'
import { AdapterDegradedError } from '~/ingest/freelap-source'

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
}

export interface VerifySessionPayload extends Record<string, unknown> {
  readonly userId: string
  readonly sourceId: string
}

export function enqueueSync(queue: JobQueue, payload: SyncSessionPayload): Promise<number> {
  return queue.enqueue(SYNC_SESSION, payload)
}

export function enqueueVerify(queue: JobQueue, payload: VerifySessionPayload): Promise<number> {
  return queue.enqueue(VERIFY_SESSION, payload)
}

/**
 * The background half of a sync. Writing can be slow and can fail for reasons that pass — rate
 * limits, an intervals.icu outage — so it happens here, out of the athlete's browser, where the
 * queue can retry it. Failures only the athlete can fix are not retried.
 */
export function syncJobHandlers(applications: Applications): Record<string, JobHandler> {
  return {
    [SYNC_SESSION]: async (job: Job) => {
      const { userId, sourceId, choice, offsetS } = job.payload as unknown as SyncSessionPayload
      const application = await applications.forUser(userId)

      await refuseToRetryUnfixable(() =>
        application.sync(sourceId, choice, offsetS === undefined ? {} : { offsetS }),
      )
    },

    [VERIFY_SESSION]: async (job: Job) => {
      const { userId, sourceId } = job.payload as unknown as VerifySessionPayload
      const application = await applications.forUser(userId)

      await refuseToRetryUnfixable(() => application.verify(sourceId))
    },
  }
}

/** Failures only the athlete can fix are not worth retrying; everything else may pass. */
async function refuseToRetryUnfixable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const hopeless = error instanceof ReconnectRequiredError || error instanceof AdapterDegradedError
    throw hopeless ? new PermanentJobFailure(error as Error) : error
  }
}
