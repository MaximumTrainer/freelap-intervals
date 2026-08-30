import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileSessionRepository } from '~/app/file-session-repository'
import { SyncApplication } from '~/app/sync-application'
import { runCommand } from '~/cli/commands'
import { HttpIntervalsIcuClient } from '~/icu/http-intervals-icu-client'
import { FileSyncLedger } from '~/ledger/file-sync-ledger'

import { FakeIntervalsIcuServer } from '../support/fake-intervals-icu-server'
import { csvFixture } from '../support/fixtures'

describe('the whole tool, over real HTTP, with state on disk', () => {
  let server: FakeIntervalsIcuServer
  let stateDir: string
  let output: string[]

  const runCli = async (...argv: string[]): Promise<number> => {
    const app = new SyncApplication({
      icu: new HttpIntervalsIcuClient({
        baseUrl: server.baseUrl,
        credentials: { kind: 'apiKey', key: 'test-key' },
        retry: { attempts: 2, baseDelayMs: 0, sleep: async () => {} },
      }),
      ledger: new FileSyncLedger(join(stateDir, 'ledger.json')),
      sessions: new FileSessionRepository(join(stateDir, 'sessions.json')),
      athleteId: server.icu.athleteId,
    })

    return runCommand(argv, {
      app,
      readFile: async (path) => csvFixture(path),
      out: (line) => output.push(line),
    })
  }

  beforeEach(async () => {
    server = await FakeIntervalsIcuServer.start()
    stateDir = await mkdtemp(join(tmpdir(), 'freelap-e2e-'))
    output = []
  })

  afterEach(async () => {
    await server.stop()
    await rm(stateDir, { recursive: true, force: true })
  })

  it('imports, pushes and verifies a session across separate commands', async () => {
    expect(await runCli('import', 'flying-30m-semicolon.csv')).toBe(0)
    const sourceId = /csv-[0-9a-f]{12}/.exec(output.join('\n'))?.[0] ?? ''
    expect(sourceId).not.toBe('')

    // A fresh command reads the session back from disk.
    expect(await runCli('list')).toBe(0)
    expect(output.join('\n')).toContain('Flying 30m')

    expect(await runCli('push', sourceId, '--new')).toBe(0)
    expect(output.join('\n')).toContain('Verification: pass')

    const activityId = server.icu.activityCount === 1 ? (await server.icu.listActivities('i1234', anyDay()))[0]!.id : ''
    const intervals = server.icu.intervalsOf(activityId)
    expect(intervals.map((interval) => interval.name)).toEqual([
      'FL #1 · 30m · 3.42s',
      'FL #2 · 30m · 3.38s',
      'FL #3 · 30m · 3.51s',
      'FL #4 · 30m · 3.35s',
      'FL #5 · 30m · 3.44s',
      'FL #6 · 30m · 3.61s',
    ])
    expect(server.icu.activity(activityId)).toMatchObject({
      external_id: `freelap:${sourceId}`,
      type: 'Run',
      distance: 180,
      custom_fields: { fl_rep_count: 6, fl_best_s: 3.35, fl_avg_s: 3.452, fl_distance_m: 30 },
    })

    expect(await runCli('verify', sourceId)).toBe(0)

    // The second command run recognises the earlier sync and offers the same activity again.
    output = []
    expect(await runCli('plan', sourceId)).toBe(0)
    expect(output.join('\n')).toContain(`Recommended: attach to ${activityId}`)
  })

  it('surfaces an intervals.icu rejection instead of writing half a session', async () => {
    await runCli('import', 'flying-30m-semicolon.csv')
    const sourceId = /csv-[0-9a-f]{12}/.exec(output.join('\n'))?.[0] ?? ''

    const code = await runCli('push', sourceId, '--attach', 'does-not-exist')

    expect(code).toBe(1)
    expect(output.join('\n')).toMatch(/No activity does-not-exist/)
  })
})

function anyDay(): { oldest: string; newest: string } {
  return { oldest: '2000-01-01', newest: '2100-01-01' }
}
