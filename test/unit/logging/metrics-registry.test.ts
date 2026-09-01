import { describe, expect, it } from 'vitest'

import { InMemoryMetricsRegistry } from '~/logging/metrics-registry'

describe('InMemoryMetricsRegistry (R4–R5)', () => {
  it('serializes a counter in Prometheus text format', () => {
    const registry = new InMemoryMetricsRegistry()

    registry.increment('sync_outcomes_total', { result: 'success', mode: 'attach' })
    registry.increment('sync_outcomes_total', { result: 'success', mode: 'attach' })
    registry.increment('sync_outcomes_total', { result: 'failed', mode: 'create' })

    const output = registry.serialize()

    expect(output).toContain('# TYPE sync_outcomes_total counter')
    expect(output).toContain('sync_outcomes_total{mode="attach",result="success"} 2')
    expect(output).toContain('sync_outcomes_total{mode="create",result="failed"} 1')
  })

  it('serializes a histogram with buckets, sum and count', () => {
    const registry = new InMemoryMetricsRegistry()

    registry.observe('sync_duration_seconds', 0.5)
    registry.observe('sync_duration_seconds', 2.0)

    const output = registry.serialize()

    expect(output).toContain('# TYPE sync_duration_seconds histogram')
    expect(output).toContain('sync_duration_seconds_bucket{le="0.5"} 1')
    expect(output).toContain('sync_duration_seconds_bucket{le="2.5"} 2')
    expect(output).toContain('sync_duration_seconds_bucket{le="+Inf"} 2')
    expect(output).toContain('sync_duration_seconds_sum 2.5')
    expect(output).toContain('sync_duration_seconds_count 2')
  })

  it('serializes a gauge', () => {
    const registry = new InMemoryMetricsRegistry()

    registry.set('jobs_running', 3)

    const output = registry.serialize()

    expect(output).toContain('# TYPE jobs_running gauge')
    expect(output).toContain('jobs_running 3')
  })

  it('evaluates gauge callbacks at scrape time', () => {
    const registry = new InMemoryMetricsRegistry()
    let depth = 5

    registry.gauge('jobs_queued', () => depth)
    depth = 12

    const output = registry.serialize()

    expect(output).toContain('jobs_queued 12')
  })

  it('allows computing failure rate from counter labels (R7)', () => {
    const registry = new InMemoryMetricsRegistry()

    for (let i = 0; i < 97; i++) {
      registry.increment('sync_outcomes_total', { result: 'success', mode: 'attach' })
    }
    for (let i = 0; i < 3; i++) {
      registry.increment('sync_outcomes_total', { result: 'failed', mode: 'attach' })
    }

    const output = registry.serialize()
    const successLine = output.split('\n').find((l) => l.includes('result="success"'))
    const failedLine = output.split('\n').find((l) => l.includes('result="failed"'))

    expect(successLine).toContain('97')
    expect(failedLine).toContain('3')
  })
})
