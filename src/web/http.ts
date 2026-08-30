import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebResponse {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export interface RequestBody {
  field(name: string): string | undefined
  file(name: string): { filename: string; text: string } | undefined
  json<T>(): T
}

export function html(body: string, status = 200): WebResponse {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body }
}

export function redirect(location: string, extraHeaders: Record<string, string> = {}): WebResponse {
  return { status: 302, headers: { location, ...extraHeaders } }
}

export function json(body: unknown, status = 200): WebResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

export function noContent(status: number): WebResponse {
  return { status }
}

export async function readRequestBody(request: IncomingMessage): Promise<RequestBody> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)

  const raw = Buffer.concat(chunks)
  const contentType = request.headers['content-type'] ?? ''
  const fields = new Map<string, string>()
  const files = new Map<string, { filename: string; text: string }>()

  if (contentType.startsWith('multipart/form-data')) {
    const form = await new Response(raw, { headers: { 'content-type': contentType } }).formData()

    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') fields.set(name, value)
      else files.set(name, { filename: value.name, text: await value.text() })
    }
  } else if (contentType.startsWith('application/x-www-form-urlencoded')) {
    for (const [name, value] of new URLSearchParams(raw.toString('utf8'))) fields.set(name, value)
  }

  return {
    field: (name) => fields.get(name),
    file: (name) => files.get(name),
    json: <T>() => (raw.length === 0 ? ({} as T) : (JSON.parse(raw.toString('utf8')) as T)),
  }
}

export function send(response: ServerResponse, web: WebResponse): void {
  response.writeHead(web.status, web.headers ?? {})
  response.end(web.body ?? '')
}
