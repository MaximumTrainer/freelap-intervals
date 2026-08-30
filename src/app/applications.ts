import type { OAuthClient } from '~/auth/oauth-client'
import { ReconnectRequiredError } from '~/auth/oauth-client'
import { OAuthCredentialSource } from '~/auth/oauth-credential-source'
import type { AuditLog } from '~/audit/audit-log'
import { AuditedIntervalsIcuClient } from '~/icu/audited-intervals-icu-client'
import type { RetryPolicy } from '~/icu/http-intervals-icu-client'
import { HttpIntervalsIcuClient } from '~/icu/http-intervals-icu-client'
import type { CsvImportOptions } from '~/ingest/csv/csv-adapter'
import type { ConnectionStore } from '~/security/connection-store'

import { SyncApplication } from './sync-application'
import type { Workspaces } from './workspaces'

export interface ApplicationsOptions {
  readonly workspaces: Workspaces
  readonly connections: ConnectionStore
  readonly oauth: OAuthClient
  readonly audit: AuditLog
  readonly icuBaseUrl?: string
  readonly icuRetry?: RetryPolicy
  readonly fetch?: typeof fetch
  readonly csv?: CsvImportOptions
  readonly now?: () => Date
}

/**
 * Builds the application for one athlete: their own storage, their own intervals.icu credentials
 * (refreshed as needed), and an audit trail of everything written on their behalf.
 */
export class Applications {
  constructor(private readonly options: ApplicationsOptions) {}

  async forUser(userId: string): Promise<SyncApplication> {
    const connection = await this.options.connections.findIntervalsIcu(userId)
    if (!connection) throw new ReconnectRequiredError('this athlete has not connected intervals.icu')

    const workspace = this.options.workspaces.forUser(userId)
    const credentials = new OAuthCredentialSource({
      userId,
      connections: this.options.connections,
      oauth: this.options.oauth,
      ...(this.options.now ? { now: this.options.now } : {}),
    })

    const icu = new AuditedIntervalsIcuClient(
      new HttpIntervalsIcuClient({
        credentials,
        ...(this.options.icuBaseUrl === undefined ? {} : { baseUrl: this.options.icuBaseUrl }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        ...(this.options.icuRetry === undefined ? {} : { retry: this.options.icuRetry }),
      }),
      this.options.audit,
      userId,
    )

    return new SyncApplication({
      icu,
      ledger: workspace.ledger,
      sessions: workspace.sessions,
      athleteId: connection.athleteId,
      ...(this.options.csv ? { csv: this.options.csv } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    })
  }
}
