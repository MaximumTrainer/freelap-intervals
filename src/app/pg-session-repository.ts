import type { Database } from '~/db/database'
import { one } from '~/db/database'
import type { SprintSession } from '~/domain/sprint-session'

import type { SessionRepository } from './session-repository'

interface SessionRow {
  readonly payload: SprintSession
}

/**
 * Sessions in Postgres. The canonical session travels as the payload the rest of the system
 * already speaks; the columns beside it exist so sessions can be listed and searched.
 */
export class PgSessionRepository implements SessionRepository {
  constructor(
    private readonly database: Database,
    private readonly userId: string,
  ) {}

  async save(session: SprintSession): Promise<void> {
    await this.database.query(
      `insert into sprint_sessions
         (source_id, user_id, athlete_ref, started_at, sport, exercise_name, distance_m, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (source_id) do update set
         athlete_ref   = excluded.athlete_ref,
         started_at    = excluded.started_at,
         sport         = excluded.sport,
         exercise_name = excluded.exercise_name,
         distance_m    = excluded.distance_m,
         payload       = excluded.payload,
         imported_at   = now()`,
      [
        session.sourceId,
        this.userId,
        session.athleteRef,
        session.startedAt,
        session.sport,
        session.exerciseName,
        session.distanceM,
        JSON.stringify(session),
      ],
    )
  }

  async find(sourceId: string): Promise<SprintSession | null> {
    const row = await one<SessionRow>(
      this.database,
      'select payload from sprint_sessions where source_id = $1 and user_id = $2',
      [sourceId, this.userId],
    )

    return row?.payload ?? null
  }

  async all(): Promise<SprintSession[]> {
    const { rows } = await this.database.query<SessionRow>(
      'select payload from sprint_sessions where user_id = $1 order by started_at',
      [this.userId],
    )

    return rows.map((row) => row.payload)
  }
}
