import type { AuditLog } from '~/audit/audit-log'

import type { ConnectionStore } from './connection-store'

export interface ResealDependencies {
  readonly connections: ConnectionStore
  readonly out: (line: string) => void
  readonly apply: boolean
  readonly audit?: AuditLog
}

/**
 * Re-seals every stored credential under the current master key. Dry-run by default; pass
 * `apply: true` to write. Returns 0 on success, 1 if at least one connection could not be resealed.
 */
export async function runReseal(deps: ResealDependencies): Promise<number> {
  const { connections, out, apply, audit } = deps

  if (!apply) {
    const result = await connections.resealAll({ dryRun: true })
    const total = result.wouldReseal! + result.skipped
    out(`${result.wouldReseal} connection(s) would be resealed`
      + ` (${result.skipped} already under target key, ${total} total)`)
    out('Run with --apply to perform the rotation.')
    return 0
  }

  await audit?.record(null, {
    action: 'reseal:start', target: null, outcome: 'ok', statusCode: null, detail: {},
  })

  const result = await connections.resealAll({
    onProgress: (current, total) => out(`  [${current}/${total}]`),
  })

  out(`Resealed: ${result.resealed}  Skipped: ${result.skipped}  Failed: ${result.failed.length}`)

  for (const failure of result.failed) {
    out(`  FAILED: user=${failure.userId} provider=${failure.provider}`)
  }

  const outcome = result.failed.length > 0 ? 'error' as const : 'ok' as const
  await audit?.record(null, {
    action: 'reseal:finish',
    target: null,
    outcome,
    statusCode: null,
    detail: { resealed: result.resealed, skipped: result.skipped, failed: result.failed.length },
  })

  return result.failed.length > 0 ? 1 : 0
}
