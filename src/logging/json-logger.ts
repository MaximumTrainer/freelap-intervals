import type { LogLevel, Logger } from './logger'
import { REDACTED_FIELDS, redact } from './logger'

export interface JsonLoggerOptions {
  readonly level?: LogLevel
  readonly write?: (line: string) => void
  readonly now?: () => Date
  readonly redactedFields?: ReadonlySet<string>
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Structured JSON logger: one JSON object per line, sensitive values redacted before serialisation.
 *
 * In production, pipe stdout to whatever log aggregator you like. In development, the human-readable
 * formatting is a thin wrapper around this; the data shape stays identical.
 */
export class JsonLogger implements Logger {
  private readonly minLevel: number
  private readonly write: (line: string) => void
  private readonly now: () => Date
  private readonly fields: Readonly<Record<string, unknown>>
  private readonly redactedFields: ReadonlySet<string>

  constructor(options: JsonLoggerOptions = {}, fields: Readonly<Record<string, unknown>> = {}) {
    this.minLevel = LEVEL_ORDER[options.level ?? 'debug']
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`))
    this.now = options.now ?? (() => new Date())
    this.fields = fields
    this.redactedFields = options.redactedFields ?? REDACTED_FIELDS
  }

  debug(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.log('debug', message, context)
  }

  info(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.log('info', message, context)
  }

  warn(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.log('warn', message, context)
  }

  error(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.log('error', message, context)
  }

  child(fields: Readonly<Record<string, unknown>>): Logger {
    return new JsonLogger(
      { level: this.levelName(), write: this.write, now: this.now, redactedFields: this.redactedFields },
      { ...this.fields, ...fields },
    )
  }

  private log(level: LogLevel, message: string, context?: Readonly<Record<string, unknown>>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return

    const entry = {
      timestamp: this.now().toISOString(),
      level,
      message,
      ...this.fields,
      ...context,
    }

    this.write(JSON.stringify(redact(entry, this.redactedFields)))
  }

  private levelName(): LogLevel {
    const entries = Object.entries(LEVEL_ORDER) as ReadonlyArray<[LogLevel, number]>
    const found = entries.find(([, order]) => order === this.minLevel)

    return found?.[0] ?? 'debug'
  }
}
