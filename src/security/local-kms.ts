import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { DataKey, KeyManagementService } from './key-management'
import { UnknownKeyError } from './key-management'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

/**
 * A key service backed by master keys held in this process — the development and self-hosted
 * option. Old keys are kept so secrets sealed before a rotation can still be opened.
 */
export class LocalKeyManagementService implements KeyManagementService {
  private readonly masterKeys: Map<string, Buffer>
  private keyId: string

  constructor(masterKeys: ReadonlyMap<string, Buffer>, currentKeyId: string) {
    if (!masterKeys.has(currentKeyId)) throw new UnknownKeyError(currentKeyId)

    this.masterKeys = new Map(masterKeys)
    this.keyId = currentKeyId
  }

  /**
   * Reads master keys from the environment as `<key-id>:<base64 32-byte key>` entries, newest last.
   * Example: `FREELAP_MASTER_KEYS="key-1:...,key-2:..." FREELAP_CURRENT_KEY_ID=key-2`.
   */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): LocalKeyManagementService {
    const entries = (env.FREELAP_MASTER_KEYS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => {
        const [keyId, material] = entry.split(':')
        if (!keyId || !material) throw new Error('FREELAP_MASTER_KEYS entries must look like <key-id>:<base64 key>')

        return [keyId, decodeKey(keyId, material)] as const
      })

    if (entries.length === 0) throw new Error('FREELAP_MASTER_KEYS must hold at least one master key')

    const keys = new Map(entries)
    return new LocalKeyManagementService(keys, env.FREELAP_CURRENT_KEY_ID ?? entries.at(-1)![0])
  }

  static forTesting(): LocalKeyManagementService {
    return new LocalKeyManagementService(
      new Map([
        ['key-1', randomBytes(KEY_BYTES)],
        ['key-2', randomBytes(KEY_BYTES)],
      ]),
      'key-1',
    )
  }

  get currentKeyId(): string {
    return this.keyId
  }

  rotateTo(keyId: string): void {
    if (!this.masterKeys.has(keyId)) throw new UnknownKeyError(keyId)
    this.keyId = keyId
  }

  async generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(KEY_BYTES)

    return { plaintext, wrapped: this.wrap(plaintext) }
  }

  async unwrap(keyId: string, wrapped: string): Promise<Buffer> {
    const masterKey = this.masterKeys.get(keyId)
    if (!masterKey) throw new UnknownKeyError(keyId)

    const [iv, tag, ciphertext] = wrapped.split('~').map((part) => Buffer.from(part, 'base64url'))
    if (!iv || !tag || !ciphertext) throw new Error('The wrapped data key is malformed')

    const decipher = createDecipheriv(ALGORITHM, masterKey, iv)
    decipher.setAuthTag(tag)

    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  }

  private wrap(dataKey: Buffer): string {
    const masterKey = this.masterKeys.get(this.keyId)!
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, masterKey, iv)
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()])

    return [iv, cipher.getAuthTag(), wrapped].map((part) => part.toString('base64url')).join('~')
  }
}

function decodeKey(keyId: string, material: string): Buffer {
  const key = Buffer.from(material, 'base64')
  if (key.length !== KEY_BYTES) throw new Error(`Master key ${keyId} must be ${KEY_BYTES} bytes of base64`)

  return key
}
