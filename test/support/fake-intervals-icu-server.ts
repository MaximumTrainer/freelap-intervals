import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import type { ActivityPatch, CustomFieldValues, IcuInterval } from '~/icu/intervals-icu-client'
import { IntervalsIcuError } from '~/icu/intervals-icu-client'

import { FakeIntervalsIcu } from './fake-intervals-icu'

const ACTIVITY_FIELDS = new Set(['name', 'description', 'external_id', 'type'])

/**
 * Serves the in-memory fake over real HTTP in intervals.icu's own wire shapes, so an end-to-end
 * test exercises the actual HTTP client, multipart upload and FIT file rather than a stub.
 */
export class FakeIntervalsIcuServer {
  private readonly server: Server
  private readonly customFieldNames = new Map<string, { code: string; name: string; type: string }>()
  private tokensIssued = 0

  private constructor(readonly icu: FakeIntervalsIcu) {
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  static async start(icu = new FakeIntervalsIcu({ timezone: 'Europe/London' })): Promise<FakeIntervalsIcuServer> {
    const server = new FakeIntervalsIcuServer(icu)
    await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve))

    return server
  }

  get baseUrl(): string {
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('The fake server is not listening')

    return `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  /** Stands in for the intervals.icu OAuth token endpoint, for tests that connect an account. */
  private issueTokens(): unknown {
    this.tokensIssued += 1

    return {
      access_token: `access-${this.tokensIssued}`,
      refresh_token: 'refresh-1',
      expires_in: 3600,
      athlete_id: this.icu.athleteId,
      scope: 'ACTIVITY:READ ACTIVITY:WRITE',
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', this.baseUrl)
      if (url.pathname === '/api/oauth/token') return send(response, 200, this.issueTokens())
      if (!request.headers.authorization) return send(response, 401, { error: 'no credentials' })

      const body = await readBody(request)
      const result = await this.route(request.method ?? 'GET', url, body, request.headers['content-type'] ?? '')

      send(response, 200, result)
    } catch (error) {
      const status = error instanceof IntervalsIcuError ? error.status : 500
      send(response, status, { error: (error as Error).message })
    }
  }

  private async route(method: string, url: URL, body: Buffer, contentType: string): Promise<unknown> {
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const segments = path.split('/').filter(Boolean)
    const json = (): Record<string, unknown> => (body.length === 0 ? {} : JSON.parse(body.toString('utf8')))

    if (segments[0] === 'athlete' && segments[1]) return this.athleteRoutes(method, segments, url, body, contentType, json)
    if (segments[0] === 'activity' && segments[1]) return this.activityRoutes(method, segments, json)

    throw new IntervalsIcuError(`No route for ${method} ${path}`, 404, false)
  }

  private async athleteRoutes(
    method: string,
    segments: readonly string[],
    url: URL,
    body: Buffer,
    contentType: string,
    json: () => Record<string, unknown>,
  ): Promise<unknown> {
    const athleteId = segments[1]!

    if (segments.length === 2) return this.icu.athlete(athleteId)

    if (segments[2] === 'activities' && method === 'GET') {
      return this.icu.listActivities(athleteId, {
        oldest: url.searchParams.get('oldest') ?? '',
        newest: url.searchParams.get('newest') ?? '',
      })
    }

    if (segments[2] === 'activities' && method === 'POST') {
      const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
      const file = form.get('file') as File

      return this.icu.uploadActivity(athleteId, {
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        name: String(form.get('name') ?? ''),
        ...(form.has('description') ? { description: String(form.get('description')) } : {}),
        ...(form.has('external_id') ? { externalId: String(form.get('external_id')) } : {}),
      })
    }

    if (segments[2] === 'custom-item' && method === 'GET') return [...this.customFieldNames.values()]

    if (segments[2] === 'custom-item' && method === 'POST') {
      const definition = json() as { code: string; name: string; type: string }
      this.customFieldNames.set(definition.code, definition)
      await this.icu.ensureCustomFields(athleteId, [{ ...definition, type: 'NUMBER' }])

      return definition
    }

    throw new IntervalsIcuError(`No athlete route for ${method} ${segments.join('/')}`, 404, false)
  }

  private async activityRoutes(
    method: string,
    segments: readonly string[],
    json: () => Record<string, unknown>,
  ): Promise<unknown> {
    const activityId = segments[1]!

    if (segments.length === 2 && method === 'GET') return this.icu.getActivity(activityId)

    if (segments.length === 2 && method === 'PUT') {
      const [patch, customFields] = splitActivityBody(json())
      if (Object.keys(customFields).length > 0) await this.icu.setCustomFields(activityId, customFields)

      return this.icu.updateActivity(activityId, patch)
    }

    if (segments[2] === 'streams') {
      const streams = await this.icu.getStreams(activityId)
      return Object.entries(streams).map(([type, data]) => ({ type, data }))
    }

    if (segments[2] === 'intervals' && method === 'GET') {
      return { icu_intervals: (await this.icu.getIntervals(activityId)).map(toWire) }
    }

    if (segments[2] === 'intervals' && method === 'PUT') {
      const envelope = json() as { icu_intervals?: Array<Record<string, unknown>> }
      await this.icu.putIntervals(activityId, (envelope.icu_intervals ?? []).map(fromWire))

      return {}
    }

    throw new IntervalsIcuError(`No activity route for ${method} ${segments.join('/')}`, 404, false)
  }
}

function splitActivityBody(body: Record<string, unknown>): [ActivityPatch, CustomFieldValues] {
  const entries = Object.entries(body)

  return [
    Object.fromEntries(entries.filter(([key]) => ACTIVITY_FIELDS.has(key))) as ActivityPatch,
    Object.fromEntries(entries.filter(([key]) => !ACTIVITY_FIELDS.has(key))) as CustomFieldValues,
  ]
}

function toWire(interval: IcuInterval): Record<string, unknown> {
  return {
    type: interval.type,
    start_index: interval.start_index,
    end_index: interval.end_index,
    label: interval.name,
  }
}

function fromWire(interval: Record<string, unknown>): IcuInterval {
  return {
    type: interval.type === 'RECOVERY' ? 'RECOVERY' : 'WORK',
    start_index: Number(interval.start_index ?? 0),
    end_index: Number(interval.end_index ?? 0),
    name: String(interval.label ?? ''),
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)

  return Buffer.concat(chunks)
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body ?? {}))
}
