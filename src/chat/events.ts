import { createHash, randomBytes } from 'node:crypto'
import crypto from 'hypercore-crypto'

export type EventKind = 'text' | 'member-add' | 'member-leave'

export interface PagerEvent {
  conv: string
  /** 64 hex chars. */
  author: string
  seq: number
  ts: number
  kind: EventKind
  body: string
  /** 128 hex chars. */
  sig: string
}

const HEX_RE = /^(?:[0-9a-f]{2})+$/

function signedBytes(e: Omit<PagerEvent, 'sig'>): Buffer {
  return Buffer.from(JSON.stringify([1, e.conv, e.author, e.seq, e.ts, e.kind, e.body]), 'utf8')
}

export function signEvent(e: Omit<PagerEvent, 'sig'>, secretKey: Buffer): PagerEvent {
  const sig = crypto.sign(signedBytes(e), secretKey).toString('hex')
  return { ...e, sig }
}

export function verifyEvent(e: PagerEvent): boolean {
  if (!HEX_RE.test(e.author) || !HEX_RE.test(e.sig)) return false
  try {
    return crypto.verify(signedBytes(e), Buffer.from(e.sig, 'hex'), Buffer.from(e.author, 'hex'))
  } catch {
    return false
  }
}

/** Same id on both sides: sha256 over the two public keys in sorted order. */
export function dmConvId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const digest = createHash('sha256').update(Buffer.from(lo, 'hex')).update(Buffer.from(hi, 'hex')).digest('hex')
  return 'dm:' + digest.slice(0, 32)
}

export function newGroupId(): string {
  return 'grp:' + randomBytes(16).toString('hex')
}
