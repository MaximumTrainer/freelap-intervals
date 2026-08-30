import type { Rep, SprintSession } from '~/domain/sprint-session'
import { summariseReps } from '~/domain/sprint-session'

export function aRep(overrides: Partial<Rep> & Pick<Rep, 'index' | 'totalS'>): Rep {
  return {
    wallClock: null,
    splits: [],
    distanceM: 30,
    avgSpeedMps: null,
    maxSpeedMps: null,
    ...overrides,
  }
}

export function aSession(overrides: Partial<SprintSession> = {}): SprintSession {
  const reps = overrides.reps ?? [aRep({ index: 1, totalS: 3.42 }), aRep({ index: 2, totalS: 3.38 })]
  return {
    sourceId: 'fl-test-session',
    athleteRef: 'Dan Wood',
    startedAt: '2026-08-29T10:14:03+01:00',
    sport: 'run',
    exerciseName: 'Flying 30m',
    distanceM: 30,
    ...overrides,
    reps,
    summary: overrides.summary ?? summariseReps(reps),
  }
}
