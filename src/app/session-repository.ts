import type { SprintSession } from '~/domain/sprint-session'

/** Where imported sessions live between import, review and write. */
export interface SessionRepository {
  save(session: SprintSession): Promise<void>
  find(sourceId: string): Promise<SprintSession | null>
  all(): Promise<SprintSession[]>
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, SprintSession>()

  async save(session: SprintSession): Promise<void> {
    this.sessions.set(session.sourceId, session)
  }

  async find(sourceId: string): Promise<SprintSession | null> {
    return this.sessions.get(sourceId) ?? null
  }

  async all(): Promise<SprintSession[]> {
    return [...this.sessions.values()]
  }
}
