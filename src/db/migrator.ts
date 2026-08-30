import type { Database } from './database'

export interface Migration {
  readonly version: string
  readonly sql: string
}

const MIGRATIONS_TABLE = `
  create table if not exists schema_migrations (
    version    text        primary key,
    applied_at timestamptz not null default now()
  )
`

/** Applies every migration the database has not seen, in version order. Returns what it applied. */
export async function migrate(database: Database, migrations: readonly Migration[]): Promise<string[]> {
  await database.exec(MIGRATIONS_TABLE)

  const already = new Set(await appliedVersions(database))
  const pending = [...migrations].sort(byVersion).filter((migration) => !already.has(migration.version))

  for (const migration of pending) {
    await applyOne(database, migration)
  }

  return pending.map((migration) => migration.version)
}

async function applyOne(database: Database, migration: Migration): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      await tx.exec(migration.sql)
      await tx.query('insert into schema_migrations (version) values ($1)', [migration.version])
    })
  } catch (cause) {
    throw new Error(`Migration ${migration.version} failed: ${(cause as Error).message}`, { cause })
  }
}

export async function appliedVersions(database: Database): Promise<string[]> {
  await database.exec(MIGRATIONS_TABLE)
  const { rows } = await database.query<{ version: string }>('select version from schema_migrations order by version')

  return rows.map((row) => row.version)
}

function byVersion(left: Migration, right: Migration): number {
  return left.version.localeCompare(right.version)
}
