import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CsvFreelapSource } from '~/ingest/csv/csv-freelap-source'
import { FreelapSources, featureFlagsFromEnvironment } from '~/ingest/freelap-sources'
import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
import { Secret } from '~/security/secret'

import { FakeMyFreelapApi } from '../../support/fake-myfreelap-api'
import { csvFixture } from '../../support/fixtures'
import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

describe('CsvFreelapSource', () => {
  const source = new CsvFreelapSource(csvFixture('two-sessions.csv'), { timezone: 'Europe/London' })

  it('lists the sessions inside the window the athlete asked about', async () => {
    const listed = await source.listSessions({ from: '2026-08-29', to: '2026-08-29' })

    expect(listed.map((session) => session.exerciseName)).toEqual(['Flying 30m', '60m from blocks'])
  })

  it('hands over a session by its id', async () => {
    const [first] = await source.listSessions({ from: '2026-08-01', to: '2026-08-31' })

    expect((await source.getSession(first!.id)).exerciseName).toBe('Flying 30m')
  })

  it('says so when the export does not hold the session asked for', async () => {
    await expect(source.getSession('csv-nope')).rejects.toThrow(/no session csv-nope/i)
  })

  it('reports an unreadable export as unhealthy rather than throwing', async () => {
    expect(await new CsvFreelapSource('Date;Athlete\n29/08/2026;Dan').checkHealth()).toMatchObject({ healthy: false })
    expect(await source.checkHealth()).toEqual({ healthy: true })
  })
})

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
