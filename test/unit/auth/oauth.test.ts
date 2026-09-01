import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OAuthClient, ReconnectRequiredError } from '~/auth/oauth-client'
import { OAuthCredentialSource } from '~/auth/oauth-credential-source'
import { PgOAuthStateStore } from '~/auth/oauth-state-store'
import { ConnectionStore } from '~/security/connection-store'
import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
import { Secret } from '~/security/secret'

import { StubFetch } from '../../support/stub-fetch'
import type { TestDatabase } from '../../support/test-database'
import { aTestDatabase } from '../../support/test-database'

const anOAuthClient = (http: StubFetch): OAuthClient =>
  new OAuthClient({
    clientId: 'freelap-sync',
    clientSecret: 'client-secret',
    redirectUri: 'https://sync.example/oauth/callback',
    fetch: http.fetch,
  })

describe('OAuthClient', () => {
  it('sends the athlete to intervals.icu with the minimum scopes and a CSRF state', () => {
    const url = new URL(anOAuthClient(new StubFetch()).authorizeUrl('state-123'))

    expect(url.origin + url.pathname).toBe('https://intervals.icu/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'freelap-sync',
      redirect_uri: 'https://sync.example/oauth/callback',
      response_type: 'code',
      scope: 'ACTIVITY:READ ACTIVITY:WRITE',
      state: 'state-123',
    })
  })

  it('exchanges the returned code for tokens', async () => {
    const http = new StubFetch().respondWith({
      status: 200,
      body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, athlete_id: 'i999', scope: 'ACTIVITY:READ ACTIVITY:WRITE' },
    })

    const tokens = await anOAuthClient(http).exchangeCode('auth-code', new Date('2026-08-29T12:00:00Z'))

    expect(http.lastRequest()).toMatchObject({ method: 'POST', url: 'https://intervals.icu/api/oauth/token' })
    expect(new URLSearchParams(String(http.lastRequest().body)).get('grant_type')).toBe('authorization_code')
    expect(tokens).toEqual({
      accessToken: new Secret('access-1'),
      refreshToken: new Secret('refresh-1'),
      expiresAt: '2026-08-29T13:00:00.000Z',
      athleteId: 'i999',
      scopes: ['ACTIVITY:READ', 'ACTIVITY:WRITE'],
    })
  })

  it('refreshes an expiring token, keeping the old refresh token when none comes back', async () => {
    const http = new StubFetch().respondWith({ status: 200, body: { access_token: 'access-2', expires_in: 3600 } })

    const tokens = await anOAuthClient(http).refresh(
      { refreshToken: new Secret('refresh-1'), athleteId: 'i999', scopes: ['ACTIVITY:READ'] },
      new Date('2026-08-29T12:00:00Z'),
    )

    expect(new URLSearchParams(String(http.lastRequest().body)).get('grant_type')).toBe('refresh_token')
    expect(tokens.accessToken).toEqual(new Secret('access-2'))
    expect(tokens.refreshToken).toEqual(new Secret('refresh-1'))
  })

  it('asks the athlete to reconnect when the refresh token has been revoked', async () => {
    const http = new StubFetch().respondWith({ status: 400, body: { error: 'invalid_grant' } })

    await expect(
      anOAuthClient(http).refresh({ refreshToken: new Secret('gone'), athleteId: 'i999', scopes: [] }, new Date()),
    ).rejects.toBeInstanceOf(ReconnectRequiredError)
  })
})

describe('PgOAuthStateStore', () => {
  let database: TestDatabase
  let userId: string
  let states: PgOAuthStateStore

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
    states = new PgOAuthStateStore(database)
  })

  afterEach(async () => {
    await database.close()
  })

  it('issues an unguessable state and remembers where to return the athlete', async () => {
    const state = await states.issue(userId, '/sessions')

    expect(state).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(await states.consume(state)).toEqual({ userId, redirectUri: '/sessions' })
  })

  it('lets a state be used exactly once', async () => {
    const state = await states.issue(userId, '/sessions')
    await states.consume(state)

    expect(await states.consume(state)).toBeNull()
  })

  it('rejects a state it never issued', async () => {
    expect(await states.consume('made-up')).toBeNull()
  })

  it('rejects a state older than the configured TTL', async () => {
    let clock = new Date('2026-08-29T12:00:00Z')
    const timedStates = new PgOAuthStateStore(database, {
      now: () => clock,
      ttlMs: 10 * 60 * 1000,
    })

    const state = await timedStates.issue(userId, '/sessions')

    clock = new Date('2026-08-29T12:11:00Z')
    expect(await timedStates.consume(state)).toBeNull()
  })

  it('accepts a state just inside the TTL boundary', async () => {
    let clock = new Date('2026-08-29T12:00:00Z')
    const timedStates = new PgOAuthStateStore(database, {
      now: () => clock,
      ttlMs: 10 * 60 * 1000,
    })

    const state = await timedStates.issue(userId, '/sessions')

    clock = new Date('2026-08-29T12:09:00Z')
    expect(await timedStates.consume(state)).toEqual({ userId, redirectUri: '/sessions' })
  })
})

describe('OAuthCredentialSource', () => {
  let database: TestDatabase
  let userId: string
  let connections: ConnectionStore

  const storedTokens = (expiresAt: string) => ({
    accessToken: new Secret('access-1'),
    refreshToken: new Secret('refresh-1'),
    expiresAt,
    athleteId: 'i999',
    scopes: ['ACTIVITY:READ'],
  })

  beforeEach(async () => {
    database = await aTestDatabase()
    userId = await database.givenUser('athlete@example.com')
    connections = new ConnectionStore(database, new EnvelopeCipher(LocalKeyManagementService.forTesting()))
  })

  afterEach(async () => {
    await database.close()
  })

  const aCredentialSource = (http: StubFetch, now: string): OAuthCredentialSource =>
    new OAuthCredentialSource({
      userId,
      connections,
      oauth: anOAuthClient(http),
      now: () => new Date(now),
    })

  it('offers the stored access token as a bearer credential', async () => {
    await connections.saveIntervalsIcu(userId, storedTokens('2026-08-29T13:00:00.000Z'))

    const credentials = await aCredentialSource(new StubFetch(), '2026-08-29T12:00:00Z').current()

    expect(credentials).toEqual({ kind: 'oauth', accessToken: 'access-1' })
  })

  it('refreshes before the token expires rather than after it fails', async () => {
    await connections.saveIntervalsIcu(userId, storedTokens('2026-08-29T12:02:00.000Z'))
    const http = new StubFetch().respondWith({ status: 200, body: { access_token: 'access-fresh', expires_in: 3600 } })

    const credentials = await aCredentialSource(http, '2026-08-29T12:00:00Z').current()

    expect(credentials).toEqual({ kind: 'oauth', accessToken: 'access-fresh' })
    expect((await connections.findIntervalsIcu(userId))?.tokens.accessToken.reveal()).toBe('access-fresh')
  })

  it('refreshes on demand after a rejected call', async () => {
    await connections.saveIntervalsIcu(userId, storedTokens('2026-08-29T14:00:00.000Z'))
    const http = new StubFetch().respondWith({ status: 200, body: { access_token: 'access-fresh', expires_in: 3600 } })
    const source = aCredentialSource(http, '2026-08-29T12:00:00Z')

    expect(await source.refresh()).toBe(true)
    expect(await source.current()).toEqual({ kind: 'oauth', accessToken: 'access-fresh' })
  })

  it('marks the connection for reconnection when the refresh is refused', async () => {
    await connections.saveIntervalsIcu(userId, storedTokens('2026-08-29T14:00:00.000Z'))
    const http = new StubFetch().respondWith({ status: 400, body: { error: 'invalid_grant' } })

    await expect(aCredentialSource(http, '2026-08-29T12:00:00Z').refresh()).rejects.toBeInstanceOf(ReconnectRequiredError)
    expect(await connections.findIntervalsIcu(userId)).toMatchObject({ status: 'needs_reconnect' })
  })

  it('asks an athlete who never connected to connect', async () => {
    await expect(aCredentialSource(new StubFetch(), '2026-08-29T12:00:00Z').current()).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    )
  })
})
