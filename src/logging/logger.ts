export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Structured, levelled logging with context propagation and secret redaction.
 *
 * Every log line carries a level, a message and optional structured fields. A `child()` call pins
 * fields for a scope — a request id, a job id — so downstream code logs naturally while the
 * correlation fields appear on every line.
 */
export interface Logger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void
  info(message: string, context?: Readonly<Record<string, unknown>>): void
  warn(message: string, context?: Readonly<Record<string, unknown>>): void
  error(message: string, context?: Readonly<Record<string, unknown>>): void
  /** Returns a logger that prepends `fields` to every entry. */
  child(fields: Readonly<Record<string, unknown>>): Logger
}

/** Sensitive field names whose values must never appear in log output. */
export const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'password',
  'secret',
  'cookie',
  'authorization',
  'email',
  'credential',
  'credentials',
  'clientSecret',
  'cookieSecret',
  'csrfSecret',
  'webhookSecret',
  'sessionCookie',
])

const REDACTED = '[REDACTED]'

/** Recursively redacts values whose keys match the sensitive-field set. */
export function redact(value: unknown, fields: ReadonlySet<string> = REDACTED_FIELDS): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, fields))
  }

  const result: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = fields.has(key) ? REDACTED : redact(val, fields)
  }

  return result
}

/** A logger that silently discards everything. Useful in tests that don't assert on logs. */
export class NullLogger implements Logger {
  debug(_message: string, _context?: Readonly<Record<string, unknown>>): void { /* no-op */ }
  info(_message: string, _context?: Readonly<Record<string, unknown>>): void { /* no-op */ }
  warn(_message: string, _context?: Readonly<Record<string, unknown>>): void { /* no-op */ }
  error(_message: string, _context?: Readonly<Record<string, unknown>>): void { /* no-op */ }

  child(_fields: Readonly<Record<string, unknown>>): Logger {
    return this
  }
}
