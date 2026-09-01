import { describe, expect, it } from 'vitest'

import { redact, REDACTED_FIELDS } from '~/logging/logger'
import { JsonLogger } from '~/logging/json-logger'

describe('redaction (R3)', () => {
  it('replaces values of sensitive fields with [REDACTED]', () => {
    const input = {
      userId: 'u1',
      accessToken: 'sk-secret-123',
      email: 'athlete@example.com',
      detail: 'safe',
    }

    const result = redact(input) as Record<string, unknown>

    expect(result).toEqual({
      userId: 'u1',
      accessToken: '[REDACTED]',
      email: '[REDACTED]',
      detail: 'safe',
    })
  })

  it('redacts nested objects recursively', () => {
    const input = {
      user: {
        name: 'Alice',
        credential: 'top-secret',
        settings: { password: 'hunter2', theme: 'dark' },
      },
    }

    const result = redact(input) as Record<string, unknown>

    expect(result).toEqual({
      user: {
        name: 'Alice',
        credential: '[REDACTED]',
        settings: { password: '[REDACTED]', theme: 'dark' },
      },
    })
  })

  it('redacts inside arrays', () => {
    const input = [
      { id: 1, token: 'abc' },
      { id: 2, token: 'def' },
    ]

    const result = redact(input)

    expect(result).toEqual([
      { id: 1, token: '[REDACTED]' },
      { id: 2, token: '[REDACTED]' },
    ])
  })

  it('passes through null and undefined unchanged', () => {
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
  })

  it('passes through primitives unchanged', () => {
    expect(redact(42)).toBe(42)
    expect(redact('hello')).toBe('hello')
    expect(redact(true)).toBe(true)
  })

  it('covers all fields the issue names as sensitive', () => {
    const expected = [
      'token', 'accessToken', 'refreshToken', 'apiKey', 'password',
      'secret', 'cookie', 'authorization', 'email', 'credential',
      'credentials', 'clientSecret', 'cookieSecret', 'csrfSecret',
      'webhookSecret', 'sessionCookie',
    ]

    for (const field of expected) {
      expect(REDACTED_FIELDS.has(field)).toBe(true)
    }
  })
})

describe('JsonLogger (R1)', () => {
  it('writes a single JSON line per log call', () => {
    const lines: string[] = []
    const logger = new JsonLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-29T12:00:00Z'),
    })

    logger.info('server started', { port: 3000 })

    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed).toEqual({
      timestamp: '2026-08-29T12:00:00.000Z',
      level: 'info',
      message: 'server started',
      port: 3000,
    })
  })

  it('respects minimum log level', () => {
    const lines: string[] = []
    const logger = new JsonLogger({
      level: 'warn',
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-29T12:00:00Z'),
    })

    logger.debug('too low')
    logger.info('still too low')
    logger.warn('just right')
    logger.error('also included')

    expect(lines).toHaveLength(2)
  })

  it('redacts sensitive values in context', () => {
    const lines: string[] = []
    const logger = new JsonLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-29T12:00:00Z'),
    })

    logger.info('auth', { accessToken: 'sk-123', email: 'a@b.com', userId: 'u1' })

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.accessToken).toBe('[REDACTED]')
    expect(parsed.email).toBe('[REDACTED]')
    expect(parsed.userId).toBe('u1')
  })

  it('child() adds fields to every subsequent log line', () => {
    const lines: string[] = []
    const logger = new JsonLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-29T12:00:00Z'),
    })

    const child = logger.child({ requestId: 'req-42' })
    child.info('handling request')

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.requestId).toBe('req-42')
    expect(parsed.message).toBe('handling request')
  })

  it('child() inherits parent fields and can be nested', () => {
    const lines: string[] = []
    const logger = new JsonLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-29T12:00:00Z'),
    })

    const child = logger.child({ requestId: 'req-1' }).child({ userId: 'u5' })
    child.info('deep context')

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.requestId).toBe('req-1')
    expect(parsed.userId).toBe('u5')
  })

  it('redacts sensitive values in child fields too', () => {
    const lines: string[] = []
    const logger = new JsonLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-29T12:00:00Z'),
    })

    const child = logger.child({ token: 'should-be-redacted', requestId: 'req-1' })
    child.info('check')

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.token).toBe('[REDACTED]')
    expect(parsed.requestId).toBe('req-1')
  })
})
