import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { LoggingErrorReporter } from '~/logging/error-reporter'
import type { ErrorContext } from '~/logging/error-reporter'
import { NullLogger } from '~/logging/logger'
import { InMemoryMetricsRegistry } from '~/logging/metrics-registry'
import type { WebAppDependencies } from '~/web/web-app'
import { createWebApp } from '~/web/web-app'

class CapturingErrorReporter extends LoggingErrorReporter {
  readonly reported: Array<{ error: Error; context: ErrorContext }> = []

  constructor() {
    super(new NullLogger())
  }

  override report(error: Error, context: ErrorContext): void {
    this.reported.push({ error, context })
  }
}

function stubSessions() {
  return {
    all: async () => [],
    find: async () => null,
  }
}

function stubLedger() {
  return {
    all: async () => [],
    findBySourceId: async () => null,
  }
}

function aMinimalWebApp(
  overrides: Partial<WebAppDependencies>,
): ReturnType<typeof createWebApp> {
  const base: WebAppDependencies = {
    users: {
      findOrCreateByEmail: async () => ({ id: 'u1', email: 'a@b.com' }),
      find: async () => null,
    } as never,
    workspaces: {
      forUser: () => ({
        sessions: stubSessions(),
        ledger: stubLedger(),
      }),
    } as never,
    applications: {} as never,
    connections: {} as never,
    oauth: {} as never,
    oauthStates: {} as never,
    audit: { record: async () => {}, recent: async () => [] },
    queue: {
      stats: async () => ({ queued: 0, running: 0, failed: 0, oldestQueuedMs: null }),
    } as never,
    directory: {} as never,
    sessionCookie: {
      read: () => null, issue: () => '', clear: () => '',
    } as never,
    sessions: {
      create: async () => '',
      validate: async () => null,
      revoke: async () => {},
      touch: async () => {},
    } as never,
    columnMappings: {} as never,
    flags: { myfreelapWebAdapter: false },
    webhookRateLimiter: {
      check: () => ({ allowed: true }),
    } as never,
    webhookDedup: { isDuplicate: () => false } as never,
    webhookSecret: 'test-secret',
    csrfSecret: 'test-csrf',
    maxBodyBytes: 1_048_576,
    now: () => new Date('2026-08-29T12:00:00Z'),
    logger: new NullLogger(),
    metrics: new InMemoryMetricsRegistry(),
    errorReporter: new LoggingErrorReporter(new NullLogger()),
    metricsSecret: 'test-metrics',
    connectionProbe: {
      probe: async () => ({
        intervalsIcu: { state: 'not_connected' as const },
        freelap: { state: 'not_connected' as const },
      }),
    } as never,
    ...overrides,
  }

  return createWebApp(base)
}

describe('web error handling with correlation (R6, R2)', () => {
  it('reports errors to the error reporter with the request id', async () => {
    const reporter = new CapturingErrorReporter()
    const app = aMinimalWebApp({ errorReporter: reporter })
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/bad/review`)

      expect(response.headers.get('x-request-id')).toBeTruthy()

      if (reporter.reported.length > 0) {
        expect(reporter.reported[0]!.context.requestId).toBeTruthy()
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns 403 from /metrics without the correct token', async () => {
    const app = aMinimalWebApp({})
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const noToken = await fetch(`http://127.0.0.1:${port}/metrics`)
      expect(noToken.status).toBe(403)

      const wrongToken = await fetch(`http://127.0.0.1:${port}/metrics?token=wrong`)
      expect(wrongToken.status).toBe(403)

      const correctToken = await fetch(`http://127.0.0.1:${port}/metrics?token=test-metrics`)
      expect(correctToken.status).toBe(200)
      expect(correctToken.headers.get('content-type')).toContain('text/plain')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
