import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ctrlH, watchCtrlH } from './ctrlH.js'

test('only a lone 0x08 byte is Ctrl+H; Backspace (0x7f) and typed text are not', () => {
  let homes = 0
  const stop = watchCtrlH(() => homes++)
  process.stdin.emit('data', Buffer.from('\x7f'))
  process.stdin.emit('data', Buffer.from('abc\x08'))
  assert.equal(homes, 0)
  process.stdin.emit('data', Buffer.from('\x08'))
  assert.equal(homes, 1)
  assert.equal(ctrlH.pending, true, 'Backspace handlers ignore the same keypress')
  stop()
  process.stdin.pause() // a 'data' listener starts the stream flowing, which would keep the test process alive
  process.stdin.emit('data', Buffer.from('\x08'))
  assert.equal(homes, 1)
})
