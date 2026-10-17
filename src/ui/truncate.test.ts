import assert from 'node:assert/strict'
import { test } from 'node:test'
import stringWidth from 'string-width'
import { truncateWidth } from './truncate.js'

test('text that fits is returned unchanged', () => {
  assert.equal(truncateWidth('hello', 5), 'hello')
  assert.equal(truncateWidth('', 3), '')
})

test('longer text is cut with an ellipsis inside the width', () => {
  assert.equal(truncateWidth('hello world', 6), 'hello…')
  assert.equal(truncateWidth('hello', 1), '…')
})

test('no room means no text', () => {
  assert.equal(truncateWidth('hello', 0), '')
  assert.equal(truncateWidth('hello', -2), '')
})

test('wide characters count by display width and never straddle the edge', () => {
  for (const max of [1, 2, 3, 4, 5, 6]) {
    assert.ok(stringWidth(truncateWidth('漢字漢字漢字', max)) <= max, `cjk at ${max}`)
    assert.ok(stringWidth(truncateWidth('🙂🙂🙂🙂', max)) <= max, `emoji at ${max}`)
  }
  assert.equal(truncateWidth('漢字漢字', 5), '漢字…')
})
