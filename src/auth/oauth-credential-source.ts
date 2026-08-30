import type { Credentials, CredentialSource } from '~/icu/http-intervals-icu-client'
import type { ConnectionStore, IntervalsIcuConnection, IntervalsIcuTokens } from '~/security/connection-store'

import type { OAuthClient } from './oauth-client'
import { ReconnectRequiredError } from './oauth-client'

export interface OAuthCredentialSourceOptions {
  readonly userId: string
  readonly connections: ConnectionStore
  readonly oauth: OAuthClient
  readonly now?: () => Date
  /** How long before expiry to refresh, rather than waiting for a call to fail. */
  readonly refreshWindowMs?: number
}

const DEFAULT_REFRESH_WINDOW_MS = 5 * 60_000

/**
 * Supplies a live intervals.icu access token, refreshing it shortly before it expires and again if
 * a call is rejected. When the refresh token itself has gone, only the athlete can put it right,
 * so the connection is marked and the caller is told to ask them to reconnect.
 */
export class OAuthCredentialSource implements CredentialSource {
  private readonly now: () => Date
  private readonly refreshWindowMs: number

  constructor(private readonly options: OAuthCredentialSourceOptions) {
    this.now = options.now ?? (() => new Date())
    this.refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS
  }

  async current(): Promise<Credentials> {
    const connection = await this.requireConnection()

    return expiresSoon(connection, this.now(), this.refreshWindowMs)
      ? { kind: 'oauth', accessToken: (await this.renew(connection)).accessToken.reveal() }
      : { kind: 'oauth', accessToken: connection.tokens.accessToken.reveal() }
  }

  async refresh(): Promise<boolean> {
    await this.renew(await this.requireConnection())
    return true
  }

  private async renew(connection: IntervalsIcuConnection): Promise<IntervalsIcuTokens> {
    try {
      const tokens = await this.options.oauth.refresh(
        { refreshToken: connection.tokens.refreshToken, athleteId: connection.athleteId, scopes: connection.scopes },
        this.now(),
      )
      await this.options.connections.saveIntervalsIcu(this.options.userId, tokens)

      return tokens
    } catch (error) {
      if (error instanceof ReconnectRequiredError) {
        await this.options.connections.markStatus(this.options.userId, 'intervals_icu', 'needs_reconnect')
      }
      throw error
    }
  }

  private async requireConnection(): Promise<IntervalsIcuConnection> {
    const connection = await this.options.connections.findIntervalsIcu(this.options.userId)
    if (!connection) throw new ReconnectRequiredError('this athlete has not connected intervals.icu')
    if (connection.status === 'needs_reconnect') throw new ReconnectRequiredError('the last connection was rejected')

    return connection
  }
}

function expiresSoon(connection: IntervalsIcuConnection, now: Date, windowMs: number): boolean {
  return connection.expiresAt !== null && Date.parse(connection.expiresAt) - now.getTime() <= windowMs
}
