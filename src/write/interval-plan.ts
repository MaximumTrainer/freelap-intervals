import { intervalNameFor } from '~/domain/interval-naming'
import type { SprintSession } from '~/domain/sprint-session'
import type { IcuInterval } from '~/icu/intervals-icu-client'

import type { SessionTimeline } from './session-timeline'
import { nearestIndex } from './session-timeline'

export interface PlannedInterval {
  readonly repIndex: number
  readonly name: string
  readonly startS: number
  readonly endS: number
}

export interface Alignment {
  /** Instant the intervals.icu activity starts, which interval offsets are measured from. */
  readonly originEpochMs: number
  /** Manual nudge, in seconds, for clock drift between the watch and the Freelap pods. */
  readonly offsetS?: number
}

/** Places each rep on the activity's clock, ready to be turned into stream indices. */
export function planIntervals(
  session: SprintSession,
  timeline: SessionTimeline,
  alignment: Alignment,
): PlannedInterval[] {
  const shiftS = (timeline.startEpochMs - alignment.originEpochMs) / 1000 + (alignment.offsetS ?? 0)
  const repsByIndex = new Map(session.reps.map((rep) => [rep.index, rep]))

  return timeline.laps.map((lap) => {
    const rep = repsByIndex.get(lap.repIndex)!

    return {
      repIndex: lap.repIndex,
      name: intervalNameFor(session, rep),
      startS: lap.startS + shiftS,
      endS: lap.endS + shiftS,
    }
  })
}

/** Snaps planned intervals onto the activity's own sample stream. */
export function toIcuIntervals(planned: readonly PlannedInterval[], streamTimes: readonly number[]): IcuInterval[] {
  return planned.map((interval) => ({
    type: 'WORK' as const,
    name: interval.name,
    start_index: nearestIndex(streamTimes, interval.startS),
    end_index: nearestIndex(streamTimes, interval.endS),
  }))
}
