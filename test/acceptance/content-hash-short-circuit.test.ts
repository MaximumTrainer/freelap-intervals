import { describe, expect, it } from 'vitest'

import type { SyncApplication } from '~/app/sync-application'

import { aRep, aSession } from '../support/builders'
import type { FakeIntervalsIcu } from '../support/fake-intervals-icu'
import { oneHzStreams } from '../support/streams'
import { aTestApp } from '../support/test-app'

const importSession = async (app: SyncApplication, icu: FakeIntervalsIcu) => {
  icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
  const session = aSession()
  await app.importSessions([session])
  return session.sourceId
}

describe('short-circuiting an unchanged re-sync (C2)', () => {
  it('skips the write when the session, activity and offset are all unchanged', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importSession(app, icu)
    await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })
    const writesBefore = icu.writeCallCount

    const second = await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    expect(second.skipped).toBe(true)
    expect(icu.writeCallCount).toBe(writesBefore)
    expect(second.verification).toEqual({ status: 'pass', diffs: [] })
  })

  it('does the full write when the content hash differs', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importSession(app, icu)
    await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    const changed = aSession({
      sourceId,
      reps: [aRep({ index: 1, totalS: 9.99 }), aRep({ index: 2, totalS: 9.88 })],
    })
    await app.importSessions([changed])

    const second = await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    expect(second.skipped).toBeUndefined()
  })

  it('does the full write when the previous ledger status is drifted', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importSession(app, icu)
    await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    await icu.putIntervals('a1', [])
    await app.verify(sourceId)

    const writesBefore = icu.writeCallCount
    const repaired = await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    expect(repaired.skipped).toBeUndefined()
    expect(icu.writeCallCount).toBeGreaterThan(writesBefore)
  })

  it('does the full write when force is set', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importSession(app, icu)
    await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })
    const writesBefore = icu.writeCallCount

    const forced = await app.sync(sourceId, { mode: 'attach', activityId: 'a1' }, { force: true })

    expect(forced.skipped).toBeUndefined()
    expect(icu.writeCallCount).toBeGreaterThan(writesBefore)
  })

  it('does the full write when the target activity changes', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importSession(app, icu)
    icu.givenActivity({ id: 'a2', start_date_local: '2026-08-29T10:10:00', name: 'Second Run' }, oneHzStreams(1200))
    await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    const second = await app.sync(sourceId, { mode: 'attach', activityId: 'a2' })

    expect(second.skipped).toBeUndefined()
    expect(second.activityId).toBe('a2')
  })

  it('does the full write when the offset changes', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importSession(app, icu)
    await app.sync(sourceId, { mode: 'attach', activityId: 'a1' }, { offsetS: 0 })

    const second = await app.sync(sourceId, { mode: 'attach', activityId: 'a1' }, { offsetS: 5 })

    expect(second.skipped).toBeUndefined()
  })

  it('still re-verifies even when skipping the write', async () => {
    const { app, icu, ledger } = aTestApp()
    const sourceId = await importSession(app, icu)
    await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    const second = await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    expect(second.skipped).toBe(true)
    expect(second.verification.status).toBe('pass')
    const entry = await ledger.findBySourceId(sourceId)
    expect(entry?.syncedAt).toBeDefined()
  })

  it('falls through to a full write when the skipped verification fails', async () => {
    const { app, icu } = aTestApp()
    const sourceId = await importSession(app, icu)
    await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    await icu.putIntervals('a1', [])

    const second = await app.sync(sourceId, { mode: 'attach', activityId: 'a1' })

    expect(second.skipped).toBeUndefined()
    expect(second.verification.status).toBe('pass')
  })
})
