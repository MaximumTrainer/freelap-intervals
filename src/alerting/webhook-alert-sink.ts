import type { Alert, AlertSink } from './alert-sink'

/**
 * POSTs alerts as JSON to a webhook URL. The smallest transport that reaches Slack, PagerDuty and
 * email relays alike: point it at an incoming webhook, a Zapier trigger, or a cloud function.
 */
export class WebhookAlertSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch,
  ) {}

  async notify(alert: Alert): Promise<void> {
    await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(alert),
    })
  }
}
