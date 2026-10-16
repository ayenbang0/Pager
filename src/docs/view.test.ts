import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffText, indexAtRow, lineKinds, rowOf, rowPieces, shiftIndex, wrapRows } from './view.js'

test('rows partition the text: wrapped at spaces, empty lines kept, every character on exactly one row', () => {
  const text = 'aaa bbb ccc ddd\n\neee'
  const rows = wrapRows(text, 8)
  assert.deepEqual(
    rows.map((r) => text.slice(r.start, r.end)),
    ['aaa bbb ', 'ccc ddd', '', 'eee'],
  )
  assert.deepEqual(rows.map((r) => [r.line, r.first, r.last]), [[0, true, false], [0, false, true], [1, true, true], [2, true, true]])
  assert.equal(wrapRows('', 10).length, 1)
  assert.deepEqual(wrapRows('abcdefghij', 4).map((r) => [r.start, r.end]), [[0, 4], [4, 8], [8, 10]])
})

test('rowOf and indexAtRow map the cursor and clicks, with the newline position owned by the last row of a line', () => {
  const text = 'aaa bbb ccc\nx'
  const rows = wrapRows(text, 8)
  assert.equal(rowOf(rows, 0), 0)
  assert.equal(rowOf(rows, 8), 1)
  assert.equal(rowOf(rows, 11), 1)
  assert.equal(rowOf(rows, 12), 2)
  assert.equal(indexAtRow(rows, 0, 99), 7)
  assert.equal(indexAtRow(rows, 1, 99), 11)
  assert.equal(indexAtRow(rows, 2, 0), 12)
  assert.equal(indexAtRow(rows, 99, 0), 12)
})

test('markdown line kinds track fenced code blocks', () => {
  assert.deepEqual(lineKinds('# T\ntext\n```js\n# not a heading\n```\n> q\n---'), ['heading', 'text', 'code', 'code', 'code', 'quote', 'rule'])
})

test('row pieces mark the selection and the cursor cell, including a cursor parked on the newline', () => {
  const text = 'hello world'
  const [row] = wrapRows(text, 40)
  assert.ok(row)
  assert.deepEqual(rowPieces(text, row, 4, { start: 2, end: 7 }), [
    { text: 'he', selected: false, cursor: false },
    { text: 'll', selected: true, cursor: false },
    { text: 'o', selected: true, cursor: true },
    { text: ' w', selected: true, cursor: false },
    { text: 'orld', selected: false, cursor: false },
  ])
  assert.deepEqual(rowPieces(text, row, 11, null).at(-1), { text: ' ', selected: false, cursor: true })
})

test('external edits shift the cursor so it keeps its character', () => {
  const change = diffText('hello world', 'hello big world')
  assert.deepEqual(change, { pos: 6, removed: 0, added: 4 })
  assert.equal(shiftIndex(8, change), 12)
  assert.equal(shiftIndex(3, change), 3)
  const cut = diffText('abcdef', 'abef')
  assert.equal(shiftIndex(3, cut), 2)
  assert.equal(shiftIndex(5, cut), 3)
})
