import process from 'node:process'

import { JsonLogger } from '~/logging/json-logger'

import { PgDatabase } from './database'
import { loadMigrations } from './migrations'
import { migrate } from './migrator'

/** `npm run migrate` — brings a database up to the schema this build expects. */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL must be set')

  const logger = new JsonLogger()
  const database = new PgDatabase(databaseUrl)

  try {
    const applied = await migrate(database, await loadMigrations())
    logger.info(applied.length === 0 ? 'Database is already up to date.' : `Applied: ${applied.join(', ')}`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${(error as Error).message}\n`)
  process.exitCode = 1
})
