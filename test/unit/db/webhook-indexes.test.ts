import { describe, expect, it } from 'vitest'

import { aTestDatabase } from '../../support/test-database'

describe('webhook lookup indexes (O4)', () => {
  it('has an index on connections for the external account lookup', async () => {
    const database = await aTestDatabase()

    const { rows } = await database.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where tablename = 'connections' and indexdef like '%external_account_id%'`,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexname).toBe('connections_by_external')

    await database.close()
  })

  it('has an index on syncs for the activity lookup', async () => {
    const database = await aTestDatabase()

    const { rows } = await database.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where tablename = 'syncs' and indexdef like '%activity_id%'`,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexname).toBe('syncs_by_activity')

    await database.close()
  })
})
