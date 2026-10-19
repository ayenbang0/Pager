import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MOUSE_OFF, MOUSE_ON, mouseEvents, wheelEvents } from './mouse.js'

test('wheel up and down map to older and newer', () => {
  assert.deepEqual(wheelEvents('\x1b[<64;10;5M'), [{ dir: 1, at: { x: 10, y: 5 } }])
  assert.deepEqual(wheelEvents('\x1b[<65;10;5M'), [{ dir: -1, at: { x: 10, y: 5 } }])
})

test('a burst of events in one chunk yields one entry each, in order', () => {
  assert.deepEqual(wheelEvents('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M').map((w) => w.dir), [1, 1, -1])
})

test('modifier bits do not hide the wheel; clicks, drags, releases and horizontal wheels are not wheel events', () => {
  assert.deepEqual(wheelEvents('\x1b[<68;3;3M'), [{ dir: 1, at: { x: 3, y: 3 } }]) // shift+wheel up
  assert.deepEqual(wheelEvents('\x1b[<0;3;3M\x1b[<32;3;4M\x1b[<0;3;3m'), [])
  assert.deepEqual(wheelEvents('\x1b[<64;3;3m'), [])
  assert.deepEqual(wheelEvents('\x1b[<66;3;3M\x1b[<67;3;3M'), [])
  assert.deepEqual(wheelEvents('plain typing'), [])
})

test('mouse reporting uses button-event tracking so drags arrive', () => {
  assert.equal(MOUSE_ON, '\x1b[?1002h\x1b[?1006h')
  assert.equal(MOUSE_OFF, '\x1b[?1006l\x1b[?1002l')
})

test('left button down, drag and up parse with their cell', () => {
  assert.deepEqual(mouseEvents('\x1b[<0;12;7M'), [{ kind: 'down', x: 12, y: 7 }])
  assert.deepEqual(mouseEvents('\x1b[<32;13;7M'), [{ kind: 'drag', x: 13, y: 7 }])
  assert.deepEqual(mouseEvents('\x1b[<0;14;8m'), [{ kind: 'up', x: 14, y: 8 }])
})

test('a whole drag in one chunk keeps its order', () => {
  assert.deepEqual(mouseEvents('\x1b[<0;1;2M\x1b[<32;2;2M\x1b[<32;3;2M\x1b[<0;3;2m'), [
    { kind: 'down', x: 1, y: 2 },
    { kind: 'drag', x: 2, y: 2 },
    { kind: 'drag', x: 3, y: 2 },
    { kind: 'up', x: 3, y: 2 },
  ])
})

test('wheel, other buttons and plain motion are not mouse events; modifier bits are ignored', () => {
  assert.deepEqual(mouseEvents('\x1b[<64;1;1M\x1b[<65;1;1M'), [])
  assert.deepEqual(mouseEvents('\x1b[<1;1;1M\x1b[<2;1;1M\x1b[<2;1;1m'), []) // middle and right buttons
  assert.deepEqual(mouseEvents('\x1b[<35;1;1M'), []) // motion with no button held
  assert.deepEqual(mouseEvents('\x1b[<34;1;1M'), []) // right-button drag
  assert.deepEqual(mouseEvents('\x1b[<4;5;5M'), [{ kind: 'down', x: 5, y: 5 }]) // shift+press
  assert.deepEqual(mouseEvents('plain typing'), [])
})
