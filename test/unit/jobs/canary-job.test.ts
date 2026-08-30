import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PgAuditLog } from '~/audit/pg-audit-log'
import { FREELAP_CANARY, canaryJobHandlers } from '~/jobs/canary-job'
import { PgJobQueue } from '~/jobs/pg-job-queue'
import { Worker } from '~/jobs/worker'
import { FreelapSources } from '~/ingest/freelap-sources'
import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
import { Secret } from '~/security/secret'

import { FakeMyFreelapApi } from '../../support/fake-myfreelap-api'
import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

describe('the MyFreelap canary', () => {
  let database: TestDatabase
  let userId: string
  let connections: ConnectionStore
  let audit: PgAuditLog

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
    connections = new ConnectionStore(database, new EnvelopeCipher(LocalKeyManagementService.forTesting()))
    audit = new PgAuditLog(database)
    await connections.saveFreelap(userId, { username: 'dan@example.com', password: new Secret('hunter2') })
  })

  afterEach(async () => {
    await database.close()
  })

  const runCanary = async (api: FakeMyFreelapApi): Promise<void> => {
    const sources = new FreelapSources({
      connections,
      flags: { myfreelapWebAdapter: true },
      timezone: 'Europe/London',
      baseUrl: 'https://api.myfreelap.test',
      fetch: api.fetch,
    })
    const queue = new PgJobQueue(database)
    await queue.enqueue(FREELAP_CANARY, { userId })

    await new Worker(queue, canaryJobHandlers(connections, sources, audit)).runUntilIdle()
  }

  it('leaves a healthy connection alone, and says so in the log', async () => {
    await runCanary(new FakeMyFreelapApi())

    expect(await connections.findFreelap(userId)).toMatchObject({ status: 'active' })
    expect(await audit.recent(userId)).toEqual([
      expect.objectContaining({ action: 'myfreelap canary', outcome: 'ok' }),
    ])
  })

  it('marks the connection degraded when MyFreelap stops answering as expected', async () => {
    await runCanary(new FakeMyFreelapApi({ serveHtml: true }))

    expect(await connections.findFreelap(userId)).toMatchObject({ status: 'degraded' })
    expect(await audit.recent(userId)).toEqual([
      expect.objectContaining({
        action: 'myfreelap canary',
        outcome: 'error',
        detail: expect.objectContaining({ reason: expect.stringContaining('degraded') }),
      }),
    ])
  })

  it('brings a degraded connection back when MyFreelap recovers', async () => {
    await runCanary(new FakeMyFreelapApi({ serveHtml: true }))
    await runCanary(new FakeMyFreelapApi())

    expect(await connections.findFreelap(userId)).toMatchObject({ status: 'active' })
  })
})
