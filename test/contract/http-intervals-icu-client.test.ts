import { describe, expect, it } from 'vitest'

import { HttpIntervalsIcuClient } from '~/icu/http-intervals-icu-client'
import { IntervalsIcuError } from '~/icu/intervals-icu-client'

import { StubFetch } from '../support/stub-fetch'

const withApiKey = (http: StubFetch) =>
  new HttpIntervalsIcuClient({ credentials: { kind: 'apiKey', key: 'secret-key' }, fetch: http.fetch })

const neverSleeps = { attempts: 3, baseDelayMs: 0, sleep: async (): Promise<void> => {} }

describe('authentication', () => {
  it('sends a personal API key as HTTP Basic under the API_KEY user', async () => {
    const http = new StubFetch().respondWith({ status: 200, body: { id: 'i1', name: 'Dan', timezone: 'Europe/London' } })

    await withApiKey(http).athlete('i1')

    expect(http.lastRequest().headers.authorization).toBe(`Basic ${btoa('API_KEY:secret-key')}`)
  })

  it('sends an OAuth access token as a bearer token', async () => {
    const http = new StubFetch().respondWith({ status: 200, body: { id: 'i1', name: 'Dan', timezone: 'UTC' } })
    const client = new HttpIntervalsIcuClient({
      credentials: { kind: 'oauth', accessToken: 'token-123' },
      fetch: http.fetch,
    })

    await client.athlete('i1')

    expect(http.lastRequest().headers.authorization).toBe('Bearer token-123')
  })
})

describe('reading activities', () => {
  it('asks for the athlete activities inside a date range', async () => {
    const http = new StubFetch().respondWith({ status: 200, body: [] })

    await withApiKey(http).listActivities('i1', { oldest: '2026-08-28', newest: '2026-08-30' })

    expect(http.lastRequest().url).toBe(
      'https://intervals.icu/api/v1/athlete/i1/activities?oldest=2026-08-28&newest=2026-08-30',
    )
  })

  it('reads the intervals out of the icu_intervals envelope', async () => {
    const http = new StubFetch().respondWith({
      status: 200,
      body: { icu_intervals: [{ type: 'WORK', start_index: 10, end_index: 13, label: 'FL #1 · 30m · 3.42s' }] },
    })

    const intervals = await withApiKey(http).getIntervals('a1')

    expect(intervals).toEqual([{ type: 'WORK', start_index: 10, end_index: 13, name: 'FL #1 · 30m · 3.42s' }])
  })

  it('turns the stream list into named streams', async () => {
    const http = new StubFetch().respondWith({
      status: 200,
      body: [
        { type: 'time', data: [0, 1, 2] },
        { type: 'distance', data: [0, 3, 6] },
        { type: 'velocity_smooth', data: [0, 3, 3] },
      ],
    })

    expect(await withApiKey(http).getStreams('a1')).toEqual({
      time: [0, 1, 2],
      distance: [0, 3, 6],
      velocity_smooth: [0, 3, 3],
    })
  })
})

describe('writing', () => {
  it('puts intervals back inside the icu_intervals envelope', async () => {
    const http = new StubFetch().respondWith({ status: 200, body: {} })

    await withApiKey(http).putIntervals('a1', [
      { type: 'WORK', start_index: 10, end_index: 13, name: 'FL #1 · 30m · 3.42s' },
    ])

    const request = http.lastRequest()
    expect(request.method).toBe('PUT')
    expect(request.url).toBe('https://intervals.icu/api/v1/activity/a1/intervals')
    expect(request.body).toEqual({
      icu_intervals: [{ type: 'WORK', start_index: 10, end_index: 13, label: 'FL #1 · 30m · 3.42s' }],
    })
  })

  it('uploads a FIT file as multipart form data and reads back the created activity', async () => {
    const http = new StubFetch().respondWith(
      { status: 200, body: { id: 'a7' } },
      { status: 200, body: { id: 'a7', start_date_local: '2026-08-29T10:14:03', type: 'Run', name: 'Flying 30m (Freelap)' } },
    )

    const created = await withApiKey(http).uploadActivity('i1', {
      filename: 'session.fit',
      bytes: Uint8Array.from([1, 2, 3]),
      name: 'Flying 30m (Freelap)',
      description: 'notes',
      externalId: 'freelap:csv-abc',
    })

    const upload = http.requests[0]!
    expect(upload.method).toBe('POST')
    expect(upload.url).toBe('https://intervals.icu/api/v1/athlete/i1/activities')
    expect(upload.formData?.get('name')).toBe('Flying 30m (Freelap)')
    expect(upload.formData?.get('description')).toBe('notes')
    expect(upload.formData?.get('external_id')).toBe('freelap:csv-abc')
    expect((upload.formData?.get('file') as File).name).toBe('session.fit')

    expect(http.requests[1]?.url).toBe('https://intervals.icu/api/v1/activity/a7')
    expect(created.id).toBe('a7')
  })

  it('creates only the custom fields the athlete does not already have', async () => {
    const http = new StubFetch().respondWith(
      { status: 200, body: [{ code: 'fl_best_s', name: 'Freelap best (s)', type: 'NUMBER' }] },
      { status: 200, body: {} },
    )

    await withApiKey(http).ensureCustomFields('i1', [
      { code: 'fl_best_s', name: 'Freelap best (s)', type: 'NUMBER' },
      { code: 'fl_avg_s', name: 'Freelap average (s)', type: 'NUMBER' },
    ])

    expect(http.requests).toHaveLength(2)
    expect(http.lastRequest()).toMatchObject({
      method: 'POST',
      url: 'https://intervals.icu/api/v1/athlete/i1/custom-item',
      body: { code: 'fl_avg_s', name: 'Freelap average (s)', type: 'NUMBER', target: 'ACTIVITY' },
    })
  })

  it('writes custom field values onto the activity by their code', async () => {
    const http = new StubFetch().respondWith({ status: 200, body: {} })

    await withApiKey(http).setCustomFields('a1', { fl_best_s: 3.35, fl_session_id: 'csv-abc' })

    expect(http.lastRequest()).toMatchObject({
      method: 'PUT',
      url: 'https://intervals.icu/api/v1/activity/a1',
      body: { fl_best_s: 3.35, fl_session_id: 'csv-abc' },
    })
  })
})

describe('failures', () => {
  it('retries a rate-limited request and succeeds on a later attempt', async () => {
    const http = new StubFetch().respondWith(
      { status: 429, body: { error: 'slow down' } },
      { status: 200, body: { id: 'i1', name: 'Dan', timezone: 'UTC' } },
    )
    const client = new HttpIntervalsIcuClient({
      credentials: { kind: 'apiKey', key: 'k' },
      fetch: http.fetch,
      retry: neverSleeps,
    })

    await expect(client.athlete('i1')).resolves.toMatchObject({ id: 'i1' })
    expect(http.requests).toHaveLength(2)
  })

  it('gives up after the configured number of attempts', async () => {
    const http = new StubFetch().respondWith(
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    )
    const client = new HttpIntervalsIcuClient({
      credentials: { kind: 'apiKey', key: 'k' },
      fetch: http.fetch,
      retry: neverSleeps,
    })

    await expect(client.athlete('i1')).rejects.toMatchObject({ status: 503, retryable: true })
    expect(http.requests).toHaveLength(3)
  })

  it('does not retry a rejected token, and says so', async () => {
    const http = new StubFetch().respondWith({ status: 401, body: { error: 'unauthorized' } })
    const client = new HttpIntervalsIcuClient({
      credentials: { kind: 'apiKey', key: 'k' },
      fetch: http.fetch,
      retry: neverSleeps,
    })

    const failure = await client.athlete('i1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(IntervalsIcuError)
    expect(failure).toMatchObject({ status: 401, retryable: false })
    expect(http.requests).toHaveLength(1)
  })
})

describe('refreshable credentials', () => {
  const aRenewingSource = (tokens: string[]) => ({
    issued: [] as string[],
    async current() {
      const token = tokens[0]!
      this.issued.push(token)
      return { kind: 'oauth' as const, accessToken: token }
    },
    async refresh() {
      if (tokens.length === 1) return false
      tokens.shift()
      return true
    },
  })

  it('retries a rejected call once with a freshly refreshed token', async () => {
    const http = new StubFetch().respondWith(
      { status: 401, body: { error: 'expired' } },
      { status: 200, body: { id: 'i1', name: 'Dan', timezone: 'UTC' } },
    )
    const credentials = aRenewingSource(['stale-token', 'fresh-token'])
    const client = new HttpIntervalsIcuClient({ credentials, fetch: http.fetch, retry: neverSleeps })

    await expect(client.athlete('i1')).resolves.toMatchObject({ id: 'i1' })
    expect(credentials.issued).toEqual(['stale-token', 'fresh-token'])
  })

  it('gives up when the credentials cannot be renewed', async () => {
    const http = new StubFetch().respondWith({ status: 401, body: { error: 'revoked' } })
    const client = new HttpIntervalsIcuClient({
      credentials: aRenewingSource(['only-token']),
      fetch: http.fetch,
      retry: neverSleeps,
    })

    await expect(client.athlete('i1')).rejects.toMatchObject({ status: 401 })
    expect(http.requests).toHaveLength(1)
  })
})
