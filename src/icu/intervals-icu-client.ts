/** The slice of the intervals.icu REST API this integration depends on. */

export interface IcuAthlete {
  readonly id: string
  readonly name: string
  readonly timezone: string
}

export interface IcuActivity {
  readonly id: string
  /** Local start as intervals.icu stores it: "YYYY-MM-DDTHH:mm:ss", no zone suffix. */
  readonly start_date_local: string
  readonly type: string
  readonly name: string
  readonly description?: string | null
  readonly external_id?: string | null
  readonly moving_time?: number
  readonly distance?: number
  readonly custom_fields?: Readonly<Record<string, number | string>>
}

export type ActivityPatch = Partial<Pick<IcuActivity, 'name' | 'description' | 'external_id' | 'type'>>

export interface IcuInterval {
  readonly type: 'WORK' | 'RECOVERY'
  readonly start_index: number
  readonly end_index: number
  readonly name: string
}

export interface IcuStreams {
  readonly time: readonly number[]
  readonly distance?: readonly number[]
  readonly velocity_smooth?: readonly number[]
}

export interface DateRange {
  readonly oldest: string
  readonly newest: string
}

export interface ActivityUpload {
  readonly filename: string
  readonly bytes: Uint8Array
  readonly name: string
  readonly description?: string
  readonly externalId?: string
}

export interface CustomFieldDefinition {
  readonly code: string
  readonly name: string
  readonly type: 'NUMBER' | 'TEXT'
}

export type CustomFieldValues = Readonly<Record<string, number | string>>

export interface IntervalsIcuClient {
  athlete(athleteId: string): Promise<IcuAthlete>
  listActivities(athleteId: string, range: DateRange): Promise<IcuActivity[]>
  getActivity(activityId: string): Promise<IcuActivity>
  updateActivity(activityId: string, patch: ActivityPatch): Promise<IcuActivity>
  getStreams(activityId: string): Promise<IcuStreams>
  getIntervals(activityId: string): Promise<IcuInterval[]>
  putIntervals(activityId: string, intervals: readonly IcuInterval[]): Promise<void>
  uploadActivity(athleteId: string, upload: ActivityUpload): Promise<IcuActivity>
  ensureCustomFields(athleteId: string, definitions: readonly CustomFieldDefinition[]): Promise<void>
  setCustomFields(activityId: string, values: CustomFieldValues): Promise<void>
}

export class IntervalsIcuError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'IntervalsIcuError'
  }
}
