import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fuzzyFilter } from './fuzzy.js'

const items = ['Theme: mono', 'Open alice', 'Alice (offline)', '# team', 'Quit'].map((label) => ({ label }))
const labels = (q: string): string[] => fuzzyFilter(items, q).map((i) => i.label)

test('empty query keeps every item in order', () => {
  assert.deepEqual(labels('  '), items.map((i) => i.label))
})

test('prefix beats word-start beats substring beats subsequence', () => {
  assert.deepEqual(labels('alice'), ['Alice (offline)', 'Open alice'])
  assert.deepEqual(labels('tm'), ['Theme: mono', '# team'])
  assert.deepEqual(labels('ono'), ['Theme: mono'])
})

test('case-insensitive; non-matches are dropped', () => {
  assert.deepEqual(labels('QUIT'), ['Quit'])
  assert.deepEqual(labels('zzz'), [])
})

test('a subsequence must keep character order', () => {
  assert.deepEqual(labels('mt'), [])
})
