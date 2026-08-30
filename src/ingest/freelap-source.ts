import type { SprintSession } from '~/domain/sprint-session'

export interface SessionSummary {
  readonly id: string
  readonly startedAt: string
  readonly exerciseName: string
  readonly athleteRef: string
  readonly repCount: number
  readonly bestS: number
}

export interface DateWindow {
  readonly from: string
  readonly to: string
}

export interface HealthReport {
  readonly healthy: boolean
  readonly reason?: string
}

/**
 * Where sessions come from. The CSV export is the path that always works; the MyFreelap web
 * backend is unofficial, so every implementation must be able to say it has stopped working.
 */
export interface FreelapSource {
  readonly name: string
  listSessions(window: DateWindow): Promise<SessionSummary[]>
  getSession(id: string): Promise<SprintSession>
  checkHealth(): Promise<HealthReport>
}

/**
 * Raised when an unofficial source stops behaving as expected — a login wall, a layout change, a
 * shape we do not recognise. The athlete is asked for a CSV export instead, and maintainers are
 * alerted; nothing is guessed.
 */
export class AdapterDegradedError extends Error {
  constructor(
    readonly source: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`The ${source} adapter is degraded: ${reason}. Upload a CSV export instead.`, options)
    this.name = 'AdapterDegradedError'
  }
}
