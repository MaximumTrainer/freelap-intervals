import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_NAME = 'freelap_session'

/**
 * A signed cookie naming the athlete this request belongs to. The value is not encrypted — it
 * holds only a user id — but it is signed, so it cannot be forged.
 */
export class SessionCookie {
  constructor(
    private readonly secret: string,
    private readonly name: string = DEFAULT_NAME,
  ) {}

  issue(userId: string): string {
    const value = `${userId}.${this.signatureOf(userId)}`

    return `${this.name}=${value}; Path=/; HttpOnly; SameSite=Lax`
  }

  clear(): string {
    return `${this.name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  }

  read(cookieHeader: string | undefined | null): string | null {
    const value = parseCookies(cookieHeader)[this.name]
    if (!value) return null

    const separator = value.lastIndexOf('.')
    const userId = value.slice(0, separator)
    const signature = value.slice(separator + 1)

    return userId !== '' && this.matches(userId, signature) ? userId : null
  }

  private matches(userId: string, signature: string): boolean {
    const expected = Buffer.from(this.signatureOf(userId))
    const given = Buffer.from(signature)

    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  private signatureOf(userId: string): string {
    return createHmac('sha256', this.secret).update(userId).digest('base64url')
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
