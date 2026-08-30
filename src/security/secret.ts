const REDACTED = '[redacted]'

/**
 * A value that must never reach a log line. It hides itself from string interpolation, JSON and
 * console output; the only way to the plaintext is to ask for it by name.
 */
export class Secret {
  constructor(private readonly value: string) {}

  reveal(): string {
    return this.value
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED
  }
}
