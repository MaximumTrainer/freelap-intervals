import { createHash } from 'node:crypto'

import { renderFreelapBlock } from '~/domain/description-block'
import { intervalNameFor } from '~/domain/interval-naming'
import type { SprintSession } from '~/domain/sprint-session'
import type { SyncChoice } from '~/domain/sync-choice'
import { epochMsOfLocal } from '~/domain/zoned-time'
import type { IcuStreams, IntervalsIcuClient } from '~/icu/intervals-icu-client'
import type { MappingOverrides, UnmappedColumn } from '~/ingest/csv/column-mapping'
import type { CsvImportOptions } from '~/ingest/csv/csv-adapter'
import { inspectCsv, readSessions } from '~/ingest/csv/csv-adapter'
import type { LedgerEntry, SyncLedger } from '~/ledger/sync-ledger'
import type { ActivityCandidate } from '~/match/matcher'
import { rankCandidates, searchWindowFor } from '~/match/matcher'
import { suggestOffset } from '~/match/offset-suggestion'
import type { VerificationReport } from '~/verify/verifier'
import { verifySync } from '~/verify/verifier'
import { ActivityWriter, WriteStepError } from '~/write/activity-writer'
import { planIntervals } from '~/write/interval-plan'
import { buildTimeline } from '~/write/session-timeline'
import { customFieldValuesFor } from '~/write/custom-fields'

import type { SessionRepository } from './session-repository'
import { InMemorySessionRepository } from './session-repository'

export interface SyncApplicationOptions {
  readonly icu: IntervalsIcuClient
  readonly ledger: SyncLedger
  readonly athleteId: string
  /** Falls back to the timezone intervals.icu holds for the athlete. */
  readonly timezone?: string
  readonly sessions?: SessionRepository
  readonly csv?: CsvImportOptions
  readonly now?: () => Date
}

export interface SyncPlan {
  readonly session: SprintSession
  readonly candidates: readonly ActivityCandidate[]
  readonly recommendation: SyncChoice
  readonly needsConfirmation: boolean
  readonly previousSync: LedgerEntry | null
}

export interface SyncOutcome {
  readonly activityId: string
  readonly mode: SyncChoice['mode']
  readonly verification: VerificationReport
  readonly entry: LedgerEntry
  /** Set when the write was skipped because the content, activity and offset are unchanged. */
  readonly skipped?: true
}

export interface CsvImportResult {
  readonly sessions: SprintSession[]
  readonly fingerprint: string
  readonly unmapped: readonly UnmappedColumn[]
}

export interface SyncPreview {
  /** The watch recording to line the reps up against, thinned out for drawing. */
  readonly stream: { readonly time: number[]; readonly speed: number[] } | null
  /** Where each rep starts, in seconds from the start of that activity. */
  readonly repOffsetsS: number[]
  /** True when the recommended activity exists but has no recorded streams (Mode A cannot work). */
  readonly noStreams?: boolean
  /** Clock offset suggested by cross-correlating rep windows against the speed stream. */
  readonly suggestedOffsetS: number | null
}

export interface SyncOptions {
  /** Nudge, in seconds, for clock drift when attaching to a watch recording. */
  readonly offsetS?: number
  /** Bypass the content-hash short-circuit and force a full write. */
  readonly force?: boolean
}

/**
 * The use cases a UI or CLI drives: import a Freelap export, work out where it should land,
 * write it, and read it back to prove the write landed.
 */
export class SyncApplication {
  private readonly icu: IntervalsIcuClient
  private readonly ledger: SyncLedger
  private readonly sessions: SessionRepository
  private readonly writer: ActivityWriter
  private readonly now: () => Date
  private resolvedTimezone: string | null

  constructor(private readonly options: SyncApplicationOptions) {
    this.icu = options.icu
    this.ledger = options.ledger
    this.sessions = options.sessions ?? new InMemorySessionRepository()
    this.writer = new ActivityWriter(options.icu)
    this.now = options.now ?? (() => new Date())
    this.resolvedTimezone = options.timezone ?? null
  }

  /** Imports a MyFreelap CSV export. */
  async importCsv(text: string, overrides: MappingOverrides = {}): Promise<SprintSession[]> {
    return (await this.importCsvExport(text, overrides)).sessions
  }

  /**
   * Imports an export and reports the layout it came in: its fingerprint, so a mapping can be
   * remembered against it, and any column we could not place, so the athlete can explain it.
   */
  async importCsvExport(text: string, overrides: MappingOverrides = {}): Promise<CsvImportResult> {
    const inspection = inspectCsv(text, overrides)
    const sessions = readSessions(text, {
      timezone: await this.timezone(),
      ...this.options.csv,
      columnOverrides: overrides,
    })

    return {
      sessions: await this.importSessions(sessions),
      fingerprint: inspection.fingerprint,
      unmapped: inspection.unmapped,
    }
  }

  /**
   * Takes already-normalised sessions from any Freelap source. A future MyFreelap web adapter
   * joins here, without the rest of the application knowing where the sessions came from.
   */
  async importSessions(sessions: readonly SprintSession[]): Promise<SprintSession[]> {
    for (const session of sessions) await this.sessions.save(session)

    return [...sessions]
  }

  async importedSessions(): Promise<SprintSession[]> {
    return this.sessions.all()
  }

  async findSession(sourceId: string): Promise<SprintSession | null> {
    return this.sessions.find(sourceId)
  }

  async planSync(sourceId: string): Promise<SyncPlan> {
    const session = await this.requireSession(sourceId)
    const timezone = await this.timezone()
    const previousSync = await this.ledger.findBySourceId(sourceId)

    const activities = await this.icu.listActivities(this.options.athleteId, searchWindowFor(session, timezone))
    const match = rankCandidates({
      session,
      activities,
      timezone,
      linkedElsewhere: await this.ledger.activityIdsLinkedElsewhere(sourceId),
      ...(previousSync ? { linkedToThisSession: previousSync.activityId } : {}),
    })

    return { session, previousSync, ...match }
  }

  async sync(sourceId: string, choice: SyncChoice, options: SyncOptions = {}): Promise<SyncOutcome> {
    const session = await this.requireSession(sourceId)
    const timezone = await this.timezone()
    const hash = intendedContentHash(session)

    const skip = !options.force && await this.canSkipWrite(sourceId, choice, hash, options.offsetS)
    if (skip) {
      const verification = await verifySync(this.icu, {
        session,
        activityId: skip.activityId,
        timezone,
        ...(options.offsetS === undefined ? {} : { offsetS: options.offsetS }),
      })

      if (verification.status === 'fail') {
        return this.fullSync(sourceId, choice, options)
      }

      const entry: LedgerEntry = {
        ...skip,
        status: 'synced',
        syncedAt: this.now().toISOString(),
        verification,
      }
      await this.ledger.save(entry)

      return { activityId: skip.activityId, mode: skip.mode, verification, entry, skipped: true }
    }

    return this.fullSync(sourceId, choice, options)
  }

  private async fullSync(
    sourceId: string,
    choice: SyncChoice,
    options: SyncOptions,
  ): Promise<SyncOutcome> {
    const session = await this.requireSession(sourceId)
    const timezone = await this.timezone()
    const hash = intendedContentHash(session)
    const outcome = await this.writeOrRecordFailure(session, choice, timezone, options)
    const verification = await verifySync(this.icu, {
      session,
      activityId: outcome.activityId,
      timezone,
      ...(options.offsetS === undefined ? {} : { offsetS: options.offsetS }),
    })

    const entry: LedgerEntry = {
      sourceId,
      activityId: outcome.activityId,
      mode: outcome.mode,
      status: verification.status === 'fail' ? 'failed' : 'synced',
      contentHash: hash,
      syncedAt: this.now().toISOString(),
      ...(options.offsetS === undefined ? {} : { offsetS: options.offsetS }),
      verification,
    }
    await this.ledger.save(entry)

    return { activityId: outcome.activityId, mode: outcome.mode, verification, entry }
  }

  private async canSkipWrite(
    sourceId: string,
    choice: SyncChoice,
    hash: string,
    offsetS: number | undefined,
  ): Promise<LedgerEntry | null> {
    const previous = await this.ledger.findBySourceId(sourceId)
    if (!previous) return null
    if (previous.status !== 'synced') return null
    if (previous.verification?.status !== 'pass') return null
    if (previous.contentHash !== hash) return null
    if (choice.mode === 'create-new') return null
    if (previous.activityId !== choice.activityId) return null
    if ((previous.offsetS ?? 0) !== (offsetS ?? 0)) return null

    return previous
  }

  /**
   * The picture behind the review screen: the candidate activity's own speed trace, and where the
   * Freelap reps would fall on it, so a clock offset can be judged by eye before anything is written.
   */
  async previewFor(plan: SyncPlan): Promise<SyncPreview> {
    const timeline = buildTimeline(plan.session)

    if (plan.recommendation.mode !== 'attach') {
      return {
        stream: null,
        repOffsetsS: timeline.laps.map((lap) => lap.startS),
        suggestedOffsetS: null,
      }
    }

    const activityId = plan.recommendation.activityId
    const [activity, streams] = await Promise.all([this.icu.getActivity(activityId), this.icu.getStreams(activityId)])
    const planned = planIntervals(plan.session, timeline, {
      originEpochMs: epochMsOfLocal(activity.start_date_local, await this.timezone()),
    })

    const suggestion = suggestOffset({
      streamTimes: [...streams.time],
      speeds: [...(streams.velocity_smooth ?? [])],
      repWindows: planned.map((interval) => ({ startS: interval.startS, endS: interval.endS })),
      searchRangeS: 120,
    })

    return {
      stream: thinnedForDrawing(streams),
      repOffsetsS: planned.map((interval) => interval.startS),
      suggestedOffsetS: suggestion?.offsetS ?? null,
      ...(streams.time.length === 0 ? { noStreams: true } : {}),
    }
  }

  /** Re-runs the read-back checks against what intervals.icu holds right now. */
  async verify(sourceId: string): Promise<VerificationReport> {
    const session = await this.requireSession(sourceId)
    const entry = await this.ledger.findBySourceId(sourceId)
    if (!entry) throw new Error(`Session ${sourceId} has not been synced yet`)

    const verification = await verifySync(this.icu, {
      session,
      activityId: entry.activityId,
      timezone: await this.timezone(),
    })

    await this.ledger.save({
      ...entry,
      status: verification.status === 'pass' ? 'synced' : 'drifted',
      verification,
    })

    return verification
  }

  private async writeOrRecordFailure(
    session: SprintSession,
    choice: SyncChoice,
    timezone: string,
    options: SyncOptions,
  ): Promise<{ activityId: string; mode: SyncChoice['mode'] }> {
    try {
      return await this.writer.write({
        session,
        choice,
        athleteId: this.options.athleteId,
        timezone,
        ...(options.offsetS === undefined ? {} : { offsetS: options.offsetS }),
      })
    } catch (error) {
      await this.recordFailure(session, choice, error)
      throw error
    }
  }

  private async recordFailure(session: SprintSession, choice: SyncChoice, error: unknown): Promise<void> {
    const previous = await this.ledger.findBySourceId(session.sourceId)

    await this.ledger.save({
      sourceId: session.sourceId,
      activityId: choice.mode === 'attach' ? choice.activityId : (previous?.activityId ?? ''),
      mode: choice.mode,
      status: 'failed',
      contentHash: intendedContentHash(session),
      syncedAt: this.now().toISOString(),
      ...(error instanceof WriteStepError ? {
        failedStep: error.step,
        completedSteps: error.completedSteps,
        rollback: error.rollback,
      } : {}),
    })
  }

  private async requireSession(sourceId: string): Promise<SprintSession> {
    const session = await this.sessions.find(sourceId)
    if (!session) throw new Error(`No imported session with id ${sourceId}`)

    return session
  }

  private async timezone(): Promise<string> {
    this.resolvedTimezone ??= (await this.icu.athlete(this.options.athleteId)).timezone
    return this.resolvedTimezone
  }
}

/** Everything this integration intends to write, hashed — an unchanged hash means an unchanged sync. */
export function intendedContentHash(session: SprintSession): string {
  const intent = {
    block: renderFreelapBlock(session),
    intervals: session.reps.map((rep) => intervalNameFor(session, rep)),
    fields: customFieldValuesFor(session),
  }

  return createHash('sha256').update(JSON.stringify(intent)).digest('hex').slice(0, 16)
}

const PREVIEW_POINTS = 300

/** Streams can hold hours of samples; a review drawing needs a few hundred. */
function thinnedForDrawing(streams: IcuStreams): { time: number[]; speed: number[] } | null {
  const speeds = streams.velocity_smooth
  if (!speeds || streams.time.length === 0) return null

  const step = Math.max(1, Math.ceil(streams.time.length / PREVIEW_POINTS))
  const time: number[] = []
  const speed: number[] = []

  for (let index = 0; index < streams.time.length; index += step) {
    time.push(streams.time[index]!)
    speed.push(speeds[index] ?? 0)
  }

  return { time, speed }
}
