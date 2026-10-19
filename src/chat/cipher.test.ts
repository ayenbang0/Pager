import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FieldCipher } from './cipher.js'

const key = Buffer.alloc(32, 9)

test('sealed values carry the marker and round trip with the same AAD only', () => {
  const c = new FieldCipher(key)
  const s = c.seal('secret ✓', 'a')
  assert.match(s, /^pgrenc1:/)
  assert.ok(c.isSealed(s))
  assert.equal(c.unseal(s, 'a'), 'secret ✓')
  assert.throws(() => c.unseal(s, 'b'))
})

test('plaintext passes through, with or without a key', () => {
  assert.equal(new FieldCipher(key).unseal('plain', 'a'), 'plain')
  const none = new FieldCipher()
  assert.equal(none.seal('plain', 'a'), 'plain')
  assert.equal(none.unseal('plain', 'a'), 'plain')
})

test('a sealed value without a key throws', () => {
  const s = new FieldCipher(key).seal('x', 'a')
  assert.throws(() => new FieldCipher().unseal(s, 'a'), /passphrase is required/)
  assert.throws(() => new FieldCipher(key).unseal('pgrenc1:AAAA', 'a'), /damaged/)
})
