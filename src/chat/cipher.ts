import { open, seal } from './secrets.js'

const MARK = 'pgrenc1:'
const NONCE = 12
const TAG = 16

/** Seals database text fields. Without a key everything passes through, and unsealed values always read back unchanged so a migration can resume after a crash. */
export class FieldCipher {
  constructor(private readonly key?: Buffer) {}

  get enabled(): boolean {
    return this.key !== undefined
  }

  isSealed(stored: string): boolean {
    return stored.startsWith(MARK)
  }

  seal(plain: string, aad: string): string {
    if (this.key === undefined) return plain
    const s = seal(this.key, Buffer.from(plain, 'utf8'), aad)
    return MARK + Buffer.concat([s.nonce, s.ct, s.tag]).toString('base64')
  }

  unseal(stored: string, aad: string): string {
    if (!this.isSealed(stored)) return stored
    if (this.key === undefined) throw new Error('pager.db is encrypted: a passphrase is required')
    const raw = Buffer.from(stored.slice(MARK.length), 'base64')
    if (raw.length < NONCE + TAG) throw new Error('pager.db has a damaged encrypted field')
    const plain = open(this.key, { nonce: raw.subarray(0, NONCE), ct: raw.subarray(NONCE, raw.length - TAG), tag: raw.subarray(raw.length - TAG) }, aad)
    return plain.toString('utf8')
  }
}
