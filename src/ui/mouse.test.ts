import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wheelEvents } from './mouse.js'

test('wheel up and down map to older and newer', () => {
  assert.deepEqual(wheelEvents('\x1b[<64;10;5M'), [1])
  assert.deepEqual(wheelEvents('\x1b[<65;10;5M'), [-1])
})

test('a burst of events in one chunk yields one entry each, in order', () => {
  assert.deepEqual(wheelEvents('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M'), [1, 1, -1])
})

test('modifier bits do not hide the wheel; clicks, releases and horizontal wheels are ignored', () => {
  assert.deepEqual(wheelEvents('\x1b[<68;3;3M'), [1]) // shift+wheel up
  assert.deepEqual(wheelEvents('\x1b[<0;3;3M\x1b[<0;3;3m'), [])
  assert.deepEqual(wheelEvents('\x1b[<66;3;3M\x1b[<67;3;3M'), [])
  assert.deepEqual(wheelEvents('plain typing'), [])
})
