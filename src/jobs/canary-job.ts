import type { AlertGate } from '~/alerting/alert-gate'
import type { AuditLog } from '~/audit/audit-log'
import type { FreelapSource } from '~/ingest/freelap-source'

import type { AdapterHealthStore } from './adapter-health'
import type { JobHandler } from './worker'

export const FREELAP_CANARY = 'freelap-canary'

/**
 * The nightly check on the unofficial MyFreelap adapter, authenticating as a dedicated test
 * account — never as a real athlete. A layout change or a new login wall shows up here first:
 * the global adapter health is marked degraded, and the alert from S7 fires. No individual
 * athlete's connection is touched.
 */
export function canaryJobHandlers(
  health: AdapterHealthStore,
  canarySource: FreelapSource,
  audit: AuditLog,
  alerts?: AlertGate,
): Record<string, JobHandler> {
  return {
    [FREELAP_CANARY]: async () => {
      const result = await canarySource.checkHealth()

      await health.update('myfreelap', result.healthy ? 'active' : 'degraded', result.reason ?? null)

      await audit.record(null, {
        action: 'myfreelap canary',
        target: canarySource.name,
        outcome: result.healthy ? 'ok' : 'error',
        statusCode: null,
        detail: result.healthy ? {} : { reason: result.reason ?? 'unknown' },
      })

      if (alerts) {
        if (!result.healthy) {
          await alerts.fire('canary:myfreelap', {
            severity: 'critical',
            title: 'MyFreelap adapter degraded',
            detail: { reason: result.reason ?? 'unknown' },
          })
        } else {
          await alerts.recover('canary:myfreelap')
        }
      }
    },
  }
}
