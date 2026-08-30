import type { AuditLog } from '~/audit/audit-log'
import type { FreelapSources } from '~/ingest/freelap-sources'
import type { ConnectionStore } from '~/security/connection-store'

import type { Job } from './job-queue'
import type { JobHandler } from './worker'

export const FREELAP_CANARY = 'freelap-canary'

export interface CanaryPayload extends Record<string, unknown> {
  readonly userId: string
}

/**
 * The nightly check on the unofficial MyFreelap adapter. A layout change or a new login wall shows
 * up here first: the connection is marked degraded, the athlete is steered back to CSV upload, and
 * the audit log carries the reason for whoever has to fix the adapter.
 */
export function canaryJobHandlers(
  connections: ConnectionStore,
  sources: FreelapSources,
  audit: AuditLog,
): Record<string, JobHandler> {
  return {
    [FREELAP_CANARY]: async (job: Job) => {
      const { userId } = job.payload as unknown as CanaryPayload
      const source = await sources.webSourceFor(userId)
      if (!source) return

      const health = await source.checkHealth()
      await connections.markStatus(userId, 'myfreelap', health.healthy ? 'active' : 'degraded')
      await audit.record(userId, {
        action: 'myfreelap canary',
        target: source.name,
        outcome: health.healthy ? 'ok' : 'error',
        statusCode: null,
        detail: health.healthy ? {} : { reason: health.reason ?? 'unknown' },
      })
    },
  }
}
