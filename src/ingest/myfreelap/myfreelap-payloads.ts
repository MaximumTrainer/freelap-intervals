import { AdapterDegradedError } from '../freelap-source'

/**
 * The assumed shape of the private MyFreelap web payloads, and the only place that assumption
 * lives. Every field is checked on the way in: a payload that has changed shape stops the adapter
 * with a precise reason rather than producing a session that is quietly wrong.
 */

export interface MyFreelapSessionList {
  readonly sessions?: unknown
}

export interface MyFreelapSessionDetail {
  readonly id?: unknown
  readonly name?: unknown
  readonly athlete?: unknown
  readonly distance_m?: unknown
  readonly runs?: unknown
}

export interface SessionListEntry {
  readonly id: string
  readonly date: string
  readonly name: string
  readonly athlete: string
  readonly runCount: number
  readonly bestS: number
}

export interface MyFreelapRun {
  readonly timestamp: string
  readonly timeS: number
  readonly avgSpeedKmh: number | null
  readonly maxSpeedKmh: number | null
  readonly splits: ReadonlyArray<{ distanceM: number; timeS: number }>
}

export interface SessionDetail {
  readonly id: string
  readonly name: string
  readonly athlete: string
  readonly distanceM: number | null
  readonly runs: readonly MyFreelapRun[]
}

export function readSessionList(payload: MyFreelapSessionList, source: string): SessionListEntry[] {
  const sessions = payload.sessions
  if (!Array.isArray(sessions)) throw degraded(source, 'the session list had no sessions array')

  return sessions.map((session: Record<string, unknown>, index) => {
    const where = `session ${index + 1} of the list`

    return {
      id: text(session.id, `${where} id`, source),
      date: text(session.date, `${where} date`, source),
      name: text(session.name ?? 'Freelap session', `${where} name`, source),
      athlete: text(session.athlete ?? 'unknown', `${where} athlete`, source),
      runCount: number(session.run_count ?? 0, `${where} run count`, source),
      bestS: number(session.best_time_s ?? 0, `${where} best time`, source),
    }
  })
}

export function readSessionDetail(payload: MyFreelapSessionDetail, source: string): SessionDetail {
  const runs = payload.runs
  if (!Array.isArray(runs) || runs.length === 0) throw degraded(source, 'the session detail carried no runs')

  return {
    id: text(payload.id, 'the session id', source),
    name: text(payload.name ?? 'Freelap session', 'the session name', source),
    athlete: text(payload.athlete ?? 'unknown', 'the athlete name', source),
    distanceM: optionalNumber(payload.distance_m, 'the session distance', source),
    runs: runs.map((run: Record<string, unknown>, index) => readRun(run, index, source)),
  }
}

function readRun(run: Record<string, unknown>, index: number, source: string): MyFreelapRun {
  const where = `run ${index + 1}`
  const splits = Array.isArray(run.splits) ? run.splits : []

  return {
    timestamp: text(run.timestamp, `${where} timestamp`, source),
    timeS: number(run.time_s, `${where} time`, source),
    avgSpeedKmh: optionalNumber(run.avg_speed_kmh, `${where} average speed`, source),
    maxSpeedKmh: optionalNumber(run.max_speed_kmh, `${where} max speed`, source),
    splits: splits.map((split: Record<string, unknown>, splitIndex) => ({
      distanceM: number(split.distance_m, `${where} split ${splitIndex + 1} distance`, source),
      timeS: number(split.time_s, `${where} split ${splitIndex + 1} time`, source),
    })),
  }
}

function text(value: unknown, what: string, source: string): string {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number') return String(value)

  throw degraded(source, `${what} was ${describe(value)} where text was expected`)
}

function number(value: unknown, what: string, source: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed

  throw degraded(source, `${what} was ${describe(value)} where a number was expected`)
}

function optionalNumber(value: unknown, what: string, source: string): number | null {
  return value === null || value === undefined ? null : number(value, what, source)
}

function describe(value: unknown): string {
  return value === undefined ? 'missing' : JSON.stringify(value)
}

function degraded(source: string, reason: string): AdapterDegradedError {
  return new AdapterDegradedError(source, reason)
}
