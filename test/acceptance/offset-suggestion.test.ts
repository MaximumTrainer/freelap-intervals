import { describe, expect, it } from 'vitest'

import type { IcuStreams } from '~/icu/intervals-icu-client'

import { csvFixture } from '../support/fixtures'
import { aTestApp, theOnlySession } from '../support/test-app'

/**
 * Builds a 1 Hz stream where speed peaks at the rep starts shifted by `shiftS` seconds.
 * The CSV fixture has reps starting at ~243 s, ~391 s, ~488 s, ~570 s, ~654 s, ~737 s
 * into the recording (the session starts 4:03 into a 20-minute watch run).
 */
function streamWithShiftedPeaks(durationS: number, repStartsS: number[], shiftS: number): IcuStreams {
  const time = Array.from({ length: durationS + 1 }, (_, i) => i)
  const speeds = time.map((t) => {
    for (const start of repStartsS) {
      const peakAt = start + shiftS
      if (t >= peakAt && t <= peakAt + 3) return 9
    }

    return 1
  })

  return { time, velocity_smooth: speeds }
}

describe('clock offset suggestion (C5)', () => {
  it('suggests a positive offset when speed peaks are shifted later than the rep starts', async () => {
    const { app, icu } = aTestApp()

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

    const repStartsS = [243, 391, 488, 570, 654, 737]
    const shiftS = 7
    icu.givenActivity(
      { start_date_local: '2026-08-29T10:10:00', name: 'Morning Run', moving_time: 1200 },
      streamWithShiftedPeaks(1200, repStartsS, shiftS),
    )

    const plan = await app.planSync(session.sourceId)
    expect(plan.recommendation).toEqual({ mode: 'attach', activityId: 'a1' })

    const preview = await app.previewFor(plan)

    expect(preview.suggestedOffsetS).not.toBeNull()
    expect(preview.suggestedOffsetS!).toBeGreaterThanOrEqual(6)
    expect(preview.suggestedOffsetS!).toBeLessThanOrEqual(8)
  })

  it('suggests a negative offset when speed peaks are shifted earlier', async () => {
    const { app, icu } = aTestApp()

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

    const repStartsS = [243, 391, 488, 570, 654, 737]
    const shiftS = -25
    icu.givenActivity(
      { start_date_local: '2026-08-29T10:10:00', name: 'Morning Run', moving_time: 1200 },
      streamWithShiftedPeaks(1200, repStartsS, shiftS),
    )

    const plan = await app.planSync(session.sourceId)
    const preview = await app.previewFor(plan)

    expect(preview.suggestedOffsetS).not.toBeNull()
    expect(preview.suggestedOffsetS!).toBeGreaterThanOrEqual(-26)
    expect(preview.suggestedOffsetS!).toBeLessThanOrEqual(-24)
  })

  it('returns null for a flat speed stream', async () => {
    const { app, icu } = aTestApp()

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

    const time = Array.from({ length: 1201 }, (_, i) => i)
    icu.givenActivity(
      { start_date_local: '2026-08-29T10:10:00', name: 'Morning Run', moving_time: 1200 },
      { time, velocity_smooth: time.map(() => 3) },
    )

    const plan = await app.planSync(session.sourceId)
    const preview = await app.previewFor(plan)

    expect(preview.suggestedOffsetS).toBeNull()
  })

  it('returns null in create mode without fetching streams', async () => {
    const { app } = aTestApp()

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))
    const plan = await app.planSync(session.sourceId)

    expect(plan.recommendation).toEqual({ mode: 'create-new' })

    const preview = await app.previewFor(plan)

    expect(preview.suggestedOffsetS).toBeNull()
    expect(preview.stream).toBeNull()
  })

  it('flows the suggested offset through to a passing sync when accepted unchanged', async () => {
    const { app, icu } = aTestApp()

    const session = theOnlySession(await app.importCsv(csvFixture('flying-30m-semicolon.csv')))

    const repStartsS = [243, 391, 488, 570, 654, 737]
    const shiftS = 7
    icu.givenActivity(
      { start_date_local: '2026-08-29T10:10:00', name: 'Morning Run', moving_time: 1200 },
      streamWithShiftedPeaks(1200, repStartsS, shiftS),
    )

    const plan = await app.planSync(session.sourceId)
    const preview = await app.previewFor(plan)

    expect(preview.suggestedOffsetS).not.toBeNull()

    const outcome = await app.sync(
      session.sourceId,
      plan.recommendation,
      { offsetS: preview.suggestedOffsetS! },
    )

    expect(outcome.verification.status).toBe('pass')
  })
})
