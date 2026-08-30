import { describe, expect, it } from 'vitest'

import type { SyncApplication } from '~/app/sync-application'

import { csvFixture } from '../support/fixtures'
import type { FakeIntervalsIcu } from '../support/fake-intervals-icu'
import { oneHzStreams } from '../support/streams'
import { aTestApp, theOnlySession } from '../support/test-app'

const importFixture = async (app: SyncApplication): Promise<string> =>
  theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv'))).sourceId

const snapshotOf = (icu: FakeIntervalsIcu, activityId: string) => ({
  activity: icu.activity(activityId),
  intervals: icu.intervalsOf(activityId),
})

describe('re-syncing a session that was already written', () => {
  it('leaves intervals.icu byte-for-byte unchanged when nothing about the session changed', async () => {
    const { app, icu, ledger } = aTestApp()
    const sourceId = await importFixture(app)
    const first = await app.sync(sourceId, { mode: 'create-new' })
    const before = structuredClone(snapshotOf(icu, first.activityId))

    const second = await app.sync(sourceId, { mode: 'attach', activityId: first.activityId })

    expect(second.activityId).toBe(first.activityId)
    expect(icu.activityCount).toBe(1)
    expect(snapshotOf(icu, first.activityId)).toEqual(before)
    expect(second.verification).toEqual({ status: 'pass', diffs: [] })
    expect((await ledger.findBySourceId(sourceId))?.contentHash).toBe(first.entry.contentHash)
  })

  it('sends the athlete back to the activity it synced last time', async () => {
    const { app, icu } = aTestApp()
    icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Sprint session' }, oneHzStreams(1200))
    const sourceId = await importFixture(app)
    const created = await app.sync(sourceId, { mode: 'create-new' })

    const plan = await app.planSync(sourceId)

    expect(plan.recommendation).toEqual({ mode: 'attach', activityId: created.activityId })
    expect(plan.previousSync).toMatchObject({ activityId: created.activityId, status: 'synced' })
  })

  it('keeps intervals and notes the athlete added between syncs', async () => {
    const { app, icu } = aTestApp()
    const watchRun = icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
    const sourceId = await importFixture(app)
    await app.sync(sourceId, { mode: 'attach', activityId: watchRun.id })

    await icu.putIntervals(watchRun.id, [
      ...icu.intervalsOf(watchRun.id),
      { type: 'RECOVERY', name: 'Cool down', start_index: 1100, end_index: 1200 },
    ])
    await icu.updateActivity(watchRun.id, {
      description: `Legs felt good.\n\n${icu.activity(watchRun.id).description}`,
    })

    await app.sync(sourceId, { mode: 'attach', activityId: watchRun.id })

    const intervals = icu.intervalsOf(watchRun.id)
    expect(intervals).toHaveLength(7)
    expect(intervals.at(-1)?.name).toBe('Cool down')
    expect(icu.activity(watchRun.id).description).toMatch(/^Legs felt good\.\n\n<!-- freelap:start -->/)
  })
})

describe('detecting changes made on intervals.icu after a sync', () => {
  it('flags the ledger as drifted when our intervals were removed', async () => {
    const { app, icu, ledger } = aTestApp()
    const sourceId = await importFixture(app)
    const { activityId } = await app.sync(sourceId, { mode: 'create-new' })

    await icu.putIntervals(activityId, [])
    const report = await app.verify(sourceId)

    expect(report.status).toBe('fail')
    expect(report.diffs).toContainEqual(expect.objectContaining({ check: 'interval count', expected: '6', actual: '0' }))
    expect(await ledger.findBySourceId(sourceId)).toMatchObject({ status: 'drifted' })
  })

  it('reports a partial pass when only the description block was edited', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importFixture(app)
    const { activityId } = await app.sync(sourceId, { mode: 'create-new' })

    await icu.updateActivity(activityId, { description: '<!-- freelap:start -->\nedited\n<!-- freelap:end -->' })
    const report = await app.verify(sourceId)

    expect(report.status).toBe('partial')
    expect(report.diffs.map((diff) => diff.check)).toEqual(['description block'])
  })

  it('restores what the athlete edited when the session is synced again', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importFixture(app)
    const { activityId } = await app.sync(sourceId, { mode: 'create-new' })
    await icu.putIntervals(activityId, [])

    const repaired = await app.sync(sourceId, { mode: 'attach', activityId })

    expect(repaired.verification).toEqual({ status: 'pass', diffs: [] })
  })
})
