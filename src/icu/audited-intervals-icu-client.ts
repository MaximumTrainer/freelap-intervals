import type { AuditLog } from '~/audit/audit-log'

import type {
  ActivityPatch,
  ActivityUpload,
  CustomFieldDefinition,
  CustomFieldValues,
  DateRange,
  IcuActivity,
  IcuAthlete,
  IcuInterval,
  IcuStreams,
  IntervalsIcuClient,
} from './intervals-icu-client'
import { IntervalsIcuError } from './intervals-icu-client'

/**
 * Wraps the intervals.icu client so that every write leaves a trace: who asked, what was written,
 * to which activity, and what the server said. Reads are not recorded — they change nothing, and
 * logging them would bury the writes that matter.
 */
export class AuditedIntervalsIcuClient implements IntervalsIcuClient {
  constructor(
    private readonly inner: IntervalsIcuClient,
    private readonly audit: AuditLog,
    private readonly userId: string | null,
  ) {}

  // --- reads pass straight through ---------------------------------------

  athlete(athleteId: string): Promise<IcuAthlete> {
    return this.inner.athlete(athleteId)
  }

  listActivities(athleteId: string, range: DateRange): Promise<IcuActivity[]> {
    return this.inner.listActivities(athleteId, range)
  }

  getActivity(activityId: string): Promise<IcuActivity> {
    return this.inner.getActivity(activityId)
  }

  getStreams(activityId: string): Promise<IcuStreams> {
    return this.inner.getStreams(activityId)
  }

  getIntervals(activityId: string): Promise<IcuInterval[]> {
    return this.inner.getIntervals(activityId)
  }

  // --- writes are recorded ------------------------------------------------

  updateActivity(activityId: string, patch: ActivityPatch): Promise<IcuActivity> {
    return this.recording('updateActivity', activityId, { fields: Object.keys(patch) }, () =>
      this.inner.updateActivity(activityId, patch),
    )
  }

  putIntervals(activityId: string, intervals: readonly IcuInterval[]): Promise<void> {
    return this.recording('putIntervals', activityId, { intervalCount: intervals.length }, () =>
      this.inner.putIntervals(activityId, intervals),
    )
  }

  uploadActivity(athleteId: string, upload: ActivityUpload): Promise<IcuActivity> {
    const detail = {
      filename: upload.filename,
      bytes: upload.bytes.byteLength,
      name: upload.name,
      externalId: upload.externalId ?? null,
    }

    return this.recording('uploadActivity', athleteId, detail, () => this.inner.uploadActivity(athleteId, upload))
  }

  ensureCustomFields(athleteId: string, definitions: readonly CustomFieldDefinition[]): Promise<void> {
    const detail = { codes: definitions.map((definition) => definition.code) }

    return this.recording('ensureCustomFields', athleteId, detail, () =>
      this.inner.ensureCustomFields(athleteId, definitions),
    )
  }

  setCustomFields(activityId: string, values: CustomFieldValues): Promise<void> {
    return this.recording('setCustomFields', activityId, { codes: Object.keys(values) }, () =>
      this.inner.setCustomFields(activityId, values),
    )
  }

  private async recording<T>(
    action: string,
    target: string,
    detail: Record<string, unknown>,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await write()
      await this.audit.record(this.userId, {
        action: `intervals.icu ${action}`,
        target,
        outcome: 'ok',
        statusCode: 200,
        detail,
      })

      return result
    } catch (error) {
      await this.audit.record(this.userId, {
        action: `intervals.icu ${action}`,
        target,
        outcome: 'error',
        statusCode: error instanceof IntervalsIcuError ? error.status : null,
        detail: { ...detail, error: (error as Error).message },
      })

      throw error
    }
  }
}
