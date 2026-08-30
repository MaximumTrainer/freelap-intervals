import { JsonFileStore } from '~/storage/json-file-store'

import type { LedgerEntry, SyncLedger } from './sync-ledger'

/** The sync ledger, kept in a JSON file so a terminal session survives between commands. */
export class FileSyncLedger implements SyncLedger {
  private readonly store: JsonFileStore<LedgerEntry>

  constructor(path: string) {
    this.store = new JsonFileStore(path, (entry) => entry.sourceId)
  }

  async findBySourceId(sourceId: string): Promise<LedgerEntry | null> {
    return this.store.find(sourceId)
  }

  async activityIdsLinkedElsewhere(sourceId: string): Promise<Set<string>> {
    const others = (await this.store.all()).filter((entry) => entry.sourceId !== sourceId)
    return new Set(others.map((entry) => entry.activityId))
  }

  async save(entry: LedgerEntry): Promise<void> {
    await this.store.save(entry)
  }

  async all(): Promise<LedgerEntry[]> {
    return this.store.all()
  }
}
