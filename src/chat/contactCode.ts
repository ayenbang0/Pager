import { createHash } from 'node:crypto'
import * as z32 from 'z32'

export class ContactCodeError extends Error {}

const PREFIX = 'pgr1-'
const KEY_CHARS = 52 // z32 of 32 bytes
const SUM_CHARS = 4 // z32 of 2 bytes (16 bits -> 4 chars of 5 bits, rounded up)
const Z32_ALPHABET = /^[ybndrfg8ejkmcpqxot1uwisza345h769]+$/

function checksum(pk: Buffer): string {
  return z32.encode(createHash('sha256').update(pk).digest().subarray(0, 2))
}

/** `pgr1-` + z32(pk) + z32(sha256(pk)[0..2]) => 61 chars. */
export function encodeContactCode(pk: Buffer): string {
  if (pk.length !== 32) throw new ContactCodeError('Public key must be 32 bytes')
  return PREFIX + z32.encode(pk) + checksum(pk)
}

export function decodeContactCode(code: string): Buffer {
  const s = code.trim().toLowerCase()
  if (!s.startsWith(PREFIX)) throw new ContactCodeError('Not a pager contact code (expected pgr1-…)')
  const body = s.slice(PREFIX.length)
  if (body.length !== KEY_CHARS + SUM_CHARS) throw new ContactCodeError('Contact code has the wrong length')
  if (!Z32_ALPHABET.test(body)) throw new ContactCodeError('Contact code has invalid characters')
  const pk = z32.decode(body.slice(0, KEY_CHARS))
  if (pk.length !== 32) throw new ContactCodeError('Contact code has the wrong length')
  if (checksum(pk) !== body.slice(KEY_CHARS)) throw new ContactCodeError('Contact code checksum mismatch (typo?)')
  return pk
}
