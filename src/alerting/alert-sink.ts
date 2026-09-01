/** The severity of an alert: critical needs immediate attention, warning can wait, recovery clears a previous alert. */
export type AlertSeverity = 'warning' | 'critical' | 'recovery'

export interface Alert {
  readonly severity: AlertSeverity
  readonly title: string
  readonly detail: Record<string, unknown>
}

/** Where alerts go. At least two implementations: one that logs, one that POSTs to a webhook. */
export interface AlertSink {
  notify(alert: Alert): Promise<void>
}
