import { PgSessionRepository } from '~/app/pg-session-repository'
import { InMemorySessionRepository } from '~/app/session-repository'
import { PgSyncLedger } from '~/ledger/pg-sync-ledger'
import { InMemorySyncLedger } from '~/ledger/sync-ledger'

import { aTestDatabase } from '../support/test-database'
import { describeStorageContract } from './repository-contract'

describeStorageContract('in memory', async () => ({
  sessions: new InMemorySessionRepository(),
  ledger: new InMemorySyncLedger(),
  close: async () => {},
}))

describeStorageContract('postgres', async () => {
  const database = await aTestDatabase()
  const userId = await database.givenUser('contract@example.com')

  return {
    sessions: new PgSessionRepository(database, userId),
    ledger: new PgSyncLedger(database, userId),
    close: () => database.close(),
  }
})
