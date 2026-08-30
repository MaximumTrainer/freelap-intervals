import { roundTo } from './units'

export type Sport = 'run' | 'cycling' | 'other'

export interface Split {
  readonly atM: number
  readonly elapsedS: number
}

export interface Rep {
  readonly index: number
  /** When Freelap saw the finish beacon; null when the export carries no time of day. */
  readonly wallClock: string | null
  readonly totalS: number
  readonly splits: readonly Split[]
  readonly distanceM: number | null
  readonly avgSpeedMps: number | null
  readonly maxSpeedMps: number | null
}

export interface SessionSummary {
  readonly count: number
  readonly bestS: number
  readonly worstS: number
  readonly avgS: number
}

export interface SprintSession {
  readonly sourceId: string
  readonly athleteRef: string
  /** Timezone-aware ISO 8601 instant of the first rep. */
  readonly startedAt: string
  readonly sport: Sport
  readonly exerciseName: string
  readonly distanceM: number | null
  readonly reps: readonly Rep[]
  readonly summary: SessionSummary
}

const TIME_PRECISION = 3

export function summariseReps(reps: readonly Rep[]): SessionSummary {
  if (reps.length === 0) throw new Error('A sprint session needs at least one rep to summarise')

  const times = reps.map((rep) => rep.totalS)
  const total = times.reduce((sum, time) => sum + time, 0)

  return {
    count: times.length,
    bestS: roundTo(Math.min(...times), TIME_PRECISION),
    worstS: roundTo(Math.max(...times), TIME_PRECISION),
    avgS: roundTo(total / times.length, TIME_PRECISION),
  }
}

export function sessionDistanceM(session: SprintSession): number | null {
  return session.distanceM ?? session.reps.find((rep) => rep.distanceM !== null)?.distanceM ?? null
}
