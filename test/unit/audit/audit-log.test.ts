import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PgAuditLog } from '~/audit/pg-audit-log'
import { AuditedIntervalsIcuClient } from '~/icu/audited-intervals-icu-client'
import { IntervalsIcuError } from '~/icu/intervals-icu-client'

import { FakeIntervalsIcu } from '../../support/fake-intervals-icu'
import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

describe('the audit log', () => {
  let database: TestDatabase
  let userId: string
  let audit: PgAuditLog
  let icu: FakeIntervalsIcu

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
    audit = new PgAuditLog(database)
    icu = new FakeIntervalsIcu({ timezone: 'Europe/London' })
  })

  afterEach(async () => {
    await database.close()
  })

  const audited = (): AuditedIntervalsIcuClient => new AuditedIntervalsIcuClient(icu, audit, userId)

  it('records every write this integration makes to somebody else\'s system', async () => {
    const activity = icu.givenActivity({ start_date_local: '2026-08-29T10:00:00' })

    await audited().putIntervals(activity.id, [{ type: 'WORK', name: 'FL #1', start_index: 0, end_index: 3 }])

    expect(await audit.recent(userId)).toEqual([
      expect.objectContaining({
        action: 'intervals.icu putIntervals',
        target: activity.id,
        outcome: 'ok',
        detail: { intervalCount: 1 },
      }),
    ])
  })

  it('records a write that failed, with the status the server gave', async () => {
    const activity = icu.givenActivity({ start_date_local: '2026-08-29T10:00:00' })
    icu.failNextCallWith(429, 'slow down')

    await expect(audited().updateActivity(activity.id, { name: 'x' })).rejects.toBeInstanceOf(IntervalsIcuError)

    expect(await audit.recent(userId)).toEqual([
      expect.objectContaining({
        action: 'intervals.icu updateActivity',
        outcome: 'error',
        statusCode: 429,
        detail: expect.objectContaining({ error: expect.stringContaining('slow down') }),
      }),
    ])
  })

  it('leaves reads out of the audit trail', async () => {
    const activity = icu.givenActivity({ start_date_local: '2026-08-29T10:00:00' })

    await audited().getActivity(activity.id)
    await audited().getIntervals(activity.id)

    expect(await audit.recent(userId)).toEqual([])
  })

  it('reads back newest first, and only for the athlete who asked', async () => {
    const activity = icu.givenActivity({ start_date_local: '2026-08-29T10:00:00' })
    await audited().updateActivity(activity.id, { name: 'first' })
    await audited().updateActivity(activity.id, { name: 'second' })

    const otherUserId = await database.givenUser('someone-else@example.com')

    expect((await audit.recent(userId)).map((entry) => entry.detail)).toEqual([
      { fields: ['name'] },
      { fields: ['name'] },
    ])
    expect(await audit.recent(otherUserId)).toEqual([])
  })

  it('records what a session upload carried without carrying the file itself', async () => {
    await audited().uploadActivity(icu.athleteId, {
      filename: 'session.fit',
      bytes: await aFitFile(),
      name: 'Flying 30m (Freelap)',
      externalId: 'freelap:csv-abc',
    })

    expect(await audit.recent(userId)).toEqual([
      expect.objectContaining({
        action: 'intervals.icu uploadActivity',
        outcome: 'ok',
        detail: expect.objectContaining({ filename: 'session.fit', externalId: 'freelap:csv-abc' }),
      }),
    ])
  })
})

async function aFitFile(): Promise<Uint8Array> {
  const { encodeFitActivity } = await import('~/write/fit')

  return encodeFitActivity({
    startEpochMs: Date.parse('2026-08-29T09:14:03Z'),
    sport: 'running',
    durationS: 10,
    totalDistanceM: 60,
    records: [
      { offsetS: 0, distanceM: 0, speedMps: 0 },
      { offsetS: 10, distanceM: 60, speedMps: 6 },
    ],
    laps: [{ repIndex: 1, startS: 0, endS: 10, distanceM: 60, avgSpeedMps: 6, maxSpeedMps: 7 }],
  })
}
