import { enqueueVerify } from '~/jobs/sync-jobs'

import { json, noContent } from '../http'
import type { Router } from '../router'
import type { RequestContext } from '../web-app'

interface IntervalsIcuWebhook {
  readonly athlete_id?: string | number
  readonly activity_id?: string
  readonly type?: string
}

const CHANGE_EVENTS = new Set(['ACTIVITY_UPDATED', 'ACTIVITY_DELETED', 'ACTIVITY_CREATED'])

/**
 * intervals.icu tells us when an activity changed. If it is one we wrote, the sync is re-verified
 * in the background, so an edit made over there shows up here as drift rather than going unnoticed.
 */
export function webhookRoutes(router: Router<RequestContext>): void {
  router.post('/webhooks/intervals-icu', async (context) => {
    const event = context.body.json<IntervalsIcuWebhook>()
    if (!event.activity_id || !event.athlete_id || !CHANGE_EVENTS.has(event.type ?? '')) {
      return json({ ignored: true }, 200)
    }

    const location = await context.deps.directory.findByActivity(String(event.athlete_id), event.activity_id)
    if (!location) return json({ ignored: true }, 200)

    await enqueueVerify(context.deps.queue, { userId: location.userId, sourceId: location.sourceId })

    return noContent(202)
  })
}
