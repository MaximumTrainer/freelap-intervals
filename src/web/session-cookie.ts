import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_NAME = 'freelap_session'
const DEFAULT_MAX_AGE_S = 30 * 24 * 60 * 60

export interface SessionCookieOptions {
  readonly name?: string
  readonly secure?: boolean
  readonly maxAgeS?: number
}

/**
 * A signed cookie carrying an opaque session id and an issue timestamp. The signature prevents
 * forgery; the embedded timestamp lets the server reject expired cookies before hitting the
 * database. The session id maps back to a user via the sessions table.
 */
export class SessionCookie {
  private readonly name: string
  private readonly secure: boolean
  private readonly maxAgeS: number

  constructor(
    private readonly secret: string,
    options?: SessionCookieOptions,
  ) {
    this.name = options?.name ?? DEFAULT_NAME
    this.secure = options?.secure ?? true
    this.maxAgeS = options?.maxAgeS ?? DEFAULT_MAX_AGE_S
  }

  issue(sessionId: string, issuedAtMs: number): string {
    const payload = `${sessionId}.${issuedAtMs}`
    const value = `${payload}.${this.signatureOf(payload)}`
    const parts = [
      `${this.name}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${this.maxAgeS}`,
    ]

    if (this.secure) parts.push('Secure')

    return parts.join('; ')
  }

  clear(): string {
    return `${this.name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  }

  /**
   * Verifies the signature and checks the embedded timestamp against the cookie's max age.
   * Returns the session id if valid, null otherwise — expired, forged, and missing cookies
   * are indistinguishable to the caller.
   */
  read(cookieHeader: string | undefined | null, nowMs: number): string | null {
    const value = parseCookies(cookieHeader)[this.name]
    if (!value) return null

    const lastDot = value.lastIndexOf('.')
    const payload = value.slice(0, lastDot)
    const signature = value.slice(lastDot + 1)

    if (!payload || !this.matches(payload, signature)) return null

    const dotInPayload = payload.indexOf('.')
    const sessionId = payload.slice(0, dotInPayload)
    const issuedAtMs = Number(payload.slice(dotInPayload + 1))

    if (!sessionId || Number.isNaN(issuedAtMs)) return null
    if (nowMs - issuedAtMs > this.maxAgeS * 1000) return null

    return sessionId
  }

  private matches(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.signatureOf(payload))
    const given = Buffer.from(signature)

    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  private signatureOf(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }
}

export function parseCookies(header: string | undefined | null): Record<string, string> {
  return Object.fromEntries(
    (header ?? '')
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => pair.includes('='))
      .map((pair) => {
        const separator = pair.indexOf('=')
        return [pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1))]
      }),
  )
}
