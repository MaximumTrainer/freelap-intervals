import { timingSafeEqual } from 'node:crypto'

import { enqueueVerify } from '~/jobs/sync-jobs'

import { json, noContent } from '../http'
import type { Router } from '../router'
import type { RequestContext } from '../web-app'

interface IntervalsIcuWebhook {
  readonly athlete_id?: string | number
  readonly activity_id?: string
  readonly type?: string
}

const CHANGE_EVENTS = new Set([
  'ACTIVITY_UPDATED',
  'ACTIVITY_DELETED',
  'ACTIVITY_CREATED',
])

/** The single response for every authenticated request, matched or not — no enumeration oracle. */
const ACCEPTED = json({ accepted: true }, 202)

/**
 * intervals.icu tells us when an activity changed. The URL carries a high-entropy secret so only
 * the real caller reaches the handler; rate limiting and dedup protect the queue from misuse.
 */
export function webhookRoutes(router: Router<RequestContext>): void {
  router.post('/webhooks/intervals-icu/:secret', async (context) => {
    const rejection = rejectIfBadSecret(context)
    if (rejection) {
      await auditRejection(context, 'bad secret')

      return rejection
    }

    const ip = context.url.hostname
    const rateLimitKey = `ip:${ip}`
    if (!context.deps.webhookRateLimiter.allow(rateLimitKey)) {
      await auditRejection(context, 'rate limited')
      const retryAfter = context.deps.webhookRateLimiter.retryAfterS(rateLimitKey)

      return json(
        { error: 'rate limited' },
        429,
        { 'retry-after': String(retryAfter) },
      )
    }

    const event = context.body.json<IntervalsIcuWebhook>()
    if (!event.activity_id || !event.athlete_id || !CHANGE_EVENTS.has(event.type ?? '')) {
      return ACCEPTED
    }

    const athleteId = String(event.athlete_id)
    const athleteKey = `athlete:${athleteId}`
    if (!context.deps.webhookRateLimiter.allow(athleteKey)) {
      await auditRejection(context, 'rate limited')
      const retryAfter = context.deps.webhookRateLimiter.retryAfterS(athleteKey)

      return json(
        { error: 'rate limited' },
        429,
        { 'retry-after': String(retryAfter) },
      )
    }

    const dedupKey = `${athleteId}:${event.activity_id}`
    if (context.deps.webhookDedup.isDuplicate(dedupKey)) return ACCEPTED

    const location = await context.deps.directory.findByActivity(athleteId, event.activity_id)
    if (!location) return ACCEPTED

    await enqueueVerify(context.deps.queue, {
      userId: location.userId,
      sourceId: location.sourceId,
      requestId: context.requestId,
    })

    return ACCEPTED
  })
}

function rejectIfBadSecret(context: RequestContext): ReturnType<typeof noContent> | null {
  const submitted = context.params.secret ?? ''
  const expected = context.deps.webhookSecret

  const a = Buffer.from(submitted)
  const b = Buffer.from(expected)

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return noContent(404)
  }

  return null
}

async function auditRejection(context: RequestContext, reason: string): Promise<void> {
  await context.deps.audit.record(null, {
    action: 'webhook rejected',
    target: '/webhooks/intervals-icu',
    outcome: 'error',
    statusCode: reason === 'rate limited' ? 429 : 404,
    detail: { reason },
  })
}
