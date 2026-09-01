import { describe, expect, it } from 'vitest'

import type { Alert } from '~/alerting/alert-sink'
import { LoggingAlertSink } from '~/alerting/logging-alert-sink'
import { WebhookAlertSink } from '~/alerting/webhook-alert-sink'

const testAlert: Alert = {
  severity: 'critical',
  title: 'MyFreelap adapter degraded',
  detail: { reason: 'HTML instead of JSON' },
}

describe('LoggingAlertSink', () => {
  it('logs critical alerts at error level', async () => {
    const logged: Array<{ level: string; message: string }> = []
    const logger = {
      debug: (message: string) => logged.push({ level: 'debug', message }),
      info: (message: string) => logged.push({ level: 'info', message }),
      warn: (message: string) => logged.push({ level: 'warn', message }),
      error: (message: string) => logged.push({ level: 'error', message }),
      child: () => logger,
    }
    const sink = new LoggingAlertSink(logger)

    await sink.notify(testAlert)

    expect(logged).toEqual([{ level: 'error', message: 'MyFreelap adapter degraded' }])
  })

  it('logs warning alerts at warn level', async () => {
    const logged: Array<{ level: string; message: string }> = []
    const logger = {
      debug: (message: string) => logged.push({ level: 'debug', message }),
      info: (message: string) => logged.push({ level: 'info', message }),
      warn: (message: string) => logged.push({ level: 'warn', message }),
      error: (message: string) => logged.push({ level: 'error', message }),
      child: () => logger,
    }
    const sink = new LoggingAlertSink(logger)

    await sink.notify({ ...testAlert, severity: 'warning' })

    expect(logged[0]!.level).toBe('warn')
  })

  it('logs recovery alerts at info level', async () => {
    const logged: Array<{ level: string; message: string }> = []
    const logger = {
      debug: (message: string) => logged.push({ level: 'debug', message }),
      info: (message: string) => logged.push({ level: 'info', message }),
      warn: (message: string) => logged.push({ level: 'warn', message }),
      error: (message: string) => logged.push({ level: 'error', message }),
      child: () => logger,
    }
    const sink = new LoggingAlertSink(logger)

    await sink.notify({ ...testAlert, severity: 'recovery' })

    expect(logged[0]!.level).toBe('info')
  })
})

describe('WebhookAlertSink', () => {
  it('POSTs the alert as JSON to the configured URL', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const fakeFetch = async (url: string, init: RequestInit) => {
      requests.push({ url, body: init.body as string })

      return new Response('ok', { status: 200 })
    }
    const sink = new WebhookAlertSink('https://hooks.example.com/alert', fakeFetch)

    await sink.notify(testAlert)

    expect(requests).toEqual([{
      url: 'https://hooks.example.com/alert',
      body: JSON.stringify(testAlert),
    }])
  })
})
