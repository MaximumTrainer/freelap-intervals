import type { Database } from '~/db/database'
import { one } from '~/db/database'

export interface SyncLocation {
  readonly userId: string
  readonly sourceId: string
}

/**
 * Answers "whose sync is this activity?" — the question an incoming intervals.icu webhook asks,
 * before any athlete's session is known.
 */
export class PgSyncDirectory {
  constructor(private readonly database: Database) {}

  async findByActivity(athleteId: string, activityId: string): Promise<SyncLocation | null> {
    const row = await one<{ user_id: string; source_id: string }>(
      this.database,
      `select s.user_id, s.source_id
         from syncs s
         join connections c on c.user_id = s.user_id and c.provider = 'intervals_icu'
        where c.external_account_id = $1 and s.activity_id = $2
        limit 1`,
      [athleteId, activityId],
    )

    return row ? { userId: row.user_id, sourceId: row.source_id } : null
  }
}
