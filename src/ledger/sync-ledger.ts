import type { SyncMode } from '~/domain/sync-choice'
import type { VerificationDiff, VerificationStatus } from '~/verify/verifier'

export type LedgerStatus = 'pending' | 'synced' | 'failed' | 'drifted'

export interface LedgerEntry {
  readonly sourceId: string
  readonly activityId: string
  readonly mode: SyncMode
  readonly status: LedgerStatus
  /** Hash of what we intended to write, so an unchanged session can be recognised. */
  readonly contentHash: string
  readonly syncedAt: string
  /** The clock offset used for this sync, so a different offset triggers a rewrite. */
  readonly offsetS?: number
  readonly verification?: { readonly status: VerificationStatus; readonly diffs: readonly VerificationDiff[] }
  readonly failedStep?: string
  readonly completedSteps?: readonly string[]
  readonly rollback?: 'ok' | 'failed' | 'skipped'
}

export interface SyncLedger {
  findBySourceId(sourceId: string): Promise<LedgerEntry | null>
  /** Activities already owned by some other Freelap session, which must not be overwritten. */
  activityIdsLinkedElsewhere(sourceId: string): Promise<Set<string>>
  save(entry: LedgerEntry): Promise<void>
  all(): Promise<LedgerEntry[]>
}

export class InMemorySyncLedger implements SyncLedger {
  private readonly entries = new Map<string, LedgerEntry>()

  async findBySourceId(sourceId: string): Promise<LedgerEntry | null> {
    return this.entries.get(sourceId) ?? null
  }

  async activityIdsLinkedElsewhere(sourceId: string): Promise<Set<string>> {
    const others = [...this.entries.values()].filter((entry) => entry.sourceId !== sourceId)
    return new Set(others.map((entry) => entry.activityId))
  }

  async save(entry: LedgerEntry): Promise<void> {
    this.entries.set(entry.sourceId, entry)
  }

  async all(): Promise<LedgerEntry[]> {
    return [...this.entries.values()]
  }
}
