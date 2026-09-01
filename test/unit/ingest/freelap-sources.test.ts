import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FreelapSources, featureFlagsFromEnvironment } from '~/ingest/freelap-sources'
import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
import { Secret } from '~/security/secret'

import { FakeMyFreelapApi } from '../../support/fake-myfreelap-api'
import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

describe('FreelapSources', () => {
  let database: TestDatabase
  let userId: string
  let connections: ConnectionStore

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
    connections = new ConnectionStore(database, new EnvelopeCipher(LocalKeyManagementService.forTesting()))
  })

  afterEach(async () => {
    await database.close()
  })

  const sourcesWith = (myfreelapWebAdapter: boolean): FreelapSources =>
    new FreelapSources({
      connections,
      flags: { myfreelapWebAdapter },
      timezone: 'Europe/London',
      baseUrl: 'https://api.myfreelap.test',
      fetch: new FakeMyFreelapApi().fetch,
    })

  it('offers the web source once an operator enables it and the athlete has stored credentials', async () => {
    await connections.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })

    const source = await sourcesWith(true).webSourceFor(userId)

    expect(source?.name).toBe('MyFreelap web')
    expect(await source?.listSessions({ from: '2026-08-01', to: '2026-08-31' })).toHaveLength(1)
  })

  it('keeps the unofficial adapter out of reach while the flag is off', async () => {
    await connections.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })

    expect(await sourcesWith(false).webSourceFor(userId)).toBeNull()
  })

  it('offers nothing for an athlete who never shared MyFreelap credentials', async () => {
    expect(await sourcesWith(true).webSourceFor(userId)).toBeNull()
  })

  it('reads the flag from the environment, defaulting to off', () => {
    expect(featureFlagsFromEnvironment({})).toEqual({ myfreelapWebAdapter: false })
    expect(featureFlagsFromEnvironment({ FREELAP_WEB_ADAPTER: 'on' })).toEqual({ myfreelapWebAdapter: true })
  })
})
