import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  backspace,
  deleteToEnd,
  deleteToStart,
  deleteWordBack,
  emptyInput,
  end,
  insert,
  moveLeft,
  moveWordLeft,
  moveWordRight,
  setText,
} from './inputBuffer.js'

test('backspace removes a whole grapheme (emoji ZWJ, combining mark)', () => {
  const family = '👨‍👩‍👧'
  assert.deepEqual(backspace(setText(`a${family}`)), { text: 'a', cursor: 1 })
  assert.deepEqual(backspace(setText('e\u0301')), { text: '', cursor: 0 })
})

test('moveLeft steps over a grapheme cluster', () => {
  assert.equal(moveLeft(setText('x👍🏽')).cursor, 1)
})

test('paste collapses newlines and tabs to spaces and drops control chars', () => {
  assert.equal(insert(emptyInput, 'a\nb').text, 'a b')
  assert.equal(insert(emptyInput, 'a\r\nb\tc').text, 'a b c')
  assert.equal(insert(emptyInput, '\x1b[2J').text, '[2J')
})

test('insert at the cursor, deleteWordBack', () => {
  const buf = insert({ text: 'ac', cursor: 1 }, 'b')
  assert.deepEqual(buf, { text: 'abc', cursor: 2 })
  assert.deepEqual(deleteWordBack(end(setText('hello big  world'))), { text: 'hello big  ', cursor: 11 })
  assert.deepEqual(deleteWordBack({ text: 'foo bar', cursor: 3 }), { text: ' bar', cursor: 0 })
})

test('word motion skips runs of spaces and stops at the ends', () => {
  const text = 'hello  big world'
  assert.equal(moveWordLeft(setText(text)).cursor, 11)
  assert.equal(moveWordLeft({ text, cursor: 11 }).cursor, 7)
  assert.equal(moveWordLeft({ text, cursor: 7 }).cursor, 0)
  assert.equal(moveWordLeft({ text, cursor: 0 }).cursor, 0)
  assert.equal(moveWordRight({ text, cursor: 0 }).cursor, 5)
  assert.equal(moveWordRight({ text, cursor: 5 }).cursor, 10)
  assert.equal(moveWordRight({ text, cursor: 16 }).cursor, 16)
})

test('deleteToEnd keeps the text before the cursor', () => {
  assert.deepEqual(deleteToEnd({ text: 'abcdef', cursor: 2 }), { text: 'ab', cursor: 2 })
  assert.deepEqual(deleteToEnd(setText('abc')), { text: 'abc', cursor: 3 })
})

test('deleteToStart keeps the text after the cursor', () => {
  assert.deepEqual(deleteToStart({ text: 'abcdef', cursor: 2 }), { text: 'cdef', cursor: 0 })
})
