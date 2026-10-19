import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applySecretInput } from './secretPrompt.js'

test('typing accumulates, Backspace removes one character, Enter finishes', () => {
  let r = applySecretInput('', 'abc')
  assert.deepEqual(r, { text: 'abc', done: false, cancelled: false })
  r = applySecretInput(r.text, '\u007f')
  assert.equal(r.text, 'ab')
  r = applySecretInput(r.text, 'é😀\u007f')
  assert.equal(r.text, 'abé')
  r = applySecretInput(r.text, 'x\r')
  assert.deepEqual(r, { text: 'abéx', done: true, cancelled: false })
})

test('Ctrl+C cancels and control characters are ignored', () => {
  assert.equal(applySecretInput('ab', '\u0003').cancelled, true)
  assert.equal(applySecretInput('', '\u001b[A').text, '[A')
  assert.equal(applySecretInput('', '\t').text, '')
  assert.equal(applySecretInput('', '\u007f').text, '')
})
