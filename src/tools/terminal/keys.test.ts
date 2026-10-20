import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyInput, encodeMouse } from './keys.js'

const plain = { appCursor: false, focus: false }

test('the four Alt chords belong to Pager, in both encodings', () => {
  assert.deepEqual(classifyInput('\x1b[1;3A', plain), { chord: 'prev' })
  assert.deepEqual(classifyInput('\x1b\x1b[A', plain), { chord: 'prev' })
  assert.deepEqual(classifyInput('\x1b[1;3B', plain), { chord: 'next' })
  assert.deepEqual(classifyInput('\x1b\x1b[B', plain), { chord: 'next' })
  assert.deepEqual(classifyInput('\x1bp', plain), { chord: 'palette' })
  assert.deepEqual(classifyInput('\x1bk', plain), { chord: 'blocks' })
})

test('everything else, including Ctrl chords, reaches the shell untouched', () => {
  for (const k of ['\x03', '\x04', '\x10', '\x1b[A', 'ls\r', '\x1bb', '\x1bf', '\x1b']) assert.deepEqual(classifyInput(k, plain), { pty: k })
})

test('mouse reports are removed even when glued to typed text', () => {
  assert.deepEqual(classifyInput('a\x1b[<0;3;4Mb\x1b[<0;3;4m', plain), { pty: 'ab' })
})

test('focus reports pass only when the child asked for them', () => {
  assert.deepEqual(classifyInput('\x1b[I', plain), { pty: '' })
  assert.deepEqual(classifyInput('\x1b[O', { appCursor: false, focus: true }), { pty: '\x1b[O' })
})

test('application cursor mode rewrites arrows, home and end', () => {
  const app = { appCursor: true, focus: false }
  assert.deepEqual(classifyInput('\x1b[A\x1b[D\x1b[H', app), { pty: '\x1bOA\x1bOD\x1bOH' })
  assert.deepEqual(classifyInput('\x1b[3~', app), { pty: '\x1b[3~' })
})

test('encodeMouse builds SGR reports', () => {
  assert.equal(encodeMouse('press', 3, 4), '\x1b[<0;3;4M')
  assert.equal(encodeMouse('release', 3, 4), '\x1b[<0;3;4m')
  assert.equal(encodeMouse('wheelUp', 1, 2), '\x1b[<64;1;2M')
  assert.equal(encodeMouse('wheelDown', 1, 2), '\x1b[<65;1;2M')
})
