/**
 * End-to-end integration test against real Freelap and intervals.icu accounts.
 *
 * Requires:
 *   INTERVALS_ICU_ATHLETE_ID  — your intervals.icu athlete id (e.g. i12345)
 *   INTERVALS_ICU_API_KEY     — a personal API key from intervals.icu
 *
 * Runs the full CLI flow: import a CSV fixture, push a new activity, verify it,
 * then delete the activity to leave the account clean.
 *
 * Usage:
 *   npx tsx scripts/integration-test.ts
 *   npx tsx scripts/integration-test.ts path/to/your-export.csv
 */
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { FileSessionRepository } from '~/app/file-session-repository'
import { SyncApplication } from '~/app/sync-application'
import { HttpIntervalsIcuClient } from '~/icu/http-intervals-icu-client'
import type { Credentials } from '~/icu/http-intervals-icu-client'
import { FileSyncLedger } from '~/ledger/file-sync-ledger'
import { FREELAP_CUSTOM_FIELDS } from '~/write/custom-fields'

const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

async function main(): Promise<number> {
  console.log('\n  Freelap → intervals.icu integration test\n')

  const athleteId = requireEnv('INTERVALS_ICU_ATHLETE_ID')
  const credentials = credentialsFromEnv()
  const csvPath = process.argv[2] ?? defaultFixture()
  const stateDir = await mkdtemp(join(tmpdir(), 'freelap-integ-'))

  const icu = new HttpIntervalsIcuClient({
    credentials,
    customFieldCodes: FREELAP_CUSTOM_FIELDS.map((field) => field.code),
  })
  const app = new SyncApplication({
    icu,
    ledger: new FileSyncLedger(join(stateDir, 'ledger.json')),
    sessions: new FileSessionRepository(join(stateDir, 'sessions.json')),
    athleteId,
  })

  let createdActivityId: string | null = null

  try {
    // 1. Verify connectivity
    step('Connecting to intervals.icu')
    const athlete = await icu.athlete(athleteId)
    pass(`Connected as ${athlete.name} (${athlete.id}, ${athlete.timezone})`)

    // 2. Import CSV
    step(`Importing ${csvPath}`)
    const csv = await readFile(csvPath, 'utf8')
    const sessions = await app.importCsv(csv)
    if (sessions.length === 0) throw new Error('No sessions found in CSV')
    pass(`Imported ${sessions.length} session(s)`)

    const session = sessions[0]!
    const sourceId = session.sourceId
    detail(`  source: ${sourceId}`)
    detail(`  exercise: ${session.exerciseName}, ${session.summary.count} reps, best ${session.summary.bestS}s`)

    // 3. Plan
    step(`Planning sync for ${sourceId}`)
    const plan = await app.planSync(sourceId)
    pass(`${plan.candidates.length} candidate(s), recommendation: ${plan.recommendation.mode}`)

    // 4. Push (always create new to avoid touching real activities)
    step('Pushing as new activity')
    const outcome = await app.sync(sourceId, { mode: 'create-new' })
    createdActivityId = outcome.activityId
    pass(`Created activity ${outcome.activityId}`)

    // 5. Verify
    step('Verifying sync')
    const verification = await app.verify(sourceId)
    if (verification.status === 'pass') {
      pass('All fields verified')
    } else {
      fail('Verification failed')
      for (const diff of verification.diffs) {
        detail(`  ${diff.check}: expected ${diff.expected}, found ${diff.actual}`)
      }
      return 1
    }

    // 6. Re-sync (idempotency check)
    step('Re-syncing (idempotency check)')
    const resync = await app.sync(sourceId, { mode: 'attach', activityId: outcome.activityId })
    if (resync.skipped) {
      pass('Correctly skipped unchanged content')
    } else {
      pass('Re-wrote (content was fresh)')
    }
    if (resync.verification.status !== 'pass') {
      fail('Re-sync verification failed')
      return 1
    }

    console.log(`\n  \x1b[32mAll checks passed.\x1b[0m\n`)
    return 0
  } catch (error) {
    fail((error as Error).message)
    console.error((error as Error).stack)
    return 1
  } finally {
    // Cleanup: delete the activity we created
    if (createdActivityId) {
      try {
        step(`Cleaning up activity ${createdActivityId}`)
        await icu.deleteActivity(createdActivityId)
        pass('Deleted test activity')
      } catch (cleanupError) {
        fail(`Cleanup failed: ${(cleanupError as Error).message}`)
      }
    }

    await rm(stateDir, { recursive: true, force: true })
  }
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

function defaultFixture(): string {
  return fileURLToPath(new URL('../test/fixtures/flying-30m-semicolon.csv', import.meta.url))
}

function step(msg: string): void { console.log(`  ${DIM}${msg}${RESET}`) }
function pass(msg: string): void { console.log(`  ${PASS} ${msg}`) }
function fail(msg: string): void { console.log(`  ${FAIL} ${msg}`) }
function detail(msg: string): void { console.log(`  ${DIM}${msg}${RESET}`) }

main()
  .then((code) => { process.exitCode = code })
  .catch((error: unknown) => {
    console.error(`Fatal: ${(error as Error).message}`)
    process.exitCode = 1
  })
