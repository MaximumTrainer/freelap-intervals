import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OAuthClient } from '~/auth/oauth-client'
import { PgJobQueue } from '~/jobs/pg-job-queue'
import { Worker } from '~/jobs/worker'
import { buildRouter, WEBHOOK_ROUTE_PATTERN } from '~/web/web-app'

import { FakeIntervalsIcuServer } from '../support/fake-intervals-icu-server'
import { csvFixture } from '../support/fixtures'
import type { RunningWebApp } from '../support/test-web-app'
import { startTestWebApp } from '../support/test-web-app'
import { oneHzStreams } from '../support/streams'

describe('the athlete journey through the web app', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('connects intervals.icu, imports an export, reviews the match, syncs it and verifies it', async () => {
    await web.signIn('athlete@example.com')

    // --- connect ---------------------------------------------------------
    const authorize = await web.get('/connect/intervals-icu', { redirect: 'manual' })
    const authorizeUrl = new URL(authorize.headers.get('location') ?? '')
    expect(authorizeUrl.pathname).toBe('/oauth/authorize')
    expect(authorizeUrl.searchParams.get('scope')).toBe('ACTIVITY:READ ACTIVITY:WRITE')

    const callback = await web.get(
      `/oauth/callback?code=auth-code&state=${authorizeUrl.searchParams.get('state')}`,
      { redirect: 'manual' },
    )
    expect(callback.status).toBe(302)

    const dashboard = await web.text('/')
    expect(dashboard).toContain('intervals.icu connected')

    // --- import ----------------------------------------------------------
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))

    const imported = await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    expect(imported.status).toBe(302)

    const sessions = await web.text('/')
    expect(sessions).toContain('Flying 30m')
    const sourceId = /csv-[0-9a-f]{12}/.exec(sessions)?.[0] ?? ''

    // --- review ----------------------------------------------------------
    const review = await web.text(`/sessions/${sourceId}/review`)
    expect(review).toContain('Morning Run')
    expect(review).toContain('same day, same sport, overlaps the session')
    expect(review).toContain('name="offsetS"') // the offset slider
    expect(review).toContain('data-preview') // the stream preview

    // --- sync ------------------------------------------------------------
    const queued = await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1', offsetS: '0' })
    expect(queued.status).toBe(302)
    expect(await web.text(`/sessions/${sourceId}`)).toContain('Queued')

    expect(await web.runWorker()).toBe(1)

    const synced = await web.text(`/sessions/${sourceId}`)
    expect(synced).toContain('Verification: pass')
    expect(synced).toContain('a1')
    expect(icu.icu.intervalsOf('a1')).toHaveLength(6)
  })

  it('shows the drift when the activity is edited on intervals.icu, and repairs it on re-sync', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''
    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    await icu.icu.putIntervals('a1', [])
    await web.post(`/sessions/${sourceId}/verify`, {})
    await web.runWorker()

    const drifted = await web.text(`/sessions/${sourceId}`)
    expect(drifted).toContain('Verification: fail')
    expect(drifted).toContain('interval count')

    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    expect(await web.text(`/sessions/${sourceId}`)).toContain('Verification: pass')
  })

  it('re-verifies an activity when intervals.icu says it changed', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''
    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    await icu.icu.updateActivity('a1', { description: 'the athlete rewrote this' })
    const webhook = await web.webhook({
      athlete_id: icu.icu.athleteId,
      activity_id: 'a1',
      type: 'ACTIVITY_UPDATED',
    })

    expect(webhook.status).toBe(202)
    expect(await web.runWorker()).toBe(1)
    expect(await web.text(`/sessions/${sourceId}`)).toContain('Drifted')
  })

  it('turns an athlete away from another athlete\'s session', async () => {
    await web.signInAndConnect('athlete@example.com')
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''

    await web.signIn('someone-else@example.com')

    expect((await web.get(`/sessions/${sourceId}`)).status).toBe(404)
  })

  it('asks anyone who is not signed in to sign in', async () => {
    expect((await web.get('/', { redirect: 'manual' })).status).toBe(302)
    expect((await web.get('/sessions/csv-anything', { redirect: 'manual' })).headers.get('location')).toBe('/sign-in')
  })

  it('wipes MyFreelap credentials the moment the athlete disconnects', async () => {
    await web.signInAndConnect('athlete@example.com')

    await web.post('/connect/myfreelap', { username: 'dan@example.com', password: 'hunter2' })
    expect(await web.text('/')).toContain('MyFreelap connected')

    await web.post('/disconnect/myfreelap', {})

    expect(await web.text('/')).not.toContain('MyFreelap connected')
    const { rows } = await web.database.query('select 1 from connections where provider = $1', ['myfreelap'])
    expect(rows).toEqual([])
  })

  it('deletes everything it holds when the athlete asks it to', async () => {
    await web.signInAndConnect('athlete@example.com')
    await web.post('/connect/myfreelap', { username: 'dan@example.com', password: 'hunter2' })
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''
    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    const purge = await web.post('/account/purge', { confirm: 'delete' })

    expect(purge.status).toBe(302)
    for (const table of ['users', 'connections', 'sprint_sessions', 'syncs', 'verifications']) {
      const { rows } = await web.database.query(`select 1 from ${table}`)
      expect({ table, rows }).toEqual({ table, rows: [] })
    }

    // The audit trail outlives the account it belonged to, with the athlete no longer named.
    const audit = await web.database.query<{ user_id: string | null; action: string }>(
      'select user_id, action from audit_log order by id desc limit 1',
    )
    expect(audit.rows[0]).toEqual({ user_id: null, action: 'account purged' })

    // What was written to intervals.icu is theirs, and stays where it is.
    expect(icu.icu.intervalsOf('a1')).toHaveLength(6)
  })

  it('asks about columns it does not recognise, once per export layout', async () => {
    await web.signInAndConnect('athlete@example.com')
    const withExtraColumns = [
      'Date;Time;Exercise;Run;Total time (s);Wind (m/s);Notes',
      '29/08/2026;10:14:03;Flying 30m;1;3,42;0,4;felt good',
      '29/08/2026;10:16:31;Flying 30m;2;3,38;0,4;better',
    ].join('\n')

    const imported = await web.upload('/sessions/import', withExtraColumns)

    // The sessions are imported either way; the athlete is then asked about the leftovers.
    expect(await web.text('/')).toContain('Flying 30m')
    const askedAbout = imported.headers.get('location') ?? ''
    expect(askedAbout).toMatch(/^\/imports\/[0-9a-f]{16}\/columns\?headers=/)

    const question = await web.text(askedAbout)
    expect(question).toContain('Wind (m/s)')
    expect(question).toContain('Notes')

    await web.post(askedAbout, { 'column:Notes': 'athlete' })

    // Next time the same layout arrives, the answer is remembered without asking again.
    const second = await web.upload('/sessions/import', withExtraColumns.replace('felt good', 'Dan Wood'))
    expect(second.headers.get('location')).toMatch(/columns\?headers=/) // Wind is still unexplained

    const athletes = await web.database.query<{ athlete_ref: string }>('select athlete_ref from sprint_sessions')
    expect(athletes.rows.map((row) => row.athlete_ref)).toContain('Dan Wood')
  })

  it('records every write it made to intervals.icu', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''
    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    const trail = await web.text('/audit')
    expect(trail).toContain('intervals.icu putIntervals')
    expect(trail).toContain('intervals.icu setCustomFields')
    expect(trail).toContain('intervals.icu updateActivity')
  })
})

describe('the worker', () => {
  it('retries a sync that failed for a reason that may pass', async () => {
    const icu = await FakeIntervalsIcuServer.start()
    const web = await startTestWebApp({ icu })

    try {
      await web.signInAndConnect('athlete@example.com')
      icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
      await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
      const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''

      // Enough failures to outlast the client's own retries, so the queue has to step in.
      icu.icu.failNextCallWith(503, 'intervals.icu is down')
      icu.icu.failNextCallWith(503, 'intervals.icu is down')
      await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })

      const firstPass = new Worker(web.queue, web.handlers, { baseRetryMs: 60_000 })
      await firstPass.runOnce()

      expect(await web.text(`/sessions/${sourceId}`)).toMatch(/Queued|Failed/)
      expect(icu.icu.activityCount).toBe(1) // nothing half-written

      // Later on, the retry falls due and intervals.icu is answering again.
      const laterQueue = new PgJobQueue(web.database, { now: () => new Date(Date.now() + 5 * 60_000) })
      await new Worker(laterQueue, web.handlers).runUntilIdle()

      expect(await web.text(`/sessions/${sourceId}`)).toContain('Verification: pass')
    } finally {
      await web.close()
      await icu.stop()
    }
  })
})

describe('CSRF enforcement', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('rejects a POST /account/purge with no CSRF token and writes an audit row', async () => {
    await web.signInAndConnect('athlete@example.com')
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))

    const purge = await web.postWithoutCsrf('/account/purge', { confirm: 'delete' })

    expect(purge.status).toBe(403)
    expect(await purge.text()).toContain('Request rejected')

    const { rows } = await web.database.query<{ action: string }>(
      "select action from audit_log where action = 'csrf rejected'",
    )
    expect(rows).toHaveLength(1)

    const users = await web.database.query('select 1 from users')
    expect(users.rows.length).toBeGreaterThan(0)
  })

  it('rejects a sync POST with a CSRF token from a different session', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''

    const sync = await web.postWithWrongCsrf(
      `/sessions/${sourceId}/sync`,
      { activityId: 'a1' },
    )

    expect(sync.status).toBe(403)

    const jobs = await web.database.query('select 1 from jobs')
    expect(jobs.rows).toEqual([])
  })

  it('rejects a sign-in POST without a valid CSRF token', async () => {
    const response = await web.postWithoutCsrf('/sign-in', { email: 'attacker@evil.com' })

    expect(response.status).toBe(403)

    const users = await web.database.query('select 1 from users')
    expect(users.rows).toEqual([])
  })

  it('lets a webhook through without a CSRF token', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''
    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    const webhook = await web.webhook({
      athlete_id: icu.icu.athleteId,
      activity_id: 'a1',
      type: 'ACTIVITY_UPDATED',
    })

    expect(webhook.status).toBe(202)
  })
})

describe('webhook authentication (S2)', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('accepts a request with the correct URL secret and enqueues a verify job', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''
    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    const response = await web.webhook({
      athlete_id: icu.icu.athleteId,
      activity_id: 'a1',
      type: 'ACTIVITY_UPDATED',
    })

    expect(response.status).toBe(202)

    const jobs = await web.database.query("select 1 from jobs where kind = 'verify-session'")
    expect(jobs.rows).toHaveLength(1)
  })

  it('returns 404 for a wrong secret and writes an audit row', async () => {
    const response = await web.webhookWithWrongSecret({
      athlete_id: 'athlete-1',
      activity_id: 'a1',
      type: 'ACTIVITY_UPDATED',
    })

    expect(response.status).toBe(404)

    const { rows } = await web.database.query<{ action: string; detail: { reason: string } }>(
      "select action, detail from audit_log where action = 'webhook rejected'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail.reason).toBe('bad secret')
  })

  it('returns the same 202 for unmatched and matched events', async () => {
    const unmatched = await web.webhook({
      athlete_id: 'nobody',
      activity_id: 'a999',
      type: 'ACTIVITY_UPDATED',
    })

    expect(unmatched.status).toBe(202)
    expect(await unmatched.text()).toBe('{"accepted":true}')
  })

  it('coalesces repeated events for the same activity within the dedup window', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''
    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    const event = {
      athlete_id: icu.icu.athleteId,
      activity_id: 'a1',
      type: 'ACTIVITY_UPDATED',
    }

    await web.webhook(event)
    await web.webhook(event)
    await web.webhook(event)

    const jobs = await web.database.query("select 1 from jobs where kind = 'verify-session'")
    expect(jobs.rows).toHaveLength(1)
  })
})

describe('body size cap (S5)', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('accepts a CSV under the default 5 MB cap and imports it', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))

    const imported = await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))

    expect(imported.status).toBe(302)
    expect(await web.text('/')).toContain('Flying 30m')
  })

  it('rejects a webhook body over the 64 KB route cap with JSON 413', async () => {
    const bigPayload = { data: 'x'.repeat(70_000) }

    const response = await web.webhook(bigPayload)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload too large' })
  })

  it('does not enqueue a job for a rejected webhook', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''
    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    const response = await web.webhook({ data: 'x'.repeat(70_000) })

    expect(response.status).toBe(413)

    const jobs = await web.database.query("select 1 from jobs where kind = 'verify-session'")
    expect(jobs.rows).toEqual([])
  })
})

describe('sign-out control (F7)', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('shows the email and sign-out form on signed-in pages, and landing on /sign-in after signing out', async () => {
    await web.signIn('athlete@example.com')

    const dashboard = await web.text('/')
    expect(dashboard).toContain('athlete@example.com')
    expect(dashboard).toContain('action="/sign-out"')
    expect(dashboard).toContain('Sign out')

    const signOut = await web.post('/sign-out', {})
    expect(signOut.status).toBe(302)
    expect(signOut.headers.get('location')).toBe('/sign-in')

    const afterSignOut = await web.get('/', { redirect: 'manual' })
    expect(afterSignOut.status).toBe(302)
    expect(afterSignOut.headers.get('location')).toBe('/sign-in')
  })

  it('does not show the sign-out control on the sign-in page', async () => {
    const signInHtml = await (await web.get('/sign-in')).text()
    expect(signInHtml).not.toContain('action="/sign-out"')
  })
})

describe('no-streams guard (C7)', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('warns on the review page when the recommended activity has no streams', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Manual Entry' })
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''

    const review = await web.text(`/sessions/${sourceId}/review`)

    expect(review).toContain('no recorded data to align')
  })

  it('offers Mode B on the session page after a no-streams failure', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Manual Entry' })
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''

    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    await web.runWorker()

    const sessionHtml = await web.text(`/sessions/${sourceId}`)

    expect(sessionHtml).toContain('Failed')
    expect(sessionHtml).toContain('Create a new activity instead')
  })
})

describe('structured logging and metrics (O3)', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('returns metrics at /metrics with a valid token and rejects without one', async () => {
    const forbidden = await web.get('/metrics')
    expect(forbidden.status).toBe(403)

    const metrics = await web.metrics()
    expect(metrics.status).toBe(200)
    expect(metrics.headers.get('content-type')).toContain('text/plain')
  })

  it('includes a request id header on every response', async () => {
    const response = await web.get('/healthz')
    const requestId = response.headers.get('x-request-id')

    expect(requestId).toBeTruthy()
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns a second unique request id on a subsequent request', async () => {
    const first = await web.get('/healthz')
    const second = await web.get('/healthz')

    const id1 = first.headers.get('x-request-id')
    const id2 = second.headers.get('x-request-id')

    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })

  it('includes sync outcome counters in /metrics after a successful sync', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''

    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1', offsetS: '0' })
    await web.runWorker()

    const metrics = await (await web.metrics()).text()
    expect(metrics).toContain('sync_outcomes_total')
    expect(metrics).toContain('result="success"')
    expect(metrics).toContain('sync_duration_seconds')
    expect(metrics).toContain('verification_results_total')
    expect(metrics).toContain('status="pass"')
  })

  it('reflects queue depth in /metrics when a job is waiting', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''

    await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })

    const before = await (await web.metrics()).text()
    expect(before).toContain('jobs_queued')
    expect(before).toMatch(/jobs_queued\s+1/)

    await web.runWorker()

    const after = await (await web.metrics()).text()
    expect(after).toMatch(/jobs_queued\s+0/)
  })

  it('passes the originating request id through to the job payload', async () => {
    await web.signInAndConnect('athlete@example.com')
    icu.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
    await web.upload('/sessions/import', csvFixture('flying-30m-semicolon.csv'))
    const sourceId = /csv-[0-9a-f]{12}/.exec(await web.text('/'))?.[0] ?? ''

    const syncResponse = await web.post(`/sessions/${sourceId}/sync`, { activityId: 'a1' })
    const originatingRequestId = syncResponse.headers.get('x-request-id')
    expect(originatingRequestId).toBeTruthy()

    const { rows } = await web.database.query<{ payload: Record<string, unknown> }>(
      "select payload from jobs where kind = 'sync-session' order by id desc limit 1",
    )
    expect(rows[0]!.payload.requestId).toBe(originatingRequestId)
  })
})

describe('OAuth scope display (F6)', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('shows the literal scopes from OAuthClient on the connect screen with a privacy link', async () => {
    await web.signIn('athlete@example.com')

    const dashboard = await web.text('/')
    const expectedScopes = new OAuthClient({
      clientId: 'unused', clientSecret: 'unused', redirectUri: 'unused',
    }).requestedScopes.join(' ')

    expect(dashboard).toContain(expectedScopes)
    expect(dashboard).toContain('href="/privacy"')
  })

  it('shows the same scope information on the reconnect screen', async () => {
    await web.signInAndConnect('athlete@example.com')

    const expectedScopes = new OAuthClient({
      clientId: 'unused', clientSecret: 'unused', redirectUri: 'unused',
    }).requestedScopes.join(' ')

    await web.database.query(
      "update connections set status = 'needs_reconnect' where provider = 'intervals_icu'",
    )

    const dashboard = await web.text('/')

    expect(dashboard).toContain('needs reconnecting')
    expect(dashboard).toContain(expectedScopes)
    expect(dashboard).toContain('href="/privacy"')
  })

  it('serves the privacy page at /privacy without requiring sign-in', async () => {
    const response = await web.get('/privacy')

    expect(response.status).toBe(200)

    const body = await response.text()
    expect(body).toContain('Privacy policy')
    expect(body).toContain('encrypted')
  })
})

describe('readiness probe (O2)', () => {
  let icu: FakeIntervalsIcuServer
  let web: RunningWebApp

  beforeEach(async () => {
    icu = await FakeIntervalsIcuServer.start()
    web = await startTestWebApp({ icu })
  })

  afterEach(async () => {
    await web.close()
    await icu.stop()
  })

  it('returns 200 when the database is reachable and migrations are current', async () => {
    const response = await web.get('/readyz')

    expect(response.status).toBe(200)
    const body = await response.json() as { status: string; migrations: string }
    expect(body.status).toBe('ready')
    expect(body.migrations).toBe('current')
  })
})

describe('CSRF route coverage', () => {
  it('every POST route is either CSRF-enforced or explicitly exempt', () => {
    const router = buildRouter()
    const postPaths = router.registeredPaths
      .filter((r) => r.method === 'POST')
      .map((r) => r.path)

    expect(postPaths.length).toBeGreaterThan(0)

    const exempt = postPaths.filter((p) => p === WEBHOOK_ROUTE_PATTERN)
    const enforced = postPaths.filter((p) => p !== WEBHOOK_ROUTE_PATTERN)

    expect(exempt).toEqual([WEBHOOK_ROUTE_PATTERN])
    expect(enforced.length).toBeGreaterThanOrEqual(4)
  })
})
