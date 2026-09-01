import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Derives a per-session CSRF token so the same token is valid across tabs and back-button re-posts. */
export function csrfTokenFor(secret: string, identity: string): string {
  return createHmac('sha256', secret).update(identity).digest('base64url')
}

/** Constant-time comparison so a timing side-channel cannot leak valid tokens. */
export function verifyCsrfToken(secret: string, identity: string, token: string): boolean {
  const expected = Buffer.from(csrfTokenFor(secret, identity))
  const given = Buffer.from(token)

  return expected.length === given.length && timingSafeEqual(expected, given)
}

const NONCE_BYTES = 16

/** An unguessable nonce for visitors who have not yet signed in — login CSRF needs a token too. */
export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url')
}

const NONCE_COOKIE_NAME = '_csrf_nonce'

export function nonceFromCookies(cookieHeader: string | undefined | null): string | undefined {
  if (!cookieHeader) return undefined

  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim()
    if (trimmed.startsWith(`${NONCE_COOKIE_NAME}=`)) {
      return trimmed.slice(NONCE_COOKIE_NAME.length + 1)
    }
  }

  return undefined
}

export function setNonceCookie(nonce: string): string {
  return `${NONCE_COOKIE_NAME}=${nonce}; Path=/; HttpOnly; SameSite=Lax`
}

export function clearNonceCookie(): string {
  return `${NONCE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
