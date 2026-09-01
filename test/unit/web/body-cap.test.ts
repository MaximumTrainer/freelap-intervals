import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { BodyTooLargeError, readRequestBody } from '~/web/http'

function fakeRequest(body: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const stream = new PassThrough()
  Object.defineProperty(stream, 'headers', { value: { 'content-type': 'application/json', ...headers } })
  stream.end(body)

  return stream as unknown as IncomingMessage
}

function chunkedRequest(chunks: Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = new PassThrough()
  Object.defineProperty(stream, 'headers', { value: { 'content-type': 'application/json', ...headers } })

  for (const chunk of chunks) stream.write(chunk)
  stream.end()

  return stream as unknown as IncomingMessage
}

describe('readRequestBody with maxBytes', () => {
  it('accepts a body under the cap', async () => {
    const body = Buffer.from(JSON.stringify({ ok: true }))
    const result = await readRequestBody(fakeRequest(body), { maxBytes: 1024 })

    expect(result.json()).toEqual({ ok: true })
  })

  it('accepts a body exactly at the cap', async () => {
    const body = Buffer.alloc(64, 0x20)
    const result = await readRequestBody(fakeRequest(body), { maxBytes: 64 })

    expect(result).toBeDefined()
  })

  it('rejects a body over the cap by one byte', async () => {
    const body = Buffer.alloc(65, 0x20)

    await expect(readRequestBody(fakeRequest(body), { maxBytes: 64 })).rejects.toThrow(BodyTooLargeError)
  })

  it('rejects early when content-length exceeds the cap', async () => {
    const body = Buffer.alloc(10)
    const request = fakeRequest(body, { 'content-length': '10000' })

    await expect(readRequestBody(request, { maxBytes: 64 })).rejects.toThrow(BodyTooLargeError)
  })

  it('rejects a chunked stream that exceeds the cap without content-length', async () => {
    const chunks = [Buffer.alloc(32, 0x41), Buffer.alloc(32, 0x42), Buffer.alloc(32, 0x43)]
    const request = chunkedRequest(chunks)

    await expect(readRequestBody(request, { maxBytes: 64 })).rejects.toThrow(BodyTooLargeError)
  })

  it('carries the limit in the error', async () => {
    const body = Buffer.alloc(200)

    try {
      await readRequestBody(fakeRequest(body), { maxBytes: 100 })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BodyTooLargeError)
      expect((error as BodyTooLargeError).limitBytes).toBe(100)
    }
  })

  it('has no cap when maxBytes is not provided', async () => {
    const body = Buffer.alloc(10_000, 0x20)
    const result = await readRequestBody(fakeRequest(body))

    expect(result).toBeDefined()
  })
})
