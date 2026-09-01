import { describe, expect, it } from 'vitest'

import { SessionCookie } from '~/web/session-cookie'

describe('SessionCookie', () => {
  const cookie = new SessionCookie('test-secret', { secure: true })
  const sessionId = '550e8400-e29b-41d4-a716-446655440000'
  const issuedAtMs = new Date('2026-08-29T12:00:00Z').getTime()

  it('issues a cookie with Secure, HttpOnly, SameSite=Lax, and Max-Age', () => {
    const header = cookie.issue(sessionId, issuedAtMs)

    expect(header).toContain('freelap_session=')
    expect(header).toContain('Secure')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Max-Age=')
    expect(header).toContain('Path=/')
  })

  it('omits Secure when configured for local development', () => {
    const insecure = new SessionCookie('test-secret', { secure: false })
    const header = insecure.issue(sessionId, issuedAtMs)

    expect(header).not.toContain('Secure')
    expect(header).toContain('HttpOnly')
  })

  it('reads back a valid session id from its own cookie', () => {
    const header = cookie.issue(sessionId, issuedAtMs)
    const value = header.split(';')[0]!

    const nowMs = issuedAtMs + 60 * 1000
    expect(cookie.read(value, nowMs)).toBe(sessionId)
  })

  it('rejects a cookie with a forged signature', () => {
    const forged = `freelap_session=${sessionId}.${issuedAtMs}.forged-signature`

    expect(cookie.read(forged, issuedAtMs)).toBeNull()
  })

  it('rejects a cookie whose embedded timestamp is older than the max age', () => {
    const header = cookie.issue(sessionId, issuedAtMs)
    const value = header.split(';')[0]!
    const thirtyOneDaysLater = issuedAtMs + 31 * 24 * 60 * 60 * 1000

    expect(cookie.read(value, thirtyOneDaysLater)).toBeNull()
  })

  it('accepts a cookie just inside the max age boundary', () => {
    const header = cookie.issue(sessionId, issuedAtMs)
    const value = header.split(';')[0]!
    const justUnderThirtyDays = issuedAtMs + 29 * 24 * 60 * 60 * 1000

    expect(cookie.read(value, justUnderThirtyDays)).toBe(sessionId)
  })

  it('rejects an empty or missing cookie header', () => {
    expect(cookie.read(null, issuedAtMs)).toBeNull()
    expect(cookie.read(undefined, issuedAtMs)).toBeNull()
    expect(cookie.read('', issuedAtMs)).toBeNull()
  })

  it('clears the cookie with Max-Age=0', () => {
    expect(cookie.clear()).toContain('Max-Age=0')
  })
})
