import { describe, expect, it } from 'vitest'

import { readSessions } from '~/ingest/csv/csv-adapter'
import { AdapterDegradedError } from '~/ingest/freelap-source'
import { MyFreelapWebSource } from '~/ingest/myfreelap/myfreelap-web-source'
import type { AcquireOptions, OutboundRateLimiter, RateLimiterStats } from '~/outbound-rate-limiter'
import { Secret } from '~/security/secret'

import { FakeMyFreelapApi } from '../../support/fake-myfreelap-api'
import { csvFixture } from '../../support/fixtures'

const august = { from: '2026-08-01', to: '2026-08-31' }

const aWebSource = (api: FakeMyFreelapApi, credentials = { username: 'dan@example.com', password: new Secret('hunter2') }) =>
  new MyFreelapWebSource({
    credentials,
    timezone: 'Europe/London',
    baseUrl: 'https://api.myfreelap.test',
    fetch: api.fetch,
  })

describe('MyFreelapWebSource', () => {
  it('lists the sessions in a date range', async () => {
    const source = aWebSource(new FakeMyFreelapApi())

    expect(await source.listSessions(august)).toEqual([
      {
        id: '77123',
        startedAt: '2026-08-29T10:14:03+01:00',
        exerciseName: 'Flying 30m',
        athleteRef: 'Dan Wood',
        repCount: 6,
        bestS: 3.35,
      },
    ])
  })

  it('logs in once and reuses the session for later calls', async () => {
    const api = new FakeMyFreelapApi()
    const source = aWebSource(api)

    await source.listSessions(august)
    await source.getSession('77123')

    expect(api.loginCount).toBe(1)
    expect(api.requests).toEqual(['POST /auth/login', 'GET /sessions', 'GET /sessions/77123'])
  })

  it('logs in again when the session expires mid-flight', async () => {
    const api = new FakeMyFreelapApi({ expireTokenOnce: true })

    await expect(aWebSource(api).listSessions(august)).resolves.toHaveLength(1)
    expect(api.loginCount).toBe(2)
  })

  it('reads a session into the canonical model', async () => {
    const session = await aWebSource(new FakeMyFreelapApi()).getSession('77123')

    expect(session).toMatchObject({
      sourceId: 'myfreelap-77123',
      athleteRef: 'Dan Wood',
      exerciseName: 'Flying 30m',
      startedAt: '2026-08-29T10:14:03+01:00',
      distanceM: 30,
      summary: { count: 6, bestS: 3.35, worstS: 3.61, avgS: 3.452 },
    })
    expect(session.reps[3]).toEqual({
      index: 4,
      wallClock: '2026-08-29T10:21:44+01:00',
      totalS: 3.35,
      distanceM: 30,
      splits: [
        { atM: 10, elapsedS: 1.18 },
        { atM: 30, elapsedS: 3.35 },
      ],
      avgSpeedMps: 8.944,
      maxSpeedMps: 9.472,
    })
  })

  it('produces the same session as the CSV export of the same workout', async () => {
    const fromWeb = await aWebSource(new FakeMyFreelapApi()).getSession('77123')
    const [fromCsv] = readSessions(csvFixture('flying-30m-semicolon.csv'), { timezone: 'Europe/London' })

    expect(withoutSourceId(fromWeb)).toEqual(withoutSourceId(fromCsv!))
  })

  it('degrades rather than guessing when the credentials are refused', async () => {
    const source = aWebSource(new FakeMyFreelapApi(), { username: 'dan@example.com', password: new Secret('wrong') })

    const failure = await source.listSessions(august).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AdapterDegradedError)
    expect((failure as AdapterDegradedError).message).toMatch(/sign in|credential/i)
  })

  it('degrades when the site answers with a page instead of data', async () => {
    const source = aWebSource(new FakeMyFreelapApi({ serveHtml: true }))

    await expect(source.listSessions(august)).rejects.toBeInstanceOf(AdapterDegradedError)
  })

  it('degrades when a session arrives in a shape it does not understand', async () => {
    const api = new FakeMyFreelapApi()
    const source = aWebSource(api)

    await expect(source.getSession('does-not-exist')).rejects.toBeInstanceOf(AdapterDegradedError)
  })

  it('reports its health for the nightly canary', async () => {
    await expect(aWebSource(new FakeMyFreelapApi()).checkHealth()).resolves.toEqual({ healthy: true })

    const broken = aWebSource(new FakeMyFreelapApi({ serveHtml: true }))
    await expect(broken.checkHealth()).resolves.toMatchObject({ healthy: false })
  })
})

function withoutSourceId<T extends { sourceId: string }>(session: T): Omit<T, 'sourceId'> {
  const { sourceId, ...rest } = session
  return rest
}

class RecordingRateLimiter implements OutboundRateLimiter {
  readonly acquires: string[] = []
  readonly drained: Array<{ key: string; durationMs: number }> = []
  readonly stats: RateLimiterStats = { waits: 0, totalWaitMs: 0 }

  async acquire(key: string, _options?: AcquireOptions): Promise<void> {
    this.acquires.push(key)
  }

  drainUntil(key: string, durationMs: number): void {
    this.drained.push({ key, durationMs })
  }
}

describe('outbound rate limiting (S6)', () => {
  it('acquires rate-limit tokens before every outbound request', async () => {
    const limiter = new RecordingRateLimiter()
    const api = new FakeMyFreelapApi()
    const source = new MyFreelapWebSource({
      credentials: { username: 'dan@example.com', password: new Secret('hunter2') },
      timezone: 'Europe/London',
      baseUrl: 'https://api.myfreelap.test',
      fetch: api.fetch,
      limiter,
      limiterKeys: ['myfreelap', 'athlete:dan'],
    })

    await source.listSessions(august)

    expect(limiter.acquires.length).toBeGreaterThan(0)
    expect(limiter.acquires.every((k) => k === 'myfreelap' || k === 'athlete:dan')).toBe(true)
  })
})
