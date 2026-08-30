import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * A small keyed JSON document on disk. Enough to run the whole flow from a terminal without a
 * database; the ports it backs are the seam where Postgres would go instead.
 */
export class JsonFileStore<T> {
  constructor(
    private readonly path: string,
    private readonly keyOf: (item: T) => string,
  ) {}

  async find(key: string): Promise<T | null> {
    return (await this.all()).find((item) => this.keyOf(item) === key) ?? null
  }

  async all(): Promise<T[]> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as T[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async save(item: T): Promise<void> {
    const kept = (await this.all()).filter((existing) => this.keyOf(existing) !== this.keyOf(item))

    await this.writeAll([...kept, item])
  }

  private async writeAll(items: readonly T[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })

    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
    await rename(temporary, this.path)
  }
}
