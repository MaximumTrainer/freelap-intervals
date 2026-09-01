import type { Rep, SprintSession } from '~/domain/sprint-session'
import { summariseReps } from '~/domain/sprint-session'
import { kmhToMps, roundTo, speedFrom } from '~/domain/units'
import { toZonedIso } from '~/domain/zoned-time'
import type { OutboundRateLimiter } from '~/outbound-rate-limiter'
import { NoopRateLimiter } from '~/outbound-rate-limiter'
import type { FreelapCredentials } from '~/security/connection-store'

import type { DateWindow, FreelapSource, HealthReport, SessionSummary } from '../freelap-source'
import { AdapterDegradedError } from '../freelap-source'
import type { MyFreelapRun, MyFreelapSessionDetail, MyFreelapSessionList } from './myfreelap-payloads'
import { readSessionDetail, readSessionList } from './myfreelap-payloads'

export interface MyFreelapWebSourceOptions {
  readonly credentials: FreelapCredentials
  readonly timezone: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  readonly limiter?: OutboundRateLimiter
  readonly limiterKeys?: readonly string[]
}

const SOURCE_NAME = 'MyFreelap web'
const DEFAULT_BASE_URL = 'https://api.myfreelap.com'
const SPEED_PRECISION = 3
const TIME_PRECISION = 3

/**
 * Reads sessions straight from the MyFreelap web account, using the athlete's own credentials.
 *
 * MyFreelap publishes no API: the endpoints and payloads below are an assumption, isolated here
 * and in {@link ./myfreelap-payloads.ts} so that a capture of the real traffic is a one-file
 * change. Every unexpected answer becomes an {@link AdapterDegradedError} rather than a guess.
 */
export class MyFreelapWebSource implements FreelapSource {
  readonly name = SOURCE_NAME

  private readonly http: typeof fetch
  private readonly baseUrl: string
  private readonly limiter: OutboundRateLimiter
  private readonly limiterKeys: readonly string[]
  private sessionToken: string | null = null

  constructor(private readonly options: MyFreelapWebSourceOptions) {
    this.http = options.fetch ?? globalThis.fetch
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.limiter = options.limiter ?? new NoopRateLimiter()
    this.limiterKeys = options.limiterKeys ?? []
  }

  async listSessions(window: DateWindow): Promise<SessionSummary[]> {
    const payload = await this.getJson<MyFreelapSessionList>(`/sessions?from=${window.from}&to=${window.to}`)

    return readSessionList(payload, SOURCE_NAME).map((session) => ({
      id: session.id,
      startedAt: this.inAthleteTimezone(session.date),
      exerciseName: session.name,
      athleteRef: session.athlete,
      repCount: session.runCount,
      bestS: session.bestS,
    }))
  }

  async getSession(id: string): Promise<SprintSession> {
    const detail = readSessionDetail(await this.getJson<MyFreelapSessionDetail>(`/sessions/${id}`), SOURCE_NAME)
    const reps = detail.runs.map((run, offset) => this.toRep(run, offset, detail.distanceM))

    return {
      sourceId: `myfreelap-${detail.id}`,
      athleteRef: detail.athlete,
      startedAt: reps[0]?.wallClock ?? this.inAthleteTimezone(detail.runs[0]?.timestamp ?? ''),
      sport: 'run',
      exerciseName: detail.name,
      distanceM: detail.distanceM,
      reps,
      summary: summariseReps(reps),
    }
  }

  async checkHealth(): Promise<HealthReport> {
    try {
      const today = new Date().toISOString().slice(0, 10)
      await this.listSessions({ from: today, to: today })

      return { healthy: true }
    } catch (error) {
      return { healthy: false, reason: (error as Error).message }
    }
  }

  private toRep(run: MyFreelapRun, offset: number, sessionDistanceM: number | null): Rep {
    const splits = run.splits.map((split) => ({
      atM: split.distanceM,
      elapsedS: roundTo(split.timeS, TIME_PRECISION),
    }))
    const distanceM = splits.at(-1)?.atM ?? sessionDistanceM

    return {
      index: offset + 1,
      wallClock: this.inAthleteTimezone(run.timestamp),
      totalS: roundTo(run.timeS, TIME_PRECISION),
      splits,
      distanceM,
      avgSpeedMps: run.avgSpeedKmh === null
        ? derivedSpeed(distanceM, run.timeS)
        : roundTo(kmhToMps(run.avgSpeedKmh), SPEED_PRECISION),
      maxSpeedMps: run.maxSpeedKmh === null ? null : roundTo(kmhToMps(run.maxSpeedKmh), SPEED_PRECISION),
    }
  }

  private inAthleteTimezone(localTimestamp: string): string {
    const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(localTimestamp)
    if (!parts) throw new AdapterDegradedError(SOURCE_NAME, `"${localTimestamp}" is not a timestamp we recognise`)

    return toZonedIso(
      {
        year: Number(parts[1]),
        month: Number(parts[2]),
        day: Number(parts[3]),
        hour: Number(parts[4]),
        minute: Number(parts[5]),
        second: Number(parts[6] ?? 0),
      },
      this.options.timezone,
    )
  }

  private async getJson<T>(path: string): Promise<T> {
    const firstTry = await this.send(path, await this.authorize())

    // A rejected token usually means the web session simply aged out; one fresh login is fair.
    const response = firstTry.status === 401 ? await this.send(path, await this.authorize({ force: true })) : firstTry

    if (response.status === 401) {
      throw new AdapterDegradedError(SOURCE_NAME, 'the stored credentials were refused at sign in')
    }
    if (!response.ok) {
      throw new AdapterDegradedError(SOURCE_NAME, `${path} answered ${response.status}`)
    }

    return this.readJson<T>(response, path)
  }

  private async send(path: string, token: string): Promise<Response> {
    try {
      for (const key of this.limiterKeys) {
        await this.limiter.acquire(key)
      }

      return await this.http(`${this.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    } catch (cause) {
      if (cause instanceof AdapterDegradedError) throw cause
      throw new AdapterDegradedError(SOURCE_NAME, `${path} could not be reached`, { cause })
    }
  }

  private async authorize(options: { force?: boolean } = {}): Promise<string> {
    if (this.sessionToken && !options.force) return this.sessionToken

    const response = await this.login()
    if (response.status === 401) {
      throw new AdapterDegradedError(SOURCE_NAME, 'the stored credentials were refused at sign in')
    }
    if (!response.ok) throw new AdapterDegradedError(SOURCE_NAME, `sign in answered ${response.status}`)

    const body = await this.readJson<{ token?: string }>(response, '/auth/login')
    if (!body.token) throw new AdapterDegradedError(SOURCE_NAME, 'sign in returned no session token')

    this.sessionToken = body.token
    return body.token
  }

  private async login(): Promise<Response> {
    try {
      for (const key of this.limiterKeys) {
        await this.limiter.acquire(key)
      }

      return await this.http(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          email: this.options.credentials.username,
          password: this.options.credentials.password.reveal(),
        }),
      })
    } catch (cause) {
      if (cause instanceof AdapterDegradedError) throw cause
      throw new AdapterDegradedError(SOURCE_NAME, 'sign in could not be reached', { cause })
    }
  }

  private async readJson<T>(response: Response, path: string): Promise<T> {
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      throw new AdapterDegradedError(SOURCE_NAME, `${path} answered with ${contentType || 'no content type'}, not data`)
    }

    try {
      return (await response.json()) as T
    } catch (cause) {
      throw new AdapterDegradedError(SOURCE_NAME, `${path} answered with unreadable data`, { cause })
    }
  }
}

function derivedSpeed(distanceM: number | null, totalS: number): number | null {
  return distanceM === null ? null : roundTo(speedFrom(distanceM, totalS), SPEED_PRECISION)
}
