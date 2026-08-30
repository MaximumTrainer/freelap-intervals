import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import { FileSessionRepository } from '~/app/file-session-repository'
import { SyncApplication } from '~/app/sync-application'
import { HttpIntervalsIcuClient } from '~/icu/http-intervals-icu-client'
import type { Credentials } from '~/icu/http-intervals-icu-client'
import { FileSyncLedger } from '~/ledger/file-sync-ledger'

import { runCommand } from './commands'

const DEFAULT_STATE_DIR = '.freelap'

async function main(): Promise<number> {
  const stateDir = process.env.FREELAP_STATE_DIR ?? DEFAULT_STATE_DIR
  const athleteId = requireEnv('INTERVALS_ICU_ATHLETE_ID')

  const app = new SyncApplication({
    icu: new HttpIntervalsIcuClient({ credentials: credentialsFromEnv() }),
    ledger: new FileSyncLedger(join(stateDir, 'ledger.json')),
    sessions: new FileSessionRepository(join(stateDir, 'sessions.json')),
    athleteId,
    ...(process.env.FREELAP_TIMEZONE ? { timezone: process.env.FREELAP_TIMEZONE } : {}),
    ...(process.env.FREELAP_DATE_ORDER === 'month-first' ? { csv: { dateOrder: 'month-first' as const } } : {}),
  })

  return runCommand(process.argv.slice(2), {
    app,
    readFile: (path) => readFile(path, 'utf8'),
    out: (line) => console.log(line),
  })
}

function credentialsFromEnv(): Credentials {
  const accessToken = process.env.INTERVALS_ICU_ACCESS_TOKEN
  if (accessToken) return { kind: 'oauth', accessToken }

  return { kind: 'apiKey', key: requireEnv('INTERVALS_ICU_API_KEY') }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set`)

  return value
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(`Error: ${(error as Error).message}`)
    process.exitCode = 1
  })
