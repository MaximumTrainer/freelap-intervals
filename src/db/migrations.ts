import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Migration } from './migrator'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))

/** Reads the SQL migrations shipped with the project, in filename order. */
export async function loadMigrations(directory = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()

  return Promise.all(
    files.map(async (name) => ({
      version: name.replace(/\.sql$/, ''),
      sql: await readFile(join(directory, name), 'utf8'),
    })),
  )
}
