import type { Database } from '~/db/database'
import type { SyncLedger } from '~/ledger/sync-ledger'
import { PgSyncLedger } from '~/ledger/pg-sync-ledger'

import { PgSessionRepository } from './pg-session-repository'
import type { SessionRepository } from './session-repository'

export interface Workspace {
  readonly sessions: SessionRepository
  readonly ledger: SyncLedger
}

/** One athlete's own storage. Every query it hands out is already scoped to them. */
export class Workspaces {
  constructor(private readonly database: Database) {}

  forUser(userId: string): Workspace {
    return {
      sessions: new PgSessionRepository(this.database, userId),
      ledger: new PgSyncLedger(this.database, userId),
    }
  }
}
