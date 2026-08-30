import type { Sport, SprintSession } from '~/domain/sprint-session'
import type { SyncChoice } from '~/domain/sync-choice'
import { epochMsOfLocal, toLocalIso } from '~/domain/zoned-time'
import type { DateRange, IcuActivity } from '~/icu/intervals-icu-client'

export interface ActivityCandidate {
  readonly activity: IcuActivity
  readonly score: number
  readonly reasons: readonly string[]
}

export interface MatchRequest {
  readonly session: SprintSession
  readonly activities: readonly IcuActivity[]
  readonly timezone: string
  /** The activity a previous sync of this very session landed on, if any. */
  readonly linkedToThisSession?: string
  /** Activities already owned by a different Freelap session. */
  readonly linkedElsewhere?: ReadonlySet<string>
}

export interface MatchResult {
  readonly candidates: readonly ActivityCandidate[]
  readonly recommendation: SyncChoice
  readonly needsConfirmation: boolean
}

interface Rule {
  readonly reason: string
  readonly points: number
  readonly holds: (activity: IcuActivity, request: MatchRequest) => boolean
}

const DAY_MS = 86_400_000
const SEARCH_DAYS = 1
const START_TOLERANCE_MS = 15 * 60_000
const STRONG_ENOUGH = 5
const CLEAR_LEAD = 2
const SPEED_WORK = /sprint|track|speed|interval|freelap/i

const RULES: readonly Rule[] = [
  {
    reason: 'already linked to this session',
    points: 5,
    holds: (activity, { linkedToThisSession }) => activity.id === linkedToThisSession,
  },
  {
    reason: 'same day',
    points: 3,
    holds: (activity, request) => localDay(activity) === sessionDay(request),
  },
  {
    reason: 'same sport',
    points: 2,
    holds: (activity, { session }) => matchesSport(activity.type, session.sport),
  },
  {
    reason: 'overlaps the session',
    points: 2,
    holds: (activity, request) => overlapsSession(activity, request),
  },
  {
    reason: 'named like speed work',
    points: 1,
    holds: (activity) => SPEED_WORK.test(activity.name),
  },
  {
    reason: 'not linked to another Freelap session',
    points: 1,
    holds: (activity, { linkedElsewhere }) => !(linkedElsewhere?.has(activity.id) ?? false),
  },
]

/** The day range to ask intervals.icu for: the session's day, plus one either side. */
export function searchWindowFor(session: SprintSession, timezone: string): DateRange {
  const startedAtMs = Date.parse(session.startedAt)

  return {
    oldest: dayOf(startedAtMs - SEARCH_DAYS * DAY_MS, timezone),
    newest: dayOf(startedAtMs + SEARCH_DAYS * DAY_MS, timezone),
  }
}

/**
 * Scores the activities that could be the watch recording of this session. Nothing is written
 * on a score alone: a weak or tied field asks the athlete to confirm.
 */
export function rankCandidates(request: MatchRequest): MatchResult {
  const window = searchWindowFor(request.session, request.timezone)
  const candidates = request.activities
    .filter((activity) => withinWindow(activity, window))
    .map((activity) => scoreActivity(activity, request))
    .sort(byScoreThenCloseness(request))

  return {
    candidates,
    recommendation: recommend(candidates),
    needsConfirmation: needsConfirmation(candidates),
  }
}

function scoreActivity(activity: IcuActivity, request: MatchRequest): ActivityCandidate {
  const met = RULES.filter((rule) => rule.holds(activity, request))

  return {
    activity,
    score: met.reduce((total, rule) => total + rule.points, 0),
    reasons: met.map((rule) => rule.reason),
  }
}

function recommend(candidates: readonly ActivityCandidate[]): SyncChoice {
  const best = candidates[0]
  return best && best.score >= STRONG_ENOUGH ? { mode: 'attach', activityId: best.activity.id } : { mode: 'create-new' }
}

function needsConfirmation(candidates: readonly ActivityCandidate[]): boolean {
  const [best, runnerUp] = candidates
  if (!best) return false
  if (best.score < STRONG_ENOUGH) return true

  return runnerUp !== undefined && best.score - runnerUp.score < CLEAR_LEAD
}

function byScoreThenCloseness(request: MatchRequest) {
  return (left: ActivityCandidate, right: ActivityCandidate): number =>
    right.score - left.score || gapToSession(left.activity, request) - gapToSession(right.activity, request)
}

function gapToSession(activity: IcuActivity, request: MatchRequest): number {
  return Math.abs(startMs(activity, request.timezone) - Date.parse(request.session.startedAt))
}

function withinWindow(activity: IcuActivity, window: DateRange): boolean {
  const day = activity.start_date_local.slice(0, 10)
  return day >= window.oldest && day <= window.newest
}

function overlapsSession(activity: IcuActivity, request: MatchRequest): boolean {
  const started = startMs(activity, request.timezone)
  const ended = started + (activity.moving_time ?? 0) * 1000
  const sessionStart = Date.parse(request.session.startedAt)

  return sessionStart >= started - START_TOLERANCE_MS && sessionStart <= ended + START_TOLERANCE_MS
}

function matchesSport(activityType: string, sport: Sport): boolean {
  const type = activityType.toLowerCase()
  if (sport === 'cycling') return type.includes('ride') || type.includes('bike')
  if (sport === 'run') return type.includes('run')

  return false
}

function startMs(activity: IcuActivity, timezone: string): number {
  return epochMsOfLocal(activity.start_date_local, timezone)
}

function localDay(activity: IcuActivity): string {
  return activity.start_date_local.slice(0, 10)
}

function sessionDay(request: MatchRequest): string {
  return dayOf(Date.parse(request.session.startedAt), request.timezone)
}

function dayOf(epochMs: number, timezone: string): string {
  return toLocalIso(epochMs, timezone).slice(0, 10)
}
