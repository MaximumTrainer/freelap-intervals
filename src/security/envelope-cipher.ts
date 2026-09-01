import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { KeyManagementService } from './key-management'
import { Secret } from './secret'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const VERSION = 'v1'
const PART_COUNT = 6

/**
 * Envelope encryption: every secret gets its own data key, that key is wrapped by the key service,
 * and the two travel together as one self-describing string:
 *
 *     v1.<key-id>.<wrapped data key>.<iv>.<auth tag>.<ciphertext>
 *
 * Because the envelope names the key that sealed it, a rotated master key does not strand the
 * secrets sealed before the rotation.
 */
export class EnvelopeCipher {
  constructor(private readonly kms: KeyManagementService) {}

  /** The key id that new seals are made under. */
  get currentKeyId(): string {
    return this.kms.currentKeyId
  }

  async seal(plaintext: string): Promise<string> {
    const dataKey = await this.kms.generateDataKey()
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, dataKey.plaintext, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

    return [
      VERSION,
      this.kms.currentKeyId,
      dataKey.wrapped,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.')
  }

  async open(envelope: string): Promise<Secret> {
    const [version, keyId, wrappedKey, iv, tag, ciphertext] = envelope.split('.')

    if (version !== VERSION || envelope.split('.').length !== PART_COUNT || !keyId || !wrappedKey || !iv || !tag || !ciphertext) {
      throw new Error('That is not a sealed envelope this version can read')
    }

    const dataKey = await this.kms.unwrap(keyId, wrappedKey)
    const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))

    try {
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()])
      return new Secret(plaintext.toString('utf8'))
    } catch (cause) {
      throw new Error('The sealed secret could not be opened; it may have been altered', { cause })
    }
  }

  /** Re-seals a secret under the current key, without it ever leaving this process. */
  async reseal(envelope: string): Promise<string> {
    return this.seal((await this.open(envelope)).reveal())
  }
}
