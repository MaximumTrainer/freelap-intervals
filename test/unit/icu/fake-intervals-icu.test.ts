import { describe, expect, it } from 'vitest'

import { IntervalsIcuError } from '~/icu/intervals-icu-client'
import { encodeFitActivity } from '~/write/fit'

import { FakeIntervalsIcu } from '../../support/fake-intervals-icu'

const aFitFile = (): Uint8Array =>
  encodeFitActivity({
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

describe('FakeIntervalsIcu', () => {
  it('creates an activity by decoding the uploaded FIT file', async () => {
    const icu = new FakeIntervalsIcu({ timezone: 'Europe/London' })

    const created = await icu.uploadActivity(icu.athleteId, {
      filename: 'session.fit',
      bytes: aFitFile(),
      name: 'Flying 30m (Freelap)',
      externalId: 'freelap:csv-abc',
    })

    expect(created).toMatchObject({
      start_date_local: '2026-08-29T10:14:03',
      type: 'Run',
      distance: 60,
      external_id: 'freelap:csv-abc',
    })
    expect(await icu.getStreams(created.id)).toEqual({ time: [0, 10], distance: [0, 60], velocity_smooth: [0, 6] })
  })

  it('refuses a FIT file that is not readable', async () => {
    const icu = new FakeIntervalsIcu()

    await expect(
      icu.uploadActivity(icu.athleteId, { filename: 'x.fit', bytes: new Uint8Array(20), name: 'x' }),
    ).rejects.toThrow(/FIT/i)
  })

  it('lists only the activities inside the requested day range', async () => {
    const icu = new FakeIntervalsIcu()
    icu.givenActivity({ start_date_local: '2026-08-28T10:00:00' })
    const wanted = icu.givenActivity({ start_date_local: '2026-08-29T10:00:00' })

    const listed = await icu.listActivities(icu.athleteId, { oldest: '2026-08-29', newest: '2026-08-30' })

    expect(listed.map((activity) => activity.id)).toEqual([wanted.id])
  })

  it('rejects custom field values whose field was never created', async () => {
    const icu = new FakeIntervalsIcu()
    const activity = icu.givenActivity({ start_date_local: '2026-08-29T10:00:00' })

    await expect(icu.setCustomFields(activity.id, { fl_best_s: 3.35 })).rejects.toThrow(/fl_best_s/)

    await icu.ensureCustomFields(icu.athleteId, [{ code: 'fl_best_s', name: 'Best', type: 'NUMBER' }])
    await icu.setCustomFields(activity.id, { fl_best_s: 3.35 })

    expect(icu.activity(activity.id).custom_fields).toEqual({ fl_best_s: 3.35 })
  })

  it('fails the next call on demand so error paths can be exercised', async () => {
    const icu = new FakeIntervalsIcu()
    icu.failNextCallWith(429)

    await expect(icu.athlete('i1')).rejects.toBeInstanceOf(IntervalsIcuError)
    await expect(icu.athlete('i1')).resolves.toMatchObject({ id: 'i1' })
  })
})
