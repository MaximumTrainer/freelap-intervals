import type { Database } from '~/db/database'

import type { AuditEntry, AuditLog, NewAuditEntry } from './audit-log'

interface AuditRow {
  readonly action: string
  readonly target: string | null
  readonly outcome: 'ok' | 'error'
  readonly status_code: number | null
  readonly detail: Record<string, unknown>
  readonly at: Date | string
}

/** The audit trail in Postgres, newest first. Rows outlive the user row they point at. */
export class PgAuditLog implements AuditLog {
  constructor(private readonly database: Database) {}

  async record(userId: string | null, entry: NewAuditEntry): Promise<void> {
    await this.database.query(
      'insert into audit_log (user_id, action, target, outcome, status_code, detail) values ($1, $2, $3, $4, $5, $6)',
      [userId, entry.action, entry.target, entry.outcome, entry.statusCode, JSON.stringify(entry.detail)],
    )
  }

  async recent(userId: string, limit = 50): Promise<AuditEntry[]> {
    const { rows } = await this.database.query<AuditRow>(
      `select action, target, outcome, status_code, detail, at
         from audit_log where user_id = $1 order by id desc limit $2`,
      [userId, limit],
    )

    return rows.map((row) => ({
      action: row.action,
      target: row.target,
      outcome: row.outcome,
      statusCode: row.status_code,
      detail: row.detail,
      at: new Date(row.at).toISOString(),
    }))
  }
}
