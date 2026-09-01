import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PgSessionStore } from '~/web/session-store'

import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

describe('PgSessionStore', () => {
  let database: TestDatabase
  let userId: string

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
  })

  afterEach(async () => {
    await database.close()
  })

  it('creates a session and validates it', async () => {
    const store = new PgSessionStore(database)

    const sessionId = await store.create(userId)

    const record = await store.validate(sessionId)
    expect(record).toEqual({ id: sessionId, userId })
  })

  it('rejects an unknown session id', async () => {
    const store = new PgSessionStore(database)

    expect(await store.validate('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('rejects an expired session', async () => {
    let clock = new Date('2026-08-01T12:00:00Z')
    const store = new PgSessionStore(database, {
      now: () => clock,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    })

    const sessionId = await store.create(userId)

    clock = new Date('2026-09-01T12:00:00Z')
    expect(await store.validate(sessionId)).toBeNull()
  })

  it('rejects a revoked session', async () => {
    const store = new PgSessionStore(database)

    const sessionId = await store.create(userId)
    await store.revoke(sessionId)

    expect(await store.validate(sessionId)).toBeNull()
  })

  it('revokes one session without affecting another', async () => {
    const store = new PgSessionStore(database)

    const session1 = await store.create(userId)
    const session2 = await store.create(userId)
    await store.revoke(session1)

    expect(await store.validate(session1)).toBeNull()
    expect(await store.validate(session2)).toEqual({ id: session2, userId })
  })

  it('revokes all sessions for a user', async () => {
    const store = new PgSessionStore(database)
    const otherUser = await database.givenUser('other@example.com')

    const session1 = await store.create(userId)
    const session2 = await store.create(userId)
    const otherSession = await store.create(otherUser)

    await store.revokeAllForUser(userId)

    expect(await store.validate(session1)).toBeNull()
    expect(await store.validate(session2)).toBeNull()
    expect(await store.validate(otherSession)).toEqual({ id: otherSession, userId: otherUser })
  })

  it('throttles last_seen_at updates to once per hour', async () => {
    let clock = new Date('2026-08-29T12:00:00Z')
    const store = new PgSessionStore(database, { now: () => clock })

    const sessionId = await store.create(userId)

    clock = new Date('2026-08-29T12:30:00Z')
    await store.touch(sessionId)

    const { rows: before } = await database.query<{ last_seen_at: string }>(
      'select last_seen_at::text from sessions where id = $1',
      [sessionId],
    )

    clock = new Date('2026-08-29T13:01:00Z')
    await store.touch(sessionId)

    const { rows: after } = await database.query<{ last_seen_at: string }>(
      'select last_seen_at::text from sessions where id = $1',
      [sessionId],
    )

    expect(before[0]!.last_seen_at).not.toBe(after[0]!.last_seen_at)
  })
})
