import type { Logger } from '~/logging/logger'

import type { Alert, AlertSink } from './alert-sink'

/** Writes alerts to the structured logger. The default transport for development. */
export class LoggingAlertSink implements AlertSink {
  constructor(private readonly logger: Logger) {}

  async notify(alert: Alert): Promise<void> {
    const log = alert.severity === 'critical'
      ? this.logger.error.bind(this.logger)
      : alert.severity === 'warning'
        ? this.logger.warn.bind(this.logger)
        : this.logger.info.bind(this.logger)

    log(alert.title, alert.detail)
  }
}
