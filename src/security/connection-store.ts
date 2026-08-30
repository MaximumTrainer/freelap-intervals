import type { Database } from '~/db/database'
import { one } from '~/db/database'

import type { EnvelopeCipher } from './envelope-cipher'
import { Secret } from './secret'

export type Provider = 'intervals_icu' | 'myfreelap'
export type ConnectionStatus = 'active' | 'needs_reconnect' | 'degraded'

export interface IntervalsIcuTokens {
  readonly accessToken: Secret
  readonly refreshToken: Secret
  readonly expiresAt: string
  readonly athleteId: string
  readonly scopes: readonly string[]
}

export interface IntervalsIcuConnection {
  readonly userId: string
  readonly provider: 'intervals_icu'
  readonly status: ConnectionStatus
  readonly athleteId: string
  readonly scopes: readonly string[]
  readonly expiresAt: string | null
  readonly tokens: { readonly accessToken: Secret; readonly refreshToken: Secret }
}

export interface FreelapCredentials {
  readonly username: string
  readonly password: Secret
}

export interface FreelapConnection {
  readonly userId: string
  readonly provider: 'myfreelap'
  readonly status: ConnectionStatus
  readonly credentials: FreelapCredentials
}

interface ConnectionRow {
  readonly user_id: string
  readonly provider: Provider
  readonly external_account_id: string | null
  readonly scopes: string[]
  readonly secret_envelope: string
  readonly expires_at: Date | string | null
  readonly status: ConnectionStatus
}

/**
 * Every credential this integration holds, sealed before it reaches the database and opened only
 * when a call is about to be made. Disconnecting deletes the row outright rather than flagging it.
 */
export class ConnectionStore {
  constructor(
    private readonly database: Database,
    private readonly cipher: EnvelopeCipher,
  ) {}

  async saveIntervalsIcu(userId: string, tokens: IntervalsIcuTokens): Promise<void> {
    const envelope = await this.cipher.seal(
      JSON.stringify({ accessToken: tokens.accessToken.reveal(), refreshToken: tokens.refreshToken.reveal() }),
    )

    await this.upsert({
      userId,
      provider: 'intervals_icu',
      envelope,
      externalAccountId: tokens.athleteId,
      scopes: [...tokens.scopes],
      expiresAt: tokens.expiresAt,
    })
  }

  async findIntervalsIcu(userId: string): Promise<IntervalsIcuConnection | null> {
    const row = await this.findRow(userId, 'intervals_icu')
    if (!row) return null

    const sealed = JSON.parse((await this.cipher.open(row.secret_envelope)).reveal()) as {
      accessToken: string
      refreshToken: string
    }

    return {
      userId: row.user_id,
      provider: 'intervals_icu',
      status: row.status,
      athleteId: row.external_account_id ?? '',
      scopes: row.scopes,
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      tokens: { accessToken: new Secret(sealed.accessToken), refreshToken: new Secret(sealed.refreshToken) },
    }
  }

  async saveFreelap(userId: string, credentials: FreelapCredentials): Promise<void> {
    const envelope = await this.cipher.seal(
      JSON.stringify({ username: credentials.username, password: credentials.password.reveal() }),
    )

    await this.upsert({ userId, provider: 'myfreelap', envelope, externalAccountId: credentials.username })
  }

  async findFreelap(userId: string): Promise<FreelapConnection | null> {
    const row = await this.findRow(userId, 'myfreelap')
    if (!row) return null

    const sealed = JSON.parse((await this.cipher.open(row.secret_envelope)).reveal()) as {
      username: string
      password: string
    }

    return {
      userId: row.user_id,
      provider: 'myfreelap',
      status: row.status,
      credentials: { username: sealed.username, password: new Secret(sealed.password) },
    }
  }

  async markStatus(userId: string, provider: Provider, status: ConnectionStatus): Promise<void> {
    await this.database.query(
      'update connections set status = $3, updated_at = now() where user_id = $1 and provider = $2',
      [userId, provider, status],
    )
  }

  /** Disconnecting is a deletion: nothing about the credential is kept. */
  async disconnect(userId: string, provider: Provider): Promise<void> {
    await this.database.query('delete from connections where user_id = $1 and provider = $2', [userId, provider])
  }

  /** Re-seals every stored secret under the current master key. Returns how many were rotated. */
  async resealAll(): Promise<number> {
    const { rows } = await this.database.query<{ user_id: string; provider: Provider; secret_envelope: string }>(
      'select user_id, provider, secret_envelope from connections where secret_envelope is not null',
    )

    for (const row of rows) {
      await this.database.query(
        'update connections set secret_envelope = $3, updated_at = now() where user_id = $1 and provider = $2',
        [row.user_id, row.provider, await this.cipher.reseal(row.secret_envelope)],
      )
    }

    return rows.length
  }

  private async findRow(userId: string, provider: Provider): Promise<ConnectionRow | null> {
    return one<ConnectionRow>(
      this.database,
      `select user_id, provider, external_account_id, scopes, secret_envelope, expires_at, status
         from connections where user_id = $1 and provider = $2`,
      [userId, provider],
    )
  }

  private async upsert(connection: {
    userId: string
    provider: Provider
    envelope: string
    externalAccountId?: string
    scopes?: string[]
    expiresAt?: string
  }): Promise<void> {
    await this.database.query(
      `insert into connections (user_id, provider, external_account_id, scopes, secret_envelope, expires_at, status)
       values ($1, $2, $3, $4, $5, $6, 'active')
       on conflict (user_id, provider) do update set
         external_account_id = excluded.external_account_id,
         scopes              = excluded.scopes,
         secret_envelope     = excluded.secret_envelope,
         expires_at          = excluded.expires_at,
         status              = 'active',
         updated_at          = now()`,
      [
        connection.userId,
        connection.provider,
        connection.externalAccountId ?? null,
        connection.scopes ?? [],
        connection.envelope,
        connection.expiresAt ?? null,
      ],
    )
  }
}
