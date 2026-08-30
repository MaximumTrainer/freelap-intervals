import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PgSessionRepository } from '~/app/pg-session-repository'
import { SyncApplication } from '~/app/sync-application'
import { PgSyncLedger } from '~/ledger/pg-sync-ledger'

import type { TestDatabase } from '../support/test-database'
import { aTestDatabase } from '../support/test-database'
import { FakeIntervalsIcu } from '../support/fake-intervals-icu'
import { csvFixture } from '../support/fixtures'
import { theOnlySession } from '../support/test-app'

describe('the sync flow backed by Postgres', () => {
  let database: TestDatabase
  let userId: string

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
  })

  afterEach(async () => {
    await database.close()
  })

  const anApplication = (icu: FakeIntervalsIcu): SyncApplication =>
    new SyncApplication({
      icu,
      ledger: new PgSyncLedger(database, userId),
      sessions: new PgSessionRepository(database, userId),
      athleteId: icu.athleteId,
    })

  it('imports, writes and verifies with every row surviving in the database', async () => {
    const icu = new FakeIntervalsIcu({ timezone: 'Europe/London' })
    const session = theOnlySession(await anApplication(icu).importCsv(csvFixture('flying-30m-semicolon.csv')))

    const outcome = await anApplication(icu).sync(session.sourceId, { mode: 'create-new' })

    expect(outcome.verification.status).toBe('pass')

    // A fresh application, sharing only the database, sees the same session and sync.
    const reopened = anApplication(icu)
    expect(await reopened.findSession(session.sourceId)).toEqual(session)
    expect(await reopened.planSync(session.sourceId)).toMatchObject({
      recommendation: { mode: 'attach', activityId: outcome.activityId },
      previousSync: { status: 'synced', mode: 'create-new' },
    })
  })

  it('keeps a verification history for the session', async () => {
    const icu = new FakeIntervalsIcu({ timezone: 'Europe/London' })
    const app = anApplication(icu)
    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
    const { activityId } = await app.sync(session.sourceId, { mode: 'create-new' })

    await icu.putIntervals(activityId, [])
    await app.verify(session.sourceId)

    const history = await database.query<{ status: string }>(
      'select status from verifications where source_id = $1 order by id',
      [session.sourceId],
    )

    expect(history.rows.map((row) => row.status)).toEqual(['pass', 'fail'])
    expect(await app.planSync(session.sourceId)).toMatchObject({ previousSync: { status: 'drifted' } })
  })

  it('keeps one athlete\'s sessions out of another\'s', async () => {
    const icu = new FakeIntervalsIcu({ timezone: 'Europe/London' })
    const session = theOnlySession(await anApplication(icu).importCsv(csvFixture('flying-30m-semicolon.csv')))

    const otherUserId = await database.givenUser('someone-else@example.com')
    const theirs = new SyncApplication({
      icu,
      ledger: new PgSyncLedger(database, otherUserId),
      sessions: new PgSessionRepository(database, otherUserId),
      athleteId: icu.athleteId,
    })

    expect(await theirs.findSession(session.sourceId)).toBeNull()
    expect(await theirs.importedSessions()).toEqual([])
  })
})
