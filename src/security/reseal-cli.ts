import process from 'node:process'

import { PgAuditLog } from '~/audit/pg-audit-log'
import { PgDatabase } from '~/db/database'
import { JsonLogger } from '~/logging/json-logger'

import { ConnectionStore } from './connection-store'
import { EnvelopeCipher } from './envelope-cipher'
import { LocalKeyManagementService } from './local-kms'
import { runReseal } from './reseal'

/** `npm run reseal` — re-seals stored credentials under the current master key. */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL must be set')

  const logger = new JsonLogger()
  const database = new PgDatabase(databaseUrl)
  const kms = LocalKeyManagementService.fromEnvironment()
  const cipher = new EnvelopeCipher(kms)
  const connections = new ConnectionStore(database, cipher)
  const audit = new PgAuditLog(database)

  const apply = process.argv.includes('--apply')

  try {
    logger.info('reseal target', { keyId: kms.currentKeyId, dryRun: !apply })
    const exitCode = await runReseal({
      connections,
      audit,
      out: (line) => logger.info(line),
      apply,
    })
    process.exitCode = exitCode
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Reseal failed: ${(error as Error).message}\n`)
  process.exitCode = 1
})
