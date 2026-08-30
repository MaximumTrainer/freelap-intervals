/**
 * A stand-in for the private MyFreelap web backend, shaped the way
 * [the adapter](../../src/ingest/myfreelap/myfreelap-web-source.ts) assumes it is shaped.
 * Both the shape and this fake are provisional until Phase 0 captures the real traffic.
 */
export interface FakeMyFreelapOptions {
  readonly email?: string
  readonly password?: string
  /** Serve HTML instead of JSON, the way a login wall or a layout change would. */
  readonly serveHtml?: boolean
  /** Reject the session token once, forcing the adapter to log in again. */
  readonly expireTokenOnce?: boolean
}

export const FLYING_30M_RUNS = [
  { index: 1, at: '2026-08-29T10:14:03', timeS: 3.42, splits: [10, 1.21, 30, 3.42], avgKmh: 31.6, maxKmh: 33.4 },
  { index: 2, at: '2026-08-29T10:16:31', timeS: 3.38, splits: [10, 1.19, 30, 3.38], avgKmh: 31.9, maxKmh: 33.8 },
  { index: 3, at: '2026-08-29T10:19:02', timeS: 3.51, splits: [10, 1.24, 30, 3.51], avgKmh: 30.8, maxKmh: 32.6 },
  { index: 4, at: '2026-08-29T10:21:44', timeS: 3.35, splits: [10, 1.18, 30, 3.35], avgKmh: 32.2, maxKmh: 34.1 },
  { index: 5, at: '2026-08-29T10:24:10', timeS: 3.44, splits: [10, 1.22, 30, 3.44], avgKmh: 31.4, maxKmh: 33.2 },
  { index: 6, at: '2026-08-29T10:26:58', timeS: 3.61, splits: [10, 1.27, 30, 3.61], avgKmh: 29.9, maxKmh: 31.7 },
] as const

export class FakeMyFreelapApi {
  readonly requests: string[] = []
  private tokensIssued = 0
  private rejectedOnce = false

  constructor(private readonly options: FakeMyFreelapOptions = {}) {}

  get fetch(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      this.requests.push(`${request.method} ${url.pathname}`)

      if (this.options.serveHtml) return html('<html><body>Maintenance</body></html>')
      if (url.pathname === '/auth/login') return this.login(await request.json())

      const unauthorized = this.checkToken(request)
      if (unauthorized) return unauthorized

      if (url.pathname === '/sessions') return json(this.sessionList(url))
      if (url.pathname.startsWith('/sessions/')) return this.sessionDetail(url.pathname.split('/')[2] ?? '')

      return json({ error: 'not found' }, 404)
    }) as typeof fetch
  }

  get loginCount(): number {
    return this.tokensIssued
  }

  private async login(body: unknown): Promise<Response> {
    const credentials = body as { email?: string; password?: string }
    const expected = { email: this.options.email ?? 'dan@example.com', password: this.options.password ?? 'hunter2' }

    if (credentials.email !== expected.email || credentials.password !== expected.password) {
      return json({ error: 'invalid_credentials' }, 401)
    }

    this.tokensIssued += 1
    return json({ token: `session-token-${this.tokensIssued}`, expires_in: 1800 })
  }

  private checkToken(request: Request): Response | null {
    const token = request.headers.get('authorization')
    if (!token?.startsWith('Bearer session-token-')) return json({ error: 'unauthenticated' }, 401)

    if (this.options.expireTokenOnce && !this.rejectedOnce) {
      this.rejectedOnce = true
      return json({ error: 'session_expired' }, 401)
    }

    return null
  }

  private sessionList(url: URL): unknown {
    const day = '2026-08-29'
    const from = url.searchParams.get('from') ?? day
    const to = url.searchParams.get('to') ?? day
    if (day < from || day > to) return { sessions: [] }

    return {
      sessions: [
        {
          id: '77123',
          date: `${day}T10:14:03`,
          name: 'Flying 30m',
          athlete: 'Dan Wood',
          distance_m: 30,
          run_count: FLYING_30M_RUNS.length,
          best_time_s: 3.35,
        },
      ],
    }
  }

  private sessionDetail(id: string): Response {
    if (id !== '77123') return json({ error: 'not found' }, 404)

    return json({
      id,
      name: 'Flying 30m',
      athlete: 'Dan Wood',
      distance_m: 30,
      runs: FLYING_30M_RUNS.map((run) => ({
        index: run.index,
        timestamp: run.at,
        time_s: run.timeS,
        avg_speed_kmh: run.avgKmh,
        max_speed_kmh: run.maxKmh,
        splits: [
          { distance_m: run.splits[0], time_s: run.splits[1] },
          { distance_m: run.splits[2], time_s: run.splits[3] },
        ],
      })),
    })
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
}
