import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveSecrets, open, seal } from './secrets.js'

const salt = Buffer.alloc(16, 7)

test('deriveSecrets is deterministic, splits into two keys and NFKC-normalizes', () => {
  const a = deriveSecrets('correct-horse', salt)
  const b = deriveSecrets('correct-horse', salt)
  assert.deepEqual(a.identityKey, b.identityKey)
  assert.equal(a.identityKey.length, 32)
  assert.equal(a.dbKey.length, 32)
  assert.notDeepEqual(a.identityKey, a.dbKey)
  assert.deepEqual(deriveSecrets('ﬁsh-and-chips', salt).dbKey, deriveSecrets('fish-and-chips', salt).dbKey)
  assert.notDeepEqual(deriveSecrets('other-pass', salt).dbKey, a.dbKey)
})

test('seal/open round trip; wrong key, wrong AAD or tampering throws', () => {
  const { dbKey, identityKey } = deriveSecrets('correct-horse', salt)
  const s = seal(dbKey, Buffer.from('hello'), 'aad')
  assert.equal(open(dbKey, s, 'aad').toString(), 'hello')
  assert.throws(() => open(identityKey, s, 'aad'))
  assert.throws(() => open(dbKey, s, 'other'))
  assert.throws(() => open(dbKey, { ...s, ct: Buffer.from(s.ct.map((x) => x ^ 1)) }, 'aad'))
  assert.notDeepEqual(seal(dbKey, Buffer.from('hello'), 'aad').nonce, s.nonce)
})
