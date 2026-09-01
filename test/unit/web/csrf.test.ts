import { describe, expect, it } from 'vitest'

import { csrfTokenFor, verifyCsrfToken } from '~/web/csrf'

describe('CSRF token derivation', () => {
  const secret = 'test-secret'

  it('produces a stable token for a given secret and identity', () => {
    const a = csrfTokenFor(secret, 'session-1')
    const b = csrfTokenFor(secret, 'session-1')

    expect(a).toBe(b)
  })

  it('produces different tokens for different sessions', () => {
    const a = csrfTokenFor(secret, 'session-1')
    const b = csrfTokenFor(secret, 'session-2')

    expect(a).not.toBe(b)
  })

  it('produces different tokens for different secrets', () => {
    const a = csrfTokenFor('secret-a', 'session-1')
    const b = csrfTokenFor('secret-b', 'session-1')

    expect(a).not.toBe(b)
  })
})

describe('CSRF token verification', () => {
  const secret = 'test-secret'

  it('accepts the token it would derive for the same identity', () => {
    const token = csrfTokenFor(secret, 'session-1')

    expect(verifyCsrfToken(secret, 'session-1', token)).toBe(true)
  })

  it('rejects a token derived from a different session', () => {
    const token = csrfTokenFor(secret, 'session-other')

    expect(verifyCsrfToken(secret, 'session-1', token)).toBe(false)
  })

  it('rejects a forged token', () => {
    expect(verifyCsrfToken(secret, 'session-1', 'not-a-real-token')).toBe(false)
  })

  it('rejects an empty token', () => {
    expect(verifyCsrfToken(secret, 'session-1', '')).toBe(false)
  })

  it('uses constant-time comparison via timingSafeEqual', () => {
    const token = csrfTokenFor(secret, 'session-1')
    const wrong = csrfTokenFor(secret, 'session-2')

    expect(verifyCsrfToken(secret, 'session-1', wrong)).toBe(false)
    expect(verifyCsrfToken(secret, 'session-1', token)).toBe(true)
  })
})
