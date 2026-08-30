import type { IntervalsIcuTokens } from '~/security/connection-store'
import { Secret } from '~/security/secret'

export interface OAuthClientOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly scopes?: readonly string[]
  readonly authorizeUrl?: string
  readonly tokenUrl?: string
  readonly fetch?: typeof fetch
}

export interface RefreshableTokens {
  readonly refreshToken: Secret
  readonly athleteId: string
  readonly scopes: readonly string[]
}

interface TokenResponse {
  readonly access_token?: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly athlete_id?: string | number
  readonly scope?: string
  readonly error?: string
}

/** Raised when only the athlete can put things right by authorising the app again. */
export class ReconnectRequiredError extends Error {
  constructor(reason: string) {
    super(`intervals.icu must be connected again: ${reason}`)
    this.name = 'ReconnectRequiredError'
  }
}

const DEFAULT_AUTHORIZE_URL = 'https://intervals.icu/oauth/authorize'
const DEFAULT_TOKEN_URL = 'https://intervals.icu/api/oauth/token'
/** The least this integration can work with: read activities, write intervals and fields. */
const DEFAULT_SCOPES = ['ACTIVITY:READ', 'ACTIVITY:WRITE']
const UNRECOVERABLE = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'])

/** The intervals.icu OAuth 2.0 authorization-code flow, and the refresh that keeps it alive. */
export class OAuthClient {
  private readonly http: typeof fetch

  constructor(private readonly options: OAuthClientOptions) {
    this.http = options.fetch ?? globalThis.fetch
  }

  authorizeUrl(state: string): string {
    const url = new URL(this.options.authorizeUrl ?? DEFAULT_AUTHORIZE_URL)
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      scope: this.scopes().join(' '),
      state,
    }).toString()

    return url.toString()
  }

  async exchangeCode(code: string, now = new Date()): Promise<IntervalsIcuTokens> {
    const response = await this.postToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
    })

    return this.toTokens(response, now, { scopes: this.scopes() })
  }

  async refresh(existing: RefreshableTokens, now = new Date()): Promise<IntervalsIcuTokens> {
    const response = await this.postToken({
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken.reveal(),
    })

    return this.toTokens(response, now, {
      fallbackRefreshToken: existing.refreshToken,
      athleteId: existing.athleteId,
      scopes: existing.scopes,
    })
  }

  private scopes(): string[] {
    return [...(this.options.scopes ?? DEFAULT_SCOPES)]
  }

  private async postToken(fields: Record<string, string>): Promise<TokenResponse> {
    const response = await this.http(this.options.tokenUrl ?? DEFAULT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        ...fields,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
    })

    const body = (await response.json().catch(() => ({}))) as TokenResponse

    if (!response.ok || body.error) {
      const reason = body.error ?? `the token endpoint answered ${response.status}`
      if (UNRECOVERABLE.has(reason)) throw new ReconnectRequiredError(reason)

      throw new Error(`intervals.icu token request failed: ${reason}`)
    }

    return body
  }

  private toTokens(
    response: TokenResponse,
    now: Date,
    context: { fallbackRefreshToken?: Secret; athleteId?: string; scopes: readonly string[] },
  ): IntervalsIcuTokens {
    const accessToken = response.access_token
    if (!accessToken) throw new ReconnectRequiredError('the token endpoint returned no access token')

    const refreshToken = response.refresh_token ? new Secret(response.refresh_token) : context.fallbackRefreshToken
    if (!refreshToken) throw new ReconnectRequiredError('the token endpoint returned no refresh token')

    return {
      accessToken: new Secret(accessToken),
      refreshToken,
      expiresAt: new Date(now.getTime() + (response.expires_in ?? 0) * 1000).toISOString(),
      athleteId: String(response.athlete_id ?? context.athleteId ?? ''),
      scopes: response.scope ? response.scope.split(/[\s,]+/).filter(Boolean) : [...context.scopes],
    }
  }
}
