import { createServer } from 'node:http'
import type { Server } from 'node:http'

import { Applications } from '~/app/applications'
import { PgUserRepository } from '~/app/user-repository'
import { Workspaces } from '~/app/workspaces'
import { PgAuditLog } from '~/audit/pg-audit-log'
import { OAuthClient } from '~/auth/oauth-client'
import { PgOAuthStateStore } from '~/auth/oauth-state-store'
import type { Database } from '~/db/database'
import type { JobHandler } from '~/jobs/worker'
import { Worker } from '~/jobs/worker'
import { PgJobQueue } from '~/jobs/pg-job-queue'
import { syncJobHandlers } from '~/jobs/sync-jobs'
import { PgAdapterHealthStore } from '~/jobs/adapter-health'
import { PgSyncDirectory } from '~/ledger/sync-directory'
import { PgColumnMappingStore } from '~/ingest/csv/column-mapping-store'
import { OAuthCredentialSource } from '~/auth/oauth-credential-source'
import { HttpIntervalsIcuClient } from '~/icu/http-intervals-icu-client'
import { ConnectionProbe } from '~/web/connection-probe'
import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
import { LoggingErrorReporter } from '~/logging/error-reporter'
import { NullLogger } from '~/logging/logger'
import { InMemoryMetricsRegistry } from '~/logging/metrics-registry'
import { DedupFilter } from '~/web/dedup-filter'
import { RateLimiter } from '~/web/rate-limiter'
import { SessionCookie } from '~/web/session-cookie'
import { PgSessionStore } from '~/web/session-store'
import { createWebApp } from '~/web/web-app'

import type { FakeIntervalsIcuServer } from './fake-intervals-icu-server'
import { aTestDatabase } from './test-database'

export interface TestWebAppOptions {
  readonly icu: FakeIntervalsIcuServer
  readonly myfreelapWebAdapter?: boolean
}

export interface RunningWebApp {
  readonly database: Database
  readonly queue: PgJobQueue
  readonly handlers: Record<string, JobHandler>
  signIn(email: string): Promise<void>
  signInAndConnect(email: string): Promise<void>
  get(path: string, init?: RequestInit): Promise<Response>
  text(path: string): Promise<string>
  post(path: string, fields: Record<string, string>): Promise<Response>
  postWithoutCsrf(path: string, fields: Record<string, string>): Promise<Response>
  postWithWrongCsrf(path: string, fields: Record<string, string>): Promise<Response>
  postJson(path: string, body: unknown): Promise<Response>
  webhook(body: unknown): Promise<Response>
  webhookWithoutSecret(body: unknown): Promise<Response>
  webhookWithWrongSecret(body: unknown): Promise<Response>
  upload(path: string, csv: string): Promise<Response>
  metrics(): Promise<Response>
  runWorker(): Promise<number>
  close(): Promise<void>
}

/** Starts the whole web app — real HTTP, real Postgres, real job queue — against the fake API. */
export async function startTestWebApp(options: TestWebAppOptions): Promise<RunningWebApp> {
  const database = await aTestDatabase()
  const connections = new ConnectionStore(database, new EnvelopeCipher(LocalKeyManagementService.forTesting()))
  const workspaces = new Workspaces(database)
  const audit = new PgAuditLog(database)
  const queue = new PgJobQueue(database)

  const oauth = new OAuthClient({
    clientId: 'freelap-sync-test',
    clientSecret: 'test-secret',
    redirectUri: 'http://localhost/oauth/callback',
    authorizeUrl: `${options.icu.baseUrl}/oauth/authorize`,
    tokenUrl: `${options.icu.baseUrl}/api/oauth/token`,
  })

  const applications = new Applications({
    workspaces,
    connections,
    oauth,
    audit,
    icuBaseUrl: options.icu.baseUrl,
    // One retry inside the client, so a test can see the queue do the retrying.
    icuRetry: { attempts: 2, baseDelayMs: 0, sleep: async () => {} },
    csv: { timezone: 'Europe/London' },
  })

  const testLogger = new NullLogger()
  const metrics = new InMemoryMetricsRegistry()
  const flags = { myfreelapWebAdapter: options.myfreelapWebAdapter ?? true }
  const adapterHealth = new PgAdapterHealthStore(database)

  const connectionProbe = new ConnectionProbe({
    connections,
    adapterHealth,
    audit,
    icuClientFor: (userId, _athleteId) => new HttpIntervalsIcuClient({
      credentials: new OAuthCredentialSource({ userId, connections, oauth }),
      baseUrl: options.icu.baseUrl,
      retry: { attempts: 2, baseDelayMs: 0, sleep: async () => {} },
    }),
    freelapSourceFor: async (userId) => {
      if (!flags.myfreelapWebAdapter) return null
      const connection = await connections.findFreelap(userId)
      if (!connection) return null
      return {
        name: 'fake-freelap',
        listSessions: async () => [],
        getSession: async () => { throw new Error('not stubbed') },
        checkHealth: async () => ({ healthy: true }),
      }
    },
  })

  const server = createServer(
    createWebApp({
      users: new PgUserRepository(database),
      workspaces,
      applications,
      connections,
      oauth,
      oauthStates: new PgOAuthStateStore(database),
      audit,
      queue,
      directory: new PgSyncDirectory(database),
      sessionCookie: new SessionCookie('test-cookie-secret', { secure: false }),
      sessions: new PgSessionStore(database),
      columnMappings: new PgColumnMappingStore(database),
      flags,
      webhookRateLimiter: new RateLimiter(),
      webhookDedup: new DedupFilter(),
      webhookSecret: 'test-webhook-secret',
      csrfSecret: 'test-csrf-secret',
      maxBodyBytes: 5_242_880,
      now: () => new Date(),
      logger: testLogger,
      metrics,
      errorReporter: new LoggingErrorReporter(testLogger),
      metricsSecret: 'test-metrics-secret',
      connectionProbe,
    }),
  )

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  return new TestWebApp(server, database, queue, syncJobHandlers(applications, metrics))
}

class TestWebApp implements RunningWebApp {
  private cookie = ''
  private csrfToken = ''

  constructor(
    private readonly server: Server,
    readonly database: Database,
    readonly queue: PgJobQueue,
    readonly handlers: Record<string, JobHandler>,
  ) {}

  private get baseUrl(): string {
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('The web app is not listening')

    return `http://127.0.0.1:${address.port}`
  }

  async get(path: string, init: RequestInit = {}): Promise<Response> {
    return this.send(path, { ...init, method: 'GET' })
  }

  async text(path: string): Promise<string> {
    return (await this.get(path)).text()
  }

  async post(path: string, fields: Record<string, string>): Promise<Response> {
    return this.send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: this.csrfToken, ...fields }).toString(),
      redirect: 'manual',
    })
  }

  async postWithoutCsrf(path: string, fields: Record<string, string>): Promise<Response> {
    return this.send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    })
  }

  async postWithWrongCsrf(path: string, fields: Record<string, string>): Promise<Response> {
    return this.send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'wrong-token-from-another-session', ...fields }).toString(),
      redirect: 'manual',
    })
  }

  async postJson(path: string, body: unknown): Promise<Response> {
    return this.send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    })
  }

  async webhook(body: unknown): Promise<Response> {
    return this.postJson('/webhooks/intervals-icu/test-webhook-secret', body)
  }

  async webhookWithoutSecret(body: unknown): Promise<Response> {
    return this.postJson('/webhooks/intervals-icu/', body)
  }

  async webhookWithWrongSecret(body: unknown): Promise<Response> {
    return this.postJson('/webhooks/intervals-icu/wrong-secret', body)
  }

  async metrics(): Promise<Response> {
    return this.get('/metrics?token=test-metrics-secret')
  }

  async upload(path: string, csv: string): Promise<Response> {
    const form = new FormData()
    form.set('_csrf', this.csrfToken)
    form.set('csv', new File([csv], 'export.csv', { type: 'text/csv' }))

    return this.send(path, { method: 'POST', body: form, redirect: 'manual' })
  }

  async signIn(email: string): Promise<void> {
    const signInPage = await this.get('/sign-in')
    const nonceCookie = signInPage.headers.get('set-cookie')
    if (nonceCookie) this.cookie = nonceCookie.split(';')[0]!

    const pageHtml = await signInPage.text()
    this.csrfToken = extractCsrfToken(pageHtml)

    const response = await this.post('/sign-in', { email })
    const cookie = response.headers.get('set-cookie')
    if (!cookie) throw new Error(`Signing in as ${email} returned no session cookie`)

    this.cookie = cookie.split(';')[0]!
    await this.refreshCsrfToken()
  }

  async signInAndConnect(email: string): Promise<void> {
    await this.signIn(email)

    const authorize = await this.get('/connect/intervals-icu', { redirect: 'manual' })
    const state = new URL(authorize.headers.get('location') ?? '').searchParams.get('state')
    await this.get(`/oauth/callback?code=auth-code&state=${state}`, { redirect: 'manual' })
  }

  private async refreshCsrfToken(): Promise<void> {
    const page = await this.text('/')
    this.csrfToken = extractCsrfToken(page)
  }

  async runWorker(): Promise<number> {
    return new Worker(this.queue, this.handlers, { baseRetryMs: 0 }).runUntilIdle()
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
    await this.database.close()
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(this.cookie ? { cookie: this.cookie } : {}) },
    })
  }
}

function extractCsrfToken(html: string): string {
  const match = /name="_csrf"\s+value="([^"]+)"/.exec(html)
  return match?.[1] ?? ''
}
