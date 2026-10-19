import crypto from 'node:crypto'

export interface Secrets {
  identityKey: Buffer
  dbKey: Buffer
}

export interface Sealed {
  nonce: Buffer
  ct: Buffer
  tag: Buffer
}

export const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
export const MIN_PASSPHRASE = 8

/** One scrypt run yields two independent keys: the first 32 bytes lock the identity seed, the last 32 the database fields. */
export function deriveSecrets(passphrase: string, salt: Buffer): Secrets {
  const out = crypto.scryptSync(passphrase.normalize('NFKC'), salt, 64, SCRYPT)
  return { identityKey: out.subarray(0, 32), dbKey: out.subarray(32, 64) }
}

export function seal(key: Buffer, plain: Buffer, aad: string): Sealed {
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain), c.final()])
  return { nonce, ct, tag: c.getAuthTag() }
}

/** Throws when the key, the data or the AAD is wrong. */
export function open(key: Buffer, p: Sealed, aad: string): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, p.nonce)
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(p.tag)
  return Buffer.concat([d.update(p.ct), d.final()])
}
