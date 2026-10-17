import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SPINNER_CELL, spinnerCell, splitSpinners } from './spinnerCells.js'

test('segs without a spinner cell stay one run', () => {
  assert.deepEqual(splitSpinners([{ text: 'a' }, { text: 'b' }]), [{ kind: 'segs', segs: [{ text: 'a' }, { text: 'b' }] }])
  assert.deepEqual(splitSpinners([]), [])
})

test('spinner cells split the row and keep their style', () => {
  const cell = spinnerCell({ color: 'red', bg: 'blue' })
  assert.equal(cell.text, SPINNER_CELL)
  const parts = splitSpinners([{ text: 'x' }, cell, { text: 'y' }, cell])
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['segs', 'spinner', 'segs', 'spinner'],
  )
  assert.deepEqual(parts[1], { kind: 'spinner', seg: cell })
})
