import type { Database } from '~/db/database'

export type AdapterStatus = 'unknown' | 'active' | 'degraded'

export interface AdapterHealthRecord {
  readonly adapter: string
  readonly status: AdapterStatus
  readonly reason: string | null
  readonly checkedAt: string
}

/** Global health of adapters this integration depends on, checked by the canary. */
export interface AdapterHealthStore {
  update(adapter: string, status: AdapterStatus, reason: string | null): Promise<void>
  find(adapter: string): Promise<AdapterHealthRecord | null>
}

export class PgAdapterHealthStore implements AdapterHealthStore {
  constructor(private readonly database: Database) {}

  async update(adapter: string, status: AdapterStatus, reason: string | null): Promise<void> {
    await this.database.query(
      `insert into adapter_health (adapter, status, reason, checked_at)
       values ($1, $2, $3, now())
       on conflict (adapter) do update set
         status     = excluded.status,
         reason     = excluded.reason,
         checked_at = excluded.checked_at`,
      [adapter, status, reason],
    )
  }

  async find(adapter: string): Promise<AdapterHealthRecord | null> {
    const { rows } = await this.database.query<{
      adapter: string
      status: AdapterStatus
      reason: string | null
      checked_at: Date | string
    }>(
      'select adapter, status, reason, checked_at from adapter_health where adapter = $1',
      [adapter],
    )

    const row = rows[0]
    if (!row) return null

    return {
      adapter: row.adapter,
      status: row.status,
      reason: row.reason,
      checkedAt: new Date(row.checked_at).toISOString(),
    }
  }
}
