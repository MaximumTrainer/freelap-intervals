import { randomUUID } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'

import type { Applications } from '~/app/applications'
import type { UserRepository } from '~/app/user-repository'
import type { Workspaces } from '~/app/workspaces'
import type { AuditLog } from '~/audit/audit-log'
import type { OAuthClient } from '~/auth/oauth-client'
import { ReconnectRequiredError } from '~/auth/oauth-client'
import type { OAuthStateStore } from '~/auth/oauth-state-store'
import { AdapterDegradedError } from '~/ingest/freelap-source'
import type { ColumnMappingStore } from '~/ingest/csv/column-mapping-store'
import type { FeatureFlags } from '~/ingest/freelap-sources'
import type { JobQueue } from '~/jobs/job-queue'
import { refreshQueueMetrics } from '~/jobs/sync-jobs'
import type { PgSyncDirectory } from '~/ledger/sync-directory'
import type { ErrorReporter } from '~/logging/error-reporter'
import type { Logger } from '~/logging/logger'
import type { MetricsRegistry } from '~/logging/metrics-registry'
import type { ConnectionStore } from '~/security/connection-store'

import type { ConnectionProbe } from './connection-probe'
import type { RequestBody, WebResponse } from './http'
import { BodyTooLargeError, html, json, readRequestBody, redirect, send } from './http'
import { csrfTokenFor, generateNonce, nonceFromCookies, setNonceCookie, verifyCsrfToken } from './csrf'
import type { DedupFilter } from './dedup-filter'
import type { RateLimiter } from './rate-limiter'
import { Router } from './router'
import type { SessionCookie } from './session-cookie'
import type { SessionStore } from './session-store'
import { connectRoutes } from './routes/connect-routes'
import { sessionRoutes } from './routes/session-routes'
import { webhookRoutes } from './routes/webhook-routes'
import { messagePage, privacyPage, signInPage } from './views'

export interface WebAppDependencies {
  readonly users: UserRepository
  readonly workspaces: Workspaces
  readonly applications: Applications
  readonly connections: ConnectionStore
  readonly oauth: OAuthClient
  readonly oauthStates: OAuthStateStore
  readonly audit: AuditLog
  readonly queue: JobQueue
  readonly directory: PgSyncDirectory
  readonly sessionCookie: SessionCookie
  readonly sessions: SessionStore
  readonly columnMappings: ColumnMappingStore
  readonly flags: FeatureFlags
  readonly webhookRateLimiter: RateLimiter
  readonly webhookDedup: DedupFilter
  readonly webhookSecret: string
  readonly csrfSecret: string
  readonly maxBodyBytes: number
  readonly now: () => Date
  readonly logger: Logger
  readonly metrics: MetricsRegistry
  readonly errorReporter: ErrorReporter
  readonly metricsSecret: string
  readonly connectionProbe: ConnectionProbe
}

export interface RequestContext {
  readonly deps: WebAppDependencies
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  readonly body: RequestBody
  /** The signed-in athlete, or null on the routes that do not need one. */
  readonly userId: string | null
  /** The signed-in athlete's email, for page chrome. */
  readonly email: string | null
  /** The current session id, if signed in. */
  readonly sessionId: string | null
  /** The CSRF token for this request, to embed in forms. */
  readonly csrfToken: string
  /** Unique identifier for this request, for correlation across logs and jobs. */
  readonly requestId: string
}

/** Routes that anyone may reach; everything else needs a signed-in athlete. */
const PUBLIC_PATHS = new Set(['/sign-in', '/healthz', '/metrics', '/privacy'])

const WEBHOOK_PREFIX = '/webhooks/intervals-icu/'

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith(WEBHOOK_PREFIX)
}

function isCsrfExemptPath(pathname: string): boolean {
  return pathname.startsWith(WEBHOOK_PREFIX)
}

/** The webhook route pattern, for route-enumeration tests. */
export const WEBHOOK_ROUTE_PATTERN = '/webhooks/intervals-icu/:secret'

export function createWebApp(deps: WebAppDependencies): RequestListener {
  const router = buildRouter()

  return (request: IncomingMessage, response: ServerResponse): void => {
    const requestId = randomUUID()

    void handle(router, deps, request, requestId)
      .catch((error: unknown) => {
        deps.errorReporter.report(error as Error, {
          requestId,
          route: request.url ?? '/',
        })

        return asWebResponse(error)
      })
      .then((web) => {
        response.setHeader('x-request-id', requestId)
        send(response, web)
      })
  }
}

/** Exported for route-enumeration tests — production code uses `createWebApp`. */
export function buildRouter(): Router<RequestContext> {
  const router = new Router<RequestContext>()

  router.get('/healthz', async () => ({ status: 200, body: 'ok' }))

  router.get('/metrics', async (context) => {
    const token = context.url.searchParams.get('token')
    if (token !== context.deps.metricsSecret) {
      return { status: 403, body: 'Forbidden' }
    }

    await refreshQueueMetrics(context.deps.metrics, context.deps.queue, context.deps.now())

    return {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      body: context.deps.metrics.serialize(),
    }
  })
  router.get('/sign-in', async (context) =>
    html(signInPage(context.csrfToken)),
  )
  router.post('/sign-in', async (context) => {
    const email = context.body.field('email')?.trim()
    if (!email) return html(signInPage(context.csrfToken), 400)

    const user = await context.deps.users.findOrCreateByEmail(email)
    const sessionId = await context.deps.sessions.create(user.id)
    const nowMs = context.deps.now().getTime()

    return redirect('/', {
      'set-cookie': context.deps.sessionCookie.issue(sessionId, nowMs),
    })
  })
  router.post('/sign-out', async (context) => {
    if (context.sessionId) await context.deps.sessions.revoke(context.sessionId)
    return redirect('/sign-in', { 'set-cookie': context.deps.sessionCookie.clear() })
  })

  router.get('/privacy', async () => html(privacyPage()))

  connectRoutes(router)
  sessionRoutes(router)
  webhookRoutes(router)

  return router
}

async function handle(
  router: Router<RequestContext>,
  deps: WebAppDependencies,
  request: IncomingMessage,
  requestId: string,
): Promise<WebResponse> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const method = request.method ?? 'GET'

  deps.logger.child({ requestId }).info(`${method} ${url.pathname}`)

  const route = router.match(method, url.pathname)
  if (!route) return html(messagePage('Not found', 'There is nothing at that address.'), 404)

  const { userId, email, sessionId } = await resolveSession(deps, request)
  if (userId === null && !isPublicPath(url.pathname)) return redirect('/sign-in')

  const body = await readBodyWithCap(request, url.pathname, deps.maxBodyBytes)

  const existingNonce = nonceFromCookies(request.headers.cookie)
  const csrfIdentity = sessionId ?? existingNonce ?? generateNonce()
  const csrfToken = csrfTokenFor(deps.csrfSecret, csrfIdentity)

  const csrfRejection = await enforceCsrf({
    method, pathname: url.pathname, body, csrfIdentity, deps, userId,
  })
  if (csrfRejection) return csrfRejection

  const response = await route.handler({
    deps, url, params: route.params, body, userId, email, sessionId, csrfToken, requestId,
  })

  if (!sessionId && !existingNonce) {
    return { ...response, headers: { ...response.headers, 'set-cookie': setNonceCookie(csrfIdentity) } }
  }

  return response
}

async function resolveSession(
  deps: WebAppDependencies,
  request: IncomingMessage,
): Promise<{ userId: string | null; email: string | null; sessionId: string | null }> {
  const nowMs = deps.now().getTime()
  const sessionId = deps.sessionCookie.read(request.headers.cookie, nowMs)
  if (!sessionId) return { userId: null, email: null, sessionId: null }

  const session = await deps.sessions.validate(sessionId)
  if (!session) return { userId: null, email: null, sessionId: null }

  void deps.sessions.touch(sessionId)

  const user = await deps.users.find(session.userId)

  return { userId: session.userId, email: user?.email ?? null, sessionId }
}

interface CsrfCheck {
  readonly method: string
  readonly pathname: string
  readonly body: RequestBody
  readonly csrfIdentity: string
  readonly deps: WebAppDependencies
  readonly userId: string | null
}

async function enforceCsrf(check: CsrfCheck): Promise<WebResponse | null> {
  if (check.method === 'GET' || check.method === 'HEAD') return null
  if (isCsrfExemptPath(check.pathname)) return null

  const submitted = check.body.field('_csrf') ?? ''
  if (verifyCsrfToken(check.deps.csrfSecret, check.csrfIdentity, submitted)) return null

  await check.deps.audit.record(check.userId, {
    action: 'csrf rejected',
    target: check.pathname,
    outcome: 'error',
    statusCode: 403,
    detail: {},
  })

  const reason = 'This form has expired or was opened from another site. '
    + 'Please go back and try again.'

  return html(messagePage('Request rejected', reason), 403)
}

const WEBHOOK_BODY_CAP = 65_536
const SIGN_IN_BODY_CAP = 16_384

function maxBodyBytesFor(pathname: string, defaultBytes: number): number {
  if (pathname.startsWith(WEBHOOK_PREFIX)) return WEBHOOK_BODY_CAP
  if (pathname === '/sign-in') return SIGN_IN_BODY_CAP

  return defaultBytes
}

class RouteBodyTooLargeError extends Error {
  constructor(readonly pathname: string, readonly limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte limit`)
  }
}

async function readBodyWithCap(
  request: IncomingMessage,
  pathname: string,
  defaultMaxBytes: number,
): Promise<RequestBody> {
  const maxBytes = maxBodyBytesFor(pathname, defaultMaxBytes)
  try {
    return await readRequestBody(request, { maxBytes })
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new RouteBodyTooLargeError(pathname, error.limitBytes)
    throw error
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`

  return `${bytes} bytes`
}

function asWebResponse(error: unknown): WebResponse {
  if (error instanceof RouteBodyTooLargeError) {
    if (error.pathname.startsWith(WEBHOOK_PREFIX)) {
      return json({ error: 'payload too large' }, 413)
    }

    return html(
      messagePage('Upload too large', `That file is larger than ${formatBytes(error.limitBytes)}.`),
      413,
    )
  }
  if (error instanceof ReconnectRequiredError) {
    return html(messagePage('Reconnect intervals.icu', error.message), 400)
  }
  if (error instanceof AdapterDegradedError) {
    return html(messagePage('MyFreelap is not answering', error.message), 502)
  }

  return html(messagePage('Something went wrong', (error as Error).message), 500)
}

/** Every signed-in route starts here, so no handler has to remember to check. */
export function requireUser(context: RequestContext): string {
  if (!context.userId) throw new Error('This page needs a signed-in athlete')

  return context.userId
}
