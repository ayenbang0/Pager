import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'hypercore-crypto'
import DHT, { type KeyPair } from 'hyperdht'
import { validName } from '../net/wire.js'
import { open, seal, type Secrets } from './secrets.js'

export interface Identity {
  keyPair: KeyPair
  /** 64 lowercase hex chars. */
  pk: string
  name: string
}

interface IdentityFileV1 {
  version: 1
  seed: string
  name: string
}

/** The seed is sealed with the passphrase-derived identity key (AES-256-GCM); the name stays readable. */
export interface IdentityFileV2 {
  version: 2
  name: string
  kdf: 'scrypt'
  /** 32 hex. */
  salt: string
  /** 24 hex. */
  nonce: string
  /** 64 hex ciphertext. */
  seed: string
  /** 32 hex. */
  tag: string
}

type IdentityFile = IdentityFileV1 | IdentityFileV2

export class LockedError extends Error {
  constructor() {
    super('identity.json is locked: a passphrase is required')
  }
}
export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase.')
  }
}

const SEED_AAD = 'pager-identity-seed'
const SEED_RE = /^[0-9a-f]{64}$/

function defaultName(): string {
  let raw = ''
  try {
    raw = os.userInfo().username
  } catch {
    raw = ''
  }
  const cleaned = raw.replace(/\p{Cc}/gu, '').slice(0, 64).trim()
  return cleaned || 'anon'
}

function corrupt(file: string): Error {
  return new Error(
    `identity.json is corrupt: ${file}. Move it away to create a new identity (contacts must re-add you).`,
  )
}

function readIdentityFile(file: string): IdentityFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw corrupt(file)
  }
  if (typeof parsed !== 'object' || parsed === null) throw corrupt(file)
  const o = parsed as Record<string, unknown>
  if (typeof o.name !== 'string' || typeof o.seed !== 'string') throw corrupt(file)
  // A stored name every peer's hello check would reject would silence this client entirely.
  const name = validName(o.name) ? o.name : defaultName()
  if (o.version === 1 && SEED_RE.test(o.seed)) return { version: 1, seed: o.seed, name }
  if (
    o.version === 2 && o.kdf === 'scrypt' && typeof o.salt === 'string' && /^[0-9a-f]{32}$/.test(o.salt) &&
    typeof o.nonce === 'string' && /^[0-9a-f]{24}$/.test(o.nonce) && /^[0-9a-f]{64}$/.test(o.seed) &&
    typeof o.tag === 'string' && /^[0-9a-f]{32}$/.test(o.tag)
  ) {
    return { version: 2, name, kdf: 'scrypt', salt: o.salt, nonce: o.nonce, seed: o.seed, tag: o.tag }
  }
  throw corrupt(file)
}

function writeIdentityFile(file: string, data: IdentityFile): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function toIdentity(seedHex: string, name: string): Identity {
  const keyPair = DHT.keyPair(Buffer.from(seedHex, 'hex'))
  return { keyPair, pk: keyPair.publicKey.toString('hex'), name }
}

function seedOf(data: IdentityFile, secrets: Secrets | undefined): string {
  if (data.version === 1) return data.seed
  if (secrets === undefined) throw new LockedError()
  try {
    return open(secrets.identityKey, { nonce: Buffer.from(data.nonce, 'hex'), ct: Buffer.from(data.seed, 'hex'), tag: Buffer.from(data.tag, 'hex') }, SEED_AAD).toString('hex')
  } catch {
    throw new WrongPassphraseError()
  }
}

export function identityLockState(dir: string): { exists: boolean; locked: boolean; salt?: Buffer } {
  const file = path.join(dir, 'identity.json')
  if (!fs.existsSync(file)) return { exists: false, locked: false }
  const data = readIdentityFile(file)
  return data.version === 2 ? { exists: true, locked: true, salt: Buffer.from(data.salt, 'hex') } : { exists: true, locked: false }
}

export function loadOrCreateIdentity(dir: string, secrets?: Secrets): Identity {
  const file = path.join(dir, 'identity.json')
  if (fs.existsSync(file)) {
    const data = readIdentityFile(file)
    return toIdentity(seedOf(data, secrets), data.name)
  }
  const data: IdentityFileV1 = { version: 1, seed: crypto.randomBytes(32).toString('hex'), name: defaultName() }
  if (secrets === undefined) {
    writeIdentityFile(file, data)
  } else {
    const salt = crypto.randomBytes(16)
    // New identities created while a key is supplied are written locked from the start.
    writeIdentityFile(file, sealedFile(data.seed, data.name, secrets, salt))
  }
  return toIdentity(data.seed, data.name)
}

function sealedFile(seedHex: string, name: string, secrets: Secrets, salt: Buffer): IdentityFileV2 {
  const sealed = seal(secrets.identityKey, Buffer.from(seedHex, 'hex'), SEED_AAD)
  return { version: 2, name, kdf: 'scrypt', salt: salt.toString('hex'), nonce: sealed.nonce.toString('hex'), seed: sealed.ct.toString('hex'), tag: sealed.tag.toString('hex') }
}

/** Rewrites identity.json as v2 (from v1, or from v2 sealed with `from`). Atomic: tmp + rename. */
export function lockIdentity(dir: string, secrets: Secrets, salt: Buffer, from?: Secrets): void {
  const file = path.join(dir, 'identity.json')
  const data = readIdentityFile(file)
  writeIdentityFile(file, sealedFile(seedOf(data, from), data.name, secrets, salt))
}

/** Rewrites identity.json as plaintext v1. */
export function unlockIdentity(dir: string, secrets: Secrets): void {
  const file = path.join(dir, 'identity.json')
  const data = readIdentityFile(file)
  if (data.version === 1) return
  writeIdentityFile(file, { version: 1, seed: seedOf(data, secrets), name: data.name })
}

export function saveName(dir: string, name: string): void {
  const file = path.join(dir, 'identity.json')
  const data = readIdentityFile(file)
  writeIdentityFile(file, { ...data, name })
}
