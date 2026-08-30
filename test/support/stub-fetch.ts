export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
  readonly formData: FormData | null
}

interface ScriptedResponse {
  readonly status: number
  readonly body?: unknown
}

/** A scripted stand-in for `fetch` that records what the client sent. */
export class StubFetch {
  readonly requests: RecordedRequest[] = []
  private readonly script: ScriptedResponse[] = []

  respondWith(...responses: ScriptedResponse[]): this {
    this.script.push(...responses)
    return this
  }

  get fetch(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const [body, formData] = await readBody(request.clone())

      this.requests.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body,
        formData,
      })

      const next = this.script.shift() ?? { status: 200, body: {} }
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      })
    })
  }

  lastRequest(): RecordedRequest {
    const last = this.requests.at(-1)
    if (!last) throw new Error('No request was made')
    return last
  }
}

async function readBody(request: Request): Promise<[unknown, FormData | null]> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.startsWith('multipart/form-data')) return [null, await request.formData()]
  if (request.method === 'GET' || request.method === 'DELETE') return [null, null]

  const text = await request.text()
  if (text === '') return [null, null]

  return [contentType.includes('json') ? JSON.parse(text) : text, null]
}
