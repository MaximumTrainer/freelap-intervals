import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
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

describe('ConnectionStore', () => {
  let database: TestDatabase
  let userId: string
  let kms: LocalKeyManagementService
  let store: ConnectionStore

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
    kms = LocalKeyManagementService.forTesting()
    store = new ConnectionStore(database, new EnvelopeCipher(kms))
  })

  afterEach(async () => {
    await database.close()
  })

  const rawSecretColumn = async (): Promise<string> => {
    const { rows } = await database.query<{ secret_envelope: string }>('select secret_envelope from connections')
    return rows.map((row) => row.secret_envelope).join('')
  }

  it('gives back the intervals.icu tokens it was given', async () => {
    await store.saveIntervalsIcu(userId, someTokens)

    expect(await store.findIntervalsIcu(userId)).toEqual({
      userId,
      provider: 'intervals_icu',
      status: 'active',
      athleteId: 'i12345',
      scopes: ['ACTIVITY:READ', 'ACTIVITY:WRITE'],
      expiresAt: '2026-08-29T13:00:00.000Z',
      tokens: { accessToken: new Secret('access-abc'), refreshToken: new Secret('refresh-xyz') },
    })
  })

  it('never writes a token to the database in the clear', async () => {
    await store.saveIntervalsIcu(userId, someTokens)

    const stored = await rawSecretColumn()
    expect(stored).not.toContain('access-abc')
    expect(stored).not.toContain('refresh-xyz')
    expect(stored).toMatch(/^v1\.key-1\./)
  })

  it('replaces the tokens of a re-connected account instead of adding a second row', async () => {
    await store.saveIntervalsIcu(userId, someTokens)
    await store.saveIntervalsIcu(userId, { ...someTokens, accessToken: new Secret('access-second') })

    const { rows } = await database.query('select 1 from connections')
    expect(rows).toHaveLength(1)
    expect((await store.findIntervalsIcu(userId))?.tokens.accessToken.reveal()).toBe('access-second')
  })

  it('stores MyFreelap credentials the same guarded way', async () => {
    await store.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })

    expect(await store.findFreelap(userId)).toMatchObject({
      status: 'active',
      credentials: { username: 'dan@example.com', password: new Secret('hunter2') },
    })
    expect(await rawSecretColumn()).not.toContain('hunter2')
  })

  it('has nothing for an athlete who has connected nothing', async () => {
    expect(await store.findIntervalsIcu(userId)).toBeNull()
    expect(await store.findFreelap(userId)).toBeNull()
  })

  it('reports a connection that needs reconnecting', async () => {
    await store.saveIntervalsIcu(userId, someTokens)

    await store.markStatus(userId, 'intervals_icu', 'needs_reconnect')

    expect(await store.findIntervalsIcu(userId)).toMatchObject({ status: 'needs_reconnect' })
  })

  it('wipes the credentials the moment an athlete disconnects', async () => {
    await store.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })

    await store.disconnect(userId, 'myfreelap')

    expect(await store.findFreelap(userId)).toBeNull()
    expect(await rawSecretColumn()).toBe('')
  })

  it('re-seals every stored secret when the master key is rotated', async () => {
    await store.saveIntervalsIcu(userId, someTokens)
    await store.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })

    kms.rotateTo('key-2')
    const result = await store.resealAll()
    expect(result).toMatchObject({ resealed: 2, skipped: 0, failed: [] })

    expect(await rawSecretColumn()).not.toContain('key-1')
    expect((await store.findIntervalsIcu(userId))?.tokens.accessToken.reveal()).toBe('access-abc')
    expect((await store.findFreelap(userId))?.credentials.password.reveal()).toBe('hunter2')
  })

  it('skips connections already sealed under the target key', async () => {
    await store.saveIntervalsIcu(userId, someTokens)
    await store.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })
    kms.rotateTo('key-2')
    await store.resealAll()

    const result = await store.resealAll()

    expect(result).toMatchObject({ resealed: 0, skipped: 2 })
  })

  it('isolates errors: one corrupt envelope does not abort the others', async () => {
    await store.saveIntervalsIcu(userId, someTokens)
    await store.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })
    await database.query(
      `update connections set secret_envelope = 'v1.key-1.garbage.garbage.garbage.garbage'
       where provider = 'myfreelap'`,
    )

    kms.rotateTo('key-2')
    const result = await store.resealAll()

    expect(result.resealed).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ userId, provider: 'myfreelap' })
    expect((await store.findIntervalsIcu(userId))?.tokens.accessToken.reveal()).toBe('access-abc')
  })

  it('reports without changing anything when asked for a dry run', async () => {
    await store.saveIntervalsIcu(userId, someTokens)
    const envelopeBefore = await rawSecretColumn()

    kms.rotateTo('key-2')
    const result = await store.resealAll({ dryRun: true })

    expect(result).toMatchObject({ resealed: 0, skipped: 0, wouldReseal: 1 })
    expect(await rawSecretColumn()).toBe(envelopeBefore)
  })

  it('calls the progress callback for each connection processed', async () => {
    await store.saveIntervalsIcu(userId, someTokens)
    await store.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })

    kms.rotateTo('key-2')
    const progress: Array<{ current: number; total: number }> = []
    await store.resealAll({ onProgress: (current, total) => progress.push({ current, total }) })

    expect(progress).toEqual([{ current: 1, total: 2 }, { current: 2, total: 2 }])
  })
})
