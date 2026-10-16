import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backspace, deleteWordBack, emptyInput, end, insert, moveLeft, setText } from './inputBuffer.js'

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
