import { blockHash, extractFreelapBlock, renderFreelapBlock } from '~/domain/description-block'
import { externalIdFor, freelapSessionIdIn } from '~/domain/freelap-link'
import { isFreelapInterval } from '~/domain/interval-naming'
import type { SprintSession } from '~/domain/sprint-session'
import { epochMsOfLocal } from '~/domain/zoned-time'
import type { IcuActivity, IcuInterval, IcuStreams, IntervalsIcuClient } from '~/icu/intervals-icu-client'
import { customFieldValuesFor } from '~/write/custom-fields'
import { planIntervals } from '~/write/interval-plan'
import { buildTimeline } from '~/write/session-timeline'

export type VerificationStatus = 'pass' | 'partial' | 'fail'

export interface VerificationDiff {
  readonly check: string
  readonly expected: string
  readonly actual: string
  readonly critical: boolean
}

export interface VerificationReport {
  readonly status: VerificationStatus
  readonly diffs: readonly VerificationDiff[]
}

export interface VerificationRequest {
  readonly session: SprintSession
  readonly activityId: string
  readonly timezone: string
  readonly offsetS?: number
  /**
   * intervals.icu indexes streams at whole seconds, so an interval boundary can never land
   * closer than half a sample to the Freelap time. Exact times live in the custom fields
   * and the description table, both of which are checked to the millisecond.
   */
  readonly toleranceS?: number
}

const DEFAULT_TOLERANCE_S = 1

/** Reads back what we wrote and reports every way it differs from what we meant to write. */
export async function verifySync(
  icu: IntervalsIcuClient,
  request: VerificationRequest,
): Promise<VerificationReport> {
  const activity = await readActivity(icu, request.activityId)
  if (!activity) {
    return report([missing('activity exists', request.activityId)])
  }

  const [intervals, streams] = await Promise.all([
    icu.getIntervals(request.activityId),
    icu.getStreams(request.activityId),
  ])

  return report([
    ...checkLink(activity, request.session),
    ...checkIntervals(intervals, streams, activity, request),
    ...checkCustomFields(activity, request.session),
    ...checkDescription(activity, request.session),
  ])
}

async function readActivity(icu: IntervalsIcuClient, activityId: string): Promise<IcuActivity | null> {
  try {
    return await icu.getActivity(activityId)
  } catch {
    return null
  }
}

function checkLink(activity: IcuActivity, session: SprintSession): VerificationDiff[] {
  const owner = freelapSessionIdIn(activity.external_id)
  const claimedByAnother = owner !== null && owner !== session.sourceId

  return claimedByAnother ? [diff('activity linked', externalIdFor(session), activity.external_id ?? '', true)] : []
}

function checkIntervals(
  intervals: readonly IcuInterval[],
  streams: IcuStreams,
  activity: IcuActivity,
  request: VerificationRequest,
): VerificationDiff[] {
  const ours = intervals.filter((interval) => isFreelapInterval(interval.name))
  const { session } = request

  if (ours.length !== session.reps.length) {
    return [diff('interval count', String(session.reps.length), String(ours.length), true)]
  }

  const planned = planIntervals(session, buildTimeline(session), {
    originEpochMs: epochMsOfLocal(activity.start_date_local, request.timezone),
    ...(request.offsetS === undefined ? {} : { offsetS: request.offsetS }),
  })
  const tolerance = request.toleranceS ?? DEFAULT_TOLERANCE_S

  return ours.flatMap((interval, index) => {
    const intended = planned[index]
    const rep = session.reps[index]
    if (!intended || !rep) return []

    if (interval.name !== intended.name) {
      return [diff(`interval ${index + 1} name`, intended.name, interval.name, true)]
    }

    const actualS = sampleTimeAt(streams, interval.end_index) - sampleTimeAt(streams, interval.start_index)
    return Math.abs(actualS - rep.totalS) > tolerance
      ? [diff(`interval ${index + 1} duration`, `${rep.totalS}s ±${tolerance}s`, `${actualS}s`, false)]
      : []
  })
}

function sampleTimeAt(streams: IcuStreams, index: number): number {
  return streams.time[index] ?? Number.NaN
}

function checkCustomFields(activity: IcuActivity, session: SprintSession): VerificationDiff[] {
  const expected = customFieldValuesFor(session)
  const actual = activity.custom_fields ?? {}

  return Object.entries(expected).flatMap(([code, value]) =>
    actual[code] === value ? [] : [diff(`custom field ${code}`, String(value), String(actual[code] ?? 'absent'), false)],
  )
}

function checkDescription(activity: IcuActivity, session: SprintSession): VerificationDiff[] {
  const expected = blockHash(renderFreelapBlock(session))
  const actual = blockHash(extractFreelapBlock(activity.description))

  return expected === actual ? [] : [diff('description block', expected ?? 'absent', actual ?? 'absent', false)]
}

function diff(check: string, expected: string, actual: string, critical: boolean): VerificationDiff {
  return { check, expected, actual, critical }
}

function missing(check: string, activityId: string): VerificationDiff {
  return diff(check, activityId, 'not found', true)
}

function report(diffs: readonly VerificationDiff[]): VerificationReport {
  if (diffs.length === 0) return { status: 'pass', diffs }

  return { status: diffs.some((entry) => entry.critical) ? 'fail' : 'partial', diffs }
}
