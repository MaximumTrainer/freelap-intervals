import { Applications } from '~/app/applications'
import { PgUserRepository } from '~/app/user-repository'
import { Workspaces } from '~/app/workspaces'
import { PgAuditLog } from '~/audit/pg-audit-log'
import { OAuthClient } from '~/auth/oauth-client'
import { PgOAuthStateStore } from '~/auth/oauth-state-store'
import type { Database } from '~/db/database'
import { PgDatabase } from '~/db/database'
import type { FeatureFlags } from '~/ingest/freelap-sources'
import { PgColumnMappingStore } from '~/ingest/csv/column-mapping-store'
import { FreelapSources, featureFlagsFromEnvironment } from '~/ingest/freelap-sources'
import { PgJobQueue } from '~/jobs/pg-job-queue'
import { PgSyncDirectory } from '~/ledger/sync-directory'
import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
import { SessionCookie } from '~/web/session-cookie'
import type { WebAppDependencies } from '~/web/web-app'

export interface Config {
  readonly databaseUrl: string
  readonly cookieSecret: string
  readonly port: number
  readonly flags: FeatureFlags
  readonly oauth: {
    readonly clientId: string
    readonly clientSecret: string
    readonly redirectUri: string
  }
  readonly timezone: string
  readonly icuBaseUrl?: string
}

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    cookieSecret: required(env, 'SESSION_COOKIE_SECRET'),
    port: Number(env.PORT ?? 3000),
    flags: featureFlagsFromEnvironment(env),
    oauth: {
      clientId: required(env, 'INTERVALS_ICU_CLIENT_ID'),
      clientSecret: required(env, 'INTERVALS_ICU_CLIENT_SECRET'),
      redirectUri: required(env, 'INTERVALS_ICU_REDIRECT_URI'),
    },
    timezone: env.FREELAP_TIMEZONE ?? 'UTC',
    ...(env.INTERVALS_ICU_BASE_URL ? { icuBaseUrl: env.INTERVALS_ICU_BASE_URL } : {}),
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
  close(): Promise<void>
}

/**
 * The composition root: one place where the configuration turns into the objects the web app and
 * the worker share. Everything either of them needs is assembled here and nowhere else.
 */
export function buildRuntime(config: Config, database: Database = new PgDatabase(config.databaseUrl)): Runtime {
  const cipher = new EnvelopeCipher(LocalKeyManagementService.fromEnvironment())
  const connections = new ConnectionStore(database, cipher)
  const workspaces = new Workspaces(database)
  const audit = new PgAuditLog(database)
  const queue = new PgJobQueue(database)
  const oauth = new OAuthClient(config.oauth)

  const applications = new Applications({
    workspaces,
    connections,
    oauth,
    audit,
    ...(config.icuBaseUrl === undefined ? {} : { icuBaseUrl: config.icuBaseUrl }),
    csv: { timezone: config.timezone },
  })

  return {
    config,
    database,
    queue,
    applications,
    connections,
    sources: new FreelapSources({ connections, flags: config.flags, timezone: config.timezone }),
    web: {
      users: new PgUserRepository(database),
      workspaces,
      applications,
      connections,
      oauth,
      oauthStates: new PgOAuthStateStore(database),
      audit,
      queue,
      directory: new PgSyncDirectory(database),
      sessionCookie: new SessionCookie(config.cookieSecret),
      columnMappings: new PgColumnMappingStore(database),
      flags: config.flags,
    },
    close: () => database.close(),
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} must be set`)

  return value
}
