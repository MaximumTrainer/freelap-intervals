export interface DataKey {
  /** The key used to encrypt one secret; never stored. */
  readonly plaintext: Buffer
  /** The same key, encrypted by the master key, safe to store beside the ciphertext. */
  readonly wrapped: string
}

/**
 * Wraps and unwraps per-secret data keys. A cloud KMS implementation swaps in here; the master
 * key never leaves the service, and only wrapped data keys are ever persisted.
 */
export interface KeyManagementService {
  /** The key new secrets are wrapped under. */
  readonly currentKeyId: string
  generateDataKey(): Promise<DataKey>
  unwrap(keyId: string, wrapped: string): Promise<Buffer>
}

export class UnknownKeyError extends Error {
  constructor(keyId: string) {
    super(`No master key ${keyId} is available to unwrap this secret`)
    this.name = 'UnknownKeyError'
  }
}
