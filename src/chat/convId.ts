import { createHash, randomBytes } from 'node:crypto'

// Conversation ids need no signing keys, so they live apart from events.ts: the daemon computes them without loading the native crypto addons.

/** Same id on both sides: sha256 over the two public keys in sorted order. */
export function dmConvId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const digest = createHash('sha256').update(Buffer.from(lo, 'hex')).update(Buffer.from(hi, 'hex')).digest('hex')
  return 'dm:' + digest.slice(0, 32)
}

export function newGroupId(): string {
  return 'grp:' + randomBytes(16).toString('hex')
}
