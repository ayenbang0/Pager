import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { identityLockState, loadOrCreateIdentity, LockedError, lockIdentity, saveName, unlockIdentity, WrongPassphraseError } from './identity.js'
import { deriveSecrets } from './secrets.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'

const tmp = (): string => tmpDir('pager-id-')

test('identity is stable and saveName keeps the key', () => {
  const dir = tmp()
  const a = loadOrCreateIdentity(dir)
  const b = loadOrCreateIdentity(dir)
  assert.equal(a.pk, b.pk)
  assert.equal(a.pk.length, 64)
  saveName(dir, 'zed')
  const c = loadOrCreateIdentity(dir)
  assert.equal(c.pk, a.pk)
  assert.equal(c.name, 'zed')
})

test('corrupt identity.json throws and is left untouched', () => {
  const dir = tmp()
  const file = path.join(dir, 'identity.json')
  fs.writeFileSync(file, '{nope')
  assert.throws(() => loadOrCreateIdentity(dir), /corrupt/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{nope')
})

test('a stored name that no hello frame would accept falls back to the default', () => {
  for (const bad of ['', 'x'.repeat(80), 'bell\x07']) {
    const dir = tmp()
    const file = path.join(dir, 'identity.json')
    loadOrCreateIdentity(dir)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...data, name: bad }))
    const name = loadOrCreateIdentity(dir).name
    assert.ok(name.length > 0 && name.length <= 64 && !/\p{Cc}/u.test(name), JSON.stringify(bad))
  }
})

after(removeTmpDirs)

test('lock seals the seed (v2), loads with the key only, and unlock restores plaintext', () => {
  const dir = tmp()
  const file = path.join(dir, 'identity.json')
  const before = loadOrCreateIdentity(dir)
  assert.deepEqual(identityLockState(dir), { exists: true, locked: false })
  const salt = Buffer.alloc(16, 3)
  const secrets = deriveSecrets('correct-horse', salt)
  lockIdentity(dir, secrets, salt)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.version, 2)
  assert.equal(raw.seed.length, 64)
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(Buffer.from(before.keyPair.secretKey.subarray(0, 32)).toString('hex')))
  const state = identityLockState(dir)
  assert.equal(state.locked, true)
  assert.deepEqual(state.salt, salt)
  assert.throws(() => loadOrCreateIdentity(dir), LockedError)
  assert.throws(() => loadOrCreateIdentity(dir, deriveSecrets('wrong-pass-1', salt)), WrongPassphraseError)
  assert.equal(loadOrCreateIdentity(dir, secrets).pk, before.pk)
  saveName(dir, 'zed')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2)
  assert.equal(loadOrCreateIdentity(dir, secrets).name, 'zed')
  // re-lock with a new passphrase
  const salt2 = Buffer.alloc(16, 4)
  const secrets2 = deriveSecrets('battery-staple', salt2)
  lockIdentity(dir, secrets2, salt2, secrets)
  assert.equal(loadOrCreateIdentity(dir, secrets2).pk, before.pk)
  unlockIdentity(dir, secrets2)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1)
  assert.equal(loadOrCreateIdentity(dir).pk, before.pk)
  assert.equal(loadOrCreateIdentity(dir).name, 'zed')
})
