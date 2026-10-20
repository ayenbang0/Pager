import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { gutterFor, moveSelection, type BlockSpan } from './blockNav.js'

test('selection starts at the newest block and clamps at both ends', () => {
  assert.equal(moveSelection([], null, 1), -1)
  assert.equal(moveSelection([4, 7, 9], null, -1), 9)
  assert.equal(moveSelection([4, 7, 9], 7, -1), 4)
  assert.equal(moveSelection([4, 7, 9], 4, -1), 4)
  assert.equal(moveSelection([4, 7, 9], 9, 1), 9)
  assert.equal(moveSelection([4, 7, 9], 99, 1), 9)
})

test('gutter colors follow running, ok and failed; selected is a full block; outside is blank', () => {
  const spans: BlockSpan[] = [
    { id: 1, first: 0, last: 2, exit: 0, running: false },
    { id: 2, first: 3, last: 4, exit: 1, running: false },
    { id: 3, first: 5, last: 6, exit: null, running: true },
  ]
  assert.deepEqual([gutterFor(1, spans, null, theme).color, gutterFor(3, spans, null, theme).color, gutterFor(5, spans, null, theme).color], [theme.success, theme.error, theme.accent])
  assert.equal(gutterFor(1, spans, 1, theme).text, '█ ')
  assert.equal(gutterFor(1, spans, 2, theme).text, '▌ ')
  const none = gutterFor(9, spans, null, theme)
  assert.equal(none.text, '  ')
  assert.equal(none.color, undefined)
})
