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
} from '~/icu/intervals-icu-client'
import { IntervalsIcuError } from '~/icu/intervals-icu-client'
import { toLocalIso } from '~/domain/zoned-time'
import { decodeFitActivity } from '~/write/fit'

export interface FakeIntervalsIcuOptions {
  readonly athleteId?: string
  readonly timezone?: string
}

interface StoredActivity {
  activity: IcuActivity
  streams: IcuStreams
  intervals: IcuInterval[]
}

/**
 * An in-memory stand-in for intervals.icu. Uploads are decoded with the FIT reader rather than
 * trusted, so an acceptance test that passes here has proved the file we send is really readable.
 */
export class FakeIntervalsIcu implements IntervalsIcuClient {
  readonly athleteId: string
  readonly timezone: string

  private readonly stored = new Map<string, StoredActivity>()
  private readonly customFields = new Set<string>()
  private nextId = 1
  private writes = 0
  private readonly failures: IntervalsIcuError[] = []
  private readonly methodFailures = new Map<string, IntervalsIcuError[]>()

  constructor(options: FakeIntervalsIcuOptions = {}) {
    this.athleteId = options.athleteId ?? 'i1234'
    this.timezone = options.timezone ?? 'Europe/London'
  }

  // --- test-facing seams -------------------------------------------------

  givenActivity(activity: Partial<IcuActivity> & Pick<IcuActivity, 'start_date_local'>, streams?: IcuStreams): IcuActivity {
    const stored: IcuActivity = {
      id: activity.id ?? this.mintId(),
      type: 'Run',
      name: 'Afternoon Run',
      description: null,
      external_id: null,
      ...activity,
    }

    this.stored.set(stored.id, {
      activity: stored,
      streams: streams ?? { time: [] },
      intervals: [],
    })

    return stored
  }

  failNextCallWith(status: number, message = 'simulated failure'): void {
    this.failures.push(new IntervalsIcuError(message, status, status === 429 || status >= 500))
  }

  /** Queues a failure for the next call to a specific API method. */
  failMethodCallWith(method: string, status: number, message = 'simulated failure'): void {
    const queue = this.methodFailures.get(method) ?? []
    queue.push(new IntervalsIcuError(message, status, status >= 500))
    this.methodFailures.set(method, queue)
  }

  activity(activityId: string): IcuActivity {
    return this.require(activityId).activity
  }

  intervalsOf(activityId: string): IcuInterval[] {
    return this.require(activityId).intervals
  }

  definedCustomFields(): string[] {
    return [...this.customFields]
  }

  get activityCount(): number {
    return this.stored.size
  }

  get writeCallCount(): number {
    return this.writes
  }

  // --- client surface ----------------------------------------------------

  async athlete(athleteId: string): Promise<IcuAthlete> {
    this.maybeFail('athlete')
    return { id: athleteId, name: 'Test Athlete', timezone: this.timezone }
  }

  async listActivities(_athleteId: string, range: DateRange): Promise<IcuActivity[]> {
    this.maybeFail('listActivities')
    return [...this.stored.values()]
      .map(({ activity }) => activity)
      .filter(({ start_date_local }) => {
        const day = start_date_local.slice(0, 10)
        return day >= range.oldest && day <= range.newest
      })
      .sort((left, right) => left.start_date_local.localeCompare(right.start_date_local))
  }

  async getActivity(activityId: string): Promise<IcuActivity> {
    this.maybeFail('getActivity')
    return this.require(activityId).activity
  }

  async updateActivity(activityId: string, patch: ActivityPatch): Promise<IcuActivity> {
    this.maybeFail('updateActivity')
    this.writes++
    const stored = this.require(activityId)
    stored.activity = { ...stored.activity, ...patch }
    return stored.activity
  }

  async deleteActivity(activityId: string): Promise<void> {
    this.maybeFail('deleteActivity')
    this.writes++
    if (!this.stored.has(activityId)) {
      throw new IntervalsIcuError(`No activity ${activityId}`, 404, false)
    }
    this.stored.delete(activityId)
  }

  async getStreams(activityId: string): Promise<IcuStreams> {
    this.maybeFail('getStreams')
    return this.require(activityId).streams
  }

  async getIntervals(activityId: string): Promise<IcuInterval[]> {
    this.maybeFail('getIntervals')
    return [...this.require(activityId).intervals]
  }

  async putIntervals(activityId: string, intervals: readonly IcuInterval[]): Promise<void> {
    this.maybeFail('putIntervals')
    this.writes++
    this.require(activityId).intervals = [...intervals]
  }

  async uploadActivity(_athleteId: string, upload: ActivityUpload): Promise<IcuActivity> {
    this.maybeFail('uploadActivity')
    this.writes++

    const decoded = decodeFitActivity(upload.bytes)
    const id = this.mintId()
    const activity: IcuActivity = {
      id,
      start_date_local: toLocalIso(decoded.session.startEpochMs, this.timezone),
      type: decoded.session.sport === 'cycling' ? 'Ride' : 'Run',
      name: upload.name,
      description: upload.description ?? null,
      external_id: upload.externalId ?? null,
      moving_time: Math.round(decoded.session.totalElapsedS ?? 0),
      distance: decoded.session.totalDistanceM ?? 0,
    }

    this.stored.set(id, {
      activity,
      streams: streamsFrom(decoded.records, decoded.session.startEpochMs),
      intervals: [],
    })

    return activity
  }

  async ensureCustomFields(_athleteId: string, definitions: readonly CustomFieldDefinition[]): Promise<void> {
    this.maybeFail('ensureCustomFields')
    this.writes++
    for (const definition of definitions) this.customFields.add(definition.code)
  }

  async setCustomFields(activityId: string, values: CustomFieldValues): Promise<void> {
    this.maybeFail('setCustomFields')
    this.writes++
    const undefinedField = Object.keys(values).find((code) => !this.customFields.has(code))
    if (undefinedField) {
      throw new IntervalsIcuError(`Unknown custom field ${undefinedField}`, 400, false)
    }

    const stored = this.require(activityId)
    stored.activity = { ...stored.activity, custom_fields: { ...stored.activity.custom_fields, ...values } }
  }

  // --- internals ---------------------------------------------------------

  private require(activityId: string): StoredActivity {
    const stored = this.stored.get(activityId)
    if (!stored) throw new IntervalsIcuError(`No activity ${activityId}`, 404, false)
    return stored
  }

  private maybeFail(method?: string): void {
    if (method) {
      const queue = this.methodFailures.get(method)
      if (queue?.length) {
        const failure = queue.shift()!
        if (queue.length === 0) this.methodFailures.delete(method)
        throw failure
      }
    }

    const failure = this.failures.shift()
    if (failure) throw failure
  }

  private mintId(): string {
    const id = `a${this.nextId}`
    this.nextId += 1
    return id
  }
}

function streamsFrom(
  records: ReadonlyArray<{ timestampEpochMs: number; distanceM: number | null; speedMps: number | null }>,
  startEpochMs: number,
): IcuStreams {
  return {
    time: records.map((record) => Math.round((record.timestampEpochMs - startEpochMs) / 1000)),
    distance: records.map((record) => record.distanceM ?? 0),
    velocity_smooth: records.map((record) => record.speedMps ?? 0),
  }
}
