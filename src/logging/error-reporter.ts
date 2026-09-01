import type { Logger } from './logger'

export interface ErrorContext {
  readonly requestId?: string
  readonly jobId?: number
  readonly userId?: string | null
  readonly route?: string
  readonly jobKind?: string
}

/**
 * Reports unexpected errors with correlation context, so the web error handler and the worker's
 * failure path can surface them without the athlete seeing anything but a generic message.
 */
export interface ErrorReporter {
  report(error: Error, context: ErrorContext): void
}

/** Logs errors through the structured logger — enough until an external error service is wired in. */
export class LoggingErrorReporter implements ErrorReporter {
  constructor(private readonly logger: Logger) {}

  report(error: Error, context: ErrorContext): void {
    this.logger.error(error.message, {
      stack: error.stack,
      ...context,
    })
  }
}
