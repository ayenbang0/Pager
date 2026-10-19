import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusEvents, focusReporting, notifySequence } from './focus.js'

test('focus reports map to gained/lost in order', () => {
  assert.deepEqual(focusEvents('\x1b[O'), [false])
  assert.deepEqual(focusEvents('a\x1b[I\x1b[O'), [true, false])
  assert.deepEqual(focusEvents('plain typing [I'), [])
})

test('desktop notifications use the terminal-specific sequence and never leak separators or control bytes', () => {
  assert.equal(notifySequence({ TERM_PROGRAM: 'ghostty' }, 'ann', 'hi;\x1b[31m there'), '\x1b]777;notify;ann;hi  [31m there\x07')
  assert.equal(notifySequence({ TERM_PROGRAM: 'iTerm.app' }, 'ann', 'hi'), '\x1b]9;ann: hi\x07')
  assert.equal(notifySequence({ WT_SESSION: '1' }, 'ann', 'hi'), '')
})

test('terminals known to report focus are recognised, others are not trusted', () => {
  assert.equal(focusReporting({ WT_SESSION: '1' }), true)
  assert.equal(focusReporting({ TERM_PROGRAM: 'iTerm.app' }), true)
  assert.equal(focusReporting({ KITTY_WINDOW_ID: '3' }), true)
  assert.equal(focusReporting({}), false)
  assert.equal(focusReporting({ TERM_PROGRAM: 'Apple_Terminal' }), false)
})
