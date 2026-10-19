import crypto from 'node:crypto'
import path from 'node:path'
import { Store } from '../chat/db.js'
import {
  identityLockState,
  loadOrCreateIdentity,
  lockIdentity,
  unlockIdentity,
  WrongPassphraseError,
} from '../chat/identity.js'
import { deriveSecrets, MIN_PASSPHRASE, type Secrets } from '../chat/secrets.js'
import { acquireLock, AlreadyRunningError } from '../platform/lock.js'
import { promptSecret } from '../platform/secretPrompt.js'

export interface LockIo {
  ask(question: string): Promise<string>
  out(line: string): void
}

const defaultIo: LockIo = { ask: promptSecret, out: (s) => void process.stdout.write(`${s}\n`) }

const ATTEMPTS = 3

/** Asks for the current passphrase (PAGER_PASSPHRASE is tried once first) until it opens identity.json. */
export async function unlockWithPassphrase(dir: string, salt: Buffer, env: NodeJS.ProcessEnv, io: LockIo): Promise<Secrets | undefined> {
  let fromEnv = env.PAGER_PASSPHRASE
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const pass = fromEnv !== undefined && fromEnv !== '' ? fromEnv : await io.ask('Passphrase: ')
    fromEnv = undefined
    const secrets = deriveSecrets(pass, salt)
    try {
      loadOrCreateIdentity(dir, secrets)
      return secrets
    } catch (err) {
      if (!(err instanceof WrongPassphraseError)) throw err
      io.out('Wrong passphrase.')
    }
  }
  return undefined
}

function acquire(dir: string, io: LockIo): (() => void) | undefined {
  try {
    return acquireLock(dir)
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      io.out(`pager is running (pid ${err.pid}). Quit it, then try again.`)
      return undefined
    }
    throw err
  }
}

export async function runLock(dir: string, env: NodeJS.ProcessEnv, io: LockIo = defaultIo): Promise<number> {
  const release = acquire(dir, io)
  if (release === undefined) return 1
  try {
    const state = identityLockState(dir)
    if (!state.exists) {
      io.out('No identity yet. Start pager once, then run `pager lock`.')
      return 1
    }
    const dbFile = path.join(dir, 'pager.db')
    let old: Secrets | undefined
    if (state.locked) {
      old = await unlockWithPassphrase(dir, state.salt!, env, io)
      if (old === undefined) return 1
    }
    const first = await io.ask('New passphrase: ')
    if (first.normalize('NFKC').length < MIN_PASSPHRASE) {
      io.out(`Use at least ${MIN_PASSPHRASE} characters.`)
      return 1
    }
    if ((await io.ask('Repeat passphrase: ')) !== first) {
      io.out('The passphrases do not match.')
      return 1
    }
    if (old !== undefined) {
      const open = new Store(dbFile, old.dbKey)
      try {
        open.decryptAll()
      } finally {
        open.close()
      }
    }
    const salt = crypto.randomBytes(16)
    const secrets = deriveSecrets(first, salt)
    // Identity first: until the database is sealed too, the half-done state still opens (plaintext passes through).
    lockIdentity(dir, secrets, salt, old)
    const store = new Store(dbFile, secrets.dbKey)
    try {
      store.encryptAll()
    } finally {
      store.close()
    }
    io.out('Encrypted. History, group titles and contact names are encrypted with your passphrase. If you forget it they cannot be recovered.')
    return 0
  } finally {
    release()
  }
}

export async function runUnlock(dir: string, env: NodeJS.ProcessEnv, io: LockIo = defaultIo): Promise<number> {
  const release = acquire(dir, io)
  if (release === undefined) return 1
  try {
    const state = identityLockState(dir)
    if (!state.locked) {
      io.out('pager is not locked.')
      return 0
    }
    const secrets = await unlockWithPassphrase(dir, state.salt!, env, io)
    if (secrets === undefined) return 1
    // Database first: if this stops half way the identity is still locked and the database still opens.
    const store = new Store(path.join(dir, 'pager.db'), secrets.dbKey)
    try {
      store.decryptAll()
    } finally {
      store.close()
    }
    unlockIdentity(dir, secrets)
    io.out('Decrypted.')
    return 0
  } finally {
    release()
  }
}
