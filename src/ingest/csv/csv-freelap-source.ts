import type { SprintSession } from '~/domain/sprint-session'

import type { DateWindow, FreelapSource, HealthReport, SessionSummary } from '../freelap-source'

import type { CsvImportOptions } from './csv-adapter'
import { readSessions } from './csv-adapter'

const SOURCE_NAME = 'CSV export'

/** The path that always works: whatever the athlete exported from the MyFreelap app. */
export class CsvFreelapSource implements FreelapSource {
  readonly name = SOURCE_NAME

  constructor(
    private readonly csv: string,
    private readonly options: CsvImportOptions = {},
  ) {}

  async listSessions(window: DateWindow): Promise<SessionSummary[]> {
    return this.sessions()
      .filter((session) => within(session, window))
      .map((session) => ({
        id: session.sourceId,
        startedAt: session.startedAt,
        exerciseName: session.exerciseName,
        athleteRef: session.athleteRef,
        repCount: session.summary.count,
        bestS: session.summary.bestS,
      }))
  }

  async getSession(id: string): Promise<SprintSession> {
    const session = this.sessions().find((candidate) => candidate.sourceId === id)
    if (!session) throw new Error(`This export holds no session ${id}`)

    return session
  }

  async checkHealth(): Promise<HealthReport> {
    try {
      this.sessions()
      return { healthy: true }
    } catch (error) {
      return { healthy: false, reason: (error as Error).message }
    }
  }

  private sessions(): SprintSession[] {
    return readSessions(this.csv, this.options)
  }
}

function within(session: SprintSession, window: DateWindow): boolean {
  const day = session.startedAt.slice(0, 10)
  return day >= window.from && day <= window.to
}
