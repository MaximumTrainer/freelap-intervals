import { PGlite } from '@electric-sql/pglite'

import type { Database, Queryable, QueryResult } from '~/db/database'
import { loadMigrations } from '~/db/migrations'
import { migrate } from '~/db/migrator'

export interface TestDatabase extends Database {
  /** Creates a user and returns their id, for tests that need something to hang rows off. */
  givenUser(email: string): Promise<string>
}

/**
 * A real Postgres, compiled to WebAssembly and run in-process. The project's own SQL migrations
 * are applied to it, so the schema under test is the schema that ships.
 */
export async function aTestDatabase(): Promise<TestDatabase> {
  const database = await anEmptyDatabase()
  await migrate(database, await loadMigrations())

  return database
}

export async function anEmptyDatabase(): Promise<TestDatabase> {
  return new PgliteDatabase(await PGlite.create())
}

class PgliteDatabase implements TestDatabase {
  constructor(private readonly pglite: PGlite) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pglite.query<T>(sql, [...params])
    return { rows: result.rows }
  }

  async exec(sql: string): Promise<void> {
    await this.pglite.exec(sql)
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pglite.transaction(async (tx) =>
      work({
        query: async <R>(sql: string, params: readonly unknown[] = []) => ({
          rows: (await tx.query<R>(sql, [...params])).rows,
        }),
        exec: async (sql: string) => {
          await tx.exec(sql)
        },
      }),
    )
  }

  async givenUser(email: string): Promise<string> {
    const { rows } = await this.query<{ id: string }>('insert into users (email) values ($1) returning id', [email])
    return rows[0]!.id
  }

  async close(): Promise<void> {
    await this.pglite.close()
  }
}
