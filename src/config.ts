import { AlertGate } from '~/alerting/alert-gate'
import type { AlertSink } from '~/alerting/alert-sink'
import { LoggingAlertSink } from '~/alerting/logging-alert-sink'
import { WebhookAlertSink } from '~/alerting/webhook-alert-sink'
import { Applications } from '~/app/applications'
import { PgUserRepository } from '~/app/user-repository'
import { Workspaces } from '~/app/workspaces'
import { PgAuditLog } from '~/audit/pg-audit-log'
import { OAuthClient } from '~/auth/oauth-client'
import { OAuthCredentialSource } from '~/auth/oauth-credential-source'
import { PgOAuthStateStore } from '~/auth/oauth-state-store'
import type { Database } from '~/db/database'
import { PgDatabase } from '~/db/database'
import { HttpIntervalsIcuClient } from '~/icu/http-intervals-icu-client'
import type { FreelapSource } from '~/ingest/freelap-source'
import type { FeatureFlags } from '~/ingest/freelap-sources'
import { PgColumnMappingStore } from '~/ingest/csv/column-mapping-store'
import { FreelapSources, featureFlagsFromEnvironment } from '~/ingest/freelap-sources'
import { MyFreelapWebSource } from '~/ingest/myfreelap/myfreelap-web-source'
import type { AdapterHealthStore } from '~/jobs/adapter-health'
import { PgAdapterHealthStore } from '~/jobs/adapter-health'
import { FREELAP_CANARY } from '~/jobs/canary-job'
import { RETENTION } from '~/jobs/retention-job'
import { PgJobQueue } from '~/jobs/pg-job-queue'
import { Scheduler } from '~/jobs/scheduler'
import { PgSyncDirectory } from '~/ledger/sync-directory'
import { LoggingErrorReporter } from '~/logging/error-reporter'
import { JsonLogger } from '~/logging/json-logger'
import type { Logger } from '~/logging/logger'
import { InMemoryMetricsRegistry } from '~/logging/metrics-registry'
import type { MetricsRegistry } from '~/logging/metrics-registry'
import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { loadMigrations } from '~/db/migrations'
import { appliedVersions } from '~/db/migrator'
import { LocalKeyManagementService } from '~/security/local-kms'
import { Secret } from '~/security/secret'
import { InMemoryRateLimiter } from '~/outbound-rate-limiter'
import { ConnectionProbe } from '~/web/connection-probe'
import { DedupFilter } from '~/web/dedup-filter'
import { RateLimiter } from '~/web/rate-limiter'
import { SessionCookie } from '~/web/session-cookie'
import { PgSessionStore } from '~/web/session-store'
import type { WebAppDependencies } from '~/web/web-app'

export interface Config {
  readonly databaseUrl: string
  readonly cookieSecret: string
  readonly csrfSecret: string
  readonly webhookSecret: string
  readonly allowInsecureCookies: boolean
  readonly port: number
  readonly flags: FeatureFlags
  readonly oauth: {
    readonly clientId: string
    readonly clientSecret: string
    readonly redirectUri: string
  }
  readonly timezone: string
  readonly maxRequestBodyBytes: number
  readonly icuRateLimit: { readonly ratePerSecond: number; readonly burst: number }
  readonly myfreelapRateLimit: { readonly ratePerSecond: number; readonly burst: number }
  readonly metricsSecret: string
  readonly icuBaseUrl?: string
  readonly alertWebhookUrl?: string
  readonly canary?: {
    readonly username: string
    readonly password: string
  }
}

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    cookieSecret: required(env, 'SESSION_COOKIE_SECRET'),
    csrfSecret: required(env, 'CSRF_SECRET'),
    webhookSecret: required(env, 'WEBHOOK_SECRET'),
    allowInsecureCookies: env.ALLOW_INSECURE_COOKIES === 'true',
    port: Number(env.PORT ?? 3000),
    maxRequestBodyBytes: Number(env.MAX_REQUEST_BODY_BYTES ?? 5_242_880),
    flags: featureFlagsFromEnvironment(env),
    oauth: {
      clientId: required(env, 'INTERVALS_ICU_CLIENT_ID'),
      clientSecret: required(env, 'INTERVALS_ICU_CLIENT_SECRET'),
      redirectUri: required(env, 'INTERVALS_ICU_REDIRECT_URI'),
    },
    timezone: env.FREELAP_TIMEZONE ?? 'UTC',
    metricsSecret: required(env, 'METRICS_SECRET'),
    icuRateLimit: parseRateLimit(env.ICU_RATE_LIMIT, 5, 10),
    myfreelapRateLimit: parseRateLimit(env.MYFREELAP_RATE_LIMIT, 0.5, 3),
    ...(env.INTERVALS_ICU_BASE_URL ? { icuBaseUrl: env.INTERVALS_ICU_BASE_URL } : {}),
    ...(env.ALERT_WEBHOOK_URL ? { alertWebhookUrl: env.ALERT_WEBHOOK_URL } : {}),
    ...(env.FREELAP_CANARY_USERNAME && env.FREELAP_CANARY_PASSWORD
      ? { canary: { username: env.FREELAP_CANARY_USERNAME, password: env.FREELAP_CANARY_PASSWORD } }
      : {}),
  }
}

export interface Runtime {
  readonly config: Config
  readonly database: Database
  readonly queue: PgJobQueue
  readonly applications: Applications
  readonly sources: FreelapSources
  readonly connections: ConnectionStore
  readonly web: WebAppDependencies
  readonly logger: Logger
  readonly metrics: MetricsRegistry
  readonly alertGate: AlertGate
  readonly scheduler: Scheduler
  readonly adapterHealth: AdapterHealthStore
  readonly canarySource: FreelapSource
  close(): Promise<void>
}

/**
 * The composition root: one place where the configuration turns into the objects the web app and
 * the worker share. Everything either of them needs is assembled here and nowhere else.
 */
export function buildRuntime(config: Config, database: Database = new PgDatabase(config.databaseUrl)): Runtime {
  const logger = new JsonLogger()
  const metrics = new InMemoryMetricsRegistry()
  const errorReporter = new LoggingErrorReporter(logger)

  const cipher = new EnvelopeCipher(LocalKeyManagementService.fromEnvironment())
  const connections = new ConnectionStore(database, cipher)
  const workspaces = new Workspaces(database)
  const audit = new PgAuditLog(database)
  const queue = new PgJobQueue(database)
  const oauth = new OAuthClient(config.oauth)

  const alertSink: AlertSink = config.alertWebhookUrl
    ? new WebhookAlertSink(config.alertWebhookUrl)
    : new LoggingAlertSink(logger)
  const alertGate = new AlertGate(alertSink, { now: () => new Date() })

  const icuLimiter = new InMemoryRateLimiter(config.icuRateLimit)
  const myfreelapLimiter = new InMemoryRateLimiter(config.myfreelapRateLimit)

  const applications = new Applications({
    workspaces,
    connections,
    oauth,
    audit,
    icuLimiter,
    ...(config.icuBaseUrl === undefined ? {} : { icuBaseUrl: config.icuBaseUrl }),
    csv: { timezone: config.timezone },
  })

  const sources = new FreelapSources({
    connections, flags: config.flags, timezone: config.timezone, limiter: myfreelapLimiter,
  })

  const adapterHealth = new PgAdapterHealthStore(database)
  const scheduler = new Scheduler(database, queue, { now: () => new Date() })
  const canarySource = buildCanarySource(config, myfreelapLimiter)

  const web = buildWebDependencies(config, database, {
    workspaces, applications, connections, oauth, audit, queue, logger, metrics, errorReporter,
    adapterHealth, sources, icuLimiter,
  })

  return {
    config, database, queue, applications, connections,
    logger, metrics, alertGate, sources, web,
    scheduler, adapterHealth, canarySource,
    close: () => database.close(),
  }
}

function buildWebDependencies(
  config: Config,
  database: Database,
  shared: {
    workspaces: Workspaces; applications: Applications; connections: ConnectionStore
    oauth: OAuthClient; audit: PgAuditLog; queue: PgJobQueue
    logger: Logger; metrics: MetricsRegistry; errorReporter: LoggingErrorReporter
    adapterHealth: AdapterHealthStore; sources: FreelapSources
    icuLimiter: InMemoryRateLimiter
  },
): WebAppDependencies {
  const connectionProbe = new ConnectionProbe({
    connections: shared.connections,
    adapterHealth: shared.adapterHealth,
    audit: shared.audit,
    icuClientFor: (userId, athleteId) => new HttpIntervalsIcuClient({
      credentials: new OAuthCredentialSource({ userId, connections: shared.connections, oauth: shared.oauth }),
      ...(config.icuBaseUrl === undefined ? {} : { baseUrl: config.icuBaseUrl }),
      limiter: shared.icuLimiter,
      limiterKeys: ['intervals.icu', `athlete:${athleteId}`],
      retry: { attempts: 2, baseDelayMs: 0, sleep: noSleep },
    }),
    freelapSourceFor: (userId) => shared.sources.webSourceFor(userId),
  })

  return {
    users: new PgUserRepository(database),
    ...shared,
    oauthStates: new PgOAuthStateStore(database),
    directory: new PgSyncDirectory(database),
    sessionCookie: new SessionCookie(config.cookieSecret, { secure: !config.allowInsecureCookies }),
    sessions: new PgSessionStore(database),
    columnMappings: new PgColumnMappingStore(database),
    flags: config.flags,
    webhookRateLimiter: new RateLimiter(),
    webhookDedup: new DedupFilter(),
    webhookSecret: config.webhookSecret,
    csrfSecret: config.csrfSecret,
    maxBodyBytes: config.maxRequestBodyBytes,
    now: () => new Date(),
    metricsSecret: config.metricsSecret,
    connectionProbe,
    checkReadiness: buildReadinessCheck(database),
  }
}

function buildReadinessCheck(
  database: Database,
): () => Promise<{ ready: boolean; migrations: 'current' | 'behind' }> {
  return async () => {
    await database.query('select 1')
    const applied = new Set(await appliedVersions(database))
    const expected = await loadMigrations()
    const behind = expected.some((m) => !applied.has(m.version))
    return { ready: !behind, migrations: behind ? 'behind' : 'current' }
  }
}

async function noSleep(): Promise<void> {
  // Probes skip backoff delays — the result is needed now for page render.
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} must be set`)

  return value
}

/**
 * Builds the canary source from the dedicated test account, or a no-op when the adapter is off
 * or no test account is configured. The canary never touches a real athlete's credentials.
 */
function buildCanarySource(config: Config, limiter: InMemoryRateLimiter): FreelapSource {
  if (!config.flags.myfreelapWebAdapter || !config.canary) {
    return {
      name: 'MyFreelap web (canary disabled)',
      listSessions: async () => [],
      getSession: async () => { throw new Error('canary is disabled') },
      checkHealth: async () => ({ healthy: true }),
    }
  }

  return new MyFreelapWebSource({
    credentials: { username: config.canary.username, password: new Secret(config.canary.password) },
    timezone: config.timezone,
    limiter,
    limiterKeys: ['myfreelap', 'canary'],
  })
}

/** Registers the initial set of scheduled jobs. */
export async function registerSchedules(config: Config, scheduler: Scheduler): Promise<void> {
  if (config.flags.myfreelapWebAdapter && config.canary) {
    const jitterMs = Math.floor(Math.random() * 3_600_000)
    await scheduler.register({
      kind: FREELAP_CANARY,
      payload: {},
      intervalMs: 86_400_000,
      nextRunAt: new Date(Date.now() + jitterMs),
      queueKey: 'system',
    })
  }

  await scheduler.register({
    kind: RETENTION,
    payload: {},
    intervalMs: 86_400_000,
    nextRunAt: new Date(Date.now() + Math.floor(Math.random() * 3_600_000)),
    queueKey: 'system',
  })
}

function parseRateLimit(
  raw: string | undefined,
  defaultRate: number,
  defaultBurst: number,
): { readonly ratePerSecond: number; readonly burst: number } {
  if (!raw) return { ratePerSecond: defaultRate, burst: defaultBurst }

  const [rateStr, burstStr] = raw.split(',')
  const ratePerSecond = Number(rateStr)
  const burst = Number(burstStr)

  if (!Number.isFinite(ratePerSecond) || !Number.isFinite(burst) || ratePerSecond <= 0 || burst < 1) {
    throw new Error(`Invalid rate limit "${raw}" — expected "<req/s>,<burst>", e.g. "5,10"`)
  }

  return { ratePerSecond, burst }
}
