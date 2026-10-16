import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusEvents } from './focus.js'

test('focus reports map to gained/lost in order', () => {
  assert.deepEqual(focusEvents('\x1b[O'), [false])
  assert.deepEqual(focusEvents('a\x1b[I\x1b[O'), [true, false])
  assert.deepEqual(focusEvents('plain typing [I'), [])
})
