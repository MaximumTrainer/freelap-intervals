import type { Database } from '~/db/database'
import { one } from '~/db/database'

import type { MappingOverrides } from './column-mapping'

/**
 * What an athlete told us their unrecognised columns meant, remembered per export layout so they
 * are asked once rather than on every import.
 */
export interface ColumnMappingStore {
  recall(userId: string, fingerprint: string): Promise<MappingOverrides>
  remember(userId: string, fingerprint: string, mapping: MappingOverrides): Promise<void>
}

export class PgColumnMappingStore implements ColumnMappingStore {
  constructor(private readonly database: Database) {}

  async recall(userId: string, fingerprint: string): Promise<MappingOverrides> {
    const row = await one<{ mapping: MappingOverrides }>(
      this.database,
      'select mapping from column_mappings where user_id = $1 and fingerprint = $2',
      [userId, fingerprint],
    )

    return row?.mapping ?? {}
  }

  async remember(userId: string, fingerprint: string, mapping: MappingOverrides): Promise<void> {
    await this.database.query(
      `insert into column_mappings (user_id, fingerprint, mapping)
       values ($1, $2, $3)
       on conflict (user_id, fingerprint) do update set mapping = excluded.mapping, updated_at = now()`,
      [userId, fingerprint, JSON.stringify(mapping)],
    )
  }
}
