import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildRuntime, configFromEnvironment } from '~/config'
import { createWebApp } from '~/web/web-app'

import type { TestDatabase } from '../support/test-database'
import { aTestDatabase } from '../support/test-database'

const aCompleteEnvironment = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://localhost/freelap',
  SESSION_COOKIE_SECRET: 'cookie-secret',
  INTERVALS_ICU_CLIENT_ID: 'client-id',
  INTERVALS_ICU_CLIENT_SECRET: 'client-secret',
  INTERVALS_ICU_REDIRECT_URI: 'https://sync.example/oauth/callback',
})

describe('configFromEnvironment', () => {
  it('reads everything the app needs to run', () => {
    const config = configFromEnvironment({ ...aCompleteEnvironment(), PORT: '8080', FREELAP_TIMEZONE: 'Europe/London' })

    expect(config).toMatchObject({
      databaseUrl: 'postgres://localhost/freelap',
      port: 8080,
      timezone: 'Europe/London',
      oauth: { clientId: 'client-id', redirectUri: 'https://sync.example/oauth/callback' },
      flags: { myfreelapWebAdapter: false },
    })
  })

  it('names the setting that is missing, rather than failing later', () => {
    const incomplete = aCompleteEnvironment()
    delete incomplete.INTERVALS_ICU_CLIENT_SECRET

    expect(() => configFromEnvironment(incomplete)).toThrow(/INTERVALS_ICU_CLIENT_SECRET must be set/)
  })

  it('keeps the unofficial MyFreelap adapter off unless an operator turns it on', () => {
    expect(configFromEnvironment(aCompleteEnvironment()).flags.myfreelapWebAdapter).toBe(false)
    expect(
      configFromEnvironment({ ...aCompleteEnvironment(), FREELAP_WEB_ADAPTER: 'on' }).flags.myfreelapWebAdapter,
    ).toBe(true)
  })
})

describe('buildRuntime', () => {
  let database: TestDatabase
  let previousKeys: string | undefined

  beforeEach(async () => {
    database = await aTestDatabase()
    previousKeys = process.env.FREELAP_MASTER_KEYS
    process.env.FREELAP_MASTER_KEYS = `key-1:${randomBytes(32).toString('base64')}`
  })

  afterEach(async () => {
    if (previousKeys === undefined) delete process.env.FREELAP_MASTER_KEYS
    else process.env.FREELAP_MASTER_KEYS = previousKeys
    await database.close()
  })

  it('assembles a web app that runs', async () => {
    const runtime = buildRuntime(configFromEnvironment(aCompleteEnvironment()), database)
    const server = createServer(createWebApp(runtime.web))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`

    try {
      expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok')

      const signedIn = await fetch(`${base}/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'athlete@example.com' }).toString(),
        redirect: 'manual',
      })

      expect(signedIn.status).toBe(302)
      expect(signedIn.headers.get('set-cookie')).toMatch(/freelap_session=/)
      expect((await database.query('select email from users')).rows).toEqual([{ email: 'athlete@example.com' }])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('refuses to start without master keys for the secret store', () => {
    delete process.env.FREELAP_MASTER_KEYS

    expect(() => buildRuntime(configFromEnvironment(aCompleteEnvironment()), database)).toThrow(
      /FREELAP_MASTER_KEYS/,
    )
  })
})
