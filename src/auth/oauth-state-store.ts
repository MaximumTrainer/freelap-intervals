import { randomBytes } from 'node:crypto'

import type { Database } from '~/db/database'

export interface IssuedState {
  readonly userId: string
  readonly redirectUri: string
}

export interface OAuthStateStore {
  issue(userId: string, redirectUri: string): Promise<string>
  /** Returns the state's details and forgets it: a state is good for exactly one callback. */
  consume(state: string): Promise<IssuedState | null>
}

const STATE_BYTES = 24
const DEFAULT_TTL_MS = 10 * 60 * 1000

export interface OAuthStateStoreOptions {
  readonly now?: () => Date
  readonly ttlMs?: number
}

/** CSRF states for in-flight authorizations, kept in Postgres so any web node can finish the flow. */
export class PgOAuthStateStore implements OAuthStateStore {
  private readonly now: () => Date
  private readonly ttlMs: number

  constructor(database: Database, options?: OAuthStateStoreOptions) {
    this.database = database
    this.now = options?.now ?? (() => new Date())
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS
  }

  private readonly database: Database

  async issue(userId: string, redirectUri: string): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url')

    await this.database.query(
      'insert into oauth_states (state, user_id, redirect_uri, created_at) values ($1, $2, $3, $4)',
      [state, userId, redirectUri, this.now().toISOString()],
    )

    return state
  }

  async consume(state: string): Promise<IssuedState | null> {
    const cutoff = new Date(this.now().getTime() - this.ttlMs)

    const { rows } = await this.database.query<{ user_id: string; redirect_uri: string }>(
      'delete from oauth_states where state = $1 and created_at >= $2 returning user_id, redirect_uri',
      [state, cutoff.toISOString()],
    )

    const row = rows[0]
    return row ? { userId: row.user_id, redirectUri: row.redirect_uri } : null
  }

  /** Removes states older than the TTL — called by the retention job. */
  async sweepExpired(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.ttlMs)

    const { rows } = await this.database.query<{ count: string }>(
      'with deleted as (delete from oauth_states where created_at < $1 returning 1) select count(*)::text as count from deleted',
      [cutoff.toISOString()],
    )

    const row = rows[0]
    return row ? Number(row.count) : 0
  }
}
