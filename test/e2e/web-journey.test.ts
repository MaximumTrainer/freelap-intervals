import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PgJobQueue } from '~/jobs/pg-job-queue'
import { Worker } from '~/jobs/worker'

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
    const webhook = await web.postJson('/webhooks/intervals-icu', {
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
