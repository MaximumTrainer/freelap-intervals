import { describe, expect, it } from 'vitest'

import { EnvelopeCipher } from '~/security/envelope-cipher'
import { LocalKeyManagementService } from '~/security/local-kms'
import { Secret } from '~/security/secret'

const aCipher = (kms = LocalKeyManagementService.forTesting()) => new EnvelopeCipher(kms)

describe('EnvelopeCipher', () => {
  it('opens what it sealed', async () => {
    const cipher = aCipher()

    const envelope = await cipher.seal('my-freelap-password')

    expect(await cipher.open(envelope)).toEqual(new Secret('my-freelap-password'))
  })

  it('never lets the plaintext appear in the envelope', async () => {
    const envelope = await aCipher().seal('correct-horse-battery-staple')

    expect(envelope).not.toContain('correct-horse')
    expect(Buffer.from(envelope).toString('base64')).not.toContain('correct-horse')
  })

  it('seals the same secret differently every time', async () => {
    const cipher = aCipher()

    expect(await cipher.seal('same')).not.toBe(await cipher.seal('same'))
  })

  it('refuses an envelope whose ciphertext was altered', async () => {
    const cipher = aCipher()
    const envelope = await cipher.seal('my-freelap-password')

    await expect(cipher.open(tamperedWith(envelope))).rejects.toThrow(/could not be opened/i)
  })

  it('refuses an envelope it does not recognise', async () => {
    await expect(aCipher().open('not-an-envelope')).rejects.toThrow(/envelope/i)
  })

  it('seals under the current key while still opening secrets sealed under the old one', async () => {
    const kms = LocalKeyManagementService.forTesting()
    const sealedBefore = await aCipher(kms).seal('old-secret')

    kms.rotateTo('key-2')
    const sealedAfter = await aCipher(kms).seal('new-secret')

    expect(sealedBefore).toContain('key-1')
    expect(sealedAfter).toContain('key-2')
    expect((await aCipher(kms).open(sealedBefore)).reveal()).toBe('old-secret')
    expect((await aCipher(kms).open(sealedAfter)).reveal()).toBe('new-secret')
  })

  it('re-seals an existing envelope under the current key', async () => {
    const kms = LocalKeyManagementService.forTesting()
    const cipher = aCipher(kms)
    const original = await cipher.seal('rotate-me')

    kms.rotateTo('key-2')
    const rotated = await cipher.reseal(original)

    expect(rotated).toContain('key-2')
    expect((await cipher.open(rotated)).reveal()).toBe('rotate-me')
  })
})

describe('Secret', () => {
  it('hides itself from logs, string interpolation and JSON', () => {
    const secret = new Secret('hunter2')

    expect(`${secret}`).toBe('[redacted]')
    expect(JSON.stringify({ password: secret })).toBe('{"password":"[redacted]"}')
    expect(String(secret)).not.toContain('hunter2')
  })

  it('gives up its value only when asked outright', () => {
    expect(new Secret('hunter2').reveal()).toBe('hunter2')
  })

  it('compares by value without leaking it', () => {
    expect(new Secret('a')).toEqual(new Secret('a'))
    expect(new Secret('a')).not.toEqual(new Secret('b'))
  })
})

function tamperedWith(envelope: string): string {
  const parts = envelope.split('.')
  const ciphertext = Buffer.from(parts.at(-1)!, 'base64url')
  ciphertext[0] = (ciphertext[0]! + 1) % 256

  return [...parts.slice(0, -1), ciphertext.toString('base64url')].join('.')
}
