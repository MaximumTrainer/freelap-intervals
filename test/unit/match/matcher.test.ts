import { describe, expect, it } from 'vitest'

import type { IcuActivity } from '~/icu/intervals-icu-client'
import { rankCandidates, searchWindowFor } from '~/match/matcher'

import { aSession } from '../../support/builders'

const session = aSession({ startedAt: '2026-08-29T10:14:03+01:00' })
const timezone = 'Europe/London'

const anActivity = (overrides: Partial<IcuActivity> & Pick<IcuActivity, 'id' | 'start_date_local'>): IcuActivity => ({
  type: 'Run',
  name: 'Afternoon Run',
  moving_time: 3600,
  ...overrides,
})

const rank = (activities: readonly IcuActivity[], linkage = {}) =>
  rankCandidates({ session, activities, timezone, ...linkage })

describe('searchWindowFor', () => {
  it('looks a day either side of the session', () => {
    expect(searchWindowFor(session, timezone)).toEqual({ oldest: '2026-08-28', newest: '2026-08-30' })
  })
})

describe('rankCandidates', () => {
  it('ignores activities outside the day either side of the session', () => {
    const far = anActivity({ id: 'a9', start_date_local: '2026-09-05T10:00:00' })

    expect(rank([far]).candidates).toEqual([])
  })

  it('ranks the run that overlaps the session above one that merely shares the day', () => {
    const overlapping = anActivity({ id: 'a1', start_date_local: '2026-08-29T10:05:00' })
    const elsewhere = anActivity({ id: 'a2', start_date_local: '2026-08-29T18:00:00' })

    expect(rank([elsewhere, overlapping]).candidates.map((candidate) => candidate.activity.id)).toEqual(['a1', 'a2'])
  })

  it('explains why it scored each candidate', () => {
    const overlapping = anActivity({ id: 'a1', start_date_local: '2026-08-29T10:05:00', name: 'Track sprints' })

    expect(rank([overlapping]).candidates[0]?.reasons).toEqual([
      'same day',
      'same sport',
      'overlaps the session',
      'named like speed work',
      'not linked to another Freelap session',
    ])
  })

  it('scores a ride below a run for a running session', () => {
    const ride = anActivity({ id: 'a1', start_date_local: '2026-08-29T10:05:00', type: 'Ride' })
    const run = anActivity({ id: 'a2', start_date_local: '2026-08-29T10:05:00' })

    const [best] = rank([ride, run]).candidates

    expect(best?.activity.id).toBe('a2')
  })

  it('puts the activity this very session is already linked to at the top', () => {
    const previouslySynced = anActivity({ id: 'a1', start_date_local: '2026-08-29T18:00:00' })
    const tempting = anActivity({ id: 'a2', start_date_local: '2026-08-29T10:05:00', name: 'Sprint session' })

    const plan = rank([previouslySynced, tempting], { linkedToThisSession: 'a1' })

    expect(plan.candidates[0]?.activity.id).toBe('a1')
    expect(plan.recommendation).toEqual({ mode: 'attach', activityId: 'a1' })
  })

  it('does not credit an activity that belongs to a different Freelap session', () => {
    const taken = anActivity({ id: 'a1', start_date_local: '2026-08-29T10:05:00' })

    const [candidate] = rank([taken], { linkedElsewhere: new Set(['a1']) }).candidates

    expect(candidate?.reasons).not.toContain('not linked to another Freelap session')
  })

  it('recommends creating a new activity when nothing plausible exists', () => {
    expect(rank([]).recommendation).toEqual({ mode: 'create-new' })
    expect(rank([]).needsConfirmation).toBe(false)
  })

  it('asks for confirmation when two candidates score alike', () => {
    const first = anActivity({ id: 'a1', start_date_local: '2026-08-29T10:05:00' })
    const second = anActivity({ id: 'a2', start_date_local: '2026-08-29T10:06:00' })

    const plan = rank([first, second])

    expect(plan.needsConfirmation).toBe(true)
    expect(plan.recommendation).toEqual({ mode: 'attach', activityId: 'a2' }) // the closer start wins the tie-break
  })

  it('asks for confirmation when the only candidate is a weak match', () => {
    const weak = anActivity({ id: 'a1', start_date_local: '2026-08-30T19:00:00', type: 'Swim' })

    const plan = rank([weak])

    expect(plan.candidates).toHaveLength(1)
    expect(plan.needsConfirmation).toBe(true)
    expect(plan.recommendation).toEqual({ mode: 'create-new' })
  })
})
