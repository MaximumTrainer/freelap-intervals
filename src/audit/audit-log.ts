export interface AuditEntry {
  readonly action: string
  readonly target: string | null
  readonly outcome: 'ok' | 'error'
  readonly statusCode: number | null
  readonly detail: Readonly<Record<string, unknown>>
  readonly at: string
}

export type NewAuditEntry = Omit<AuditEntry, 'at'>

/** A record of everything this integration does to somebody else's system, on whose behalf. */
export interface AuditLog {
  record(userId: string | null, entry: NewAuditEntry): Promise<void>
  recent(userId: string, limit?: number): Promise<AuditEntry[]>
}

export class InMemoryAuditLog implements AuditLog {
  private readonly entries: Array<{ userId: string | null; entry: AuditEntry }> = []

  async record(userId: string | null, entry: NewAuditEntry): Promise<void> {
    this.entries.push({ userId, entry: { ...entry, at: new Date().toISOString() } })
  }

  async recent(userId: string, limit = 50): Promise<AuditEntry[]> {
    return this.entries
      .filter((row) => row.userId === userId)
      .slice(-limit)
      .reverse()
      .map((row) => row.entry)
  }
}
