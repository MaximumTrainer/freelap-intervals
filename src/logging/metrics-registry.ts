/**
 * In-process metrics collection, exposed as Prometheus text at `/metrics`.
 *
 * Counters, histograms and gauges — enough for the exit criterion (§8: <2% failed syncs) without
 * pulling in a metrics library.
 */
export interface MetricsRegistry {
  /** Increment a counter. */
  increment(name: string, labels?: Readonly<Record<string, string>>): void
  /** Record a histogram observation. */
  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void
  /** Set a gauge to an absolute value. */
  set(name: string, value: number, labels?: Readonly<Record<string, string>>): void
  /** Set a gauge to the value a callback returns at scrape time. */
  gauge(name: string, compute: () => number, labels?: Readonly<Record<string, string>>): void
  /** Prometheus text exposition format. */
  serialize(): string
}

const HISTOGRAM_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]

function labelKey(labels: Readonly<Record<string, string>> | undefined): string {
  if (!labels) return ''

  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')
}

function formatLabels(key: string): string {
  return key ? `{${key}}` : ''
}

interface HistogramData {
  readonly buckets: number[]
  sum: number
  count: number
}

interface GaugeCallback {
  readonly compute: () => number
  readonly labels: string
}

export class InMemoryMetricsRegistry implements MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>()
  private readonly histograms = new Map<string, Map<string, HistogramData>>()
  private readonly gauges = new Map<string, Map<string, number>>()
  private readonly gaugeCallbacks = new Map<string, GaugeCallback[]>()

  increment(name: string, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels)
    const byLabel = this.counters.get(name) ?? new Map<string, number>()
    byLabel.set(key, (byLabel.get(key) ?? 0) + 1)
    this.counters.set(name, byLabel)
  }

  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels)
    const byLabel = this.histograms.get(name) ?? new Map<string, HistogramData>()

    let data = byLabel.get(key)
    if (!data) {
      data = { buckets: HISTOGRAM_BUCKETS.map(() => 0), sum: 0, count: 0 }
      byLabel.set(key, data)
    }

    data.sum += value
    data.count += 1
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
      if (value <= HISTOGRAM_BUCKETS[i]!) data.buckets[i]!++
    }

    this.histograms.set(name, byLabel)
  }

  set(name: string, value: number, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels)
    const byLabel = this.gauges.get(name) ?? new Map<string, number>()
    byLabel.set(key, value)
    this.gauges.set(name, byLabel)
  }

  gauge(name: string, compute: () => number, labels?: Readonly<Record<string, string>>): void {
    const callbacks = this.gaugeCallbacks.get(name) ?? []
    callbacks.push({ compute, labels: labelKey(labels) })
    this.gaugeCallbacks.set(name, callbacks)
  }

  serialize(): string {
    const lines: string[] = []

    for (const [name, byLabel] of this.counters) {
      lines.push(`# TYPE ${name} counter`)
      for (const [key, value] of byLabel) {
        lines.push(`${name}${formatLabels(key)} ${value}`)
      }
    }

    for (const [name, byLabel] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`)
      for (const [key, data] of byLabel) {
        const base = key ? `,${key}` : ''
        for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
          lines.push(`${name}_bucket{le="${HISTOGRAM_BUCKETS[i]}"${base}} ${data.buckets[i]}`)
        }
        lines.push(`${name}_bucket{le="+Inf"${base}} ${data.count}`)
        lines.push(`${name}_sum${formatLabels(key)} ${data.sum}`)
        lines.push(`${name}_count${formatLabels(key)} ${data.count}`)
      }
    }

    for (const [name, byLabel] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`)
      for (const [key, value] of byLabel) {
        lines.push(`${name}${formatLabels(key)} ${value}`)
      }
    }

    for (const [name, callbacks] of this.gaugeCallbacks) {
      if (!this.gauges.has(name)) lines.push(`# TYPE ${name} gauge`)
      for (const cb of callbacks) {
        lines.push(`${name}${formatLabels(cb.labels)} ${cb.compute()}`)
      }
    }

    return lines.join('\n') + '\n'
  }
}
