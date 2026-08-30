import { describe, expect, it } from 'vitest'

import { summariseReps } from '~/domain/sprint-session'

import { aRep } from '../../support/builders'

describe('summariseReps', () => {
  it('reports the count, best, worst and mean rep time', () => {
    const reps = [3.42, 3.38, 3.51, 3.35, 3.44, 3.61].map((totalS, index) => aRep({ index: index + 1, totalS }))

    expect(summariseReps(reps)).toEqual({ count: 6, bestS: 3.35, worstS: 3.61, avgS: 3.452 })
  })

  it('rounds the mean to millisecond precision rather than leaking float noise', () => {
    const reps = [10.1, 10.2].map((totalS, index) => aRep({ index: index + 1, totalS }))

    expect(summariseReps(reps).avgS).toBe(10.15)
  })

  it('refuses to summarise a session with no reps', () => {
    expect(() => summariseReps([])).toThrow(/at least one rep/i)
  })
})
