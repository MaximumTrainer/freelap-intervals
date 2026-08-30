import type { Database, Queryable } from '~/db/database'
import type { SyncMode } from '~/domain/sync-choice'
import type { VerificationDiff, VerificationStatus } from '~/verify/verifier'

import type { LedgerEntry, LedgerStatus, SyncLedger } from './sync-ledger'

interface SyncRow {
  readonly source_id: string
  readonly activity_id: string
  readonly mode: SyncMode
  readonly status: LedgerStatus
  readonly content_hash: string
  readonly failed_step: string | null
  readonly synced_at: Date | string
  readonly verification_status: VerificationStatus | null
  readonly verification_diffs: VerificationDiff[] | null
}

const SELECT_ENTRY = `
  select s.source_id, s.activity_id, s.mode, s.status, s.content_hash, s.failed_step, s.synced_at,
         v.status as verification_status, v.diffs as verification_diffs
    from syncs s
    left join lateral (
      select status, diffs from verifications where source_id = s.source_id order by id desc limit 1
    ) v on true
   where s.user_id = $1
`

/**
 * The sync ledger in Postgres. Each save records the current state of the sync and appends the
 * verification that produced it, so the history of read-back checks is never lost.
 */
export class PgSyncLedger implements SyncLedger {
  constructor(
    private readonly database: Database,
    private readonly userId: string,
  ) {}

  async findBySourceId(sourceId: string): Promise<LedgerEntry | null> {
    const { rows } = await this.database.query<SyncRow>(`${SELECT_ENTRY} and s.source_id = $2`, [
      this.userId,
      sourceId,
    ])

    return rows[0] ? toEntry(rows[0]) : null
  }

  async activityIdsLinkedElsewhere(sourceId: string): Promise<Set<string>> {
    const { rows } = await this.database.query<{ activity_id: string }>(
      'select activity_id from syncs where user_id = $1 and source_id <> $2',
      [this.userId, sourceId],
    )

    return new Set(rows.map((row) => row.activity_id))
  }

  async save(entry: LedgerEntry): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.upsertSync(tx, entry)

      if (entry.verification) {
        await tx.query('insert into verifications (source_id, status, diffs) values ($1, $2, $3)', [
          entry.sourceId,
          entry.verification.status,
          JSON.stringify(entry.verification.diffs),
        ])
      }
    })
  }

  async all(): Promise<LedgerEntry[]> {
    const { rows } = await this.database.query<SyncRow>(`${SELECT_ENTRY} order by s.synced_at desc`, [this.userId])

    return rows.map(toEntry)
  }

  private async upsertSync(tx: Queryable, entry: LedgerEntry): Promise<void> {
    await tx.query(
      `insert into syncs (source_id, user_id, activity_id, mode, status, content_hash, failed_step, synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (source_id) do update set
         activity_id  = excluded.activity_id,
         mode         = excluded.mode,
         status       = excluded.status,
         content_hash = excluded.content_hash,
         failed_step  = excluded.failed_step,
         synced_at    = excluded.synced_at`,
      [
        entry.sourceId,
        this.userId,
        entry.activityId,
        entry.mode,
        entry.status,
        entry.contentHash,
        entry.failedStep ?? null,
        entry.syncedAt,
      ],
    )
  }
}

function toEntry(row: SyncRow): LedgerEntry {
  return {
    sourceId: row.source_id,
    activityId: row.activity_id,
    mode: row.mode,
    status: row.status,
    contentHash: row.content_hash,
    syncedAt: new Date(row.synced_at).toISOString(),
    ...(row.failed_step === null ? {} : { failedStep: row.failed_step }),
    ...(row.verification_status === null
      ? {}
      : { verification: { status: row.verification_status, diffs: row.verification_diffs ?? [] } }),
  }
}
