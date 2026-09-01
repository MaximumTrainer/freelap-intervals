import { describe, expect, it } from 'vitest'

import { appliedVersions, migrate } from '~/db/migrator'
import { loadMigrations } from '~/db/migrations'

import { anEmptyDatabase } from '../../support/test-database'

const createWidgets = { version: '001_widgets', sql: 'create table widgets (id int primary key);' }
const addColour = { version: '002_colour', sql: 'alter table widgets add column colour text;' }

describe('migrate', () => {
  it('applies pending migrations in version order and records them', async () => {
    const database = await anEmptyDatabase()

    expect(await migrate(database, [createWidgets, addColour])).toEqual(['001_widgets', '002_colour'])
    expect(await appliedVersions(database)).toEqual(['001_widgets', '002_colour'])

    await database.close()
  })

  it('applies nothing the second time', async () => {
    const database = await anEmptyDatabase()
    await migrate(database, [createWidgets])

    expect(await migrate(database, [createWidgets, addColour])).toEqual(['002_colour'])
    expect(await migrate(database, [createWidgets, addColour])).toEqual([])

    await database.close()
  })

  it('leaves the database untouched when a migration fails', async () => {
    const database = await anEmptyDatabase()
    const broken = { version: '002_broken', sql: 'create table widgets (this is not sql);' }

    await expect(migrate(database, [createWidgets, broken])).rejects.toThrow(/002_broken/)
    expect(await appliedVersions(database)).toEqual(['001_widgets'])

    await database.close()
  })
})

describe('loadMigrations', () => {
  it('reads the project migrations in filename order', async () => {
    const migrations = await loadMigrations()

    expect(migrations.map((migration) => migration.version)).toEqual([
      '001_init',
      '002_sessions',
      '003_webhook_indexes',
      '004_rate_limiter',
      '005_queue_key',
      '006_scheduler',
    ])
    expect(migrations[0]?.sql).toContain('create table users')
    expect(migrations[1]?.sql).toContain('create table sessions')
    expect(migrations[2]?.sql).toContain('connections_by_external')
    expect(migrations[3]?.sql).toContain('rate_limiter_buckets')
  })
})
