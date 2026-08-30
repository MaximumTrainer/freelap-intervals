import { Secret } from '~/security/secret'

import { html, redirect } from '../http'
import type { Router } from '../router'
import type { RequestContext } from '../web-app'
import { requireUser } from '../web-app'
import { messagePage } from '../views'

/** Connecting and disconnecting the two outside accounts this integration talks to. */
export function connectRoutes(router: Router<RequestContext>): void {
  router.get('/connect/intervals-icu', async (context) => {
    const userId = requireUser(context)
    const state = await context.deps.oauthStates.issue(userId, '/')

    return redirect(context.deps.oauth.authorizeUrl(state))
  })

  router.get('/oauth/callback', async (context) => {
    const code = context.url.searchParams.get('code')
    const state = context.url.searchParams.get('state')
    if (!code || !state) return html(messagePage('Connection failed', 'intervals.icu sent us back without a code.'), 400)

    const issued = await context.deps.oauthStates.consume(state)
    if (!issued) return html(messagePage('Connection failed', 'That authorization has already been used.'), 400)

    const tokens = await context.deps.oauth.exchangeCode(code)
    await context.deps.connections.saveIntervalsIcu(issued.userId, tokens)
    await context.deps.audit.record(issued.userId, {
      action: 'intervals.icu connected',
      target: tokens.athleteId,
      outcome: 'ok',
      statusCode: 200,
      detail: { scopes: tokens.scopes },
    })

    return redirect(issued.redirectUri)
  })

  router.post('/connect/myfreelap', async (context) => {
    const userId = requireUser(context)
    const username = context.body.field('username')?.trim()
    const password = context.body.field('password')

    if (!username || !password) return html(messagePage('Not connected', 'Both an email and a password are needed.'), 400)

    await context.deps.connections.saveFreelap(userId, { username, password: new Secret(password) })
    await context.deps.audit.record(userId, {
      action: 'myfreelap credentials stored',
      target: username,
      outcome: 'ok',
      statusCode: null,
      detail: {},
    })

    return redirect('/')
  })

  router.post('/account/purge', async (context) => {
    const userId = requireUser(context)

    // Recorded first: the audit row is kept, with the athlete unnamed, once the account is gone.
    await context.deps.audit.record(userId, {
      action: 'account purged',
      target: null,
      outcome: 'ok',
      statusCode: null,
      detail: { requestedByAthlete: true },
    })
    await context.deps.users.purge(userId)

    return redirect('/sign-in', { 'set-cookie': context.deps.sessionCookie.clear() })
  })

  router.post('/disconnect/:provider', async (context) => {
    const userId = requireUser(context)
    const provider = context.params.provider === 'myfreelap' ? 'myfreelap' : 'intervals_icu'

    await context.deps.connections.disconnect(userId, provider)
    await context.deps.audit.record(userId, {
      action: `${provider} disconnected`,
      target: null,
      outcome: 'ok',
      statusCode: null,
      detail: { credentialsDeleted: true },
    })

    return redirect('/')
  })
}
