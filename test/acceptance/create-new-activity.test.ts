import { describe, expect, it } from 'vitest'

import { csvFixture } from '../support/fixtures'
import { aTestApp, theOnlySession } from '../support/test-app'

describe('syncing a Freelap session when there is no watch recording', () => {
  it('creates a new intervals.icu activity from a synthetic FIT and verifies it', async () => {
    const { app, icu, ledger } = aTestApp()

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

    expect(session.exerciseName).toBe('Flying 30m')
    expect(session.startedAt).toBe('2026-08-29T10:14:03+01:00')
    expect(session.reps).toHaveLength(6)
    expect(session.summary).toEqual({ count: 6, bestS: 3.35, worstS: 3.61, avgS: 3.452 })

    const plan = await app.planSync(session.sourceId)

    expect(plan.candidates).toEqual([])
    expect(plan.recommendation).toEqual({ mode: 'create-new' })

    const outcome = await app.sync(session.sourceId, plan.recommendation)

    expect(outcome.verification.status).toBe('pass')
    expect(outcome.verification.diffs).toEqual([])

    const activity = icu.activity(outcome.activityId)
    expect(activity.external_id).toBe(`freelap:${session.sourceId}`)
    expect(activity.type).toBe('Run')
    expect(activity.name).toBe('Flying 30m (Freelap)')

    const intervals = icu.intervalsOf(outcome.activityId)
    expect(intervals.map((interval) => interval.name)).toEqual([
      'FL #1 · 30m · 3.42s',
      'FL #2 · 30m · 3.38s',
      'FL #3 · 30m · 3.51s',
      'FL #4 · 30m · 3.35s',
      'FL #5 · 30m · 3.44s',
      'FL #6 · 30m · 3.61s',
    ])
    expect(intervals.map((interval) => interval.end_index - interval.start_index)).toEqual([3, 3, 4, 3, 3, 4])

    expect(activity.custom_fields).toMatchObject({
      fl_session_id: session.sourceId,
      fl_rep_count: 6,
      fl_best_s: 3.35,
      fl_avg_s: 3.452,
      fl_distance_m: 30,
    })

    expect(activity.description).toContain('<!-- freelap:start -->')
    expect(activity.description).toContain('| 4 | 3.35 | 1.18 | 34.1 |')

    const entry = await ledger.findBySourceId(session.sourceId)
    expect(entry).toMatchObject({ status: 'synced', activityId: outcome.activityId, mode: 'create-new' })
  })
})
