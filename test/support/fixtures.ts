import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function csvFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')
}
