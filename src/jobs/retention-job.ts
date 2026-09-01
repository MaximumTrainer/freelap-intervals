import type { Database } from '~/db/database'
import type { MetricsRegistry } from '~/logging/metrics-registry'

import type { JobHandler } from './worker'

export const RETENTION = 'retention'

export interface RetentionWindows {
  /** Days to keep `done` jobs. Default 7. */
  readonly doneJobsDays: number
  /** Days to keep `failed` jobs. Default 30. */
  readonly failedJobsDays: number
  /** Hours to keep abandoned `oauth_states`. Default 1. */
  readonly oauthStatesHours: number
  /** Days past expiry/revocation to keep sessions. Default 30. */
  readonly sessionsDays: number
  /**
   * Years to keep audit log entries. Default 2, deliberately longer than everything else —
   * PRIVACY.md says the audit trail outlives accounts so we can answer what the app did.
   */
  readonly auditLogYears: number
}

export const DEFAULT_RETENTION_WINDOWS: Readonly<RetentionWindows> = {
  doneJobsDays: 7,
  failedJobsDays: 30,
  oauthStatesHours: 1,
  sessionsDays: 30,
  auditLogYears: 2,
}

export interface RetentionOptions {
  readonly windows?: Partial<RetentionWindows>
  readonly batchSize?: number
  readonly maxBatches?: number
}

export interface RetentionReport {
  readonly deletedJobs: number
  readonly deletedOauthStates: number
  readonly deletedSessions: number
  readonly deletedAuditLog: number
}

/**
 * Sweeps finished work, expired states, and old audit rows in bounded batches so a large
 * backlog never holds a long transaction or locks the queue table.
 */
export function retentionJobHandlers(
  database: Database,
  options: RetentionOptions = {},
  metrics?: MetricsRegistry,
): Record<string, JobHandler> {
  return {
    [RETENTION]: async () => {
      const report = await runRetention(database, options)

      metrics?.set('retention_last_deleted', report.deletedJobs, { table: 'jobs' })
      metrics?.set('retention_last_deleted', report.deletedOauthStates, { table: 'oauth_states' })
      metrics?.set('retention_last_deleted', report.deletedSessions, { table: 'sessions' })
      metrics?.set('retention_last_deleted', report.deletedAuditLog, { table: 'audit_log' })
    },
  }
}

export async function runRetention(database: Database, options: RetentionOptions = {}): Promise<RetentionReport> {
  const windows = { ...DEFAULT_RETENTION_WINDOWS, ...options.windows }
  const batchSize = options.batchSize ?? 1000
  const maxBatches = options.maxBatches ?? 100

  const deletedJobs = await sweepJobs(database, windows, batchSize, maxBatches)
  const deletedOauthStates = await sweep({
    database, batchSize, maxBatches,
    sql: `delete from oauth_states
            where state in (
              select state from oauth_states
               where created_at < now() - make_interval(hours => $1)
               limit $2
            ) returning 1`,
    windowParams: [windows.oauthStatesHours],
  })
  const deletedSessions = await sweep({
    database, batchSize, maxBatches,
    sql: `delete from sessions
            where id in (
              select id from sessions
               where coalesce(revoked_at, expires_at) < now() - make_interval(days => $1)
               limit $2
            ) returning 1`,
    windowParams: [windows.sessionsDays],
  })
  const deletedAuditLog = await sweep({
    database, batchSize, maxBatches,
    sql: `delete from audit_log
            where id in (
              select id from audit_log
               where at < now() - make_interval(years => $1)
               limit $2
            ) returning 1`,
    windowParams: [windows.auditLogYears],
  })

  return { deletedJobs, deletedOauthStates, deletedSessions, deletedAuditLog }
}

interface SweepRequest {
  readonly database: Database
  readonly sql: string
  readonly windowParams: readonly number[]
  readonly batchSize: number
  readonly maxBatches: number
}

async function sweepJobs(
  database: Database,
  windows: RetentionWindows,
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  return sweep({
    database, batchSize, maxBatches,
    sql: `delete from jobs
            where id in (
              select id from jobs
               where (status = 'done' and updated_at < now() - make_interval(days => $1))
                  or (status = 'failed' and updated_at < now() - make_interval(days => $2))
               limit $3
            ) returning 1`,
    windowParams: [windows.doneJobsDays, windows.failedJobsDays],
  })
}

async function sweep(request: SweepRequest): Promise<number> {
  let total = 0

  for (let batch = 0; batch < request.maxBatches; batch++) {
    const { rows } = await request.database.query<{ n: string }>(
      `with deleted as (${request.sql}) select count(*)::text as n from deleted`,
      [...request.windowParams, request.batchSize],
    )

    const deleted = Number(rows[0]?.n ?? 0)
    total += deleted
    if (deleted < request.batchSize) break
  }

  return total
}
