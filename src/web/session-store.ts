import type { Database } from '~/db/database'

export interface SessionRecord {
  readonly id: string
  readonly userId: string
}

/** Server-side session records that back the session cookie, so individual cookies can be revoked. */
export interface SessionStore {
  create(userId: string): Promise<string>
  validate(sessionId: string): Promise<SessionRecord | null>
  touch(sessionId: string): Promise<void>
  revoke(sessionId: string): Promise<void>
  revokeAllForUser(userId: string): Promise<void>
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TOUCH_THROTTLE_MS = 60 * 60 * 1000

export interface PgSessionStoreOptions {
  readonly now?: () => Date
  readonly maxAgeMs?: number
  readonly touchThrottleMs?: number
}

/** Sessions in Postgres, validated against expiry and revocation on every lookup. */
export class PgSessionStore implements SessionStore {
  private readonly now: () => Date
  private readonly maxAgeMs: number
  private readonly touchThrottleMs: number

  constructor(
    private readonly database: Database,
    options?: PgSessionStoreOptions,
  ) {
    this.now = options?.now ?? (() => new Date())
    this.maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.touchThrottleMs = options?.touchThrottleMs ?? TOUCH_THROTTLE_MS
  }

  async create(userId: string): Promise<string> {
    const now = this.now()
    const expiresAt = new Date(now.getTime() + this.maxAgeMs)

    const { rows } = await this.database.query<{ id: string }>(
      'insert into sessions (user_id, created_at, last_seen_at, expires_at) values ($1, $2, $2, $3) returning id',
      [userId, now.toISOString(), expiresAt.toISOString()],
    )

    return rows[0]!.id
  }

  async validate(sessionId: string): Promise<SessionRecord | null> {
    const now = this.now()

    const { rows } = await this.database.query<{ id: string; user_id: string }>(
      'select id, user_id from sessions where id = $1 and expires_at > $2 and revoked_at is null',
      [sessionId, now.toISOString()],
    )

    const row = rows[0]
    return row ? { id: row.id, userId: row.user_id } : null
  }

  async touch(sessionId: string): Promise<void> {
    const now = this.now()
    const threshold = new Date(now.getTime() - this.touchThrottleMs)

    await this.database.query(
      'update sessions set last_seen_at = $2 where id = $1 and last_seen_at < $3',
      [sessionId, now.toISOString(), threshold.toISOString()],
    )
  }

  async revoke(sessionId: string): Promise<void> {
    await this.database.query(
      'update sessions set revoked_at = $1 where id = $2 and revoked_at is null',
      [this.now().toISOString(), sessionId],
    )
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.database.query(
      'update sessions set revoked_at = $1 where user_id = $2 and revoked_at is null',
      [this.now().toISOString(), userId],
    )
  }
}
