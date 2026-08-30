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

/** CSRF states for in-flight authorizations, kept in Postgres so any web node can finish the flow. */
export class PgOAuthStateStore implements OAuthStateStore {
  constructor(private readonly database: Database) {}

  async issue(userId: string, redirectUri: string): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url')

    await this.database.query('insert into oauth_states (state, user_id, redirect_uri) values ($1, $2, $3)', [
      state,
      userId,
      redirectUri,
    ])

    return state
  }

  async consume(state: string): Promise<IssuedState | null> {
    const { rows } = await this.database.query<{ user_id: string; redirect_uri: string }>(
      'delete from oauth_states where state = $1 returning user_id, redirect_uri',
      [state],
    )

    const row = rows[0]
    return row ? { userId: row.user_id, redirectUri: row.redirect_uri } : null
  }
}
