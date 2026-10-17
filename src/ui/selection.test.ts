import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Line, Seg } from './layout.js'
import { selectedText, withSelection, type Sel } from './selection.js'

const line = (...texts: string[]): Line => ({ key: texts.join(''), segs: texts.map((text): Seg => ({ text })) })
const at = (row: number, col: number) => ({ row, col })
const drag = (a: [number, number], h: [number, number]): Sel => ({ anchor: at(...a), head: at(...h) })

const LINES = [line('alpha beta gamma'), line('delta', ' epsilon'), line('zeta eta theta   ')]

test('a drag within one row copies the columns it covers, both ends included', () => {
  assert.equal(selectedText(LINES, drag([0, 6], [0, 9])), 'beta')
  assert.equal(selectedText(LINES, drag([0, 0], [0, 0])), 'a')
})

test('a reversed drag copies the same text', () => {
  assert.equal(selectedText(LINES, drag([0, 9], [0, 6])), 'beta')
  assert.equal(selectedText(LINES, drag([2, 3], [0, 6])), selectedText(LINES, drag([0, 6], [2, 3])))
})

test('several rows: first from its column, middle whole, last up to its column; segments join without a separator', () => {
  assert.equal(selectedText(LINES, drag([0, 11], [2, 3])), 'gamma\ndelta epsilon\nzeta')
})

test('trailing spaces are trimmed and a selection past the end of a row stops at the text', () => {
  assert.equal(selectedText(LINES, drag([2, 5], [2, 40])), 'eta theta')
  assert.equal(selectedText(LINES, drag([0, 11], [1, 99])), 'gamma\ndelta epsilon')
})

test('wide characters count two columns and a half-selected one is included whole', () => {
  const wide = [line('日本語 ok')]
  assert.equal(selectedText(wide, drag([0, 2], [0, 3])), '本')
  assert.equal(selectedText(wide, drag([0, 3], [0, 4])), '本語')
  assert.equal(selectedText(wide, drag([0, 7], [0, 8])), 'ok')
})

test('combining marks and emoji stay with their base character', () => {
  const rows = [line('e\u0301x 🔥y')]
  assert.equal(selectedText(rows, drag([0, 0], [0, 0])), 'e\u0301')
  assert.equal(selectedText(rows, drag([0, 3], [0, 3])), '🔥')
})

test('nothing selectable returns an empty string', () => {
  assert.equal(selectedText([], drag([0, 0], [0, 5])), '')
  assert.equal(selectedText(LINES, drag([0, 40], [0, 50])), '')
  assert.equal(selectedText([line('   '), line('')], drag([0, 0], [1, 3])), '')
  assert.equal(selectedText(LINES, drag([7, 0], [9, 3])), '')
})

test('rows beyond the visible lines are ignored', () => {
  assert.equal(selectedText(LINES, drag([2, 0], [9, 3])), 'zeta eta theta')
})

const plain = (segs: Seg[]): string => segs.map((s) => s.text).join('')
const marked = (segs: Seg[]): string => segs.filter((s) => s.inverse === true).map((s) => s.text).join('')

test('withSelection marks exactly the selected cells and keeps the text and styling', () => {
  const segs: Seg[] = [{ text: 'bob', bold: true, color: 'red' }, { text: '  hello world' }]
  const out = withSelection(segs, 0, drag([0, 2], [0, 7]))
  assert.equal(plain(out), 'bob  hello world')
  assert.equal(marked(out), 'b  hel')
  assert.deepEqual(out[0], { text: 'bo', bold: true, color: 'red' })
  assert.deepEqual(out[1], { text: 'b', bold: true, color: 'red', inverse: true })
})

test('withSelection covers whole middle rows and leaves other rows untouched', () => {
  const sel = drag([0, 4], [2, 1])
  const segs: Seg[] = [{ text: 'middle row' }]
  assert.equal(marked(withSelection(segs, 1, sel)), 'middle row')
  assert.equal(withSelection(segs, 3, sel), segs)
  assert.equal(withSelection(segs, 0, null), segs)
  assert.equal(marked(withSelection(segs, 0, sel)), 'le row')
  assert.equal(marked(withSelection(segs, 2, sel)), 'mi')
})

test('withSelection splits wide characters on column boundaries', () => {
  const out = withSelection([{ text: '日本語' }], 0, drag([0, 2], [0, 3]))
  assert.equal(marked(out), '本')
  assert.equal(plain(out), '日本語')
})
