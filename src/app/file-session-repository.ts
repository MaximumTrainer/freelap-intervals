import type { SprintSession } from '~/domain/sprint-session'
import { JsonFileStore } from '~/storage/json-file-store'

import type { SessionRepository } from './session-repository'

/** Imported sessions, kept in a JSON file between CLI commands. */
export class FileSessionRepository implements SessionRepository {
  private readonly store: JsonFileStore<SprintSession>

  constructor(path: string) {
    this.store = new JsonFileStore(path, (session) => session.sourceId)
  }

  async save(session: SprintSession): Promise<void> {
    await this.store.save(session)
  }

  async find(sourceId: string): Promise<SprintSession | null> {
    return this.store.find(sourceId)
  }

  async all(): Promise<SprintSession[]> {
    return this.store.all()
  }
}
