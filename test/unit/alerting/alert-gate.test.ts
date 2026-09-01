import { describe, expect, it } from 'vitest'

import type { Alert, AlertSink } from '~/alerting/alert-sink'
import { AlertGate } from '~/alerting/alert-gate'

const collectingAlertSink = (): AlertSink & { readonly sent: Alert[] } => {
  const sent: Alert[] = []

  return { sent, notify: async (alert) => { sent.push(alert) } }
}

const throwingAlertSink = (): AlertSink => ({
  notify: async () => { throw new Error('transport down') },
})

const fixedClock = (iso: string) => {
  let ms = new Date(iso).getTime()

  return {
    now: () => new Date(ms),
    advanceMs: (delta: number) => { ms += delta },
  }
}

describe('AlertGate', () => {
  it('sends an alert to the sink on the first fire', async () => {
    const sink = collectingAlertSink()
    const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })

    await gate.fire('test', { severity: 'critical', title: 'Server down', detail: { host: 'a' } })

    expect(sink.sent).toEqual([{ severity: 'critical', title: 'Server down', detail: { host: 'a' } }])
  })

  it('suppresses a duplicate alert within the cooldown', async () => {
    const sink = collectingAlertSink()
    const clock = fixedClock('2026-08-29T12:00:00Z')
    const gate = new AlertGate(sink, { now: clock.now, cooldownMs: 60_000 })

    await gate.fire('test', { severity: 'critical', title: 'Down', detail: {} })
    clock.advanceMs(30_000)
    await gate.fire('test', { severity: 'critical', title: 'Down', detail: {} })

    expect(sink.sent).toHaveLength(1)
  })

  it('fires again after the cooldown expires', async () => {
    const sink = collectingAlertSink()
    const clock = fixedClock('2026-08-29T12:00:00Z')
    const gate = new AlertGate(sink, { now: clock.now, cooldownMs: 60_000 })

    await gate.fire('test', { severity: 'critical', title: 'Down', detail: {} })
    clock.advanceMs(60_001)
    await gate.fire('test', { severity: 'critical', title: 'Down', detail: {} })

    expect(sink.sent).toHaveLength(2)
  })

  it('sends a recovery alert when a previously-fired key recovers', async () => {
    const sink = collectingAlertSink()
    const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })

    await gate.fire('adapter', { severity: 'critical', title: 'Adapter down', detail: {} })
    await gate.recover('adapter')

    expect(sink.sent).toHaveLength(2)
    expect(sink.sent[1]).toEqual({
      severity: 'recovery',
      title: 'Recovered: adapter',
      detail: {},
    })
  })

  it('does not send a recovery alert when no prior alert was active', async () => {
    const sink = collectingAlertSink()
    const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })

    await gate.recover('adapter')

    expect(sink.sent).toHaveLength(0)
  })

  it('fires a critical alert when the rolling failure threshold is crossed', async () => {
    const sink = collectingAlertSink()
    const clock = fixedClock('2026-08-29T12:00:00Z')
    const gate = new AlertGate(sink, { now: clock.now, rollingThreshold: 3, rollingWindowMs: 60_000 })

    await gate.trackFailure('sync-session')
    await gate.trackFailure('sync-session')
    expect(sink.sent).toHaveLength(0)

    await gate.trackFailure('sync-session')

    expect(sink.sent).toEqual([
      expect.objectContaining({
        severity: 'critical',
        title: 'High failure rate: sync-session',
      }),
    ])
  })

  it('does not re-fire the rolling alert within cooldown', async () => {
    const sink = collectingAlertSink()
    const clock = fixedClock('2026-08-29T12:00:00Z')
    const gate = new AlertGate(sink, {
      now: clock.now, rollingThreshold: 3, rollingWindowMs: 60_000, cooldownMs: 60_000,
    })

    for (let i = 0; i < 6; i++) await gate.trackFailure('sync-session')

    expect(sink.sent).toHaveLength(1)
  })

  it('expires old failures outside the rolling window', async () => {
    const sink = collectingAlertSink()
    const clock = fixedClock('2026-08-29T12:00:00Z')
    const gate = new AlertGate(sink, { now: clock.now, rollingThreshold: 5, rollingWindowMs: 900_000 })

    for (let i = 0; i < 4; i++) await gate.trackFailure('sync-session')
    clock.advanceMs(900_001)
    await gate.trackFailure('sync-session')

    expect(sink.sent).toHaveLength(0)
  })

  it('swallows a transport error on fire without throwing', async () => {
    const sink = throwingAlertSink()
    const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })

    await expect(gate.fire('x', { severity: 'critical', title: 'oops', detail: {} })).resolves.toBeUndefined()
  })

  it('swallows a transport error on recover without throwing', async () => {
    const calls: Alert[] = []
    let shouldThrow = false
    const sink: AlertSink = {
      notify: async (alert) => {
        calls.push(alert)
        if (shouldThrow) throw new Error('transport down')
      },
    }
    const gate = new AlertGate(sink, { now: () => new Date('2026-08-29T12:00:00Z') })
    await gate.fire('x', { severity: 'critical', title: 'oops', detail: {} })
    shouldThrow = true

    await expect(gate.recover('x')).resolves.toBeUndefined()
  })

  it('tracks different keys independently', async () => {
    const sink = collectingAlertSink()
    const clock = fixedClock('2026-08-29T12:00:00Z')
    const gate = new AlertGate(sink, { now: clock.now, cooldownMs: 60_000 })

    await gate.fire('a', { severity: 'critical', title: 'A down', detail: {} })
    await gate.fire('b', { severity: 'warning', title: 'B slow', detail: {} })
    await gate.fire('a', { severity: 'critical', title: 'A down', detail: {} })

    expect(sink.sent).toHaveLength(2)
    expect(sink.sent[0]!.title).toBe('A down')
    expect(sink.sent[1]!.title).toBe('B slow')
  })
})
