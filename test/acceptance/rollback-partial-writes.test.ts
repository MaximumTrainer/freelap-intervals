import { describe, expect, it } from 'vitest'

import { renderFreelapBlock } from '~/domain/description-block'
import { WriteStepError } from '~/write/activity-writer'

import { csvFixture } from '../support/fixtures'
import { oneHzStreams } from '../support/streams'
import { aTestApp, theOnlySession } from '../support/test-app'

const aWatchRun = () => ({
  start_date_local: '2026-08-29T10:10:00',
  type: 'Run',
  name: 'Morning Run',
  moving_time: 1200,
  description: 'Track session.',
})

describe('rolling back partial writes when a sync fails mid-way', () => {
  describe('attach mode', () => {
    it('restores intervals when the custom-fields step fails', async () => {
      const { app, icu } = aTestApp()
      const watchRun = icu.givenActivity(aWatchRun(), oneHzStreams(1200))
      const athleteInterval = { type: 'WORK' as const, name: 'Warmup', start_index: 0, end_index: 100 }
      await icu.putIntervals(watchRun.id, [athleteInterval])

      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      icu.failMethodCallWith('ensureCustomFields', 500)

      await expect(app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id })).rejects.toThrow(
        WriteStepError,
      )

      const intervals = icu.intervalsOf(watchRun.id)
      expect(intervals).toEqual([athleteInterval])
      expect(icu.activity(watchRun.id).description).toBe('Track session.')
    })

    it('restores intervals when the description step fails', async () => {
      const { app, icu } = aTestApp()
      const watchRun = icu.givenActivity(aWatchRun(), oneHzStreams(1200))
      const athleteInterval = { type: 'WORK' as const, name: 'Warmup', start_index: 0, end_index: 100 }
      await icu.putIntervals(watchRun.id, [athleteInterval])

      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      icu.failMethodCallWith('updateActivity', 500)

      await expect(app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id })).rejects.toThrow(
        WriteStepError,
      )

      const intervals = icu.intervalsOf(watchRun.id)
      expect(intervals).toEqual([athleteInterval])
      expect(icu.activity(watchRun.id).description).toBe('Track session.')
    })

    it('restores an older Freelap block and athlete prose on rollback', async () => {
      const { app, icu } = aTestApp()
      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      const olderBlock = renderFreelapBlock(session)
      const proseAndBlock = `My notes about this session.\n\n${olderBlock}`

      const watchRun = icu.givenActivity(
        { ...aWatchRun(), description: proseAndBlock },
        oneHzStreams(1200),
      )

      icu.failMethodCallWith('updateActivity', 500)

      await expect(app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id })).rejects.toThrow(
        WriteStepError,
      )

      expect(icu.activity(watchRun.id).description).toBe(proseAndBlock)
    })

    it('does not touch the activity when the intervals step fails', async () => {
      const { app, icu } = aTestApp()
      const watchRun = icu.givenActivity(aWatchRun(), oneHzStreams(1200))
      const athleteInterval = { type: 'WORK' as const, name: 'Warmup', start_index: 0, end_index: 100 }
      await icu.putIntervals(watchRun.id, [athleteInterval])

      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      icu.failMethodCallWith('putIntervals', 500)

      await expect(app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id })).rejects.toThrow(
        WriteStepError,
      )

      expect(icu.intervalsOf(watchRun.id)).toEqual([athleteInterval])
      expect(icu.activity(watchRun.id).description).toBe('Track session.')
    })

    it('records completedSteps and rollback outcome in the ledger', async () => {
      const { app, icu, ledger } = aTestApp()
      const watchRun = icu.givenActivity(aWatchRun(), oneHzStreams(1200))

      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      icu.failMethodCallWith('updateActivity', 500)

      await expect(app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id })).rejects.toThrow()

      const entry = await ledger.findBySourceId(session.sourceId)
      expect(entry).toMatchObject({
        status: 'failed',
        failedStep: 'description',
        completedSteps: ['activity', 'intervals', 'custom-fields'],
        rollback: 'ok',
      })
    })
  })

  describe('create mode', () => {
    it('deletes the created activity when the intervals step fails', async () => {
      const { app, icu } = aTestApp()
      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      icu.failMethodCallWith('putIntervals', 500)

      await expect(app.sync(session.sourceId, { mode: 'create-new' })).rejects.toThrow(WriteStepError)

      expect(icu.activityCount).toBe(0)
    })

    it('deletes the created activity when the custom-fields step fails', async () => {
      const { app, icu } = aTestApp()
      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      icu.failMethodCallWith('ensureCustomFields', 500)

      await expect(app.sync(session.sourceId, { mode: 'create-new' })).rejects.toThrow(WriteStepError)

      expect(icu.activityCount).toBe(0)
    })

    it('deletes the created activity when the description step fails', async () => {
      const { app, icu } = aTestApp()
      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      icu.failMethodCallWith('updateActivity', 500)

      await expect(app.sync(session.sourceId, { mode: 'create-new' })).rejects.toThrow(WriteStepError)

      expect(icu.activityCount).toBe(0)
    })

    it('records completedSteps and rollback outcome in the ledger', async () => {
      const { app, icu, ledger } = aTestApp()
      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
      icu.failMethodCallWith('ensureCustomFields', 500)

      await expect(app.sync(session.sourceId, { mode: 'create-new' })).rejects.toThrow()

      const entry = await ledger.findBySourceId(session.sourceId)
      expect(entry).toMatchObject({
        status: 'failed',
        failedStep: 'custom-fields',
        completedSteps: ['activity', 'intervals'],
        rollback: 'ok',
      })
    })
  })

  describe('rollback failure', () => {
    it('surfaces the original error and records rollback as failed', async () => {
      const { app, icu, ledger } = aTestApp()
      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

      icu.failMethodCallWith('ensureCustomFields', 500)
      icu.failMethodCallWith('deleteActivity', 500)

      const error = await app
        .sync(session.sourceId, { mode: 'create-new' })
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(WriteStepError)
      expect((error as WriteStepError).step).toBe('custom-fields')
      expect((error as WriteStepError).rollback).toBe('failed')

      const entry = await ledger.findBySourceId(session.sourceId)
      expect(entry).toMatchObject({ rollback: 'failed' })
    })
  })

  describe('idempotent rollback', () => {
    it('leaves the same state when compensation runs twice against the same activity', async () => {
      const { app, icu } = aTestApp()
      const watchRun = icu.givenActivity(aWatchRun(), oneHzStreams(1200))
      const athleteInterval = { type: 'WORK' as const, name: 'Warmup', start_index: 0, end_index: 100 }
      await icu.putIntervals(watchRun.id, [athleteInterval])

      const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

      icu.failMethodCallWith('updateActivity', 500)
      await expect(app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id })).rejects.toThrow()

      const stateAfterFirst = {
        intervals: icu.intervalsOf(watchRun.id),
        description: icu.activity(watchRun.id).description,
      }

      icu.failMethodCallWith('updateActivity', 500)
      await expect(app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id })).rejects.toThrow()

      expect(icu.intervalsOf(watchRun.id)).toEqual(stateAfterFirst.intervals)
      expect(icu.activity(watchRun.id).description).toBe(stateAfterFirst.description)
    })
  })
})
