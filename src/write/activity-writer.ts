import { applyFreelapBlock, renderFreelapBlock } from '~/domain/description-block'
import { externalIdFor, freelapSessionIdIn } from '~/domain/freelap-link'
import { isFreelapInterval } from '~/domain/interval-naming'
import type { SprintSession } from '~/domain/sprint-session'
import type { SyncChoice } from '~/domain/sync-choice'
import { epochMsOfLocal } from '~/domain/zoned-time'
import type { IcuActivity, IcuInterval, IntervalsIcuClient } from '~/icu/intervals-icu-client'

import { FREELAP_CUSTOM_FIELDS, customFieldValuesFor } from './custom-fields'
import { encodeFitActivity } from './fit'
import { planIntervals, toIcuIntervals } from './interval-plan'
import { buildTimeline } from './session-timeline'

export type WriteStep = 'activity' | 'intervals' | 'custom-fields' | 'description'

export interface WriteRequest {
  readonly session: SprintSession
  readonly choice: SyncChoice
  readonly athleteId: string
  readonly timezone: string
  /** Nudge, in seconds, applied when attaching to a watch recording whose clock drifted. */
  readonly offsetS?: number
}

export interface WriteOutcome {
  readonly activityId: string
  readonly mode: SyncChoice['mode']
  readonly completedSteps: readonly WriteStep[]
}

/**
 * Mode A was attempted against an activity with no recorded streams — the reps cannot be aligned
 * to the recording because there is no recording. The athlete should create a new activity instead.
 */
export class NoStreamsError extends Error {
  constructor(readonly activityId: string) {
    super(
      `Activity ${activityId} has no recorded data to align the reps against. `
        + 'Create a new activity from the Freelap timings instead.',
    )
    this.name = 'NoStreamsError'
  }
}

export type RollbackOutcome = 'ok' | 'failed' | 'skipped'

export class WriteStepError extends Error {
  constructor(
    readonly step: WriteStep,
    readonly completedSteps: readonly WriteStep[],
    cause: unknown,
    readonly rollback: RollbackOutcome = 'skipped',
  ) {
    super(`Sync failed at the ${step} step: ${(cause as Error).message}`, { cause })
    this.name = 'WriteStepError'
  }
}

/**
 * Writes a session into intervals.icu, either by creating an activity from a synthetic FIT file
 * or by layering Freelap precision onto a watch recording that already exists.
 *
 * Steps run in a fixed order — activity, intervals, custom fields, description — so a failure
 * half way through can be reported against the step it stopped at, and resumed. When a step
 * fails, the writer compensates the completed steps in reverse order before rethrowing.
 */
export class ActivityWriter {
  constructor(private readonly icu: IntervalsIcuClient) {}

  async write(request: WriteRequest): Promise<WriteOutcome> {
    const completed: WriteStep[] = []
    const step = async <T>(name: WriteStep, run: () => Promise<T>): Promise<T> => {
      try {
        const result = await run()
        completed.push(name)
        return result
      } catch (cause) {
        throw new WriteStepError(name, completed, cause)
      }
    }

    const activity = await step('activity', () => this.openActivity(request))
    const streams = await this.icu.getStreams(activity.id)

    if (request.choice.mode === 'attach' && streams.time.length === 0) {
      throw new WriteStepError('intervals', ['activity'], new NoStreamsError(activity.id))
    }

    const snapshot = request.choice.mode === 'attach'
      ? await this.captureSnapshot(activity.id)
      : null

    try {
      await step('intervals', () => this.writeIntervals(request, activity, [...streams.time]))
      await step('custom-fields', () => this.writeCustomFields(request, activity.id))
      await step('description', () => this.writeDescription(request, activity))
    } catch (error) {
      if (!(error instanceof WriteStepError)) throw error

      const rollback = await this.compensate(activity.id, request.choice.mode, snapshot, completed)
      throw new WriteStepError(error.step, error.completedSteps, error.cause, rollback)
    }

    return { activityId: activity.id, mode: request.choice.mode, completedSteps: completed }
  }

  private async captureSnapshot(activityId: string): Promise<ActivitySnapshot> {
    const [activity, intervals] = await Promise.all([
      this.icu.getActivity(activityId),
      this.icu.getIntervals(activityId),
    ])

    return {
      intervals,
      description: activity.description ?? null,
      externalId: activity.external_id ?? null,
      customFields: activity.custom_fields ?? {},
    }
  }

  private async compensate(
    activityId: string,
    mode: 'create-new' | 'attach',
    snapshot: ActivitySnapshot | null,
    completed: readonly WriteStep[],
  ): Promise<RollbackOutcome> {
    try {
      if (mode === 'create-new') {
        await this.icu.deleteActivity(activityId)
        return 'ok'
      }

      if (!snapshot) return 'skipped'

      for (const completedStep of [...completed].reverse()) {
        switch (completedStep) {
          case 'activity':
            break
          case 'intervals':
            await this.icu.putIntervals(activityId, snapshot.intervals)
            break
          case 'custom-fields':
            await this.icu.setCustomFields(activityId, snapshot.customFields)
            break
          case 'description':
            await this.icu.updateActivity(activityId, {
              description: snapshot.description,
              ...(snapshot.externalId === null ? {} : { external_id: snapshot.externalId }),
            })
            break
        }
      }

      return 'ok'
    } catch {
      return 'failed'
    }
  }

  private async openActivity(request: WriteRequest): Promise<IcuActivity> {
    if (request.choice.mode !== 'attach') return this.uploadSyntheticActivity(request)

    const activity = await this.icu.getActivity(request.choice.activityId)
    refuseIfOwnedByAnotherSession(activity, request.session)

    return activity
  }

  private async uploadSyntheticActivity(request: WriteRequest): Promise<IcuActivity> {
    const { session } = request
    const timeline = buildTimeline(session)

    return this.icu.uploadActivity(request.athleteId, {
      filename: `${session.sourceId}.fit`,
      bytes: encodeFitActivity({
        startEpochMs: timeline.startEpochMs,
        sport: session.sport === 'cycling' ? 'cycling' : 'running',
        durationS: timeline.durationS,
        totalDistanceM: timeline.totalDistanceM,
        records: timeline.records,
        laps: timeline.laps,
      }),
      name: activityNameFor(session),
      description: renderFreelapBlock(session),
      externalId: externalIdFor(session),
    })
  }

  private async writeIntervals(request: WriteRequest, activity: IcuActivity, streamTimes: number[]): Promise<void> {
    const timeline = buildTimeline(request.session)
    const planned = planIntervals(request.session, timeline, {
      originEpochMs: epochMsOfLocal(activity.start_date_local, request.timezone),
      ...(request.offsetS === undefined ? {} : { offsetS: request.offsetS }),
    })

    const ours = toIcuIntervals(planned, streamTimes)
    const theirs = (await this.icu.getIntervals(activity.id)).filter((interval) => !isFreelapInterval(interval.name))

    await this.icu.putIntervals(activity.id, [...theirs, ...ours].sort(byStartIndex))
  }

  private async writeCustomFields(request: WriteRequest, activityId: string): Promise<void> {
    await this.icu.ensureCustomFields(request.athleteId, FREELAP_CUSTOM_FIELDS)
    await this.icu.setCustomFields(activityId, customFieldValuesFor(request.session))
  }

  private async writeDescription(request: WriteRequest, activity: IcuActivity): Promise<void> {
    const description = applyFreelapBlock(activity.description, renderFreelapBlock(request.session))
    const claimsExternalId = !activity.external_id

    await this.icu.updateActivity(activity.id, {
      description,
      ...(claimsExternalId ? { external_id: externalIdFor(request.session) } : {}),
    })
  }
}

export function activityNameFor(session: SprintSession): string {
  return `${session.exerciseName} (Freelap)`
}

interface ActivitySnapshot {
  readonly intervals: readonly IcuInterval[]
  readonly description: string | null
  readonly externalId: string | null
  readonly customFields: Readonly<Record<string, number | string>>
}

function byStartIndex(left: IcuInterval, right: IcuInterval): number {
  return left.start_index - right.start_index
}

/**
 * A `freelap:` external id belonging to a different session means another sync owns this
 * activity's intervals. Overwriting them would silently destroy that sync, so we stop instead.
 */
function refuseIfOwnedByAnotherSession(activity: IcuActivity, session: SprintSession): void {
  const owner = freelapSessionIdIn(activity.external_id)
  if (owner === null || owner === session.sourceId) return

  throw new Error(`Activity ${activity.id} already carries Freelap session ${owner}`)
}
