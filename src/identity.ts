import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'hypercore-crypto'
import DHT, { type KeyPair } from 'hyperdht'
import { validName } from './wire.js'

export interface Identity {
  keyPair: KeyPair
  /** 64 lowercase hex chars. */
  pk: string
  name: string
}

interface IdentityFile {
  version: 1
  seed: string
  name: string
}

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
  if (o.version !== 1 || typeof o.seed !== 'string' || !SEED_RE.test(o.seed) || typeof o.name !== 'string') {
    throw corrupt(file)
  }
  // A stored name every peer's hello check would reject would silence this client entirely.
  return { version: 1, seed: o.seed, name: validName(o.name) ? o.name : defaultName() }
}

function writeIdentityFile(file: string, data: IdentityFile): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function toIdentity(data: IdentityFile): Identity {
  const keyPair = DHT.keyPair(Buffer.from(data.seed, 'hex'))
  return { keyPair, pk: keyPair.publicKey.toString('hex'), name: data.name }
}

export function loadOrCreateIdentity(dir: string): Identity {
  const file = path.join(dir, 'identity.json')
  if (fs.existsSync(file)) return toIdentity(readIdentityFile(file))
  const data: IdentityFile = { version: 1, seed: crypto.randomBytes(32).toString('hex'), name: defaultName() }
  writeIdentityFile(file, data)
  return toIdentity(data)
}

export function saveName(dir: string, name: string): void {
  const file = path.join(dir, 'identity.json')
  const data = readIdentityFile(file)
  writeIdentityFile(file, { ...data, name })
}
