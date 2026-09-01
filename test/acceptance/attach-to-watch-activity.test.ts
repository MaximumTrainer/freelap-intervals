import { describe, expect, it } from 'vitest'

import { NoStreamsError, WriteStepError } from '~/write/activity-writer'

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

describe('syncing a Freelap session onto the watch recording of the same session', () => {
  it('attaches intervals, fields and a description block without disturbing the athlete\'s own data', async () => {
    const { app, icu, ledger } = aTestApp()
    const watchRun = icu.givenActivity(aWatchRun(), oneHzStreams(1200))
    await icu.putIntervals(watchRun.id, [{ type: 'WORK', name: 'Warmup', start_index: 0, end_index: 100 }])

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
    const plan = await app.planSync(session.sourceId)

    expect(plan.recommendation).toEqual({ mode: 'attach', activityId: watchRun.id })
    expect(plan.needsConfirmation).toBe(false)
    expect(plan.candidates[0]?.reasons).toContain('overlaps the session')

    const outcome = await app.sync(session.sourceId, plan.recommendation)

    expect(outcome.verification).toEqual({ status: 'pass', diffs: [] })
    expect(icu.activityCount).toBe(1) // nothing new was created

    const intervals = icu.intervalsOf(watchRun.id)
    expect(intervals.map((interval) => interval.name)).toEqual([
      'Warmup',
      'FL #1 · 30m · 3.42s',
      'FL #2 · 30m · 3.38s',
      'FL #3 · 30m · 3.51s',
      'FL #4 · 30m · 3.35s',
      'FL #5 · 30m · 3.44s',
      'FL #6 · 30m · 3.61s',
    ])
    // The session starts 4:03 into the recording, so the first rep sits at sample 243.
    expect(intervals[1]).toMatchObject({ start_index: 243, end_index: 246 })
    expect(intervals[2]).toMatchObject({ start_index: 391, end_index: 394 })

    const activity = icu.activity(watchRun.id)
    expect(activity.description).toBe(`Track session.\n\n${extractBlock(activity.description)}`)
    expect(activity.external_id).toBe(`freelap:${session.sourceId}`)
    expect(activity.custom_fields).toMatchObject({ fl_rep_count: 6, fl_best_s: 3.35 })

    expect(await ledger.findBySourceId(session.sourceId)).toMatchObject({
      mode: 'attach',
      activityId: watchRun.id,
      status: 'synced',
    })
  })

  it('shifts every rep when the athlete corrects for clock drift', async () => {
    const { app, icu } = aTestApp()
    const watchRun = icu.givenActivity(aWatchRun(), oneHzStreams(1200))

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
    const outcome = await app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id }, { offsetS: -12 })

    expect(outcome.verification.status).toBe('pass')
    expect(icu.intervalsOf(watchRun.id)[0]).toMatchObject({ start_index: 231, end_index: 234 })
  })

  it('refuses to attach to an activity with no streams and records the failure', async () => {
    const { app, icu, ledger } = aTestApp()
    const manualActivity = icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Manual Entry' })

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

    try {
      await app.sync(session.sourceId, { mode: 'attach', activityId: manualActivity.id })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(WriteStepError)
      expect((error as WriteStepError).step).toBe('intervals')
      expect((error as WriteStepError).cause).toBeInstanceOf(NoStreamsError)
    }

    expect(icu.intervalsOf(manualActivity.id)).toEqual([])
    expect(icu.activity(manualActivity.id).description).toBeNull()

    const entry = await ledger.findBySourceId(session.sourceId)
    expect(entry).toMatchObject({ status: 'failed', failedStep: 'intervals' })
  })

  it('falls back to Mode B after a no-streams refusal, creating a new activity', async () => {
    const { app, icu, ledger } = aTestApp()
    icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Manual Entry' })

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

    await expect(app.sync(session.sourceId, { mode: 'attach', activityId: 'a1' })).rejects.toThrow()

    const fallback = await app.sync(session.sourceId, { mode: 'create-new' })

    expect(fallback.verification.status).toBe('pass')
    expect(icu.activityCount).toBe(2)

    const entry = await ledger.findBySourceId(session.sourceId)
    expect(entry).toMatchObject({ status: 'synced', mode: 'create-new' })
  })

  it('flags a stream-less activity in the preview', async () => {
    const { app, icu } = aTestApp()
    icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Manual Entry' })

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
    const plan = await app.planSync(session.sourceId)

    expect(plan.recommendation).toEqual({ mode: 'attach', activityId: 'a1' })

    const preview = await app.previewFor(plan)

    expect(preview.stream).toBeNull()
    expect(preview.noStreams).toBe(true)
  })

  it('refuses to claim an activity that already belongs to another Freelap session', async () => {
    const { app, icu, ledger } = aTestApp()
    const watchRun = icu.givenActivity(
      { ...aWatchRun(), external_id: 'freelap:csv-someoneelse' },
      oneHzStreams(1200),
    )

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

    await expect(app.sync(session.sourceId, { mode: 'attach', activityId: watchRun.id })).rejects.toThrow(
      /already carries Freelap session csv-someoneelse/,
    )

    expect(icu.intervalsOf(watchRun.id)).toEqual([])
    expect(icu.activity(watchRun.id).description).toBe('Track session.')
    expect(await ledger.findBySourceId(session.sourceId)).toMatchObject({ status: 'failed', failedStep: 'activity' })
  })
})

function extractBlock(description: string | null | undefined): string {
  return /<!-- freelap:start -->[\s\S]*<!-- freelap:end -->/.exec(description ?? '')?.[0] ?? ''
}
