import pg from 'pg'

export interface QueryResult<T> {
  readonly rows: T[]
}

export interface Queryable {
  query<T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>
  /** Runs a script that may hold several statements and takes no parameters. */
  exec(sql: string): Promise<void>
}

export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** The production database: a pooled connection to Postgres. */
export class PgDatabase implements Database {
  private readonly pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString })
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, [...params])
    return { rows: result.rows as T[] }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql)
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()

    try {
      await client.query('begin')
      const result = await work(clientAsQueryable(client))
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function clientAsQueryable(client: pg.PoolClient): Queryable {
  return {
    query: async <T>(sql: string, params: readonly unknown[] = []) => ({
      rows: (await client.query(sql, [...params])).rows as T[],
    }),
    exec: async (sql: string) => {
      await client.query(sql)
    },
  }
}

/** Reads the single row a query was expected to return. */
export async function one<T>(queryable: Queryable, sql: string, params: readonly unknown[] = []): Promise<T | null> {
  const { rows } = await queryable.query<T>(sql, params)
  return rows[0] ?? null
}
