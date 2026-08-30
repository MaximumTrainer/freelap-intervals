import { describe, expect, it } from 'vitest'

import type { SessionRepository } from '~/app/session-repository'
import type { LedgerEntry, SyncLedger } from '~/ledger/sync-ledger'

import { aSession } from '../support/builders'

export interface Storage {
  readonly sessions: SessionRepository
  readonly ledger: SyncLedger
  close(): Promise<void>
}

export type OpenStorage = () => Promise<Storage>

const anEntry = (overrides: Partial<LedgerEntry> & Pick<LedgerEntry, 'sourceId' | 'activityId'>): LedgerEntry => ({
  mode: 'create-new',
  status: 'synced',
  contentHash: 'hash-1',
  syncedAt: '2026-08-29T12:00:00.000Z',
  ...overrides,
})

/** Every SessionRepository and SyncLedger implementation must behave this way. */
export function describeStorageContract(name: string, open: OpenStorage): void {
  const withStorage = async (test: (storage: Storage) => Promise<void>): Promise<void> => {
    const storage = await open()
    try {
      await test(storage)
    } finally {
      await storage.close()
    }
  }

  describe(`${name}: sessions`, () => {
    it('gives back a session exactly as it was saved', async () => {
      await withStorage(async ({ sessions }) => {
        const session = aSession({ sourceId: 'csv-one' })
        await sessions.save(session)

        expect(await sessions.find('csv-one')).toEqual(session)
      })
    })

    it('has nothing to say about a session it never saw', async () => {
      await withStorage(async ({ sessions }) => {
        expect(await sessions.find('csv-unknown')).toBeNull()
      })
    })

    it('replaces a session imported a second time rather than duplicating it', async () => {
      await withStorage(async ({ sessions }) => {
        await sessions.save(aSession({ sourceId: 'csv-one', exerciseName: 'Flying 30m' }))
        await sessions.save(aSession({ sourceId: 'csv-one', exerciseName: 'Flying 40m' }))

        expect(await sessions.all()).toHaveLength(1)
        expect((await sessions.find('csv-one'))?.exerciseName).toBe('Flying 40m')
      })
    })

    it('lists every session it holds', async () => {
      await withStorage(async ({ sessions }) => {
        await sessions.save(aSession({ sourceId: 'csv-one' }))
        await sessions.save(aSession({ sourceId: 'csv-two' }))

        expect((await sessions.all()).map((session) => session.sourceId).sort()).toEqual(['csv-one', 'csv-two'])
      })
    })
  })

  describe(`${name}: ledger`, () => {
    const givenSessions = async (storage: Storage, ...sourceIds: string[]): Promise<void> => {
      for (const sourceId of sourceIds) await storage.sessions.save(aSession({ sourceId }))
    }

    it('remembers where a session was written', async () => {
      await withStorage(async (storage) => {
        await givenSessions(storage, 'csv-one')
        const entry = anEntry({ sourceId: 'csv-one', activityId: 'a1' })

        await storage.ledger.save(entry)

        expect(await storage.ledger.findBySourceId('csv-one')).toEqual(entry)
      })
    })

    it('has nothing to say about a session that was never synced', async () => {
      await withStorage(async ({ ledger }) => {
        expect(await ledger.findBySourceId('csv-unknown')).toBeNull()
      })
    })

    it('keeps the verification report alongside the entry', async () => {
      await withStorage(async (storage) => {
        await givenSessions(storage, 'csv-one')
        const entry = anEntry({
          sourceId: 'csv-one',
          activityId: 'a1',
          verification: { status: 'partial', diffs: [{ check: 'description block', expected: 'a', actual: 'b', critical: false }] },
        })

        await storage.ledger.save(entry)

        expect(await storage.ledger.findBySourceId('csv-one')).toEqual(entry)
      })
    })

    it('overwrites an earlier sync of the same session', async () => {
      await withStorage(async (storage) => {
        await givenSessions(storage, 'csv-one')
        await storage.ledger.save(anEntry({ sourceId: 'csv-one', activityId: 'a1' }))
        await storage.ledger.save(anEntry({ sourceId: 'csv-one', activityId: 'a2', status: 'drifted' }))

        expect(await storage.ledger.all()).toHaveLength(1)
        expect(await storage.ledger.findBySourceId('csv-one')).toMatchObject({ activityId: 'a2', status: 'drifted' })
      })
    })

    it('remembers the failed step of a sync that stopped half way', async () => {
      await withStorage(async (storage) => {
        await givenSessions(storage, 'csv-one')
        await storage.ledger.save(anEntry({ sourceId: 'csv-one', activityId: 'a1', status: 'failed', failedStep: 'intervals' }))

        expect(await storage.ledger.findBySourceId('csv-one')).toMatchObject({ failedStep: 'intervals' })
      })
    })

    it('names the activities other sessions have claimed, but not this one\'s own', async () => {
      await withStorage(async (storage) => {
        await givenSessions(storage, 'csv-one', 'csv-two', 'csv-three')
        await storage.ledger.save(anEntry({ sourceId: 'csv-one', activityId: 'a1' }))
        await storage.ledger.save(anEntry({ sourceId: 'csv-two', activityId: 'a2' }))
        await storage.ledger.save(anEntry({ sourceId: 'csv-three', activityId: 'a3' }))

        expect(await storage.ledger.activityIdsLinkedElsewhere('csv-one')).toEqual(new Set(['a2', 'a3']))
      })
    })
  })
}
