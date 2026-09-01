import { describe, expect, it } from 'vitest'

import { LoggingErrorReporter } from '~/logging/error-reporter'
import { JsonLogger } from '~/logging/json-logger'

describe('LoggingErrorReporter (R6)', () => {
  it('logs the error with correlation context', () => {
    const lines: string[] = []
    const logger = new JsonLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-29T12:00:00Z'),
    })
    const reporter = new LoggingErrorReporter(logger)

    reporter.report(new Error('something broke'), {
      requestId: 'req-42',
      route: '/sessions/abc/sync',
      userId: 'u1',
    })

    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.level).toBe('error')
    expect(parsed.message).toBe('something broke')
    expect(parsed.requestId).toBe('req-42')
    expect(parsed.route).toBe('/sessions/abc/sync')
    expect(parsed.stack).toBeDefined()
  })

  it('redacts sensitive values in the error context', () => {
    const lines: string[] = []
    const logger = new JsonLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-29T12:00:00Z'),
    })
    const reporter = new LoggingErrorReporter(logger)

    reporter.report(new Error('auth failed'), {
      requestId: 'req-1',
    })

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.requestId).toBe('req-1')
    expect(parsed.message).toBe('auth failed')
  })
})
