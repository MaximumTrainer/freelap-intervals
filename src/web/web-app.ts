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
import type { PgSyncDirectory } from '~/ledger/sync-directory'
import type { ConnectionStore } from '~/security/connection-store'

import type { RequestBody, WebResponse } from './http'
import { html, readRequestBody, redirect, send } from './http'
import { Router } from './router'
import type { SessionCookie } from './session-cookie'
import { connectRoutes } from './routes/connect-routes'
import { sessionRoutes } from './routes/session-routes'
import { webhookRoutes } from './routes/webhook-routes'
import { messagePage, signInPage } from './views'

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
  readonly columnMappings: ColumnMappingStore
  readonly flags: FeatureFlags
}

export interface RequestContext {
  readonly deps: WebAppDependencies
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  readonly body: RequestBody
  /** The signed-in athlete, or null on the routes that do not need one. */
  readonly userId: string | null
}

/** Routes that anyone may reach; everything else needs a signed-in athlete. */
const PUBLIC_PATHS = new Set(['/sign-in', '/healthz', '/webhooks/intervals-icu'])

export function createWebApp(deps: WebAppDependencies): RequestListener {
  const router = buildRouter()

  return (request: IncomingMessage, response: ServerResponse): void => {
    void handle(router, deps, request)
      .catch(asWebResponse)
      .then((web) => send(response, web))
  }
}

function buildRouter(): Router<RequestContext> {
  const router = new Router<RequestContext>()

  router.get('/healthz', async () => ({ status: 200, body: 'ok' }))
  router.get('/sign-in', async () => html(signInPage()))
  router.post('/sign-in', async (context) => {
    const email = context.body.field('email')?.trim()
    if (!email) return html(signInPage(), 400)

    const user = await context.deps.users.findOrCreateByEmail(email)
    return redirect('/', { 'set-cookie': context.deps.sessionCookie.issue(user.id) })
  })
  router.post('/sign-out', async (context) => redirect('/sign-in', { 'set-cookie': context.deps.sessionCookie.clear() }))

  connectRoutes(router)
  sessionRoutes(router)
  webhookRoutes(router)

  return router
}

async function handle(
  router: Router<RequestContext>,
  deps: WebAppDependencies,
  request: IncomingMessage,
): Promise<WebResponse> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = router.match(request.method ?? 'GET', url.pathname)
  if (!route) return html(messagePage('Not found', 'There is nothing at that address.'), 404)

  const userId = deps.sessionCookie.read(request.headers.cookie)
  if (userId === null && !PUBLIC_PATHS.has(url.pathname)) return redirect('/sign-in')

  return route.handler({ deps, url, params: route.params, body: await readRequestBody(request), userId })
}

function asWebResponse(error: unknown): WebResponse {
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
