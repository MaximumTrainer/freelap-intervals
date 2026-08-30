import type { SprintSession } from '~/domain/sprint-session'
import { InMemorySyncLedger } from '~/ledger/sync-ledger'
import type { SyncApplicationOptions } from '~/app/sync-application'
import { SyncApplication } from '~/app/sync-application'

import { FakeIntervalsIcu } from './fake-intervals-icu'

export interface TestApp {
  readonly app: SyncApplication
  readonly icu: FakeIntervalsIcu
  readonly ledger: InMemorySyncLedger
}

export function aTestApp(overrides: Partial<SyncApplicationOptions> = {}): TestApp {
  const icu = new FakeIntervalsIcu({ timezone: 'Europe/London' })
  const ledger = new InMemorySyncLedger()

  const app = new SyncApplication({
    icu,
    ledger,
    athleteId: icu.athleteId,
    now: () => new Date('2026-08-29T12:00:00Z'),
    ...overrides,
  })

  return { app, icu, ledger }
}

/** Reads the one session a single-session fixture is expected to yield. */
export function theOnlySession(sessions: readonly SprintSession[]): SprintSession {
  if (sessions.length !== 1) throw new Error(`Expected exactly one session, got ${sessions.length}`)

  return sessions[0]!
}
