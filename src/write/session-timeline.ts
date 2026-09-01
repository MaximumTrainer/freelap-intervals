import type { Rep, SprintSession } from '~/domain/sprint-session'
import { roundTo, speedFrom } from '~/domain/units'

export interface TimelineRecord {
  readonly offsetS: number
  readonly distanceM: number
  readonly speedMps: number
}

export interface TimelineLap {
  readonly repIndex: number
  readonly startS: number
  readonly endS: number
  readonly distanceM: number
  readonly avgSpeedMps: number
  readonly maxSpeedMps: number
}

export interface SessionTimeline {
  readonly startEpochMs: number
  readonly durationS: number
  readonly totalDistanceM: number
  readonly records: readonly TimelineRecord[]
  readonly laps: readonly TimelineLap[]
}

export interface TimelineOptions {
  /** Rest assumed between reps when the export carried no time of day. */
  readonly restS?: number
}

interface Point {
  readonly atS: number
  readonly distanceM: number
}

const DEFAULT_REST_S = 120
const SAMPLE_INTERVAL_S = 1
const DISTANCE_PRECISION = 3
const SPEED_PRECISION = 3

/**
 * Lays the session out on a single timeline: one lap per rep, plus a 1 Hz record stream that
 * runs at the rep's own pace and rests at zero speed in between. Both the synthetic FIT file
 * and the interval indices are derived from this, so they cannot disagree.
 */
export function buildTimeline(session: SprintSession, options: TimelineOptions = {}): SessionTimeline {
  const laps = layOutLaps(session, options.restS ?? DEFAULT_REST_S)
  const profiles = session.reps.map(distanceProfile)
  const durationS = laps.at(-1)?.endS ?? 0
  const records = sampleRecords(laps, profiles, durationS)

  return {
    startEpochMs: startEpochMsOf(session),
    durationS,
    totalDistanceM: records.at(-1)?.distanceM ?? 0,
    records,
    laps,
  }
}

function startEpochMsOf(session: SprintSession): number {
  return Date.parse(session.reps[0]?.wallClock ?? session.startedAt)
}

function layOutLaps(session: SprintSession, restS: number): TimelineLap[] {
  const originMs = startEpochMsOf(session)
  const laps: TimelineLap[] = []

  for (const rep of session.reps) {
    const previousEnd = laps.at(-1)?.endS
    const startS =
      rep.wallClock === null
        ? previousEnd === undefined
          ? 0
          : roundTo(previousEnd + restS, DISTANCE_PRECISION)
        : roundTo((Date.parse(rep.wallClock) - originMs) / 1000, DISTANCE_PRECISION)

    laps.push({
      repIndex: rep.index,
      startS,
      endS: roundTo(startS + rep.totalS, DISTANCE_PRECISION),
      distanceM: rep.distanceM ?? 0,
      avgSpeedMps: rep.avgSpeedMps ?? roundTo(speedFrom(rep.distanceM ?? 0, rep.totalS), SPEED_PRECISION),
      maxSpeedMps: rep.maxSpeedMps ?? fastestSegmentSpeed(rep),
    })
  }

  return laps
}

/** Cumulative distance within a rep, taken from its splits and finishing at the full distance. */
function distanceProfile(rep: Rep): Point[] {
  const splits = [...rep.splits].sort((left, right) => left.elapsedS - right.elapsedS)
  const points: Point[] = [{ atS: 0, distanceM: 0 }]

  for (const split of splits) {
    if (split.elapsedS > (points.at(-1)?.atS ?? 0) && split.elapsedS <= rep.totalS) {
      points.push({ atS: split.elapsedS, distanceM: split.atM })
    }
  }

  const finish = rep.distanceM ?? points.at(-1)?.distanceM ?? 0
  if (rep.totalS > (points.at(-1)?.atS ?? 0)) points.push({ atS: rep.totalS, distanceM: finish })

  return points
}

function fastestSegmentSpeed(rep: Rep): number {
  const points = distanceProfile(rep)
  const speeds = points.slice(1).map((point, index) => {
    const previous = points[index]!
    return speedFrom(point.distanceM - previous.distanceM, point.atS - previous.atS)
  })

  return roundTo(Math.max(0, ...speeds), SPEED_PRECISION)
}

function sampleRecords(
  laps: readonly TimelineLap[],
  profiles: readonly Point[][],
  durationS: number,
): TimelineRecord[] {
  const lastSample = Math.ceil(durationS)
  const records: TimelineRecord[] = []

  for (let offsetS = 0; offsetS <= lastSample; offsetS += SAMPLE_INTERVAL_S) {
    records.push({
      offsetS,
      distanceM: roundTo(distanceAt(laps, profiles, offsetS), DISTANCE_PRECISION),
      speedMps: roundTo(speedAt(laps, profiles, offsetS), SPEED_PRECISION),
    })
  }

  return records
}

function distanceAt(laps: readonly TimelineLap[], profiles: readonly Point[][], offsetS: number): number {
  return laps.reduce((total, lap, index) => total + distanceIntoLap(lap, profiles[index] ?? [], offsetS), 0)
}

function distanceIntoLap(lap: TimelineLap, profile: readonly Point[], offsetS: number): number {
  if (offsetS <= lap.startS) return 0
  if (offsetS >= lap.endS) return profile.at(-1)?.distanceM ?? 0

  return interpolate(profile, offsetS - lap.startS)
}

function speedAt(laps: readonly TimelineLap[], profiles: readonly Point[][], offsetS: number): number {
  const running = laps.findIndex((lap) => offsetS > lap.startS && offsetS < lap.endS)
  if (running === -1) return 0

  const profile = profiles[running] ?? []
  const intoLap = offsetS - laps[running]!.startS
  const segmentEnd = profile.findIndex((point) => point.atS >= intoLap)
  const before = profile[segmentEnd - 1]
  const after = profile[segmentEnd]
  if (!before || !after) return 0

  return speedFrom(after.distanceM - before.distanceM, after.atS - before.atS)
}

function interpolate(profile: readonly Point[], intoLap: number): number {
  const segmentEnd = profile.findIndex((point) => point.atS >= intoLap)
  const before = profile[segmentEnd - 1]
  const after = profile[segmentEnd]
  if (!before || !after) return profile.at(-1)?.distanceM ?? 0

  const progress = (intoLap - before.atS) / (after.atS - before.atS)
  return before.distanceM + progress * (after.distanceM - before.distanceM)
}

/** Finds the index of the sample closest to `targetS`. Throws on an empty array — returning 0 for "nothing to search" is a silent data-corruption trap. */
export function nearestIndex(times: readonly number[], targetS: number): number {
  if (times.length === 0) throw new Error('nearestIndex called with an empty time array')

  let best = 0
  let bestGap = Number.POSITIVE_INFINITY

  times.forEach((time, index) => {
    const gap = Math.abs(time - targetS)
    if (gap < bestGap) {
      best = index
      bestGap = gap
    }
  })

  return best
}
