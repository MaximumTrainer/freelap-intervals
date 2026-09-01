import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_RETENTION_WINDOWS, runRetention } from '~/jobs/retention-job'

import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

describe('retention', () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await aTestDatabase()
  })

  afterEach(async () => {
    await database.close()
  })

  it('deletes done jobs older than the window and keeps newer ones', async () => {
    await database.query(
      `insert into jobs (kind, payload, queue_key, status, updated_at, created_at)
       values ('sync-session', '{}', 'a', 'done', now() - interval '8 days', now() - interval '8 days'),
              ('sync-session', '{}', 'b', 'done', now() - interval '1 day', now() - interval '1 day')`,
    )

    const report = await runRetention(database, { windows: { doneJobsDays: 7 } })

    expect(report.deletedJobs).toBe(1)
    const { rows } = await database.query<{ queue_key: string }>('select queue_key from jobs')
    expect(rows).toEqual([{ queue_key: 'b' }])
  })

  it('deletes failed jobs older than the window', async () => {
    await database.query(
      `insert into jobs (kind, payload, queue_key, status, updated_at, created_at)
       values ('sync-session', '{}', 'a', 'failed', now() - interval '31 days', now() - interval '31 days')`,
    )

    const report = await runRetention(database, { windows: { failedJobsDays: 30 } })

    expect(report.deletedJobs).toBe(1)
  })

  it('never deletes queued or running jobs regardless of age', async () => {
    await database.query(
      `insert into jobs (kind, payload, queue_key, status, updated_at, created_at)
       values ('sync-session', '{}', 'a', 'queued', now() - interval '100 days', now() - interval '100 days'),
              ('sync-session', '{}', 'b', 'running', now() - interval '100 days', now() - interval '100 days')`,
    )

    const report = await runRetention(database)

    expect(report.deletedJobs).toBe(0)
    const { rows } = await database.query<{ status: string }>('select status from jobs order by queue_key')
    expect(rows).toEqual([{ status: 'queued' }, { status: 'running' }])
  })

  it('deletes oauth_states older than the window', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await database.query(
      `insert into oauth_states (state, user_id, redirect_uri, created_at)
       values ('old-state', $1, '/callback', now() - interval '2 hours'),
              ('fresh-state', $1, '/callback', now() - interval '30 minutes')`,
      [userId],
    )

    const report = await runRetention(database, { windows: { oauthStatesHours: 1 } })

    expect(report.deletedOauthStates).toBe(1)
    const { rows } = await database.query<{ state: string }>('select state from oauth_states')
    expect(rows).toEqual([{ state: 'fresh-state' }])
  })

  it('deletes expired sessions older than the window', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await database.query(
      `insert into sessions (user_id, expires_at)
       values ($1, now() - interval '31 days'),
              ($1, now() + interval '1 day')`,
      [userId],
    )

    const report = await runRetention(database, { windows: { sessionsDays: 30 } })

    expect(report.deletedSessions).toBe(1)
  })

  it('keeps audit log entries younger than the two-year window', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await database.query(
      `insert into audit_log (user_id, action, outcome, at)
       values ($1, 'write', 'ok', now() - interval '1 year')`,
      [userId],
    )

    const report = await runRetention(database, { windows: { auditLogYears: 2 } })

    expect(report.deletedAuditLog).toBe(0)
  })

  it('deletes in batches and stays within the batch cap', async () => {
    for (let i = 0; i < 25; i++) {
      await database.query(
        `insert into jobs (kind, payload, queue_key, status, updated_at, created_at)
         values ('sync-session', '{}', 'a', 'done', now() - interval '8 days', now() - interval '8 days')`,
      )
    }

    const report = await runRetention(database, {
      windows: { doneJobsDays: 7 },
      batchSize: 10,
      maxBatches: 2,
    })

    expect(report.deletedJobs).toBe(20)
    const { rows } = await database.query<{ n: string }>('select count(*)::text as n from jobs')
    expect(Number(rows[0]?.n)).toBe(5)
  })

  it('is safe to re-run after interruption', async () => {
    await database.query(
      `insert into jobs (kind, payload, queue_key, status, updated_at, created_at)
       values ('sync-session', '{}', 'a', 'done', now() - interval '8 days', now() - interval '8 days'),
              ('sync-session', '{}', 'b', 'done', now() - interval '8 days', now() - interval '8 days')`,
    )

    await runRetention(database, { windows: { doneJobsDays: 7 }, batchSize: 1, maxBatches: 1 })
    const second = await runRetention(database, { windows: { doneJobsDays: 7 } })

    expect(second.deletedJobs).toBe(1)
    const { rows } = await database.query<{ n: string }>('select count(*)::text as n from jobs')
    expect(Number(rows[0]?.n)).toBe(0)
  })

  it('exposes default windows that match PRIVACY.md', () => {
    expect(DEFAULT_RETENTION_WINDOWS).toEqual({
      doneJobsDays: 7,
      failedJobsDays: 30,
      oauthStatesHours: 1,
      sessionsDays: 30,
      auditLogYears: 2,
    })
  })
})
