import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { ContactCodeError, decodeContactCode, encodeContactCode } from './contactCode.js'

test('round trips, tolerating case and whitespace', () => {
  const pk = randomBytes(32)
  const code = encodeContactCode(pk)
  assert.equal(code.length, 61)
  assert.ok(decodeContactCode(code).equals(pk))
  assert.ok(decodeContactCode(`  ${code.toUpperCase()}\n`).equals(pk))
})

test('a flipped character fails the checksum', () => {
  const code = encodeContactCode(randomBytes(32))
  const i = 10
  const swapped = code[i] === 'y' ? 'b' : 'y'
  assert.throws(() => decodeContactCode(code.slice(0, i) + swapped + code.slice(i + 1)), ContactCodeError)
})

test('wrong prefix and wrong length throw ContactCodeError', () => {
  const code = encodeContactCode(randomBytes(32))
  assert.throws(() => decodeContactCode('xyz1-' + code.slice(5)), ContactCodeError)
  assert.throws(() => decodeContactCode(code.slice(0, -1)), ContactCodeError)
})
