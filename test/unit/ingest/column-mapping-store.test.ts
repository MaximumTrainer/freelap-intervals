import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PgColumnMappingStore } from '~/ingest/csv/column-mapping-store'
import { inspectCsv, readSessions } from '~/ingest/csv/csv-adapter'

import { csvFixture } from '../../support/fixtures'
import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

const withNotesColumn = 'Date;Time;Exercise;Run;Total time (s);Wind (m/s);Notes\n29/08/2026;10:14:03;Flying 30m;1;3,42;0,4;felt good'

describe('inspectCsv', () => {
  it('describes an export before importing it', () => {
    const inspection = inspectCsv(withNotesColumn)

    expect(inspection.headers).toContain('Notes')
    expect(inspection.unmapped.map((column) => column.header)).toEqual(['Wind (m/s)', 'Notes'])
    expect(inspection.dialect).toEqual({ delimiter: ';', decimal: ',' })
    expect(inspection.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('gives the same layout the same fingerprint, whatever the rows hold', () => {
    const sameLayout = withNotesColumn.replace('felt good', 'felt awful')

    expect(inspectCsv(sameLayout).fingerprint).toBe(inspectCsv(withNotesColumn).fingerprint)
    expect(inspectCsv(csvFixture('flying-30m-semicolon.csv')).fingerprint).not.toBe(inspectCsv(withNotesColumn).fingerprint)
  })

  it('reports nothing unmapped for an export it fully understands', () => {
    expect(inspectCsv(csvFixture('flying-30m-semicolon.csv')).unmapped).toEqual([])
  })

  it('takes a remembered mapping into account, and still asks about the rest', () => {
    const unmapped = inspectCsv(withNotesColumn, { Notes: 'athlete' }).unmapped

    expect(unmapped.map((column) => column.header)).toEqual(['Wind (m/s)'])
  })
})

describe('PgColumnMappingStore', () => {
  let database: TestDatabase
  let userId: string
  let store: PgColumnMappingStore

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
    store = new PgColumnMappingStore(database)
  })

  afterEach(async () => {
    await database.close()
  })

  it('remembers what an athlete said a column meant', async () => {
    const { fingerprint } = inspectCsv(withNotesColumn)

    await store.remember(userId, fingerprint, { Notes: 'athlete' })

    expect(await store.recall(userId, fingerprint)).toEqual({ Notes: 'athlete' })
  })

  it('has nothing to say about a layout it has not seen', async () => {
    expect(await store.recall(userId, 'unknown-layout')).toEqual({})
  })

  it('replaces an earlier answer for the same layout', async () => {
    await store.remember(userId, 'layout-1', { Notes: 'athlete' })
    await store.remember(userId, 'layout-1', { Notes: 'exercise' })

    expect(await store.recall(userId, 'layout-1')).toEqual({ Notes: 'exercise' })
  })

  it('keeps one athlete\'s mappings away from another\'s', async () => {
    const otherUserId = await database.givenUser('someone-else@example.com')
    await store.remember(userId, 'layout-1', { Notes: 'athlete' })

    expect(await store.recall(otherUserId, 'layout-1')).toEqual({})
  })

  it('feeds the import so the athlete only has to explain a column once', async () => {
    const { fingerprint } = inspectCsv(withNotesColumn)
    await store.remember(userId, fingerprint, { Notes: 'athlete' })

    const [session] = readSessions(withNotesColumn, {
      timezone: 'Europe/London',
      columnOverrides: await store.recall(userId, fingerprint),
    })

    expect(session?.athleteRef).toBe('felt good')
  })
})
