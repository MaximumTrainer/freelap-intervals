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

export type Credentials =
  | { readonly kind: 'apiKey'; readonly key: string }
  | { readonly kind: 'oauth'; readonly accessToken: string }

/**
 * Supplies the credentials for each call. An OAuth implementation renews an expiring token before
 * it is used, and again when intervals.icu rejects one.
 */
export interface CredentialSource {
  current(): Promise<Credentials>
  /** Renews after a rejected call. Returns false when there is nothing left to try. */
  refresh(): Promise<boolean>
}

export interface RetryPolicy {
  readonly attempts?: number
  readonly baseDelayMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface HttpIntervalsIcuClientOptions {
  readonly credentials: Credentials | CredentialSource
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  readonly retry?: RetryPolicy
}

interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly json?: unknown
  readonly form?: FormData
}

const DEFAULT_BASE_URL = 'https://intervals.icu'
const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 500
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const STREAM_TYPES = ['time', 'distance', 'velocity_smooth'] as const

/**
 * The real intervals.icu REST client. Interval names travel as `label`, streams arrive as a list
 * of typed arrays, and custom field values are written onto the activity by their code — the
 * translation between those wire shapes and the domain lives here and nowhere else.
 */
export class HttpIntervalsIcuClient implements IntervalsIcuClient {
  private readonly baseUrl: string
  private readonly http: typeof fetch
  private readonly retry: Required<RetryPolicy>
  private readonly credentials: CredentialSource

  constructor(options: HttpIntervalsIcuClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.credentials = asCredentialSource(options.credentials)
    this.http = options.fetch ?? globalThis.fetch
    this.retry = {
      attempts: options.retry?.attempts ?? DEFAULT_ATTEMPTS,
      baseDelayMs: options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      sleep: options.retry?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    }
  }

  async athlete(athleteId: string): Promise<IcuAthlete> {
    const athlete = await this.send<{ id: string; name?: string; timezone?: string }>({
      method: 'GET',
      path: `/api/v1/athlete/${athleteId}`,
    })

    return { id: String(athlete.id), name: athlete.name ?? '', timezone: athlete.timezone ?? 'UTC' }
  }

  async listActivities(athleteId: string, range: DateRange): Promise<IcuActivity[]> {
    return this.send<IcuActivity[]>({
      method: 'GET',
      path: `/api/v1/athlete/${athleteId}/activities`,
      query: { oldest: range.oldest, newest: range.newest },
    })
  }

  async getActivity(activityId: string): Promise<IcuActivity> {
    return this.send<IcuActivity>({ method: 'GET', path: `/api/v1/activity/${activityId}` })
  }

  async updateActivity(activityId: string, patch: ActivityPatch): Promise<IcuActivity> {
    return this.send<IcuActivity>({ method: 'PUT', path: `/api/v1/activity/${activityId}`, json: patch })
  }

  async getStreams(activityId: string): Promise<IcuStreams> {
    const streams = await this.send<Array<{ type: string; data: number[] }>>({
      method: 'GET',
      path: `/api/v1/activity/${activityId}/streams`,
      query: { types: STREAM_TYPES.join(',') },
    })

    const named = new Map(streams.map((stream) => [stream.type, stream.data]))
    return {
      time: named.get('time') ?? [],
      ...(named.has('distance') ? { distance: named.get('distance')! } : {}),
      ...(named.has('velocity_smooth') ? { velocity_smooth: named.get('velocity_smooth')! } : {}),
    }
  }

  async getIntervals(activityId: string): Promise<IcuInterval[]> {
    const envelope = await this.send<{ icu_intervals?: WireInterval[] }>({
      method: 'GET',
      path: `/api/v1/activity/${activityId}/intervals`,
    })

    return (envelope.icu_intervals ?? []).map(fromWireInterval)
  }

  async putIntervals(activityId: string, intervals: readonly IcuInterval[]): Promise<void> {
    await this.send({
      method: 'PUT',
      path: `/api/v1/activity/${activityId}/intervals`,
      json: { icu_intervals: intervals.map(toWireInterval) },
    })
  }

  async uploadActivity(athleteId: string, upload: ActivityUpload): Promise<IcuActivity> {
    const form = new FormData()
    form.set('file', new File([upload.bytes], upload.filename, { type: 'application/octet-stream' }))
    form.set('name', upload.name)
    if (upload.description !== undefined) form.set('description', upload.description)
    if (upload.externalId !== undefined) form.set('external_id', upload.externalId)

    const created = await this.send<{ id?: string; activity?: { id: string } }>({
      method: 'POST',
      path: `/api/v1/athlete/${athleteId}/activities`,
      form,
    })

    const activityId = created.id ?? created.activity?.id
    if (!activityId) throw new IntervalsIcuError('The upload did not return an activity id', 502, false)

    return this.getActivity(String(activityId))
  }

  async ensureCustomFields(athleteId: string, definitions: readonly CustomFieldDefinition[]): Promise<void> {
    const existing = await this.send<Array<{ code?: string }>>({
      method: 'GET',
      path: `/api/v1/athlete/${athleteId}/custom-item`,
    })
    const known = new Set(existing.map((item) => item.code))

    for (const definition of definitions.filter((field) => !known.has(field.code))) {
      await this.send({
        method: 'POST',
        path: `/api/v1/athlete/${athleteId}/custom-item`,
        json: { ...definition, target: 'ACTIVITY' },
      })
    }
  }

  async setCustomFields(activityId: string, values: CustomFieldValues): Promise<void> {
    await this.send({ method: 'PUT', path: `/api/v1/activity/${activityId}`, json: values })
  }

  private async send<T>(spec: RequestSpec): Promise<T> {
    let lastError: IntervalsIcuError | null = null
    let renewedCredentials = false

    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      try {
        return await this.sendOnce<T>(spec)
      } catch (error) {
        lastError = asIntervalsIcuError(error)

        // A rejected token is worth exactly one more try, with a fresh one.
        if (lastError.status === 401 && !renewedCredentials && (await this.credentials.refresh())) {
          renewedCredentials = true
          continue
        }

        if (!lastError.retryable || attempt === this.retry.attempts) throw lastError

        await this.retry.sleep(backoffMs(this.retry.baseDelayMs, attempt))
      }
    }

    throw lastError ?? new IntervalsIcuError('Request failed', 500, false)
  }

  private async sendOnce<T>(spec: RequestSpec): Promise<T> {
    const response = await this.http(this.urlFor(spec), {
      method: spec.method,
      headers: await this.headersFor(spec),
      ...(spec.form ? { body: spec.form } : {}),
      ...(spec.json === undefined ? {} : { body: JSON.stringify(spec.json) }),
    })

    if (!response.ok) {
      throw new IntervalsIcuError(
        `intervals.icu ${spec.method} ${spec.path} failed with ${response.status}: ${await safeText(response)}`,
        response.status,
        RETRYABLE_STATUSES.has(response.status),
      )
    }

    return (await parseJson(response)) as T
  }

  private urlFor(spec: RequestSpec): string {
    const url = new URL(`${this.baseUrl}${spec.path}`)
    for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value)

    return url.toString()
  }

  private async headersFor(spec: RequestSpec): Promise<Record<string, string>> {
    return {
      authorization: authorizationFor(await this.credentials.current()),
      accept: 'application/json',
      ...(spec.json === undefined ? {} : { 'content-type': 'application/json' }),
    }
  }
}

interface WireInterval {
  readonly type?: string
  readonly start_index?: number
  readonly end_index?: number
  readonly label?: string
  readonly name?: string
}

function fromWireInterval(interval: WireInterval): IcuInterval {
  return {
    type: interval.type === 'RECOVERY' ? 'RECOVERY' : 'WORK',
    start_index: interval.start_index ?? 0,
    end_index: interval.end_index ?? 0,
    name: interval.label ?? interval.name ?? '',
  }
}

function toWireInterval(interval: IcuInterval): WireInterval {
  return {
    type: interval.type,
    start_index: interval.start_index,
    end_index: interval.end_index,
    label: interval.name,
  }
}

function asCredentialSource(credentials: Credentials | CredentialSource): CredentialSource {
  if ('current' in credentials) return credentials

  return { current: async () => credentials, refresh: async () => false }
}

function authorizationFor(credentials: Credentials): string {
  return credentials.kind === 'oauth'
    ? `Bearer ${credentials.accessToken}`
    : `Basic ${btoa(`API_KEY:${credentials.key}`)}`
}

function backoffMs(baseDelayMs: number, attempt: number): number {
  const window = baseDelayMs * 2 ** (attempt - 1)
  return window + Math.floor(Math.random() * baseDelayMs)
}

function asIntervalsIcuError(error: unknown): IntervalsIcuError {
  if (error instanceof IntervalsIcuError) return error

  // A transport failure (DNS, socket, timeout) is worth another attempt.
  return new IntervalsIcuError(`intervals.icu request failed: ${(error as Error).message}`, 0, true)
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await safeText(response)
  return text === '' ? {} : JSON.parse(text)
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
