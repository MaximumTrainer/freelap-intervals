import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PgAuditLog } from '~/audit/pg-audit-log'
import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
import { runReseal } from '~/security/reseal'
import { Secret } from '~/security/secret'

import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

const someTokens = {
  accessToken: new Secret('access-abc'),
  refreshToken: new Secret('refresh-xyz'),
  expiresAt: '2026-08-29T13:00:00.000Z',
  athleteId: 'i12345',
  scopes: ['ACTIVITY:READ', 'ACTIVITY:WRITE'],
}

describe('reseal CLI', () => {
  let database: TestDatabase
  let kms: LocalKeyManagementService
  let store: ConnectionStore
  let output: string[]

  beforeEach(async () => {
    database = await aTestDatabase()
    kms = LocalKeyManagementService.forTesting()
    store = new ConnectionStore(database, new EnvelopeCipher(kms))
    output = []
  })

  afterEach(async () => {
    await database.close()
  })

  const run = (apply = false) =>
    runReseal({ connections: store, out: (line: string) => output.push(line), apply })

  it('reports the count without changing anything in dry-run mode', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await store.saveIntervalsIcu(userId, someTokens)

    kms.rotateTo('key-2')
    const exitCode = await run()

    expect(exitCode).toBe(0)
    expect(output.join('\n')).toContain('1 connection(s) would be resealed')

    const rawEnvelope = (await database.query<{ secret_envelope: string }>('select secret_envelope from connections'))
      .rows[0]!.secret_envelope
    expect(rawEnvelope).toContain('key-1')
  })

  it('reseals connections when --apply is given', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await store.saveIntervalsIcu(userId, someTokens)

    kms.rotateTo('key-2')
    const exitCode = await run(true)

    expect(exitCode).toBe(0)
    expect(output.join('\n')).toContain('Resealed: 1')

    const rawEnvelope = (await database.query<{ secret_envelope: string }>('select secret_envelope from connections'))
      .rows[0]!.secret_envelope
    expect(rawEnvelope).toContain('key-2')
    expect((await store.findIntervalsIcu(userId))?.tokens.accessToken.reveal()).toBe('access-abc')
  })

  it('returns non-zero when at least one connection fails', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await store.saveIntervalsIcu(userId, someTokens)
    await store.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })
    await database.query(
      `update connections set secret_envelope = 'v1.key-1.garbage.garbage.garbage.garbage'
       where provider = 'myfreelap'`,
    )

    kms.rotateTo('key-2')
    const exitCode = await run(true)

    expect(exitCode).toBe(1)
    expect(output.join('\n')).toContain('Failed: 1')
  })

  it('never prints credentials or key material', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await store.saveIntervalsIcu(userId, someTokens)

    kms.rotateTo('key-2')
    await run(true)

    const allOutput = output.join('\n')
    expect(allOutput).not.toContain('access-abc')
    expect(allOutput).not.toContain('refresh-xyz')
    expect(allOutput).not.toContain(someTokens.accessToken.reveal())
    expect(allOutput).not.toContain(someTokens.refreshToken.reveal())
  })

  it('skips connections already under the target key', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await store.saveIntervalsIcu(userId, someTokens)

    const exitCode = await run(true)

    expect(exitCode).toBe(0)
    expect(output.join('\n')).toContain('Skipped: 1')
    expect(output.join('\n')).toContain('Resealed: 0')
  })

  it('writes audit rows for start and finish', async () => {
    const userId = await database.givenUser('athlete@example.com')
    await store.saveIntervalsIcu(userId, someTokens)
    const audit = new PgAuditLog(database)

    kms.rotateTo('key-2')
    await runReseal({
      connections: store,
      out: (line: string) => output.push(line),
      apply: true,
      audit,
    })

    const { rows } = await database.query<{ action: string; outcome: string; detail: unknown }>(
      'select action, outcome, detail from audit_log where user_id is null order by id',
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ action: 'reseal:start', outcome: 'ok' })
    expect(rows[1]).toMatchObject({
      action: 'reseal:finish',
      outcome: 'ok',
      detail: { resealed: 1, skipped: 0, failed: 0 },
    })
  })
})
